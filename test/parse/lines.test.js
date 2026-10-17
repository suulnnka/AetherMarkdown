// 行块解析器测试（D34 行块模型）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, parseTableRow } from '../../src/index.js';

const kinds = (src) => parseLines(src).map((b) => b.kind);
const slice = (src, b) => src.slice(b.range[0], b.range[1]);

test('每行独立成块：普通行/空行', () => {
  assert.deepEqual(kinds('a\nb'), ['text', 'text']);
  assert.deepEqual(kinds('a\n\n\nb'), ['text', 'blank', 'blank', 'text']);
  const bs = parseLines('a\n\nb');
  assert.equal(slice('a\n\nb', bs[1]), '');
});

test('标题行', () => {
  for (let l = 1; l <= 6; l++) {
    const [b] = parseLines(`${'#'.repeat(l)} 标题`);
    assert.equal(b.kind, 'heading');
    assert.equal(b.level, l);
    assert.equal(b.text, '标题');
  }
  assert.equal(kinds('#nospace')[0], 'text');
  assert.equal(kinds('####### x')[0], 'text');
});

test('分割线行', () => {
  for (const s of ['---', '***', '___']) assert.equal(kinds(s)[0], 'hr');
  assert.equal(kinds('--')[0], 'text');
});

test('列表行：无序/有序/任务/嵌套缩进', () => {
  const [a] = parseLines('- 甲');
  assert.equal(a.kind, 'item');
  assert.equal(a.markerText, '-');
  assert.equal(a.text, '甲');
  assert.equal(a.indent, 0);

  const [o] = parseLines('3) 丙');
  assert.equal(o.ordered, true);
  assert.equal(o.markerText, '3)');

  const [t] = parseLines('- [x] 完成');
  assert.equal(t.task, true);
  assert.equal(t.checked, true);
  assert.equal(t.text, '完成');

  const [n] = parseLines('  - 子项');
  assert.equal(n.indent, 2);
});

test('列表行独立：相邻行不组成容器，中间插入文字行不"拆分"', () => {
  const bs = parseLines('- 甲\n插入文字\n- 乙');
  assert.deepEqual(bs.map((b) => b.kind), ['item', 'text', 'item']);
});

test('引用行：层级与文本', () => {
  const [q] = parseLines('> 引用');
  assert.equal(q.kind, 'quote');
  assert.equal(q.qdepth, 1);
  assert.equal(q.text, '引用');
  const [q2] = parseLines('>> 深层');
  assert.equal(q2.qdepth, 2);
  assert.equal(q2.text, '深层');
});

test('围栏代码块：唯一跨行结构', () => {
  const bs = parseLines('```js\nconst a = 1;\n**非粗体**\n```');
  assert.deepEqual(bs.map((b) => b.kind), ['code']);
  assert.equal(bs[0].info, 'js');
  assert.equal(bs[0].text, 'const a = 1;\n**非粗体**');
  // 未闭合
  const [open] = parseLines('```\nx');
  assert.equal(open.text, 'x');
  // 波浪线与更长闭合栏
  const [t] = parseLines('~~~\n```\n~~~');
  assert.equal(t.text, '```');
});

test('每行只应用一个主语法：引用行内的 # 按字面', () => {
  const [q] = parseLines('> # 非标题');
  assert.equal(q.kind, 'quote');
  assert.equal(q.text, '# 非标题');
});

test('range：每行区间可从源文本切片还原（不含行尾换行）', () => {
  const src = '# T\n\ntext\n- a\n- b';
  const bs = parseLines(src);
  assert.deepEqual(bs.map((b) => b.kind), ['heading', 'blank', 'text', 'item', 'item']);
  for (const b of bs) {
    const s = slice(src, b);
    assert.ok(!s.includes('\n'), JSON.stringify(s));
  }
  assert.equal(slice(src, bs[0]), '# T');
  assert.equal(slice(src, bs[2]), 'text');
  assert.equal(slice(src, bs[3]), '- a');
});

test('textStart：内容起点（编辑态标记前缀分界）', () => {
  const [h] = parseLines('# 标题');
  assert.equal(h.textStart, 2);
  const [i] = parseLines('- [x] 完成');
  assert.equal(i.textStart, 6);
  const [q] = parseLines('> 引用');
  assert.equal(q.textStart, 2);
  const [n] = parseLines('  - 子');
  assert.equal(n.textStart, 4);
});

test('空输入', () => {
  const bs = parseLines('');
  assert.equal(bs.length, 1);
  assert.equal(bs[0].kind, 'blank');
});

test('表格：连续 | 行合并为跨行单元', () => {
  const src = '| a | b |\n| c | d |\n文字';
  const bs = parseLines(src);
  assert.deepEqual(kinds(src), ['table', 'text']);
  const t = bs[0];
  assert.equal(slice(src, t), '| a | b |\n| c | d |');
  assert.equal(t.lines.length, 2);
  assert.equal(t.lines[0].text, '| a | b |');
  assert.equal(t.lines[1].textStart, 10);
});

test('表格行解析：单元格偏移 / 分隔行 / 边界形态', () => {
  const row = parseTableRow('| a | b |');
  assert.equal(row.sep, false);
  assert.deepEqual(row.cells.map((c) => c.text), ['a', 'b']);
  assert.deepEqual(row.cells.map((c) => [c.s, c.e]), [[2, 3], [6, 7]]);

  // 分隔行（GFM 兼容：渲染时跳过，不区分表头）
  assert.equal(parseTableRow('| --- | :--: |').sep, true);
  assert.equal(parseTableRow('| a | --- |').sep, false);

  // 边缘 pipe 之外仅允许空白；至少 2 个未转义 pipe
  assert.equal(parseTableRow('a | b'), null);
  assert.equal(parseTableRow('| a'), null);
  assert.equal(parseTableRow('||').cells.length, 1);

  // 转义 \| 不分割
  const esc = parseTableRow('| a\\|b | c |');
  assert.deepEqual(esc.cells.map((c) => c.text), ['a\\|b', 'c']);

  // 空/纯空白行不是表格行；单个 | 不是表格行
  assert.equal(parseTableRow(''), null);
  assert.equal(parseTableRow('|'), null);

  // 引用/列表行优先于表格判定
  assert.equal(kinds('> | a |')[0], 'quote');
  assert.equal(kinds('- | a |')[0], 'item');
});

test('表格单元 range 可整体切片还原（含行间换行）', () => {
  const src = '前\n| a | b |\n| --- | --- |\n| c | d |';
  const bs = parseLines(src);
  assert.deepEqual(kinds(src), ['text', 'table']);
  assert.equal(slice(src, bs[1]), '| a | b |\n| --- | --- |\n| c | d |');
  assert.equal(bs[1].lines.length, 3);
});
