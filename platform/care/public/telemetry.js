// Platform's telemetry for every app: track(name, data) and a ring buffer of the page's last ~100 events,
// in the page's memory only (never localStorage, sessionStorage, IndexedDB or cookies). It keeps errors,
// unhandled rejections, failed requests (method, path pattern, status), page views and the steps an app tracks, and
// redacts them *before* they enter the buffer: no input values, no query strings, no fragments, id-like path segments
// masked, emails and runs of 6+ digits (a card number written with spaces too) replaced, messages cut to 200 characters.
// It has no network code of its own: it only watches fetch and XMLHttpRequest. Only the chat's consent card sends a
// bundle, through the widget, after the tap on "Send it".
//   An app may load it early, to catch errors before the chat loads: <script type="module" src="./__care/telemetry.js">
//   and import { track } from '/__care/telemetry.js'; the widget imports ./telemetry.js, the same URL, so one copy.
const MAX = 100;
const buf = [];

// ---- redaction (the server does the same again: src/diagnostics.ts)
// any x@y (an address in any script, with any dot), digits in any script, a bare
// query or fragment, and long tokens, as src/diagnostics.ts
const EMAIL = /[^\s@<>()[\]{},;:"'`]+@[^\s@<>()[\]{},;:"'`]*[^\s@<>()[\]{},;:"'`.\u3002\uff0e\uff61]/g; // any x@y (a sentence's full stop after it kept): anna@пример.рф, anna@example。com
const DIGITS = /\p{Nd}(?:[\s.\/_,-]{0,2}\p{Nd}){5,}/gu; // 6+ digits, also with up to two spaces, dots, slashes or dashes between (4242 4242 4242 4242)
// An absolute URL, a path starting at /, or a query or fragment on its own. Safari before 16.4 has no lookbehind.
// The path pattern also matches the character before the path, and urlish puts that character back
const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*|(^|[^\w.~-])(\/[^\s"'<>()]*)|[?#&][\w.~%-]+=[^\s"'<>()]*/gi;
const TOKEN = /[\w-]{20,}(?:\.[\w-]+)*/g; // a long token (a link's, an order's key): masked whole if it has a digit, or is 32+ long
const token = (w) => (/\d/.test(w) || w.length >= 32 ? '[token]' : w);
// a segment that names one thing rather than a place in the app: has a digit, or is long, or holds an @
const idLike = (s) => (/\d/.test(s) && s.length > 2) || s.length >= 24 || s.includes('@');
// a URL or path without its query and fragment, its id-like segments masked: /api/orders/BUD-7Q4K-M2?t=x → /api/orders/:id
export function pattern(u) {
  const s = String(u).split(/[?#]/)[0];
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/i.exec(s);
  const host = (m[1] ?? '').replace(/^[^:]+:\/\/(?:[^@/]*@)?/, (x) => x.replace(/[^/:]*@/, '')); // no user:password@
  return host + m[2].split('/').map((seg) => (seg && idLike(decodeSafe(seg)) ? ':id' : seg)).join('/');
}
const decodeSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
export const redact = (s, max = 200) => String(s ?? '').slice(0, 2000).replace(URLISH, urlish).replace(EMAIL, '[email]').replace(TOKEN, token).replace(DIGITS, '[number]').slice(0, max);
const urlish = (u, before, path) => (path === undefined ? pattern(u) : before + pattern(path));

// ---- the buffer
function add(kind, text) {
  buf.push({ at: Date.now(), kind, text: redact(text) });
  if (buf.length > MAX) buf.shift();
}
// the events for the bundle and the preview: the last ten minutes only (the card says "the last few minutes"; a quiet
// tab's buffer can hold hours-old ones), as copies, so nothing outside can change what's kept
export const WINDOW_MS = 10 * 60_000;
export const events = () => buf.filter((e) => e.at >= Date.now() - WINDOW_MS).map((e) => ({ ...e }));
// the page the customer is on, as a pattern (no query, no fragment, ids masked)
export const where = () => pattern(location.pathname);

// track('poster_previewed', { step: 'preview', ok: true }): a short name, and data only under the shared keys below, as
// numbers, booleans or short lower-case words (a word with a digit in it is masked like an id). Anything else is dropped,
// so an app's step can never carry what someone typed: a street, a name, an email (one vocabulary, until it
// moves to shared/telemetry/events.ts).
const NAME = /^[a-z][a-z0-9_.:-]{0,39}$/;
export const KEYS = new Set(['step', 'ok', 'n', 'count', 'ms', 'kind', 'status', 'code', 'variant', 'size', 'format', 'lang', 'source', 'action', 'screen']);
const value = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? String(v) : null) : typeof v === 'boolean' ? String(v)
  : typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v) ? (idLike(v) ? ':id' : v) : null);
export function track(name, data = {}) {
  if (!NAME.test(String(name))) return;
  const keep = Object.entries(data && typeof data === 'object' ? data : {}).filter(([k]) => KEYS.has(k)).map(([k, v]) => [k, value(v)]).filter(([, v]) => v != null);
  add('track', [name, ...keep.map(([k, v]) => `${k}=${v}`)].join(' '));
}

// ---- what's watched: errors, rejections, failed requests, page views
const file = (f) => (f ? pattern(f).split('/').pop() : '');
addEventListener('error', (e) => {
  if (e.target && e.target !== window) { // a resource that didn't load (an image, a script): which one, never the page's data
    const t = e.target, src = t.currentSrc || t.src || t.href;
    if (src) add('error', `${String(t.tagName).toLowerCase()} didn’t load: ${pattern(src)}`);
    return;
  }
  add('error', `${e.message || 'Error'}${e.filename ? ` (${file(e.filename)}:${e.lineno}:${e.colno})` : ''}`);
}, true);
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  add('rejection', r instanceof Error ? `${r.name}: ${r.message}` : typeof r === 'string' ? r : 'a promise was rejected');
});

// failed requests only: method, the path pattern (another origin's host kept, so a CDN failing shows), the status, or
// 0 for a network failure. Never headers or bodies (an app's order token sits in a header).
const target = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin ? x.pathname : x.origin + x.pathname; } catch { return ''; } };
const request = (method, url, status) => add('request', `${String(method || 'GET').toUpperCase().slice(0, 10)} ${pattern(target(url))} ${status}`);
if (typeof window.fetch === 'function') {
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input), method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return real.apply(this, arguments).then((r) => { if (!r.ok && r.type !== 'opaque') request(method, url, r.status); return r; },
      (err) => { if (err?.name !== 'AbortError') request(method, url, 0); throw err; });
  };
}
if (typeof XMLHttpRequest === 'function') {
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  const seen = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) { seen.set(this, { method, url: String(url) }); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const r = seen.get(this);
    if (r) this.addEventListener('loadend', () => { if (this.status === 0 || this.status >= 400) request(r.method, r.url, this.status); }, { once: true });
    return send.apply(this, arguments);
  };
}

// page views: the first, and each change of path (a query or fragment change is no new page, and isn't kept anyway)
let last = '';
const view = () => { const p = where(); if (p !== last) { last = p; add('view', p); } };
for (const k of ['pushState', 'replaceState']) {
  const real = history[k];
  history[k] = function () { const r = real.apply(this, arguments); view(); return r; };
}
addEventListener('popstate', view);
view();
