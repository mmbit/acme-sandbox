// An artifact's end of the link with HQ's notebook: a page HQ shows in its viewer (a game, a deck, a site) hears the
// notebook pulled out and let go, and can talk back. Optional: a page that never imports it hears and sends nothing.
// Import it by its path in the repo (from a product's app/public/, '../../../../shared/notebook/notebook.js'): every
// product host serves it there (infra/products.py, KITS).
//
//   notebook.on('pull', () => freeze())                 a hand takes the notebook to pull it out or in
//   notebook.on('letgo', ({ open }) => open || thaw())   the hand lets go: open, whether the notebook ends up open
//   notebook.send('context', { level: 3 })              a word to the notebook: any kind, any cloneable detail
//
// The messages, for a page that posts them itself: HQ to the page { hq: 'hq', notebook: 'pull' | 'letgo', detail },
// the page to HQ { hq: 'notebook', kind, detail }.

const EVENTS = ['pull', 'letgo'];
const listeners = new Map(EVENTS.map(event => [event, new Set()]));
// HQ's origin, as the host serving the page names it at /__hq-origin (infra/products.py kit_route): the one origin the
// page hears from and sends to, and only while it's framed. null before then, and on a page no host names HQ for.
let hq = null;
if (window.parent !== window)
  fetch('/__hq-origin')
    .then(r => (r.ok ? r.text() : null))
    .then(text => {
      hq = originOf(text);
      if (hq) window.addEventListener('message', heard);
    })
    .catch(() => {
      /* no HQ named: the page hears and sends nothing */
    });

// → unsubscribe
export function on(event, fn) {
  if (!EVENTS.includes(event)) throw new Error(`The notebook has no event called ${event}: ${EVENTS.join(' or ')}`);
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

// → whether it went: never outside HQ, nor before the host has named HQ (just after the page loads)
export function send(kind, detail) {
  if (!hq) return false;
  window.parent.postMessage({ hq: 'notebook', kind, detail }, hq);
  return true;
}

function heard(e) {
  if (e.source !== window.parent || e.origin !== hq || e.data?.hq !== 'hq') return;
  for (const fn of listeners.get(e.data.notebook) ?? []) fn(e.data.detail ?? {});
}
// An origin and nothing else, or null: a host that answers every path with a page names no HQ
function originOf(text) {
  const named = text?.trim();
  try {
    return new URL(named).origin === named ? named : null;
  } catch {
    return null;
  }
}
