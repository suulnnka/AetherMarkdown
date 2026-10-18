// 行内解析器测试（golden）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, plainText } from '../../src/index.js';

const one = (s) => {
  const t = parseInline(s);
  assert.equal(t.length, 1, `期望单 token：${JSON.stringify(t)}`);
  return t[0];
};

test('纯文本', () => {
  assert.deepEqual(one('hello'), { t: 'text', v: 'hello', s: 0, e: 5 });
});

test('粗体/斜体/删除线', () => {
  assert.equal(one('**b**').t, 'strong');
  assert.equal(one('*i*').t, 'em');
  assert.equal(one('~~d~~').t, 'del');
  assert.deepEqual(one('**b**').c, [{ t: 'text', v: 'b', s: 2, e: 3 }]);
  // 下划线不支持强调，一律字面
  assert.equal(one('__b__').t, 'text');
  assert.equal(one('_i_').t, 'text');
});

test('***x*** 解析为 em > strong', () => {
  const tk = one('***x***');
  assert.equal(tk.t, 'em');
  assert.equal(tk.c[0].t, 'strong');
});

test('嵌套：strong 内 em', () => {
  const tk = one('**a *b* c**');
  assert.equal(tk.t, 'strong');
  assert.deepEqual(tk.c.map((x) => x.t), ['text', 'em', 'text']);
});

test('下划线一律字面（不支持强调）', () => {
  const tks = parseInline('a*b*c');
  assert.deepEqual(tks.map((x) => x.t), ['text', 'em', 'text']);
  const snake = parseInline('snake_case_word');
  assert.equal(plainText(snake), 'snake_case_word');
  assert.ok(!snake.some((x) => x.t === 'em'));
  const under = parseInline('__b__ _i_');
  assert.ok(!under.some((x) => x.t === 'strong' || x.t === 'em'));
});

test('未配对的强调按字面', () => {
  assert.equal(one('*literal').v, '*literal');
  assert.equal(one('~single~字面').t, 'text');
  // 空强调不成立（CommonMark 规则）：** / *** 按字面显示，不产生空 <em>
  assert.equal(one('**').v, '**');
  assert.equal(one('***').v, '***');
  assert.equal(one('____').v, '____');
});

test('行内代码', () => {
  assert.deepEqual(one('`x`'), { t: 'code', v: 'x', s: 0, e: 3 });
  assert.deepEqual(one('``a`b``'), { t: 'code', v: 'a`b', s: 0, e: 7 }); // 双反引号包单反引号
  assert.deepEqual(one('` spaced `'), { t: 'code', v: 'spaced', s: 0, e: 10 }); // 首尾各去一空格
  assert.equal(one('`未闭合').v, '`未闭合');
});

test('转义', () => {
  assert.deepEqual(one('\\*x\\*'), { t: 'text', v: '*x*', s: 0, e: 5 });
  assert.deepEqual(one('\\\\'), { t: 'text', v: '\\', s: 0, e: 2 });
  assert.deepEqual(one('\\_a\\_'), { t: 'text', v: '_a_', s: 0, e: 5 });
  const tks = parseInline('\\# 不是标题');
  assert.equal(plainText(tks), '# 不是标题');
});

test('链接', () => {
  const tk = one('[t](https://x.com)');
  assert.equal(tk.t, 'link');
  assert.equal(tk.href, 'https://x.com');
  assert.deepEqual(tk.c, [{ t: 'text', v: 't', s: 1, e: 2 }]);

  const titled = one('[t](u.html "标题")');
  assert.equal(titled.title, '标题');

  const angled = one('[t](<my url>)');
  assert.equal(angled.href, 'my url');

  // 不构成链接时按字面
  assert.equal(one('[t]').v, '[t]');
  assert.equal(one('[t](u').t, 'text');
});

test('链接文本可包含强调与行内代码', () => {
  const tk = one('[**b** `c`](u)');
  assert.deepEqual(tk.c.map((x) => x.t), ['strong', 'text', 'code']);
});

test('图片', () => {
  const tk = one('![替代](i.png)');
  assert.equal(tk.t, 'image');
  assert.equal(tk.src, 'i.png');
  assert.equal(tk.alt, '替代');
});

test('链接包裹图片', () => {
  const tk = one('[![alt](i.png)](u.html)');
  assert.equal(tk.t, 'link');
  assert.equal(tk.c[0].t, 'image');
  assert.equal(tk.c[0].src, 'i.png');
});

test('自动链接：尖括号 URI 与邮箱', () => {
  const tk = one('<https://x.com/a?b=1>');
  assert.equal(tk.t, 'autolink');
  assert.equal(tk.href, 'https://x.com/a?b=1');

  const mail = one('<a@b.com>');
  assert.equal(mail.href, 'mailto:a@b.com');
  assert.equal(mail.text, 'a@b.com');

  assert.equal(one('<不是链接>').v, '<不是链接>');
});

test('自动链接：裸 URL（简化 GFM）', () => {
  const tks = parseInline('see https://x.com/a.');
  const url = tks.find((x) => x.t === 'autolink');
  assert.equal(url.href, 'https://x.com/a'); // 尾部标点剔除

  const www = parseInline('go www.x.com now').find((x) => x.t === 'autolink');
  assert.equal(www.href, 'http://www.x.com'); // www. 补协议

  // 前方是字母数字时不触发
  const no = parseInline('xhttps://x.com');
  assert.ok(!no.some((x) => x.t === 'autolink'));
});

test('plainText 汇总', () => {
  assert.equal(plainText(parseInline('**a** `b` ~~c~~')), 'a b c');
});
