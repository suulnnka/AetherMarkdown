// 行内解析器：扫描分段 + 强调定界符栈（规范见 docs/markdown-syntax.md）
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
// 强调配对采用简化定界符栈（左右 flanking 仅看紧邻字符是否空白），
// 支持一层嵌套与共享闭合（`***x***` → em>strong，`**bold *em***` → strong>em）；
// 链接文本内的 `[` 不再嵌套链接。

import { ESCAPABLE } from './entities.js';

const WS = new Set([' ', '\t']);
const isWs = (c) => c === undefined || WS.has(c);

function countRun(src, i, ch) {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
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

// 定界符栈：把 flat 分段里的 * / ~ 定界符配成 em/strong/del
// 配对规则（简化）：从左到右扫闭合，取最近的、能配上的同字符开标记；
// 每次吃 min(开, 闭, 2) 个字符（2 → strong/del，1 → em）；
// 共享闭合（`***x***` 的 *** = em 闭 + strong 闭）通过剩余计数继续配对完成。
function resolveEmphasis(items) {
  let list = items;
  let i = 0;
  while (i < list.length) {
    const c = list[i];
    if (c.t !== 'delim' || !c.canClose || c.count <= 0) {
      i++;
      continue;
    }
    const isDel = c.ch === '~';
    let oi = -1;
    for (let j = i - 1; j >= 0; j--) {
      const d = list[j];
      if (d.t !== 'delim' || d.ch !== c.ch || !d.canOpen || d.count <= 0) continue;
      if (isDel && (d.count < 2 || c.count < 2)) continue;
      // 空强调不成立（CommonMark）：开闭紧邻无内容则跳过，继续找更远的开标记
      if (j + 1 === i) continue;
      oi = j;
      break;
    }
    if (oi === -1) {
      i++;
      continue;
    }
    const o = list[oi];
    const use = isDel ? 2 : Math.min(o.count, c.count, 2);
    const type = isDel ? 'del' : use === 2 ? 'strong' : 'em';
    // 开标记吃内侧 use 个字符，闭标记吃内侧 use 个字符
    const nodeS = o.s + o.count - use;
    const nodeE = c.s + use;
    const children = list.slice(oi + 1, i);
    const node = { t: type, c: children, s: nodeS, e: nodeE };
    const before = list.slice(0, oi);
    const after = list.slice(i + 1);
    o.count -= use;
    c.count -= use;
    c.s += use;
    const mid = [];
    if (o.count > 0) mid.push(o);
    mid.push(node);
    if (c.count > 0) mid.push(c);
    list = before.concat(mid, after);
    // 闭标记仍有剩余则停在它上面继续吃；否则从节点之后继续
    i = c.count > 0 ? before.length + mid.length - 1 : before.length + mid.length;
  }

  // 剩余定界符字面化，并合并相邻文本
  return finalizeChildren(list);
}

function finalizeChildren(children) {
  const out = [];
  for (const it of children) {
    if (it.t === 'delim') {
      pushText(out, it.ch.repeat(it.count), it.s, it.e);
    } else if (it.c) {
      it.c = finalizeChildren(it.c);
      pushNode(out, it);
    } else if (it.t === 'text') {
      pushText(out, it.v, it.s, it.e);
    } else {
      pushNode(out, it);
    }
  }
  return out;
}

function pushText(out, v, s, e) {
  const last = out[out.length - 1];
  if (last && last.t === 'text' && last.e === s) {
    last.v += v;
    last.e = e;
    return;
  }
  out.push({ t: 'text', v, s, e });
}

function pushNode(out, n) {
  out.push(n);
}

export function parseInline(src, opts = {}, base = 0) {
  const items = [];
  const n = src.length;

  const put = (ch, pos, end = pos + 1) => {
    pushText(items, ch, base + pos, base + end);
  };

  let i = 0;
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
        items.push({ t: 'code', v: content, s: base + i, e: base + close + run });
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
        items.push({ t: 'autolink', href, text: href, s: base + i, e: base + i + m[0].length });
        i += m[0].length;
        continue;
      }
      m = /^<([^<>\n\t ]+@[^<>\n\t ]+)>/.exec(rest);
      if (m) {
        items.push({ t: 'autolink', href: 'mailto:' + m[1], text: m[1], s: base + i, e: base + i + m[0].length });
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
        r.node.s = base + i;
        r.node.e = base + r.next;
        items.push(r.node);
        i = r.next;
        continue;
      }
    }

    // 图片 / 链接
    if (c === '!' && src[i + 1] === '[') {
      const r = parseLink(src, i, opts, base);
      if (r) { items.push(r.node); i = r.next; continue; }
      put('!', i);
      i++;
      continue;
    }
    if (c === '[') {
      const r = parseLink(src, i, opts, base);
      if (r) { items.push(r.node); i = r.next; continue; }
      put('[', i);
      i++;
      continue;
    }

    // 强调 / 删除线定界符
    if (c === '*' || c === '~') {
      const run = countRun(src, i, c);
      if (c === '~' && run < 2) {
        put('~', i, i + run);
        i += run;
        continue;
      }
      items.push({
        t: 'delim',
        ch: c,
        count: run,
        s: base + i,
        e: base + i + run,
        canOpen: !isWs(src[i + run]),
        canClose: !isWs(src[i - 1]),
      });
      i += run;
      continue;
    }

    put(c, i);
    i++;
  }
  return resolveEmphasis(items);
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
