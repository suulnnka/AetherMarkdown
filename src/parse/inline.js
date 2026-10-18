// 行内解析器：递归下降 + 简化强调配对（规范见 docs/markdown-syntax.md）
//
// 产出 token 树，所有 token 带 s/e（在传入 src 坐标系中的源偏移，e 不含），
// 供编辑层把渲染 DOM 的光标位置精确映射回源文本（render/dom.js + edit/selection.js）：
//   {t:'text',v,s,e} {t:'code',v,s,e} {t:'strong'|'em'|'del',c,s,e}
//   {t:'link',href,title,c,s,e} {t:'image',src,alt,title,s,e}
//   {t:'autolink',href,text,s,e}
//
// 输入恒为单行内容（D34 行块模型：每行独立成块，跨行结构不走行内解析），
// 故不处理换行（无 br/softbreak）。
//
// 与 CommonMark 的偏离：强调仅支持 `*`（`_` 一律字面）、无序列表仅支持 `-`；
// 强调采用"同长度标记成对即生效"的简化配对（`***x***` 解析为 em>strong）；
// 链接文本内的 `[` 不再嵌套链接。

import { ESCAPABLE } from './entities.js';

const WS = new Set([' ', '\t']);
const isWs = (c) => c === undefined || WS.has(c);

function countRun(src, i, ch) {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

function canOpenAt(src, i, L) {
  return !isWs(src[i + L]);
}

function canCloseAt(src, k, L) {
  return !isWs(src[k - 1]);
}

// 尝试在 i 处解析强调；成功返回 {node, next}，失败返回 null
function tryEmphasis(src, i, opts, base) {
  const ch = src[i];
  const run = countRun(src, i, ch);
  if (ch === '~' && run < 2) return null;

  const lens = ch === '~' ? [2] : run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1];
  for (const L of lens) {
    if (!canOpenAt(src, i, L)) continue;
    // 从 i+L 起找最早的等长闭合
    let k = i + L;
    while (k < src.length) {
      if (src[k] === ch) {
        const run2 = countRun(src, k, ch);
        // 空强调不允许（CommonMark 规则）：闭标记必须与开标记至少隔一个字符，
        // 否则单行 "**" 会被配成空 <em></em> 而整行消失
        if (k > i + L && run2 >= L && canCloseAt(src, k, L)) {
          const inner = parseInline(src.slice(i + L, k), opts, base + i + L);
          let node;
          if (ch === '~') node = { t: 'del', c: inner };
          else if (L === 3) node = { t: 'em', c: [{ t: 'strong', c: inner }] }; // ***x***
          else if (L === 2) node = { t: 'strong', c: inner };
          else node = { t: 'em', c: inner };
          node.s = base + i;
          node.e = base + k + L;
          return { node, next: k + L };
        }
        k += run2;
      } else {
        k++;
      }
    }
  }
  return null;
}

// 解析 [text](dest "title") / ![alt](dest "title")
// 返回 {node, next} 或 null（按字面文本处理）
function parseLink(src, i, opts, base) {
  const openLen = src[i] === '!' ? 2 : 1;
  if (openLen === 1 && opts.inLink) return null; // 链接不嵌套链接

  // 找配对的 ]（处理括号嵌套与转义）
  let depth = 0;
  let j = i + openLen;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { if (depth === 0) break; depth--; }
  }
  if (j >= src.length) return null;
  const text = src.slice(i + openLen, j);
  if (src[j + 1] !== '(') return null;

  // 目标地址
  let k = j + 2;
  while (src[k] === ' ' || src[k] === '\t') k++;
  let dest = '';
  if (src[k] === '<') {
    const e = src.indexOf('>', k + 1);
    if (e === -1) return null;
    if (/[\n<>]/.test(src.slice(k + 1, e))) return null;
    dest = src.slice(k + 1, e);
    k = e + 1;
  } else {
    const start = k;
    let pdepth = 0;
    for (; k < src.length; k++) {
      const ch = src[k];
      if (ch === '\\') { k++; continue; }
      if (ch === '(') { pdepth++; continue; }
      if (ch === ')') { if (pdepth === 0) break; pdepth--; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
    }
    dest = src.slice(start, k);
  }

  // 可选 title
  let title = null;
  while (src[k] === ' ' || src[k] === '\t') k++;
  if (src[k] === '"' || src[k] === "'") {
    const q = src[k];
    let e = k + 1;
    while (e < src.length && src[e] !== q) {
      if (src[e] === '\\') e++;
      e++;
    }
    if (e >= src.length) return null;
    title = src.slice(k + 1, e).replace(/\\(["'\\])/g, '$1');
    k = e + 1;
  }
  while (src[k] === ' ' || src[k] === '\t') k++;
  if (src[k] !== ')') return null;

  let node;
  if (openLen === 2) {
    node = { t: 'image', src: dest, alt: plainText(parseInline(text, { inLink: true }, base + i + 2)), title };
  } else {
    node = { t: 'link', href: dest, title, c: parseInline(text, { inLink: true }, base + i + 1) };
  }
  node.s = base + i;
  node.e = base + k + 1;
  return { node, next: k + 1 };
}

// 裸 URL 自动链接（简化 GFM）：https:// 或 www. 开头的独立词
function tryBareUrl(src, i) {
  const prev = src[i - 1];
  if (!(i === 0 || isWs(prev) || prev === '(' || prev === '<')) return null;
  const m = /^(?:https?:\/\/|www\.)[^\s<>]+/.exec(src.slice(i));
  if (!m) return null;
  let u = m[0].replace(/[.,;:!?'"]+$/, '');
  while (u.endsWith(')')) {
    const opens = (u.match(/\(/g) || []).length;
    const closes = (u.match(/\)/g) || []).length;
    if (closes > opens) u = u.slice(0, -1);
    else break;
  }
  if (u.length <= 'www.'.length && u.startsWith('www.')) return null;
  return { node: { t: 'autolink', href: u.startsWith('www.') ? 'http://' + u : u, text: u }, next: i + u.length };
}

export function parseInline(src, opts = {}, base = 0) {
  const out = [];
  let buf = '';
  let bufStart = -1;
  let bufEnd = 0; // 末字符的下一位置（源坐标；转义使文本长 ≠ 源跨度，故单独跟踪）
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf, s: base + bufStart, e: base + bufEnd });
      buf = '';
      bufStart = -1;
    }
  };
  const put = (ch, pos, end = pos + 1) => {
    if (!buf) bufStart = pos;
    buf += ch;
    bufEnd = end;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    // 反斜杠转义
    if (c === '\\' && i + 1 < n) {
      if (ESCAPABLE.has(src[i + 1])) { put(src[i + 1], i, i + 2); i += 2; continue; }
    }

    // 行内代码：等长反引号配对
    if (c === '`') {
      const run = countRun(src, i, '`');
      let k = i + run;
      let close = -1;
      while (k < n) {
        if (src[k] === '`') {
          const run2 = countRun(src, k, '`');
          if (run2 === run) { close = k; break; }
          k += run2;
        } else {
          k++;
        }
      }
      if (close > -1) {
        let content = src.slice(i + run, close);
        if (
          content.length >= 2 &&
          content[0] === ' ' &&
          content[content.length - 1] === ' ' &&
          !/^[\s]+$/.test(content)
        ) {
          content = content.slice(1, -1);
        }
        flush();
        out.push({ t: 'code', v: content, s: base + i, e: base + close + run });
        i = close + run;
        continue;
      }
      for (let q = 0; q < run; q++) put('`', i + q); // 未闭合：字面
      i += run;
      continue;
    }

    // 尖括号自动链接（URI 或邮箱）
    if (c === '<') {
      const rest = src.slice(i);
      let m = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\n\t ]*>/.exec(rest);
      if (m) {
        const href = m[0].slice(1, -1);
        flush();
        out.push({ t: 'autolink', href, text: href, s: base + i, e: base + i + m[0].length });
        i += m[0].length;
        continue;
      }
      m = /^<([^<>\n\t ]+@[^<>\n\t ]+)>/.exec(rest);
      if (m) {
        flush();
        out.push({ t: 'autolink', href: 'mailto:' + m[1], text: m[1], s: base + i, e: base + i + m[0].length });
        i += m[0].length;
        continue;
      }
      put('<', i);
      i++;
      continue;
    }

    // 裸 URL
    if (c === 'h' || c === 'w' || c === 'H' || c === 'W') {
      const r = tryBareUrl(src, i);
      if (r) {
        flush();
        r.node.s = base + i;
        r.node.e = base + r.next;
        out.push(r.node);
        i = r.next;
        continue;
      }
    }

    // 图片 / 链接
    if (c === '!' && src[i + 1] === '[') {
      const r = parseLink(src, i, opts, base);
      if (r) { flush(); out.push(r.node); i = r.next; continue; }
      put('!', i);
      i++;
      continue;
    }
    if (c === '[') {
      const r = parseLink(src, i, opts, base);
      if (r) { flush(); out.push(r.node); i = r.next; continue; }
      put('[', i);
      i++;
      continue;
    }

    // 强调 / 删除线
    if (c === '*' || c === '~') {
      const r = tryEmphasis(src, i, opts, base);
      if (r) { flush(); out.push(r.node); i = r.next; continue; }
      const run = countRun(src, i, c);
      for (let q = 0; q < run; q++) put(c, i + q);
      i += run;
      continue;
    }

    put(c, i);
    i++;
  }
  flush();
  return out;
}

// token 树 → 纯文本（用于图片 alt 等）
export function plainText(tokens) {
  let s = '';
  for (const tk of tokens) {
    if (tk.t === 'text' || tk.t === 'code') s += tk.v;
    else if (tk.t === 'autolink') s += tk.text;
    else if (tk.t === 'image') s += tk.alt;
    else if (tk.c) s += plainText(tk.c); // strong/em/del/link
  }
  return s;
}
