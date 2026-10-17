# 主题与样式

## 隔离模型（light DOM + 强作用域）

- 编辑器 UI 挂载在宿主元素内的 light DOM（**不使用 Shadow DOM**）：Shadow 内的 Selection/键盘事件在 WebKit 等引擎不可靠，会破坏真实点击与输入（D21 修订）。
- **结构样式**（布局、间距、代码块边框等）由 JS 内嵌字符串（`src/render/styles.js`）注入 `<style>` 到宿主元素内：全部规则以 `.aether-host` 为前缀、类名 `md-` 前缀、宿主容器显式重置可继承属性，实现与宿主页面互不影响。
- **主题 = 两套普通 CSS 文件**（`theme/light.css`、`theme/dark.css`），在 `.aether-host` 上定义变量取值，宿主覆盖变量即可定制外观。

## 两套主题文件

```css
/* theme/light.css —— 作用于宿主元素（.aether-host） */
.aether-host { --md-text: #1f2328; ... }
/* theme/dark.css —— .aether-host[data-theme='dark']，需与 light 同时导入 */
.aether-host[data-theme='dark'] { --md-text: #e6edf3; ... }
```

宿主按需导入：

```js
import 'aether-markdown/theme/light.css';  // 只要亮色
import 'aether-markdown/theme/dark.css';   // 两套都导入 → setTheme('dark') 即可运行时切换
```

`new MarkdownEditor({ theme })` 与 `setTheme(t)` 只切换宿主元素上的 `data-theme`，不加载/卸载 CSS——导入哪些主题文件由宿主自己决定。

## CSS 变量清单

与 `src/render/styles.js` 实际消费的变量一一对应。"fallback" 为库内默认值（主题未定义该变量时生效）。

### 排版

| 变量 | 用途 | light / dark 取值 | fallback |
|---|---|---|---|
| `--md-font-family` | 正文字体栈 | `system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif`（dark 沿用 light） | 同左 |
| `--md-font-size` | 正文字号 | `16px` | `16px` |
| `--md-line-height` | 正文行高 | 未定义 | `normal`（浏览器默认，随字体度量） |
| `--md-line-gap` | 普通行块间距 | 未定义 | `0.4em` |
| `--md-item-gap` | 列表/引用行间距 | 未定义 | `0.25em` |
| `--md-br-hard-gap` | 硬换行（Shift+Enter）下一行的额外间距 | `0`（与折行行距完全一致） | `0` |
| `--md-heading-weight` | 标题字重 | `600` | `600` |
| `--md-content-width` | 内容列最大宽度 | `800px` | `800px` |
| `--md-code-font-family` | 代码字体栈 | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | 同左 |
| `--md-code-font-size` | 代码字号（行内与块级） | `0.9em` | `0.9em` |
| `--md-img-max-height` | 图片渲染最大高度（宽度上限恒为内容列宽） | `75vh` | `75vh` |

### 颜色

| 变量 | 用途 | light | dark |
|---|---|---|---|
| `--md-text` | 正文颜色（含项目符号/编号） | `#1f2328` | `#e6edf3` |
| `--md-text-secondary` | 次要文本（代码语言标签、h6） | `#656d76` | `#8b949e` |
| `--md-border` | 边框（代码块、表格单元格） | `#d0d7de` | `#30363d` |
| `--md-link` | 链接颜色 | `#0969da` | `#58a6ff` |
| `--md-pre-bg` | 代码背景（行内与块级共用） | `#f6f8fa` | `#161b22` |
| `--md-quote-border` | 引用竖线颜色 | `#d0d7de` | `#3d444d` |
| `--md-quote-text` | 引用文字颜色 | `#656d76` | `#8b949e` |
| `--md-hr` | 分割线颜色 | `#d0d7de` | `#30363d` |
| `--md-selection-bg` | 选区背景 | `rgba(9,105,218,0.25)` | `rgba(88,166,255,0.35)` |
| `--md-caret` | 光标颜色 | `#1f2328` | `#e6edf3` |
| `--md-checkbox` | 复选框颜色 | `#0969da` | `#58a6ff` |
| `--md-marker` | 编辑态语法标记弱化色 | `#6e7781` | `#8b949e` |

## 宿主定制指引

1. **改配色/字体**：在宿主 CSS 中覆盖变量即可，无需碰库内文件：

   ```css
   .my-editor-scope { --md-content-width: 100%; --md-link: #c05b4d; }
   ```

   作用域写在编辑器容器或其任意祖先上均可（CSS 变量沿继承链生效）。

2. **做新主题**：复制一份主题文件修改变量值即可；库对主题数量无假设，`data-theme` 的值只要和宿主 CSS 选择器对得上就行（`setTheme('sepia')` + `[data-theme='sepia']` 同样有效）。

3. **更深度的定制（结构级）**：不在承诺范围内。`.aether-host` 内部 DOM 结构属于实现细节，跨版本可能变化；变量清单是唯一的稳定定制接口。

## 渲染态 class 钩子

渲染产物上带语义 class（light DOM 内，宿主选择器理论上可命中，但**内部结构不承诺稳定**，仅建议作为内部样式组织与未来扩展——如代码高亮——的着色锚点）：

- 行块：`md-line`、`md-p`、`md-blank`、`md-h1`…`md-h6`、`md-hr`、`md-item-line`、`md-task`、`md-quote-line`、`md-pre`、`md-table`
- 行内：`md-bullet`、`md-num`、`md-checkbox`、`md-code`、`md-code-block`、`md-table-el`、`md-tr`、`md-td`、`md-link`、`md-autolink`、`md-del`、`md-strong`、`md-em`、`md-img`
- 编辑态：`md-active`、`md-marker`、`md-prefix`、`md-indent`、`md-qmark`、`md-link-edit`
- 状态：`md-gap-short`（硬换行后的短间距行）
