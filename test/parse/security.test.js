// 安全测试：XSS 防线（docs/architecture.md §10）
// 编辑器渲染走 DOM textContent（无字符串拼接），URL 安全边界是 sanitizeUrl
// （渲染层对返回 null 的链接/图片降级为纯文本）；HTML 序列化管线已删除（D36）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrl, parseInline } from '../../src/index.js';

test('不安全协议被拒（返回 null）', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl('jAvascript:alert(1)'), null);
  assert.equal(sanitizeUrl(' java\nscript:alert(1)'), null); // 控制字符/空白混淆
  assert.equal(sanitizeUrl('vbscript:msgbox'), null);
  assert.equal(sanitizeUrl('data:text/html,<b>'), null);
});

test('图片模式仅放行 data:image/*', () => {
  assert.ok(sanitizeUrl('data:image/png;base64,xxxx', { image: true }));
  assert.equal(sanitizeUrl('data:image/png;base64,xxxx'), null); // 链接模式禁 data
  assert.equal(sanitizeUrl('data:text/html,<b>', { image: true }), null);
});

test('允许的协议与相对地址', () => {
  assert.ok(sanitizeUrl('https://x.com'));
  assert.ok(sanitizeUrl('HTTP://X.COM'));
  assert.ok(sanitizeUrl('//cdn.x.com/a.png'));
  assert.ok(sanitizeUrl('a/b/c.png?x=1'));
  assert.ok(sanitizeUrl('mailto:a@b.com'));
});

test('HTML 直写不解析为标签：按字面文本 token', () => {
  const tks = parseInline('<script>alert(1)</script>');
  assert.equal(tks.length, 1);
  assert.equal(tks[0].t, 'text');
  assert.equal(tks[0].v, '<script>alert(1)</script>');
});
