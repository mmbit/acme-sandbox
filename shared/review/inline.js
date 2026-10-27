// A page's pictures and fonts as data: URLs, for the screenshot's copy of it (snapshot.js, copy.js, flow.js):
// same-origin or CORS-enabled ones, each fetched once; the rest are left out (null).
const cache = new Map();
export function inline(url) {
  if (url.startsWith('data:')) return Promise.resolve(url);
  if (!cache.has(url))
    cache.set(
      url,
      fetch(url, { credentials: 'same-origin' })
        .then(res => (res.ok ? res.blob() : null))
        .then(
          b =>
            b &&
            new Promise(res => {
              const f = new FileReader();
              f.onload = () => res(f.result);
              f.onerror = () => res(null);
              f.readAsDataURL(b);
            }),
        )
        .catch(() => null),
    );
  return cache.get(url);
}
export async function inlineUrls(css, base) {
  const urls = [...css.matchAll(/url\((['"]?)(.*?)\1\)/g)];
  for (const [all, , u] of urls) {
    if (u.startsWith('data:')) continue;
    let abs;
    try {
      abs = new URL(u, base).href;
    } catch {
      continue;
    }
    const data = await inline(abs);
    css = css.replace(all, data ? `url("${data}")` : 'none');
  }
  return css;
}
