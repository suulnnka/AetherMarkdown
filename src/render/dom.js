// 渲染层（D34 行块模型）：每个行块渲染为 surface 的直接子元素（扁平结构）。
//
// 起始显示位置 = surface 内容左缘。所有行块（标记 + 正文）一律从此处向右排列，
// 嵌套缩进以 marginLeft 叠加；没有任何元素悬挂到起始位置左侧。
// 渲染态：主语法转为视觉元素——列表行行首显示项目符号/自身编号/复选框（行内、后接正文），
//         引用行画层级竖线（`>>` 深一层，正文随层数右移），标题/文字/空行/分割线各自独立，
//         代码块与表格是仅有的两个跨行结构（表格渲染 <table>，单元格仅行内样式）。
// 编辑态：显示整行源码，标记前缀（含前导缩进空格，## / - / 1. / > 等）以 md-marker
//         弱化并排于行首，空格按源码字面占位（pre-wrap），不做缩进加工（D39）。
//         引用编辑态不画竖线（> 标记即层级指示），仅保留缩进。
//         DOM 纯文本与源切片逐字节一致（幂等同步前提）。
// 文本节点携带 __src（内容坐标），是渲染态光标 → 源偏移映射的依据。

import { parseInline } from '../parse/inline.js';
import { parseTableRow } from '../parse/lines.js';
import { sanitizeUrl } from '../parse/entities.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const textNode = (v, s, e2) => {
  const tn = document.createTextNode(v);
  tn.__src = [s, e2];
  return tn;
};

// base：token 坐标系在单元内容坐标中的偏移（表格单元格等内容不从 0 起时用于 __src）
function inlineDom(tokens, parent, base = 0) {
  for (const tk of tokens) {
    switch (tk.t) {
      case 'text':
        parent.append(textNode(tk.v, base + tk.s, base + tk.e));
        break;
      case 'code': {
        const c = el('code', 'md-code');
        c.append(textNode(tk.v, base + tk.s, base + tk.e));
        parent.append(c);
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const tag = { strong: 'strong', em: 'em', del: 'del' }[tk.t];
        const c = el(tag, 'md-' + tk.t);
        inlineDom(tk.c, c, base);
        parent.append(c);
        break;
      }
      case 'autolink': {
        const href = sanitizeUrl(tk.href);
        if (href) {
          const a = el('a', 'md-link md-autolink');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.append(textNode(tk.text, base + tk.s, base + tk.e));
          parent.append(a);
        } else {
          parent.append(textNode(tk.text, base + tk.s, base + tk.e));
        }
        break;
      }
      case 'link': {
        const href = sanitizeUrl(tk.href);
        if (href) {
          const a = el('a', 'md-link');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          if (tk.title) a.title = tk.title;
          inlineDom(tk.c, a, base);
          parent.append(a);
        } else {
          inlineDom(tk.c, parent, base);
        }
        break;
      }
      case 'image': {
        const src = sanitizeUrl(tk.src, { image: true });
        if (src) {
          const img = el('img', 'md-img');
          img.src = src;
          img.alt = tk.alt;
          if (tk.title) img.title = tk.title;
          img.__src = [base + tk.s, base + tk.e];
          parent.append(img);
        } else {
          parent.append(textNode(tk.alt, base + tk.s, base + tk.e));
        }
        break;
      }
    }
  }
}

// ---------- 编辑态 ----------

function markerSpan(text, extraCls) {
  const sp = el('span', extraCls ? 'md-marker ' + extraCls : 'md-marker');
  sp.textContent = text;
  return sp;
}

// 行内 token：内容正常渲染，嵌套标记（如 ***x*** 的收尾 *）弱化
function editToken(tk, sliceBase, slice, into) {
  const piece = slice.slice(sliceBase + tk.s, sliceBase + tk.e);
  // sliceBase 此处恒为 0（切片即内容），保留参数以兼容既有调用
  switch (tk.t) {
    case 'text':
      into.append(document.createTextNode(piece));
      break;
    case 'code': {
      const c = el('code', 'md-code');
      c.textContent = piece;
      into.append(c);
      break;
    }
    case 'strong':
    case 'em':
    case 'del':
    case 'link': {
      const tag = { strong: 'strong', em: 'em', del: 'del', link: 'span' }[tk.t];
      const c = el(tag, tk.t === 'link' ? 'md-link md-link-edit' : 'md-' + tk.t);
      // 编辑态链接携带原始 href：点击 URL 尾部 / Cmd+Ctrl 点击时打开（surface.js）
      if (tk.t === 'link' && tk.href) c.dataset.href = tk.href;
      let cur = tk.s;
      for (const child of tk.c) {
        if (child.s > cur) c.append(markerSpan(slice.slice(sliceBase + cur, sliceBase + child.s)));
        editToken(child, sliceBase, slice, c);
        cur = child.e;
      }
      if (tk.e > cur) c.append(markerSpan(slice.slice(sliceBase + cur, sliceBase + tk.e)));
      into.append(c);
      break;
    }
    case 'image': {
      // 行内显示：![ 与 ](url) 弱化，alt 正常（不悬浮、不整体偏移）
      const idx = piece.indexOf('](', 2);
      if (idx > 0) {
        into.append(markerSpan(piece.slice(0, 2)));
        into.append(document.createTextNode(piece.slice(2, idx)));
        into.append(markerSpan(piece.slice(idx)));
      } else {
        into.append(markerSpan(piece));
      }
      break;
    }
    case 'autolink':
      into.append(markerSpan(piece));
      break;
  }
}

// 单行块的编辑态内容：前缀（含前导空格，pre-wrap 下按源码字面占位）弱化 + 行内 token + 行尾弱化
function editLineContent(u, doc, parent) {
  const slice = doc.source.slice(u.range[0], u.range[1]);
  const prefixLen = u.textStart - u.range[0];
  if (prefixLen > 0) parent.append(markerSpan(slice.slice(0, prefixLen), 'md-prefix'));
  appendInlineEdit(u, slice.slice(prefixLen), prefixLen, parent);
}

// 行内 token 编辑态（sliceBase：内容在整行切片中的偏移）
function appendInlineEdit(u, content, sliceBase, parent) {
  const tokens = parseInline(content);
  const slice = content;
  let cur = 0;
  for (const t of tokens) {
    if (t.s > cur) parent.append(markerSpan(slice.slice(cur, t.s)));
    editToken(t, 0, slice, parent);
    cur = t.e;
  }
  if (slice.length > cur) parent.append(markerSpan(slice.slice(cur)));
}

// 代码块编辑态：围栏行弱化 + 内容原样
function editCodeContent(u, doc, parent) {
  const slice = doc.source.slice(u.range[0], u.range[1]);
  let cursor = 0;
  for (let i = 0; i < u.lines.length; i++) {
    const l = u.lines[i];
    const textStart = l.textStart - u.range[0];
    if (textStart > cursor) parent.append(markerSpan(slice.slice(cursor, textStart)));
    parent.append(document.createTextNode(slice.slice(textStart, textStart + l.text.length)));
    cursor = textStart + l.text.length;
  }
  if (slice.length > cursor) parent.append(markerSpan(slice.slice(cursor)));
}

// 表格编辑态：pipe 与单元格边界空白弱化，单元格内容按行内 token 渲染（保持排版）；
// 分隔行整行弱化。行间换行符保留在文本流中（与代码块一致）。
function editTableContent(u, doc, parent) {
  const slice = doc.source.slice(u.range[0], u.range[1]);
  let cursor = 0;
  for (const l of u.lines) {
    const textStart = l.textStart - u.range[0];
    if (textStart > cursor) parent.append(document.createTextNode(slice.slice(cursor, textStart)));
    const row = parseTableRow(l.text);
    if (row.sep) {
      parent.append(markerSpan(l.text));
    } else {
      let cur = 0;
      for (const c of row.cells) {
        if (c.s > cur) parent.append(markerSpan(l.text.slice(cur, c.s)));
        appendInlineEdit(u, l.text.slice(c.s, c.e), 0, parent);
        cur = c.e;
      }
      if (l.text.length > cur) parent.append(markerSpan(l.text.slice(cur)));
    }
    cursor = textStart + l.text.length;
  }
  if (slice.length > cursor) parent.append(markerSpan(slice.slice(cursor)));
}

function activeTagCls(u) {
  switch (u.kind) {
    case 'heading': return { tag: 'h' + u.level, cls: 'md-h' + u.level };
    case 'item': return { tag: 'div', cls: 'md-item-line' };
    case 'quote': return { tag: 'div', cls: 'md-quote-line' };
    case 'code': return { tag: 'pre', cls: 'md-pre' };
    case 'table': return { tag: 'div', cls: 'md-table' };
    case 'hr': return { tag: 'p', cls: 'md-hr' }; // 编辑态显示 --- 源码（保 1em 间距，不画线）
    default: return { tag: 'p', cls: 'md-p' }; // text / blank
  }
}

// 渲染态引用行竖线：按层级在 0、1em、2em… 处各画一条（background 分层），
// 内容缩进 = 层级数 × 1em；相邻引用行间距归零使竖线连续（编辑态不画线，见 buildActiveElement）
function applyQuoteBars(e, depth) {
  const bar = 'linear-gradient(90deg, var(--md-quote-border, #d0d7de) 0 3px, transparent 3px)';
  e.style.backgroundImage = Array.from({ length: depth }, () => bar).join(', ');
  e.style.backgroundSize = Array.from({ length: depth }, () => '1em 100%').join(', ');
  e.style.backgroundPosition = Array.from({ length: depth }, (_, i) => `${i}em 0`).join(', ');
  e.style.backgroundRepeat = Array.from({ length: depth }, () => 'no-repeat').join(', ');
  e.style.paddingLeft = depth + 'em';
}

// 编辑态引用前缀：编辑态不画竖线（> 标记即层级指示，竖线会压住行首字符），
// 每个 > 定位到对应层级起点（i × 1em，其余字符并入前一个标记，保持字节一致）
function quoteEditPrefix(prefix, parent) {
  let barIndex = -1;
  let span = null;
  for (const ch of prefix) {
    if (ch === '>') {
      barIndex++;
      span = el('span', 'md-marker md-qmark');
      span.textContent = ch;
      span.style.left = `${barIndex}em`;
      parent.append(span);
    } else if (span) {
      span.textContent += ch;
    } else {
      span = el('span', 'md-marker md-qmark');
      span.style.left = '0';
      span.textContent = ch;
      parent.append(span);
    }
  }
}

export function buildActiveElement(u, doc) {
  const { tag, cls } = activeTagCls(u);
  // 空行编辑态保留 md-blank（min-height），避免空块高度塌陷把邻行拉上来
  const e = el(tag, cls + ' md-line md-active' + (u.kind === 'blank' ? ' md-blank' : ''));
  e.dataset.id = u.id;
  if (u.kind === 'code') editCodeContent(u, doc, e);
  else if (u.kind === 'table') editTableContent(u, doc, e);
  else if (u.kind === 'quote') {
    // 编辑态不画竖线，只保留与渲染态一致的缩进（文字起点 = 层级数 × 1em）
    e.style.paddingLeft = u.qdepth + 'em';
    const prefix = doc.source.slice(u.range[0], u.textStart);
    const rest = doc.source.slice(u.textStart, u.range[1]);
    quoteEditPrefix(prefix, e);
    appendInlineEdit(u, rest, u.textStart - u.range[0], e);
  }
  else editLineContent(u, doc, e);
  // 渲染态嵌套缩进由 marginLeft 表达；编辑态不做缩进加工，前导空格按源码字面显示
  return e;
}

// 列表行缩进（em）：每 2 个前导空格一级
function itemIndent(u) {
  return Math.floor(u.indent / 2) * 1.6;
}

// ---------- 渲染态 ----------

function renderedBlock(u, doc) {
  switch (u.kind) {
    case 'heading': {
      const e = el('h' + u.level, 'md-h' + u.level + ' md-line' + (u.text ? '' : ' md-blank'));
      e.dataset.id = u.id;
      inlineDom(parseInline(u.text), e);
      return e;
    }
    case 'hr': {
      // 渲染态是 <hr> 无文本，点击激活需 data-id（编辑态见 activeTagCls）
      const e = el('hr', 'md-hr md-line');
      e.dataset.id = u.id;
      return e;
    }
    case 'blank': {
      const e = el('p', 'md-p md-blank md-line');
      e.dataset.id = u.id;
      return e;
    }
    case 'item': {
      const e = el('div', 'md-item-line md-line' + (u.task ? ' md-task' : ''));
      e.dataset.id = u.id;
      e.style.marginLeft = itemIndent(u) + 'em';
      if (u.task) {
        const box = el('input', 'md-checkbox');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = u.checked;
        e.append(box); // 行内排在行首（起始位置处）
      } else {
        e.append(el('span', u.ordered ? 'md-num' : 'md-bullet', u.ordered ? u.markerText : '•'));
      }
      inlineDom(parseInline(u.text), e);
      return e;
    }
    case 'quote': {
      const e = el('div', 'md-quote-line md-line');
      e.dataset.id = u.id;
      applyQuoteBars(e, u.qdepth);
      inlineDom(parseInline(u.text), e);
      return e;
    }
    case 'code': {
      const e = el('pre', 'md-pre md-line');
      e.dataset.id = u.id;
      if (u.info) e.dataset.lang = u.info;
      const c = el('code', 'md-code-block');
      c.append(textNode(u.text, 0, u.text.length));
      e.append(c);
      return e;
    }
    case 'table': {
      // 单元格 __src = 单元内容坐标（acc + 行内偏移），contentToSrc 按 lines 换算回源；
      // 分隔行不产出 <tr>（表格不区分表头，所有内容行同等渲染）
      const e = el('div', 'md-table md-line');
      e.dataset.id = u.id;
      const tb = el('tbody');
      let acc = 0;
      for (const l of u.lines) {
        const row = parseTableRow(l.text);
        if (!row.sep) {
          const tr = el('tr', 'md-tr');
          for (const c of row.cells) {
            const td = el('td', 'md-td');
            inlineDom(parseInline(c.text), td, acc + c.s);
            tr.append(td);
          }
          tb.append(tr);
        }
        acc += l.text.length + 1;
      }
      const t = el('table', 'md-table-el');
      t.append(tb);
      e.append(t);
      return e;
    }
    default: {
      const e = el('p', 'md-p md-line');
      e.dataset.id = u.id;
      inlineDom(parseInline(u.text), e);
      return e;
    }
  }
}

export function renderDoc(surface, doc, activeId) {
  surface.replaceChildren();
  let prevHard = false; // 上一行是否以硬换行（两空格）结尾 → 本行短间距
  for (const u of doc.units) {
    const e = u.id === activeId ? buildActiveElement(u, doc) : renderedBlock(u, doc);
    if (prevHard) e.classList.add('md-gap-short');
    surface.append(e);
    prevHard = u.kind !== 'code' && / {2}$/.test(doc.source.slice(u.range[0], u.range[1]));
  }
}
