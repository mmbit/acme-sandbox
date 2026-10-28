// An invited person's own Sketchbook, on the guest desk (sketches.ts: /guest/sketchbook/, their own session): the same
// shelf and pages as the board's in HQ (sketchshelf.js, sketchpage.js), on the guest desk's look, sent to the CEO from
// their own book. The board opens it from its own book and draws in it too. A phone and a tablet first: the shelf is the whole screen, a sketch opens over it.
import { esc, stylesheet } from '../../util.js';
import { shelf, back } from './sketchshelf.js';

const main = document.querySelector('.sk-guest'),
  name = main.dataset.name,
  API = 'api';

// The book's routes, the board's own under /guest/sketchbook/api/ for this person's book
async function call(path, body) {
  const sent =
    body instanceof Blob ? { type: body.type, data: body } : { type: 'application/json', data: JSON.stringify(body) };
  const res = await fetch(
    `${API}/${path}`,
    body === undefined
      ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': sent.type }, body: sent.data },
  ).catch(() => null);
  if (!res)
    throw Object.assign(new Error('That didn’t reach us. Are you online? Try again in a moment.'), { status: 0 });
  // (signed out, or the book was closed: the page says so and goes back to their link's page)
  if (res.status === 401 || res.status === 403) {
    closed();
    // (the Notebook, once the Sketchbook)
    throw Object.assign(new Error('This Notebook isn’t open for you now.'), { status: res.status });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(
      new Error(json.error || `That didn’t go through (error ${res.status}). Try again in a minute.`),
      { status: res.status },
    );
  return json;
}
const book = {
  dev: false,
  list: () => call('list'),
  load: id => call(`ink?id=${Number(id)}`),
  act: (what, body) => call(what, body),
  upload: (id, blob) => call(`scrap?id=${Number(id)}`, blob),
  to: main.dataset.to,
  toast,
  ago,
};

// (the Notebook, once the Sketchbook)
main.innerHTML = `<header class="sk-head"><h1>${esc(name)}’s Notebook</h1>
  <p>Draw anything: a pen or a finger. When it’s ready, <b>Send to ${esc(book.to)}</b> hands it to ${esc(book.to)}, who runs the crew, with your name on it. Only you and ${esc(main.dataset.co)} see your sketches, and ${esc(main.dataset.co)} can draw in them too, in its own ink.</p></header>
  <section class="sk-shelf"></section><div class="sk-toasts" aria-live="polite"></div>`;
const at = main.querySelector('.sk-shelf');
await Promise.all([
  stylesheet('shell/ink/sketchbook.css'),
  stylesheet('shell/ink/sketchpage.css'),
  stylesheet('shell/ink/sketchtray.css'),
]);
await shelf(at, book).catch(e => problem(e.message));
// the list again when they come back to the tab (another device may have drawn meanwhile)
document.addEventListener(
  'visibilitychange',
  () => !document.hidden && !document.querySelector('dialog[open]') && shelf(at, book).catch(() => {}),
);
// Escape or the browser's back on the shelf: a menu or another shelf first
addEventListener('keydown', e => e.key === 'Escape' && !document.querySelector('dialog[open]') && back());

function problem(words) {
  at.innerHTML = `<p class="sk-problem" role="alert">${esc(words)}</p>`;
}
function closed() {
  problem('This Notebook isn’t open for you now. Open your link again to sign in.');
}

// A short line over the page for a few seconds; tap: what it leads to
function toast(html, tap) {
  const t = Object.assign(document.createElement('button'), { className: 'sk-toast', type: 'button' });
  t.innerHTML = html;
  t.onclick = () => {
    t.remove();
    tap?.();
  };
  (document.querySelector('dialog[open]') ?? main.querySelector('.sk-toasts')).append(t);
  setTimeout(() => t.remove(), 3500);
}

// When, as a person says it: just now, 5 min ago, 3 h ago, yesterday, then the date
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
