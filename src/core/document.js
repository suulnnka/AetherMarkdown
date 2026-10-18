// 文档模型（D34 行块模型）：源文本为唯一数据事实。
//
// 单元 = 一个行块（parseLines 产出，扁平结构，无容器嵌套）：
//  - 无虚拟空段——空行是真实的 blank 单元，点击即可输入
//  - 行与行互不影响：无跨行合并、无列表分组、无编号联动
//
// 结构操作均为源文本变换，返回新光标源偏移。

import { parseLines } from '../parse/lines.js';

let UID = 1;

export class Document {
  constructor(source) {
    this.source = source;
    this.units = [];
    this.rebuild();
  }

  rebuild() {
    const fresh = parseLines(this.source);

    // id 对齐：内容键优先，range[0] 兜底（编辑中的行保持 id，供 DOM 复用）
    const byKey = new Map();
    for (const old of this.units) {
      if (old.id == null) continue;
      const key = old.kind + '\x00' + this.source.slice(old.range[0], old.range[1]);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(old.id);
    }
    const used = new Set();
    for (const u of fresh) {
      const pool = byKey.get(u.kind + '\x00' + this.source.slice(u.range[0], u.range[1]));
      if (pool) {
        while (pool.length && used.has(pool[0])) pool.shift();
        if (pool.length) {
          u.id = pool.shift();
          used.add(u.id);
        }
      }
    }
    const byStart = new Map();
    for (const old of this.units) {
      if (old.id != null && !used.has(old.id)) byStart.set(old.range[0], old.id);
    }
    for (const u of fresh) {
      if (u.id != null) continue;
      const id = byStart.get(u.range[0]);
      if (id != null && !used.has(id)) {
        u.id = id;
        used.add(id);
      } else {
        u.id = UID++;
      }
    }
    this.units = fresh;
  }

  signature(activeId) {
    return this.units.map((u) => (u.id === activeId ? '#' : `${u.id}:${u.kind}:${u.range.join('-')}`)).join('|');
  }

  unitById(id) {
    return this.units.find((u) => u.id === id) || null;
  }

  editableAt(srcOff) {
    for (const u of this.units) {
      if (u.range[0] <= srcOff && srcOff <= u.range[1]) return u;
    }
    return null;
  }

  splice(start, end, text) {
    this.source = this.source.slice(0, start) + text + this.source.slice(end);
  }

  // ---- 结构操作（返回新光标偏移）----

  // 行首退格：剥一层语法（标题→文字行、列表项降级/转文字行、引用降一层）
  stripLayer(u) {
    const slice = this.source.slice(u.range[0], u.range[1]);
    let stripped = null;
    if (u.kind === 'heading') {
      stripped = slice.replace(/^ {0,3}#{1,6}[ \t]?/, '');
    } else if (u.kind === 'item') {
      stripped = u.indent >= 2
        ? slice.replace(/^ {1,2}/, '')
        : slice.replace(/^ {0,3}(?:-|\d{1,9}[.)])(?: \[[ xX]\])?[ \t]?/, '');
    } else if (u.kind === 'quote') {
      stripped = slice.replace(/^ {0,3}> ?/, '');
    } else if (u.kind === 'hr') {
      // 分隔符可编辑（D38）：行首退格删一个标记字符，少于 3 个即成普通行
      stripped = slice.slice(1);
    }
    if (stripped == null || stripped === slice) return null;
    this.splice(u.range[0], u.range[1], stripped);
    return u.range[0];
  }

  // 与上一行合并：删除行边界（并清上一行行尾硬换行空格）。
  // 上一行是分隔符时不合并——退格删其末尾一个标记字符（--- → --，即成普通行）
  joinPrev(u) {
    const idx = this.units.indexOf(u);
    const prev = idx > 0 ? this.units[idx - 1] : null;
    if (!prev) return null;
    if (prev.kind === 'hr') {
      const s = prev.range[1] - 1;
      this.splice(s, prev.range[1], '');
      return s;
    }
    let s = prev.range[1];
    while (s > prev.range[0] && this.source[s - 1] === ' ') s--;
    this.splice(s, u.range[0], '');
    return s;
  }

  // 与下一行合并（行尾 Delete）：行直接拼接，无分隔符。
  // 自己是分隔符时删自身末尾一个标记字符；下一行是分隔符时删其行首一个字符
  joinNext(u) {
    if (u.kind === 'hr') {
      const e = u.range[1] - 1;
      this.splice(e, u.range[1], '');
      return e;
    }
    const idx = this.units.indexOf(u);
    const next = idx >= 0 && idx + 1 < this.units.length ? this.units[idx + 1] : null;
    if (!next) return null;
    if (next.kind === 'hr') {
      this.splice(next.range[0], next.range[0] + 1, '');
      return u.range[1];
    }
    let e = u.range[1];
    while (e > u.range[0] && this.source[e - 1] === ' ') e--;
    this.splice(e, next.range[0], '');
    return e;
  }

  // 列表项整行缩进 ±2 空格
  indentItem(u, delta) {
    const slice = this.source.slice(u.range[0], u.range[1]);
    if (delta > 0) {
      this.splice(u.range[0], u.range[1], '  ' + slice);
      return u.range[0] + 2;
    }
    const s = slice.replace(/^ {1,2}/, '');
    this.splice(u.range[0], u.range[1], s);
    return u.range[0];
  }

  deleteRange(start, end) {
    this.splice(start, end, '');
    return start;
  }
}
