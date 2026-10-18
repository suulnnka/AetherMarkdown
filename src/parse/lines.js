// 行块解析器（D34 行块模型）：**每一行独立成块，行与行互不影响**。
//
// 块种类（kind）：
//   text    普通文字行        blank  空行（真实的空块，可点击输入）
//   heading `#`~`######` 行   hr     `---` 等分割线行
//   item    `-`/`*`/`+`/`1.` 行（含任务 `- [ ]`，缩进决定层级）
//   quote   `>` 行（`>>` 深一层）
//   code    围栏代码块（跨行结构：``` 到闭合栏；不支持 ~~~）
//   table   简单表格（跨行结构：连续的 `| A | B |` 行，无表头区分，单元格仅行内样式）
//
// 每行只应用一个主语法（引用/列表行内的 `#` 等按字面处理），
// 行内语法（粗体/链接等）仍按 inline.js 解析。
// 所有块带 range: [start, end)（不含行尾换行符）与 textStart（内容起点，
// 前缀 [range[0], textStart) 为缩进/标记，编辑态弱化显示）。

const FENCE_RE = /^ {0,3}(`{3,})(.*)$/;
const HR_RE = /^ {0,3}(-)(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const QUOTE_PREFIX_RE = /^ {0,3}(>+) ?/;
// 标记后必须真有空格（$ 不算）——否则键入 "-" 的瞬间就变成带圆点的列表项，
// 敲 "--"、"—" 时类型来回切换、间距跳动。无序仅支持 -（+ / * 不构成列表）
const MARKER_RE = /^ *(?:(-)|(\d{1,9})([.)]))[ \t]+/;
const TASK_RE = /^\[([ xX])][ \t]+/;

export function parseLines(src) {
  const lines = src.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const start = starts[i];
    const end = start + line.length;

    const fence = FENCE_RE.exec(line);
    if (fence && !fence[2].includes('`')) {
      const lead = /^ */.exec(line)[0].length; // 开栏行前导空格数（内容行剥同等缩进）
      const closeRe = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      const contentLines = [];
      const contentStarts = [];
      let j = i + 1;
      let closed = false;
      let blockEnd = end;
      for (; j < lines.length; j++) {
        const t = lines[j];
        if (closeRe.test(t)) {
          blockEnd = starts[j] + t.length;
          closed = true;
          break;
        }
        const ind = /^[ \t]*/.exec(t)[0].length;
        const strip = Math.min(ind, lead);
        contentLines.push(t.slice(strip));
        contentStarts.push(starts[j] + strip);
      }
      if (!closed) blockEnd = starts[lines.length - 1] + lines[lines.length - 1].length;
      blocks.push({
        kind: 'code',
        range: [start, blockEnd],
        text: contentLines.join('\n'),
        textStart: start,
        info: fence[2].trim(),
        fenceChar: fence[1][0],
        fenceLen: fence[1].length,
        lines: contentLines.map((t, k) => ({ start: contentStarts[k], textStart: contentStarts[k], text: t })),
      });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // 表格：连续的简单表格行合并为一个跨行单元（遇非表格行结束）。
    // 全部分隔行（无内容行）的"表格"没有任何可渲染行——会得到 0 高空表，
    // 不可见也不可点，该行彻底无法编辑；降级为普通文字行，
    // 补上内容行后自然重新聚合为表格（D35 修订）
    if (isTableRow(line)) {
      const rows = [];
      let j = i;
      for (; j < lines.length && isTableRow(lines[j]); j++) {
        rows.push({ start: starts[j], textStart: starts[j], text: lines[j] });
      }
      if (rows.some((r) => !parseTableRow(r.text).sep)) {
        const last = rows[rows.length - 1];
        blocks.push({
          kind: 'table',
          range: [start, last.start + last.text.length],
          textStart: start,
          lines: rows,
        });
      } else {
        for (const r of rows) blocks.push(parseOneLine(r.text, r.start, r.start + r.text.length));
      }
      i = j;
      continue;
    }

    blocks.push(parseOneLine(line, start, end));
    i++;
  }
  return blocks;
}

// 简单表格行（D35）：未转义 `|` 分割单元格，首尾 pipe 之外仅允许空白，
// 且至少 2 个未转义 pipe（即至少一个单元格）。`\|` 为字面竖线。
// 分隔行（所有单元格均为 --- / :-- / --: / :-: 形态）标记 sep=true，
// 渲染层跳过——表格不区分表头，所有内容行同等渲染。
const isTableRow = (line) => parseTableRow(line) != null;

export function parseTableRow(line) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') pipes.push(i);
  }
  if (pipes.length < 2) return null;
  if (line.slice(0, pipes[0]).trim() !== '' || line.slice(pipes[pipes.length - 1] + 1).trim() !== '') {
    return null;
  }
  const cells = [];
  for (let k = 0; k + 1 < pipes.length; k++) {
    const s = pipes[k] + 1;
    const e = pipes[k + 1];
    const raw = line.slice(s, e);
    const lead = /^[\t ]*/.exec(raw)[0].length;
    const tail = /[\t ]*$/.exec(raw)[0].length;
    cells.push({ s: s + lead, e: e - tail, text: raw.slice(lead, raw.length - tail) });
  }
  const sep = cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.text));
  return { cells, sep };
}

function parseOneLine(line, start, end) {
  if (line.trim() === '') {
    return { kind: 'blank', range: [start, end], text: '', textStart: start };
  }

  const hm = HEADING_RE.exec(line);
  if (hm) {
    const text = hm[2] || '';
    // hm[0] 锚定整行（含文本），文本起点需扣除文本长度
    return {
      kind: 'heading',
      range: [start, end],
      text,
      textStart: start + hm[0].length - text.length,
      level: hm[1].length,
    };
  }
  if (HR_RE.test(line)) {
    return { kind: 'hr', range: [start, end], text: '', textStart: start };
  }
  const qm = QUOTE_PREFIX_RE.exec(line);
  if (qm) {
    return {
      kind: 'quote',
      range: [start, end],
      text: line.slice(qm[0].length),
      textStart: start + qm[0].length,
      qdepth: qm[1].length,
    };
  }
  const mm = MARKER_RE.exec(line);
  if (mm) {
    const ordered = !!mm[2];
    const markerText = mm[1] || mm[2] + mm[3];
    let after = line.slice(mm[0].length);
    let task = false;
    let checked = false;
    if (!ordered) {
      const tm = TASK_RE.exec(after);
      if (tm) {
        task = true;
        checked = tm[1] !== ' ';
        after = after.slice(tm[0].length);
      }
    }
    return {
      kind: 'item',
      range: [start, end],
      text: after,
      textStart: start + (line.length - after.length),
      ordered,
      markerText,
      task,
      checked,
      indent: /^ */.exec(line)[0].length,
    };
  }

  const indent = /^ */.exec(line)[0].length;
  return { kind: 'text', range: [start, end], text: line.slice(indent), textStart: start + indent };
}
