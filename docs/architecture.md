# 架构设计

## 1. 设计原则

1. **源文本为唯一数据事实。** 内部任何状态（单元列表、DOM、undo 栈）都是源文本的派生物，不存在第二份"文档模型"。序列化零成本（未编辑区域逐字节保留）、undo 退化为"源文本快照栈"、宿主集成无需理解私有数据结构。
2. **行块模型（D34）。** 每一源码行独立成一个单元，行与行互不影响：无跨行段落合并、无列表容器、空行是真实可输入的空块。仅围栏代码块与简单表格（D35）是跨行结构。这是全项目最重要的简化——删除了虚拟段、物化、容器对齐等全部机制。
3. **合成期零操作。** IME `compositionstart` → `compositionend` 期间不做任何 DOM 结构变更与重渲染。
4. **DOM 即渲染层。** 不存在 HTML 字符串序列化路径（D36 删除）：渲染直接构建 DOM 元素，文本一律经 `textContent` 写入，天然无注入；URL 安全由 `sanitizeUrl` 白名单把关。

## 2. 分层与目录

```
src/
  index.js            // 包出口：MarkdownEditor + 解析层工具（7 行）
  parse/              // 纯函数，可在 Node 独立测试
    lines.js          // 行块解析器：源文本 → 单元列表（含表格行解析 parseTableRow）
    inline.js         // 行内解析器：单行内容 → token 树（输入恒为单行，无换行处理）
    entities.js       // URL 协议白名单 sanitizeUrl + 转义字符集 ESCAPABLE
  core/
    document.js       // 单元列表 + id 对齐 + 结构操作（剥层/合并/缩进，源文本变换）
    undo.js           // 快照栈（500ms 同单元连续输入合并）
  render/
    dom.js            // 单元 → DOM（渲染态/编辑态两套构建）；__src 坐标标注
    styles.js         // 结构样式（JS 内嵌字符串，light DOM 强作用域）
  edit/
    surface.js        // MarkdownEditor 主类：事件、活动块机制、编辑数据流
    keyboard.js       // 键盘行为表（Enter/Shift+Enter/Tab/Backspace/Delete/undo）
    selection.js      // DOM ↔ 源偏移 双向映射
theme/                // 两套普通 CSS（CSS 变量取值）
test/parse/           // Node golden 测试（33 例，npm test）
demo/                 // 演示页（Vite 入口；npm run dev 本地开发，npm run build 打包到 dist/）
dist/                 // 构建产物（gitignore；CI 构建并部署 GitHub Pages）
.github/workflows/    // CI：测试 → 构建 → Pages 部署
```

各层均为纯浏览器 JS（ES Module），零依赖。实际代码量（含注释）：

| 模块 | 行数 | | 模块 | 行数 |
|---|---|---|---|---|
| edit/surface.js | 499 | | parse/lines.js | 188 |
| render/dom.js | 390 | | core/document.js | 144 |
| parse/inline.js | 303 | | edit/selection.js | 144 |
| render/styles.js | 140 | | edit/keyboard.js | 90 |
| core/undo.js | 54 | | parse/entities.js | 35 |
| src/index.js | 7 | | **合计** | **≈ 2,000** |

测试 324 行、主题 46 行、文档若干。体积预算见 D28（JS gzip ≤ 25 KB）。

## 3. 单元模型

`parseLines(src)` 把源文本切成扁平单元列表，每个单元：

```js
Unit {
  id: number          // 跨解析保持稳定（见 §4），用于 DOM 与 undo 定位
  kind: string        // 'text' | 'blank' | 'heading' | 'hr' | 'item' | 'quote' | 'code' | 'table'
  range: [start, end) // 源文本区间，不含行尾换行符
  textStart: number   // 内容起点；[range[0], textStart) 为前缀（缩进/标记），编辑态弱化显示
  text: string        // 内容（不含前缀；code/table 为跨行拼接）
  editable: boolean   // hr 不可编辑，其余可
  // kind 特有：heading.level、item.{ordered,markerText,task,checked,indent}、
  //            quote.qdepth、code.{info,lines}、table.lines
}
```

- 每行只应用一个主语法（引用/列表行内的 `#` 等按字面处理），行内语法（粗体/链接等）由 inline.js 在渲染时解析。
- **跨行结构**只有两个：围栏代码块（开栏到闭栏整体一个单元，`lines` 记录内容行的 `{start, textStart, text}`）；简单表格（连续 `|` 行整体一个单元，`lines` 记录各行）。两者共用同一机制：整块一个编辑单元，内部换行符保留在源码与编辑态文本流中。

## 4. id 对齐

每次解析后，新旧单元做对齐：**内容键优先**（kind + 源切片相同则沿用旧 id），**range[0] 兜底**。id 稳定的意义：

- 活动块跨解析保持激活（`_activeId` 指向的单元在重解析后仍是同一行）；
- undo 的连续输入合并依赖 unitId 判定"同一单元"（否则每次按键都成独立 undo 项）；
- `_findEl(id)` 在重渲染后的 DOM 中找回对应元素以放置光标。

## 5. 编辑数据流

一次典型输入（活动行内打字）：

```
浏览器默认编辑（活动行是 contenteditable 文本）
  → input 事件 / MutationObserver
  → 读活动行 DOM 纯文本，整行写回源文本区间（幂等：DOM 纯文本 ↔ 源切片逐字节一致）
  → doc.rebuild() 整篇重解析（逐行正则，纯字符串操作，毫秒级）
  → _finishEdit：
      结构签名（单元 id/kind/range 序列）未变 → 仅局部重建活动行元素（_refreshActiveEl）
      签名变了（行数/类型/区间移动）→ 全量重渲染（_renderAll）
  → 按源偏移恢复光标（setCollapsed）
  → undo 快照入栈、触发 change 事件
```

要点：**解析永远整篇重跑**，但 DOM 更新分两档（局部/全量）。不维护增量解析器——行块模型下整篇重解析足够快，这是刻意的简化取舍。

结构操作（回车、行首退格剥层、Tab 缩进、选区删除、粘贴）不走浏览器默认编辑：keydown/beforeinput 拦截后直接做源文本变换，再走同一条 `rebuild → 渲染 → 光标` 流程。

## 6. 活动块机制

- 编辑容器整体 `contenteditable`，每个单元渲染为容器的直接子元素（扁平结构，无嵌套容器）。
- **任何时刻至多一个活动单元**（`md-active`）。光标进入渲染态单元（selectionchange 检测）即切换为**编辑态**：显示整行源码，语法标记（`#`、`**`、`](url)`、pipe 等）以 `md-marker` 弱化色排在对应位置，排版保持（标题仍是标题字号、粗体仍加粗）；前导缩进空格以 `md-indent` 零宽收纳（视觉缩进由 marginLeft 表达，字节保留）。编辑态 DOM 纯文本与源切片逐字节一致——这是幂等同步的前提。
- 其余单元为**渲染态**（语法隐藏）。切换不改源文本、不进 undo 栈。
- 渲染态光标定位有**边界吸附**（`_renderedSrcOff`）：点击落在可见内容最前/最后时，光标对齐源码内容起点/行尾，避免行尾隐藏语法（`**`、`](url)`）把光标留在源码行中部。

## 7. 选区映射

双向映射 `DOM 位置（节点 + offset）↔ 源偏移`（edit/selection.js）：

- 编辑态单元是纯文本流：偏移即字符偏移（`charOffsetIn`）。
- 渲染态单元：文本节点携带 `__src`（单元内容坐标），经 `domToContentOff` → `contentToSrc`（多行单元按 `lines` 的 lineMap 换算）回到源偏移；图片同样携带 `__src`。
- 跨单元选区的删除/复制：DOM 选区翻译为源文本区间 `[start, end)`，操作直接作用于源文本，再走 §5 数据流。**跨块操作统一走"翻译到源文本 → 整体替换"**，不在 DOM 层逐节点操作——这是避免 contenteditable 混乱的关键纪律。
- 复制：选区映射回源文本后以 `text/plain` 写入剪贴板（即 Markdown 源码）。

## 8. 撤销 / 重做

- 栈内容为 `{ 源文本快照, 光标源偏移 }`（core/undo.js）。
- **单元划分**：同一单元内 500ms 连续输入合并（`typing` 标记 + unitId 判定）；结构操作（回车、合并、剥层、缩进、粘贴、选区删除）各自独立；IME 一次合成为一个单元。
- 默认栈深 200（构造项 `historyLimit` 可调）。`setValue(value, { resetHistory: true })`（默认）清空整栈。
- undo/redo = 整体替换源文本 + 按快照偏移重定位光标。

## 9. IME 策略

- `compositionstart` → `compositionend` 期间：不重渲染、不切活动块、不动 DOM 结构（`_composing` 旗标拦截全部同步入口）；合成树交给浏览器。
- `compositionend` 后：一次性同步源文本并走正常数据流。
- 活动块本身即源码态纯文本，合成树不会被语法结构打断。丢字/断字/合成中被重渲染为零容忍缺陷。

## 10. 粘贴与拖放

- 粘贴：只取 `text/plain`（`\r` 剥除），忽略 HTML 与文件（D17）；选区先删再插入，纯文本直接进源文本（换行符原样进入，重解析后自然成行）。一个 undo 单元。
- 拖放：不承诺支持，drop 一律 preventDefault。

## 11. 安全

- **渲染路径**：全部走 DOM API（`createElement` / `textContent`），无 HTML 字符串拼接，无 `innerHTML`——不存在用户 HTML 直通路径（HTML 直写按字面文本显示）。
- **URL 协议白名单**（parse/entities.js `sanitizeUrl`）：链接允许 `http:`、`https:`、`mailto:`、无协议相对地址；图片额外允许 `data:image/*`。含控制字符、空白混淆协议一律拒绝；被拒的链接/图片降级为纯文本渲染。链接统一 `target="_blank" rel="noopener noreferrer"`。
- 只读态复用同一渲染管线，无第二套输出路径。

## 12. 样式隔离（light DOM + 强作用域）

编辑面位于 light DOM（不使用 Shadow DOM）：Shadow 内的 Selection API 与键盘事件在 WebKit 等引擎不穿透边界，实测真实点击/输入完全失效（D21 修订）。隔离由三重手段实现（render/styles.js）：

1. 宿主容器 `.aether-host` 显式重置全部可继承属性（字体/颜色/对齐/空白等），阻断宿主样式向内继承；
2. 所有规则以 `.aether-host` 为前缀，类名统一 `md-` 前缀；
3. 视觉值全部来自 CSS 自定义属性（主题文件定义、宿主可覆盖，见 theme.md）。

## 13. 测试策略

- **解析层**（test/parse/，Node 直接跑，毫秒级）：golden 用例覆盖行块种类与字段（lines.test.js）、行内 token 与偏移（inline.test.js）、安全边界直测（security.test.js：sanitizeUrl 协议白名单 + HTML 字面化）。CI（GitHub Actions）每次推送跑全量测试 + Vite 构建 + Pages 部署。
- **编辑层**：无自动化基建（零依赖约束下不引入 DOM 模拟），以 demo 页手动冒烟为准：输入、Enter/Shift+Enter、表格、代码块、列表/引用、undo/redo、粘贴、主题/只读切换。
- **回归重点**：光标不跳（编辑态 DOM 与源切片逐字节一致是前提）、IME 不断字、undo 后光标还原。
