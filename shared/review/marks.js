// The Pencil's mark on an HQ page (review mode with the book, data-book on its script: pencil.js), and its note in the
// book's store (the coordinator's /api/book routes, booknotes.ts). The mark being made is drawn in full while it's
// made; once its note is in the book (or it's let go) the page is clean, its lines only in the note's snip (rule zero:
// paint). A mark goes on the sheet of the agent whose work it's on (data-owner on HQ's page; nobody's: the CEO's), on
// that agent's page in today's book; on a call, the call's page. Every change is a step the two-finger tap takes back
// (pencil.js).
import * as inkjs from './ink.js';
import { boxOfLines, nearLines } from './mark.js';
import { ownerOf, pageOf, send, toNotebook } from './markpage.js';

// A snip: the page around a mark, the ink on it, with this much margin round the ink (the book shows it at its width)
const MARGIN = 24;
const SNIP_MIN = { w: 240, h: 150 };
// A scribble wipes the mark being made when its ink comes this close to the scribble's box (px), so a quick zigzag that
// ends a stroke-width short still counts.
const SCRIBBLE_PX = 10;

// The open mark's lines where its element is now: drawn on the screen as it was at its first line, they move as the
// element has moved since (the page scrolled under a finger, or a box of it did). m: another mark (a call's held one)
export function openLines(r, lines = r.strokes, m = r.mark) {
  const then = m?.element?.rect,
    el = m?.el;
  if (!then || !el?.isConnected) return lines;
  const now = el.getBoundingClientRect(),
    dx = now.left - then.x,
    dy = now.top - then.y;
  if (!dx && !dy) return lines;
  return lines.map(l => ({ ...l, points: l.points.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest]) }));
}
// ...and a line drawn on the screen now, back on the screen as it was at the mark's first line
export function intoMark(r, stroke) {
  const [shifted] = openLines(r, [{ points: [[0, 0]] }]);
  const [dx, dy] = shifted.points[0];
  return dx || dy ? { ...stroke, points: stroke.points.map(([x, y, ...rest]) => [x - dx, y - dy, ...rest]) } : stroke;
}

// The page's ink layer: the mark being made, and nothing else (rule zero, the board's, 2026-10-27: strokes live only
// while a note is being made; once it's saved or let go they're gone from the page at once, and live on only in its
// snip). This draws only the open mark's lines and those waiting for the next (settle.js), never a note in the book:
// the book keeps no lines of a note to draw (booknotes.ts), and no tab, screen or call has any to bring back. On a call
// the board's marks the call's agent hasn't had its turn on yet stay too (r.held, callnotes.js): they're for the agent,
// and go once its turn is done (the board, call 161).
export function paint(r, lines = r.strokes) {
  const c = r.inkCanvas,
    g = inkjs.fit(c);
  const open = r.mark?.filed ? [] : lines === r.strokes ? openLines(r, lines) : lines;
  const shown = [];
  for (const h of r.held ?? []) {
    const held = openLines(r, h.lines, h.mark);
    inkjs.draw(g, held, { halo: true });
    shown.push(...held);
  }
  if (open.length) {
    inkjs.draw(g, open, { halo: true });
    shown.push(...open);
  }
  // (the lines drawn while the last mark goes in: settle.js.)
  if (r.nextLines?.length) {
    inkjs.draw(g, r.nextLines, { halo: true });
    shown.push(...r.nextLines);
  }
  // (...and the mark being made's words, while its post-it holds them as read.)
  const read = r.mark?.written;
  if (read && open.length && r.text?.value.trim() === read) tag(g, boxOfLines(open), read, TYPE_INK, TYPE);
  inkjs.shown(c, shown, { halo: true });
}
// The board's words beside its mark, wrapped to this width
const TAG_W = 240;
// (the board's handwriting read into type: set in the page's own kind of type, dark, so it reads as the words and the
// ink beside it as the hand.)
const TYPE = '500 14px system-ui, -apple-system, "Segoe UI", sans-serif',
  TYPE_INK = '#2b2230';
function tag(g, b, words, color, font) {
  g.save();
  g.font = font;
  const lines = [];
  for (const word of words.split(/\s+/)) {
    const last = lines.at(-1);
    if (last && g.measureText(`${last} ${word}`).width <= TAG_W) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const w = Math.max(...lines.map(l => g.measureText(l).width)),
    x = Math.max(4, Math.min(innerWidth - w - 4, b.x + b.w + 10)),
    y = Math.max(16, Math.min(innerHeight - 18 * lines.length, b.y + 4));
  g.textBaseline = 'top';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,.92)';
  g.fillStyle = color;
  lines.forEach((l, i) => {
    g.strokeText(l, x, y + 18 * i);
    g.fillText(l, x, y + 18 * i);
  });
  g.restore();
}

// Whether a scribble over an area crosses the mark being made (to wipe it)
export const markAt = (r, area) => r.mode === 'note' && nearLines(area, openLines(r), SCRIBBLE_PX);

// The snip: the screenshot around the mark (its lines on it), at least SNIP_MIN, within the screen (snapshot.js has
// already read the screenshot, so a page that taints it never gets here)
export function snipOf({ c, k }, area) {
  const W = c.width / k,
    H = c.height / k;
  const w = Math.min(W, Math.max(SNIP_MIN.w, area.w + 2 * MARGIN)),
    h = Math.min(H, Math.max(SNIP_MIN.h, area.h + 2 * MARGIN));
  const x = Math.min(W - w, Math.max(0, area.x + area.w / 2 - w / 2)),
    y = Math.min(H - h, Math.max(0, area.y + area.h / 2 - h / 2));
  const out = document.createElement('canvas');
  out.width = Math.round(w * k);
  out.height = Math.round(h * k);
  out.getContext('2d').drawImage(c, x * k, y * k, w * k, h * k, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

// A mark as its note: its anchor (anchor.js v1, document px; live: its element), its words and how they came, its snip.
// Returns the note. by: the call's agent, for its own ink on the call's page (callnotes.js), which nobody hears of: the
// board's notes are heard as they go in ('pencil:note', with the call they're on, if any).
export async function post(r, { anchor, live, words, said, snip, by }) {
  const owner = r.call ? null : await ownerOf(r, live);
  if (!r.call) return scrap(r, { anchor, words, said, snip, owner });
  const page = await pageOf(r, owner);
  const { note } = await send('/note', { page: page.id, anchor, words, said, snip, ...(by ? { by } : {}) });
  if (owner) r.lastOwner = owner; // (the sheet review mode's menu names: menu.js.)
  if (!by)
    document.dispatchEvent(
      new CustomEvent('pencil:note', { detail: { id: note.id, n: note.n, page: page.id, call: page.call ?? null } }),
    );
  return note;
}
// Off a call, the mark is a scrap on the newest page of My Notebook (the board's pin flow, 27 Oct: not a sheet), the
// owner the one its page's send gives it to. Returns the group, with group: true (its id and page are the group's).
async function scrap(r, { anchor, words, said, snip, owner }) {
  const g = await toNotebook('/groups/scrap', { anchor, words, said, snip, owner });
  r.lastOwner = owner;
  document.dispatchEvent(
    new CustomEvent('pencil:note', { detail: { id: g.id, page: g.page, call: null, group: true } }),
  );
  return { ...g, group: true };
}
// ...taken back: deleted (the Notebook keeps it aside for its Undo)
export async function unscrap(id) {
  await toNotebook('/groups/delete', { id });
  document.dispatchEvent(new CustomEvent('pencil:wiped', { detail: { id, back: false, group: true } }));
}
// A note wiped (the last one in, taken back): gone from its sheet, and heard so by whatever else shows the book's notes
// (a second screen, pair.js)
export async function wipe(id) {
  await send('/note/delete', { id });
  document.dispatchEvent(new CustomEvent('pencil:wiped', { detail: { id, back: false } }));
}
