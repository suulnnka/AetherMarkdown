# AetherMarkdown

一个**零依赖、可嵌入**的浏览器 Markdown 所见即所得编辑器。

交互形态类似 Typora：单一编辑面、块级实时渲染——光标所在的块显示 Markdown 源码，光标移开后立即渲染为最终样式。底层文档永远是纯 Markdown 文本。

## 设计目标

- **零运行时依赖**：不依赖任何 npm 包，宿主通过 webpack / vite 等工具直接导入本项目源码。
- **以源文本为唯一数据事实**：内部不维护富文本 AST，任何时刻 `getValue()` 都返回与所见内容一致的 Markdown 源码；未编辑过的区域逐字节保留原样。
- **完全无入侵**：以 class API 挂载到宿主任意容器元素（不注册 Custom Element、不占用全局标签名、无全局副作用），`destroy()` 后不留任何痕迹。
- **样式完全隔离**：强作用域样式（`.aether-host` 前缀 + 继承属性显式重置），宿主页面样式与编辑器样式互不影响；主题通过 CSS 变量定制。（注：不使用 Shadow DOM——其 Selection API 在 WebKit 等引擎不穿透边界，会破坏真实输入。）
- **IME 安全**：中文/日文输入法合成期间不触碰 DOM，保证不丢字、不断字。
- **小体积**：运行时全量（JS + CSS + 两套主题）gzip 预算 ≤ 25 KB（估算约 20 KB，见 architecture.md 体积预算）。

## 功能范围（已锁定）

**做：**

- **行块模型**（D34）：每一行独立成块，行与行互不影响——无跨行合并、无列表容器（插入文字行不会"拆分"列表）、空行是真实可输入的空块
- 回车 = 分行、Shift+Enter = 短间距行；编辑器不代写语法（无回车自动续行列表/引用）
- 编辑态参考 milkdown：保持排版、语法标记弱化显示（内容不位移）、无底色
- Markdown 语法：标题、文字行、粗体、斜体、删除线、行内代码、链接、自动链接、图片、有序/无序列表（嵌套）、任务列表、引用、围栏代码块、简单表格（D35）、分割线、转义、硬换行（详见 [docs/markdown-syntax.md](docs/markdown-syntax.md)）
- 图片渲染（尺寸自动约束在内容列宽与视口高度内）；点击发出 `imageClick` 事件，放大查看由宿主实现
- 块级撤销/重做（自建 undo 栈）
- 只读模式
- 亮/暗两套主题（CSS 变量抽象，宿主可改）
- 粘贴自动清理为纯文本

**明确不做（非目标）：**

| 不做 | 说明 |
|---|---|
| 数学公式 / mermaid / 脚注 / 定义列表 | 需外部渲染器或性价比低 |
| HTML 直写 | 按字面文本处理（安全考虑） |
| 代码语法高亮 | 代码块纯等宽字体展示，渲染层预留 class 钩子 |
| 键盘格式快捷键（Ctrl+B/I/K） | 不做 |
| 源码模式切换 / 分栏预览 | 编辑面只有实时渲染一种形态 |
| 图片上传 / 粘贴 / 拖拽 | 图片只认 URL（`![alt](url)`） |
| 任务列表复选框点击 | 复选框纯展示，切换靠编辑源码 `[ ]`↔`[x]` |
| 智能粘贴（HTML→Markdown） | 粘贴一律清理为纯文本 |
| 符号自动配对 | 不做 |
| 字数统计 / 查找替换 / 大纲 TOC / 打字机与焦点模式 / 导出 HTML | 不做 |
| 移动端 | 目标为桌面浏览器，不做软键盘/触摸适配 |
| 图片尺寸调整 | 不做 |

## 浏览器支持

桌面版 Chrome / Edge / Firefox / Safari，最近两年的主流版本。不支持 IE。

## 高度与滚动

本库**不管理高度**。根元素不设置任何 `height` / `max-height` / `overflow` 样式：编辑器随内容自然增高，由宿主的外层容器决定尺寸和滚动（想要固定高度内滚，就给外层容器设 `height` + `overflow: auto`）。

## 开发状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 解析层 | ✅ 完成 | `parseLines` / `parseInline` 等纯函数，golden 测试全通过（`npm test`，33 例）。HTML 序列化管线（`markdownToHtml`）曾作为过渡产物存在，已随 D36 删除 |
| M2 编辑面 | ✅ 完成 | contenteditable 行块渲染、活动块源码化、选区双向映射、块级 undo、IME 防护、粘贴纯文本化、简单表格（D35）、只读、主题。编辑面为 light DOM（Shadow DOM 的 Selection API 在 WebKit 不穿透，曾导致真实输入全部失效） |
| M3 打磨 | ⬜ 未开始 | 真机 IME 手动验证、边缘案例打磨、打包产物 |

## 快速开始

```js
import { MarkdownEditor } from 'aether-markdown';
import 'aether-markdown/theme/light.css';
import 'aether-markdown/theme/dark.css'; // 可选，两套都导入后可用 setTheme 切换

const editor = new MarkdownEditor({
  target: document.querySelector('#editor'),
  value: '# Hello\n\n世界。',
  theme: 'light',
});

editor.on('change', (value) => {
  console.log(value);
});
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/decisions.md](docs/decisions.md) | 决策记录：所有已锁定的取舍及理由 |
| [docs/architecture.md](docs/architecture.md) | 架构设计：分层、块模型、数据流、undo、IME、安全 |
| [docs/markdown-syntax.md](docs/markdown-syntax.md) | 支持的 Markdown 语法规范与对 CommonMark 的有意偏离 |
| [docs/editing-behavior.md](docs/editing-behavior.md) | 编辑交互行为规范：键盘行为、链接/图片行为 |
| [docs/api.md](docs/api.md) | API 参考：构造项、方法、事件、包导出面、宿主框架集成 |
| [docs/theme.md](docs/theme.md) | 主题与样式：light DOM 隔离、CSS 变量清单、定制指引 |
