// The notebook's end of its link with HQ and the artifacts HQ shows (a game, a deck, a site in the viewer): it tells
// them the notebook's moves and hears them talk back. All optional: whatever never listens is untouched.
//
// Events, on(event, fn):
//   'pull'     a hand takes the notebook to pull it out or in (its pull tab dragged or tapped)
//   'letgo'    the hand lets go, detail { open }: whether the notebook ends up open
//   'message'  HQ or an artifact talking back to the notebook, detail { kind, detail, from: 'hq' | 'artifact' }
// An artifact's frame hears { hq: 'hq', notebook: 'pull' | 'letgo', detail } and talks back with
// { hq: 'notebook', kind, detail }: its own end is shared/notebook/notebook.js.

const listeners = new Map(); // event → its listeners
let artifacts = () => []; // the windows of the artifact frames HQ shows now (mountFrames)

// → unsubscribe
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

// The notebook's move, told to HQ and to the artifacts it shows (to any origin: it carries nothing but the move)
export function emit(event, detail = {}) {
  tell(event, detail);
  for (const frame of artifacts()) frame.postMessage({ hq: 'hq', notebook: event, detail }, '*');
}

// HQ's own word to the notebook
export const send = (kind, detail) => tell('message', { kind, detail, from: 'hq' });

// The artifacts' side of the link, on HQ's window (win). frames(): the windows of the artifact frames HQ shows now.
// trusts(origin): whether a page from there is one HQ shows, as a frame may go on to another site. A message from
// anything else is dropped, and what an artifact sends is its data, never an instruction.
export function mountFrames(win, { frames, trusts }) {
  artifacts = frames;
  win.addEventListener('message', e => {
    const said = e.data;
    if (said?.hq !== 'notebook' || typeof said.kind !== 'string') return;
    if (!frames().includes(e.source) || !trusts(e.origin)) return;
    tell('message', { kind: said.kind, detail: said.detail, from: 'artifact' });
  });
}

const tell = (event, detail) => {
  for (const fn of listeners.get(event) ?? []) fn(detail);
};
