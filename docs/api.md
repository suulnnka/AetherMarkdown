# API 参考

## 安装与导入

本项目作为普通 ES Module 源码分发，无任何运行时依赖。宿主用自己的打包工具（webpack / vite / Rollup 等）直接导入：

```js
import { MarkdownEditor } from 'aether-markdown';  // 或相对路径导入 src/index.js
import 'aether-markdown/theme/light.css';           // 主题 CSS（见 theme.md）
import 'aether-markdown/theme/dark.css';            // 可选：两套都导入后支持运行时切换
```

不注册 Custom Element、不挂全局变量、不监听全局事件；多实例互不影响；`destroy()` 后无残留。

## 构造

```js
const editor = new MarkdownEditor(options);
```

### options

| 项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `target` | `HTMLElement` | 必填 | 挂载容器。编辑器在其内部创建 light DOM 结构（强作用域样式隔离，不用 Shadow DOM），容器原有内容会被清空 |
| `value` | `string` | `''` | 初始 Markdown 文本 |
| `theme` | `'light' \| 'dark'` | `'light'` | 初始主题（设置宿主元素 `data-theme`） |
| `readonly` | `boolean` | `false` | 初始只读态 |
| `historyLimit` | `number` | `200` | undo 栈深度 |

## 实例方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `getValue()` | `string` | 当前 Markdown 源文本（任何时刻与所见内容一致） |
| `setValue(value, opts?)` | `void` | 整体替换文档。`opts.resetHistory`（默认 `true`）清空 undo 栈；`false` 时替换记为一个 undo 单元 |
| `focus(position?)` | `void` | 聚焦编辑器；`position`：`'start' \| 'end'`（默认恢复上次光标位置，无记录则 `'start'`） |
| `blur()` | `void` | 失焦（活动块随之渲染化） |
| `setReadonly(v)` | `void` | 运行时切换只读态（不清空文档与历史） |
| `setTheme(t)` | `void` | 切换 `'light' / 'dark'`（切换宿主元素 `data-theme`；对应主题 CSS 需已由宿主导入） |
| `on(event, cb)` | `this` | 订阅事件 |
| `off(event, cb?)` | `this` | 退订（`cb` 省略则清空该事件全部订阅） |
| `destroy()` | `void` | 解绑事件、移除 DOM、断开观察；实例不可再用 |

## 事件

| 事件 | 回调签名 | 时机 |
|---|---|---|
| `change` | `(value: string) => void` | 源文本任何变化后（输入、粘贴、undo/redo、setValue） |
| `focus` | `() => void` | 编辑器获得焦点 |
| `blur` | `() => void` | 编辑器失去焦点 |
| `imageClick` | `(src: string) => void` | 渲染态图片被点击（D12 修订：放大展示由宿主实现；无监听时点击回落为激活该块） |

`change` 在一次用户操作完成后同步触发一次（不做逐键防抖去重，宿主可自行节流持久化）。

## 高度与滚动

库在根元素上不设置 `height` / `max-height` / `overflow`。编辑器随内容自然增高；要固定高度内滚，由宿主包一层：

```html
<div style="height: 480px; overflow: auto"><!-- 编辑器挂载于此 --></div>
```

## 宿主框架集成

推荐**非受控**用法：`value` 仅作初值，之后数据流向单一（编辑器 → 宿主 state），避免受控回环：

```jsx
// React 示例
function Editor({ initial }) {
  const ref = useRef(null);
  const edRef = useRef(null);
  useEffect(() => {
    const ed = new MarkdownEditor({ target: ref.current, value: initial });
    ed.on('change', (v) => save(v));        // 宿主自行节流持久化
    edRef.current = ed;
    return () => ed.destroy();
  }, []);                                    // initial 变化不重建；外部需要覆盖时调 setValue
  return <div ref={ref} />;
}
```

Vue 同理：`onMounted` 创建、`onBeforeUnmount` 销毁、`@change` 同步，不在模板里绑定 value。

## 无障碍（尽力提供）

- 编辑区带 `role="textbox"` 与 `aria-multiline`、`aria-readonly`（只读态切换）。
- 图片 alt 透传；链接保留文本；标题使用真实 `h1-h6`。
- 全键盘可达（浏览器原生 contenteditable 行为）。

## 包导出面（D36 收敛）

包根 `aether-markdown`（`src/index.js`）导出：

| 导出 | 说明 |
|---|---|
| `MarkdownEditor` | 编辑器类（本文档） |
| `parseLines(src)` | 源文本 → 行块单元列表（纯函数） |
| `parseTableRow(line)` | 单行表格解析（`{cells, sep}` 或 `null`） |
| `parseInline(src)` | 单行内容 → 行内 token 树（纯函数，输入不含换行） |
| `plainText(tokens)` | token 树 → 纯文本（图片 alt 等） |
| `sanitizeUrl(url, {image})` | URL 协议白名单（安全边界，返回安全 URL 或 `null`） |

**无 HTML 序列化导出**（`markdownToHtml` 等已随 D36 删除：编辑器渲染直接构建 DOM，HTML 字符串管线为死代码）。

## 稳定性承诺

- 语义化版本；破坏性变更仅发生在主版本。
- 本文档列出的 API 与事件为公开接口；`MarkdownEditor` 实例上的其他属性/方法均为内部实现，不承诺稳定。
