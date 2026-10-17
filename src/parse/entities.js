// URL 白名单与转义字符集（docs/architecture.md §10）
//
// 本文件是 XSS 防线的一部分：编辑器渲染走 DOM textContent（无字符串拼接），
// 链接与图片地址必须经过 sanitizeUrl（返回 null 时调用方降级为纯文本）。

// CommonMark 反斜杠转义覆盖的 ASCII 标点集合
export const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
const IMAGE_SCHEMES = new Set(['http', 'https']);

// 返回安全的 URL；不安全则返回 null（调用方降级为纯文本渲染）。
// image=true 时额外允许 data:image/*（用于内联小图）。
export function sanitizeUrl(url, { image = false } = {}) {
  if (!url) return null;
  // 含控制字符直接拒绝（<> 形式的目标可能携带换行等）
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(url)) return null;
  // 去除 URL 内的空白后再判定协议
  const cleaned = url.replace(/[\t\n\r ]/g, '');
  if (!cleaned) return null;

  const m = SCHEME_RE.exec(cleaned);
  if (m) {
    const scheme = m[0].slice(0, -1).toLowerCase();
    if (image) {
      if (IMAGE_SCHEMES.has(scheme)) return cleaned;
      if (scheme === 'data' && /^data:image\//i.test(cleaned)) return cleaned;
      return null;
    }
    return LINK_SCHEMES.has(scheme) ? cleaned : null;
  }
  // 无协议：相对路径或协议相对 //，均允许
  return cleaned;
}
