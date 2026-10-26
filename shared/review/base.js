// What every part of review mode shares (review.js loads them all through tool.js): its red, its icons, the styles
// under every part and small helpers. Imports nothing, so any part can read it as it loads.

export const ACCENT = '#ff5a5f';
export const PIN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 2.5l7 7-2.2.6-3.6 3.6.4 4.6-1.6 1.6-4.2-4.2L5 21l-.9-.9 5.3-5.3-4.2-4.2 1.6-1.6 4.6.4 3.6-3.6z" fill="currentColor"/></svg>';
export const MIC =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';

// Under every part: the host reset, the menus' colours (look: the guest pages', review.js fills them in), the overlay
export const baseCss = look => `
      :host { all: initial; }
      ${look}   /* the menus' colours */
      * { box-sizing: border-box; }
      .ui { position: fixed; inset: 0; container-type: inline-size; pointer-events: none; font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #2b2230; -webkit-tap-highlight-color: transparent; }
      /* (.ui a container: what's in it is sized by its box, cqw, which on HQ's pages is the page's, beside the book.) */
      button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
      @keyframes pop-in { from { transform: translateY(12px) scale(.85); opacity: 0 } }
      @keyframes boing { 0% { transform: scale(1) } 30% { transform: scale(1.3) rotate(12deg) } 60% { transform: scale(.9) rotate(-6deg) } 100% { transform: none } }
      @keyframes shimmer { to { background-position: -150% 0 } }`;
export const REDUCED_MOTION_CSS = `
      @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }`;

// localStorage or sessionStorage, where the browser keeps them (private mode: not at all)
export const keep = (store, k, v) => {
  try {
    store.setItem(k, v);
  } catch {
    /* private mode */
  }
};
export const kept = (store, k) => {
  try {
    return store.getItem(k);
  } catch {
    return null;
  }
};

// a JSON post next to the script (route: where review.js was served from)
export const post = (route, path, body) =>
  fetch(new URL(path, route), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// an element of plain words (never HTML: the words are the reviewer's), and a button
export const line = (cls, words, tag = 'p') => {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = words;
  return e;
};
export const button = (words, cls = '') => {
  const b = line(cls, words, 'button');
  b.type = 'button';
  return b;
};
// a menu line's title and sub-line
export const label = (b, main, sub) => {
  b.firstChild.textContent = main;
  if (sub !== undefined) b.querySelector('small').textContent = sub;
};

// Its message is shown to the reviewer as it is
export class RefusedError extends Error {}
// the hourly rate (429) and a disk too full for a screenshot (507) say why in their own words
export async function refusal(res) {
  if (res.status === 429 || res.status === 507) throw new RefusedError((await res.json()).error);
}
