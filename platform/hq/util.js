// Small shared helpers: seeded randomness, colour maths, canvas creation, pixel art, stylesheets, words.

// FNV-1a: a string's 32-bit hash, the same on every visit
export function hash(s) { // (exported)
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// mulberry32: tiny, fast, deterministic.
export function rng(seed) {
  let a = typeof seed === 'number' ? seed : hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
export const rand = (a, b) => a + Math.random() * (b - a); // unseeded: for the simulation's small surprises
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// A #rrggbb colour's channels, 0 to 255
export const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export function mix(a, b, t) {
  const x = rgb(a), y = rgb(b);
  return '#' + x.map((v, i) => Math.round(lerp(v, y[i], t)).toString(16).padStart(2, '0')).join('');
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// (pixelArt, stylesheet, picture, MONTHS and DAYS)
// Pixel art as an SVG, one unit per character of `rows` ('#' inked, anything else clear). With a label it's an image
// for screen readers, without one it's decoration.
export function pixelArt(rows, cls = 'px', label = '') {
  const path = rows.map((r, y) => [...r].map((c, x) => c === '#' ? `M${x} ${y}h1v1h-1z` : '').join('')).join('');
  const role = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="${cls}" viewBox="0 0 ${rows[0].length} ${rows.length}" ${role}><path d="${path}"/></svg>`;
}
// A stylesheet, linked once: resolves when it has loaded or failed (3 s at most), so a screen never paints unstyled
const sheets = {};
export const stylesheet = href => sheets[href] ??= new Promise(done => {
  const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
  l.onload = l.onerror = done; setTimeout(done, 3000);
  document.head.append(l);
});
// A picture from HQ's files for a canvas, loaded once per address: draw it once it's complete with a size (a failed one
// stays at 0 x 0). picturesLoaded resolves when every one asked for so far has loaded or failed (the pixel check's shots
// wait for it).
const pictures = new Map();
export function picture(src) {
  const cachedPicture = pictures.get(src);
  if (cachedPicture) return cachedPicture;
  const image = new Image();
  image.onerror = () => console.warn(`[hq] Could not load picture: ${src}`);
  image.src = src;
  pictures.set(src, image);
  return image;
}
export const picturesLoaded = () => Promise.all([...pictures.values()].map(p => p.decode().catch(() => {})));
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// A job as the board names it: its task's code, or its number while its agent hasn't named a task HQ made (hq code).
export const jobName = (id, code) => code ?? `#${Number(id)}`;
// A person's title, and after it, quieter, their focus (org.yaml's words for what the title doesn't say)
export const roleHtml = d => `${esc(d.role)}${d.focus ? `<span class="role-focus">${d.role ? ' · ' : ''}${esc(d.focus)}</span>` : ''}`;
export const titleCase = s => String(s).replace(/(^|[-_ ])(\w)/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase());
export const cap = s => s[0].toUpperCase() + s.slice(1);
// how long since t, in whole minutes ("7 min", "2 h 5 min", "3 d")
export const mins = t => { const m = Math.max(1, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`; };
// a text box as tall as its text
export function grow(t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 4}px`; }
export const store = {
  get(k, d) { try { const v = localStorage.getItem('hq.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hq.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// Crop a canvas to its visible pixels: { c, dx, dy } (dx, dy: the crop's offset inside the original).
export function trim(src) {
  const { width: w, height: h } = src, d = src.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  if (x1 < 0) return { c: canvas(1, 1), dx: 0, dy: 0 };
  const c = canvas(x1 - x0 + 1, y1 - y0 + 1);
  c.getContext('2d').drawImage(src, -x0, -y0);
  return { c, dx: x0, dy: y0 };
}
