// The answers on an HQ page's notes (marks.js draws the marks): a slip's corner under a number, the card a tap opens
// on an open mark with an answer (hairline.js), what its slips do, and the same place cut again from the live page for
// an answer's "then and now" (slip.js).
import { placed, snipOf, whereNow } from './marks.js';
import { send } from './markpage.js';
import { snapshot } from './snapshot.js';

// Whether a note (or a mark) has an answer not yet ticked
export const answered = n => (n.slips ?? []).some(s => !s.ticked);
// The open marks with an answer, as a tap finds them: their lines and their number's disc
export const answeredNow = r =>
  (r.marks ?? [])
    .filter(m => m.slips?.length)
    .map(m => {
      const ink = placed(m),
        at = whereNow(m, ink),
        disc = at ? [[Math.max(12, at.x - 6), Math.max(12, at.y - 6)]] : [];
      return { note: m, lines: [...ink, { points: disc }] };
    });
// What the card's slips do: the store's tick and reply, then the book reads its sheets again (book:changed, HQ's rail),
// and the page its marks with them
const changed = () => document.dispatchEvent(new CustomEvent('book:changed'));
export const slipActs = {
  tick: (id, ticked) => send('/slip/tick', { id, ticked }).then(changed),
  reply: (id, words) => send('/slip/reply', { id, words }).then(answer => (changed(), answer)),
};
// A slip's corner peeking out under a note's number: a little paper with a clip
export function tab(g, b) {
  const x = Math.max(12, b.x - 6) + 6,
    y = Math.max(12, b.y - 6) + 4;
  g.save();
  g.translate(x, y);
  g.rotate(0.12);
  g.fillStyle = '#fffdf6';
  g.shadowColor = 'rgba(42,35,82,.3)';
  g.shadowBlur = 3;
  g.shadowOffsetY = 1;
  g.fillRect(0, 0, 18, 13);
  g.shadowColor = 'transparent';
  g.strokeStyle = '#2a2352';
  g.lineWidth = 1;
  for (const dy of [4, 7, 10]) {
    g.beginPath();
    g.moveTo(3, dy);
    g.lineTo(dy === 10 ? 10 : 15, dy);
    g.stroke();
  }
  g.restore();
}

// The same place cut again from the live page, for an answer's "then and now": each note on this page whose newest
// answer has no cut since it came (none for a preview's: its own picture is its now), cut once its mark is on the screen
// while the page is idle, kept on the store (slip/now) for the book and every device. One screenshot serves them all;
// a slip tried once on this visit isn't tried again.
export async function cutNow(r) {
  if (r.mode !== 'idle' || r.covered || r.cutting) return;
  r.cutTried ??= new Set();
  const due = [...(r.marks ?? []), ...(r.sent ?? [])]
    .map(n => ({ n, slip: (n.slips ?? []).at(-1) }))
    .filter(({ slip }) => slip && !slip.ticked && !slip.preview && !r.cutTried.has(slip.id))
    .filter(({ slip }) => !slip.now_at || slip.now_at < slip.created)
    .map(d => ({ ...d, area: areaNow(d.n) }))
    .filter(d => d.area && onScreen(d.area));
  if (!due.length) return;
  r.cutting = true;
  try {
    const shot = await snapshot(r, { masked: true });
    if (!shot) return;
    for (const { slip, area } of due) {
      r.cutTried.add(slip.id);
      await send('/slip/now', { id: slip.id, picture: snipOf(shot, area) }).catch(err =>
        console.info("[review] the answer's now:", err.message),
      );
    }
    changed(); // (the book shows them)
  } finally {
    r.cutting = false;
  }
}
// cutNow once the page has been still a moment, after a load (the function returned: call it then) and every scroll
const CUT_AFTER_MS = 1200;
export function cutsWhenStill(r) {
  let settle = 0;
  const cut = () => {
    clearTimeout(settle);
    settle = setTimeout(() => cutNow(r).catch(err => console.info("[review] the answers' now:", err)), CUT_AFTER_MS);
  };
  addEventListener('scroll', cut, { capture: true, passive: true });
  return cut;
}
// Where a note's mark is on the screen now: around its lines, or its element's box (a pin)
function areaNow(n) {
  const at = whereNow({ anchor: n.anchor, live: n.live ?? null });
  if (!at) return null;
  const el = n.anchor.el?.box;
  return at.w || !el ? at : { ...at, w: el.w, h: el.h };
}
const onScreen = a =>
  a.x + a.w / 2 >= 0 && a.x + a.w / 2 <= innerWidth && a.y + a.h / 2 >= 0 && a.y + a.h / 2 <= innerHeight;
