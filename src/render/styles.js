// 行块结构样式（D34）：随编辑器注入宿主元素（light DOM）。
// 隔离：宿主容器重置可继承属性 + .aether-host 前缀 + md- 类名前缀 + CSS 变量。
//
// BASE_CSS 为紧凑形态（注释在字符串外、每规则一行）——字符串字面量
// 不经压缩器处理，注释与缩进会原样进入产物体积（D37）。
// 规则说明：
//  - .aether-host：重置全部可继承属性，阻断宿主样式泄漏
//  - .md-surface：内容左缘 = 所有行块（标记 + 正文）的统一起始位置；
//    嵌套缩进以各行 marginLeft 叠加，无元素悬挂到起始位置左侧
//  - 行块间距：普通行 --md-line-gap；列表/引用行 --md-item-gap；
//    硬换行（md-gap-short）--md-br-hard-gap（相邻引用行归零使竖线连续）
//  - 列表行：符号/编号/复选框行内排在行首，正文跟随（编辑态前缀同一起点）
//  - 引用行：渲染态竖线按层级由 background 绘制（dom.js 内联）；
//    编辑态不画线（> 标记即层级指示，md-qmark 定位到各层级起点）
//  - .md-blank：空行块保最小高度；与 .md-active 的 min-height 一致，
//    进出编辑态高度不变
//  - 代码块/表格：仅有的两个跨行结构；宽表格横向滚动
//  - 编辑态：整行源码显示，标记前缀（## / - / 1. / > 等）行内排在行首，
//    前导缩进空格以 md-indent 零宽收纳（视觉缩进由 marginLeft 表达）
//  - 图片：尺寸约束（D27），zoom-in 光标提示可点击（imageClick 交宿主）

export const BASE_CSS = `
.aether-host { display: block; font-family: var(--md-font-family, system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif); font-size: var(--md-font-size, 16px); font-weight: normal; font-style: normal; line-height: var(--md-line-height, normal); color: var(--md-text, #1f2328); text-align: left; letter-spacing: normal; word-spacing: normal; text-transform: none; text-indent: 0; white-space: normal; font-variant: normal; }
.aether-host .md-surface { caret-color: var(--md-caret, #1f2328); outline: none; min-height: 1.75em; max-width: var(--md-content-width, 800px); padding: 2px 0; }
.aether-host .md-surface ::selection { background: var(--md-selection-bg, rgba(9, 105, 218, 0.25)); }
.aether-host .md-surface[contenteditable='false'] { cursor: default; }
.aether-host .md-line { margin: 0; }
.aether-host .md-line + .md-line { margin-top: var(--md-line-gap, 0.4em); }
.aether-host .md-item-line + .md-line, .aether-host .md-line + .md-item-line, .aether-host .md-item-line + .md-item-line { margin-top: var(--md-item-gap, 0.25em); }
.aether-host .md-quote-line + .md-line, .aether-host .md-line + .md-quote-line, .aether-host .md-quote-line + .md-quote-line { margin-top: var(--md-item-gap, 0.25em); }
.aether-host .md-line.md-hr { margin: 1em 0; }
.aether-host .md-line.md-hr:not(.md-active) { border: none; border-top: 1px solid var(--md-hr, #d0d7de); }
.aether-host .md-line.md-gap-short { margin-top: var(--md-br-hard-gap, 0) !important; }
.aether-host .md-h1, .aether-host .md-h2, .aether-host .md-h3, .aether-host .md-h4, .aether-host .md-h5, .aether-host .md-h6 { font-weight: var(--md-heading-weight, 600); line-height: 1.3; margin-top: 1em; }
.aether-host .md-h1 { font-size: 1.7em; }
.aether-host .md-h2 { font-size: 1.4em; }
.aether-host .md-h3 { font-size: 1.2em; }
.aether-host .md-h4 { font-size: 1.05em; }
.aether-host .md-h5 { font-size: 0.9em; }
.aether-host .md-h6 { font-size: 0.85em; color: var(--md-text-secondary, #656d76); }
.aether-host .md-surface > :first-child { margin-top: 0; }
.aether-host .md-item-line { min-height: 1em; }
.aether-host .md-bullet, .aether-host .md-num { margin-right: 0.45em; color: var(--md-text, #1f2328); }
.aether-host .md-num { font-variant-numeric: tabular-nums; }
.aether-host .md-checkbox { margin: 0 0.45em 0 0; accent-color: var(--md-checkbox, #0969da); pointer-events: none; }
.aether-host .md-quote-line { color: var(--md-quote-text, #656d76); }
.aether-host .md-quote-line + .md-quote-line { margin-top: 0; }
.aether-host .md-qmark { position: absolute; top: 0; }
.aether-host .md-blank { min-height: 1.2em; }
.aether-host .md-pre, .aether-host .md-code { font-family: var(--md-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: var(--md-code-font-size, 0.9em); background: var(--md-pre-bg, #f6f8fa); border: 1px solid var(--md-border, #d0d7de); border-radius: 6px; padding: 0.75em 1em; }
.aether-host .md-pre { position: relative; overflow-x: auto; white-space: pre; margin-top: var(--md-line-gap, 0.4em); }
.aether-host .md-pre[data-lang]::before { content: attr(data-lang); position: absolute; top: 0.3em; right: 0.6em; font-size: 0.75em; color: var(--md-text-secondary, #656d76); }
.aether-host .md-code { padding: 0.15em 0.35em; }
.aether-host .md-table { margin-top: var(--md-line-gap, 0.4em); overflow-x: auto; }
.aether-host .md-table-el { border-collapse: collapse; width: 100%; }
.aether-host .md-td { border: 1px solid var(--md-border, #d0d7de); padding: 0.3em 0.65em; vertical-align: top; }
.aether-host .md-active { position: relative; white-space: pre-wrap; min-height: 1.2em; }
.aether-host .md-marker { color: var(--md-marker, #6e7781); }
.aether-host .md-indent { display: inline-block; width: 0; height: 0; overflow: hidden; white-space: pre; }
.aether-host .md-pre.md-active[data-lang]::before { display: none; }
.aether-host .md-link { color: var(--md-link, #0969da); text-decoration: none; cursor: pointer; }
.aether-host .md-link:hover { text-decoration: underline; }
.aether-host .md-del { opacity: 0.75; }
.aether-host .md-img { max-width: 100%; height: auto; max-height: var(--md-img-max-height, 75vh); cursor: zoom-in; }
`;
