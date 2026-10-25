// 选区与光标工具（M2）：DOM ↔ 源偏移 双向映射
//
// 活动单元是纯文本节点（源码态），偏移即文本偏移；
// 渲染态单元用文本节点的 __src（内容坐标）+ 单元 lineMap（内容坐标 ↔ 源偏移）换算。

// 元素内纯文本（编辑态源码流）。
// <br> 不计入：contenteditable 空块/行尾会由浏览器塞 placeholder <br>（Firefox
// 尤甚），它不是源码内容；多行单元的换行以文本节点里的 \n 表达（pre-wrap）。
export function extractText(elm) {
  let s = '';
  const rec = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) s += c.data;
      else if (c.tagName !== 'BR') rec(c);
    }
  };
  rec(elm);
  return s;
}

// (node, offset) 在容器内的字符偏移（与 extractText 同一坐标,<br> 同样不计入:
// 它是占位/浏览器塞入的行框,不是源码内容）。
// node 可能位于任意深度的子树（如标记 span 内的文本节点），需下钻匹配。
export function charOffsetIn(elm, node, offset) {
  let s = 0;
  let found = false;
  const len = (n) =>
    n.nodeType === Node.TEXT_NODE ? n.data.length : n.tagName === 'BR' ? 0 : extractText(n).length;
  const rec = (n) => {
    if (found) return;
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) {
        s += offset;
      } else {
        // 元素偏移：统计前 offset 个子树的文本长度
        for (let i = 0; i < offset && i < n.childNodes.length; i++) s += len(n.childNodes[i]);
      }
      found = true;
      return;
    }
    for (const c of n.childNodes) {
      if (found) return;
      if (c === node || (c.nodeType === Node.ELEMENT_NODE && c.contains(node))) {
        rec(c);
        return;
      }
      s += len(c);
    }
  };
  rec(elm);
  return s;
}

// 容器内第 charOff 个字符处放置折叠光标
export function setCollapsed(elm, charOff) {
  const sel = window.getSelection();
  if (!sel) return false;
  let remaining = charOff;
  let target = null;
  let targetOff = 0;
  const rec = (n) => {
    if (target) return;
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        if (remaining <= c.data.length) {
          target = c;
          targetOff = remaining;
          return;
        }
        remaining -= c.data.length;
      } else if (c.tagName === 'BR') {
        if (remaining <= 1) {
          target = c.parentNode;
          targetOff = Array.prototype.indexOf.call(c.parentNode.childNodes, c) + (remaining === 1 ? 1 : 0);
          return;
        }
        remaining -= 1;
      } else {
        rec(c);
        if (target) return;
      }
    }
  };
  rec(elm);
  const range = document.createRange();
  if (!target) {
    // 超出末尾：放到最后一个文本位置
    range.selectNodeContents(elm);
    range.collapse(false);
  } else if (target.nodeType === Node.TEXT_NODE) {
    range.setStart(target, targetOff);
    range.collapse(true);
  } else {
    range.setStart(target, Math.min(targetOff, target.childNodes.length));
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

// 渲染态节点 (node, offset) → 内容坐标偏移（借 __src；元素偏移就近取文本节点）
export function domToContentOff(node, offset) {
  if (node.nodeType === Node.TEXT_NODE && node.__src) {
    return Math.min(node.__src[0] + offset, node.__src[1]);
  }
  if (node.nodeType === Node.TEXT_NODE) return null;
  // 元素：取第 offset 个子树之前/之内的最近映射（文本节点或带 __src 的图片）
  const kids = node.childNodes;
  if (offset > 0 && kids[offset - 1]) {
    const last = deepestSrc(kids[offset - 1], true);
    if (last != null) return last;
  }
  const first = kids[offset] ? deepestSrc(kids[offset], false) : deepestSrc(node, false);
  if (first != null) return first;
  return null;
}

// 子树中最近的 __src 映射（文本节点或图片）；fromEnd 取最末
function deepestSrc(n, fromEnd) {
  if (n.nodeType === Node.TEXT_NODE) return n.__src ? (fromEnd ? n.__src[1] : n.__src[0]) : null;
  if (n.tagName === 'IMG') return n.__src ? (fromEnd ? n.__src[1] : n.__src[0]) : null;
  const kids = fromEnd ? [...n.childNodes].reverse() : [...n.childNodes];
  for (const c of kids) {
    const r = deepestSrc(c, fromEnd);
    if (r != null) return r;
  }
  return null;
}

// 内容坐标偏移 → 源偏移（多行单元按 lineMap 换算；单行单元从 textStart 起算，
// 内容坐标不含标记前缀）
export function contentToSrc(unit, contentOff) {
  if (!unit.lines) {
    const base = unit.textStart != null ? unit.textStart : unit.range ? unit.range[0] : 0;
    return Math.min(base + contentOff, unit.range ? unit.range[1] : base + contentOff);
  }
  let acc = 0;
  for (const l of unit.lines) {
    const len = l.text.length;
    if (contentOff <= acc + len) return l.textStart + (contentOff - acc);
    acc += len + 1;
  }
  const last = unit.lines[unit.lines.length - 1];
  return last ? last.textStart + last.text.length : unit.range[1];
}
