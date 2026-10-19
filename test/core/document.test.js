// 文档模型测试：CRLF 归一化、跨行结构边界合并
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../../src/core/document.js';

test('CRLF 归一化为 LF', () => {
  const d = new Document('# title\r\n\r\n---\r\n\r\n- item\r\n');
  assert.equal(d.source, '# title\n\n---\n\n- item\n');
  assert.deepEqual(d.units.map((u) => u.kind), ['heading', 'blank', 'hr', 'blank', 'item', 'blank']);
  // 单独 \r 也归一化
  assert.equal(new Document('a\rb').source, 'a\nb');
});

test('joinPrev/joinNext 不合并进代码围栏', () => {
  const after = new Document('```\ncode\n```\nnext');
  assert.equal(after.joinPrev(after.units[1]), null);
  assert.equal(after.source, '```\ncode\n```\nnext');

  const before = new Document('prev\n```\ncode\n```');
  assert.equal(before.joinNext(before.units[0]), null);
  assert.equal(before.source, 'prev\n```\ncode\n```');

  // 自己是 code 也不合并
  const code = new Document('```\ncode\n```');
  assert.equal(code.joinPrev(code.units[0]), null);
  assert.equal(code.joinNext(code.units[0]), null);
  assert.equal(code.source, '```\ncode\n```');
});

test('joinPrev/joinNext 不合并进表格', () => {
  const d = new Document('| a |\n| b |\nnext');
  assert.equal(d.joinPrev(d.units[1]), null);
  assert.equal(d.source, '| a |\n| b |\nnext');

  const d2 = new Document('prev\n| a |\n| b |');
  assert.equal(d2.joinNext(d2.units[0]), null);
});

test('普通行 joinPrev/joinNext 仍然合并', () => {
  const d = new Document('hello\nworld');
  assert.equal(d.joinPrev(d.units[1]), 5);
  assert.equal(d.source, 'helloworld');

  const d2 = new Document('hello\nworld');
  assert.equal(d2.joinNext(d2.units[0]), 5);
  assert.equal(d2.source, 'helloworld');
});
