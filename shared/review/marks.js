// The marks on an HQ page (review mode with the book, data-book on its script: pencil.js): each mark a note in the
// book's store (the coordinator's /api/book routes, booknotes.ts), its ink drawn on the page where its element is now
// (anchor.js). The mark being made is drawn in full, numbered when several need telling apart; once its note is in the
// book it's a faint hairline there, the page clean for the next (no fade). A mark goes on the sheet of the agent whose work it's on (data-owner on HQ's page; nobody's: the CEO's), on that
// agent's page in today's book; a sent one stays as a hairline. On a call, the call's page. Every change is a step the
// two-finger tap takes back (pencil.js).
import { ACCENT, keep, kept } from './base.js';
import * as inkjs from './ink.js';
import { placer } from './anchor.js';
import { boxOfLines, nearLines } from './mark.js';
import { insideRing } from './carry.js';
import { under } from './layer.js';
import { shows } from './markshows.js';
import { shownNumbers } from './notenumbers.js';
import { drawHairlines } from './hairline.js';
import { get, here, onThisPage, ownerOf, pageOf, send } from './markpage.js';
import { answered, tab } from './slip.js';

// A snip: the page around a mark, the ink on it, with this much margin round the ink (the book shows it at its width)
const MARGIN = 24;
const SNIP_MIN = { w: 240, h: 150 };
// A scribble wipes what it crosses: a mark or a hairline whose ink comes this close to its box (px), so a quick zigzag
// that ends a stroke-width short still counts.
const SCRIBBLE_PX = 10;

// The notes made on this HQ page, any day, from the store: open ones drawn as marks, each with its number now; sent
// ones kept as r.sent (hairlines). On a call, the call's page's notes (loadCall).
export async function load(r) {
  const url = here();
  if (r.call) return loadCall(r, url, r.call.call);
  const { notes } = await get(`/notes?url=${encodeURIComponent(url)}`);
  if (here() !== url || r.call) return;
  const shown = notes.filter(n => !n.answers && onThisPage(n.anchor));
  const kept = new Map((r.marks ?? []).map(m => [m.id, m.live]));
  r.marks = shown.filter(n => n.status === 'open').map(n => markOf(n, kept));
  r.sent = shown.filter(n => n.status === 'sent' && !clearedHairs().includes(n.id));
  paint(r);
  r.loaded?.(); // (what waits on the page's notes: markslips.js cutsWhenStill.)
}
// On a call, the call's page's notes drawn on this HQ page, the board's and its agent's (by)
async function loadCall(r, url, call) {
  const day = await get('');
  const page = day.pages.find(p => p.kind === 'call' && p.call === call);
  const moved = () => here() !== url || r.call?.call !== call;
  if (moved()) return;
  r.sent = [];
  if (!page) {
    r.marks = [];
    return paint(r);
  }
  r.bookPage = { id: page.id, url: null, call };
  const { notes } = await get(`/notes?page=${page.id}`);
  if (moved()) return;
  const kept = new Map((r.marks ?? []).map(m => [m.id, m.live]));
  r.marks = notes
    .filter(n => n.status === 'open' && !n.answers && pathOf(n.anchor.url) === url)
    .map(n => markOf(n, kept));
  paint(r);
}
const pathOf = url => {
  const u = new URL(url, location.href);
  return u.pathname + u.search;
};
// A note as its mark on the page (live: its element, kept from the mark it was)
const markOf = (n, kept = new Map()) => ({
  id: n.id,
  n: n.n,
  page: n.page,
  // (its sheet, whose that is and whether a call's.)
  sheet: n.sheet,
  owner: n.owner,
  onCall: n.onCall,
  anchor: n.anchor,
  live: kept.get(n.id) ?? null,
  by: n.by,
  words: n.words,
  said: n.said,
  // (its answers, and its snip for their then and now.)
  slips: n.slips ?? [],
  snip: n.snip,
});

// The number the mark being made will have: one past its owner's open sheet's notes (counted, no page made for it), or
// on a call, past the call's page's
export async function nextNumber(r) {
  if (r.call) {
    const page = r.bookPage?.call === r.call.call ? r.bookPage : null;
    return page ? (await get(`/notes?page=${page.id}`)).notes.length + 1 : 1;
  }
  const [owner, { open }] = await Promise.all([ownerOf(r, r.mark?.el), get('/sheets')]);
  const sheet = open.find(s => s.owner === owner && s.status === 'open');
  return (sheet?.notes.length ?? 0) + 1;
}

// The open mark's lines where its element is now: drawn on the screen as it was at its first line, they move as the
// element has moved since (the page scrolled under a finger, or a box of it did)
export function openLines(r, lines = r.strokes) {
  const m = r.mark,
    then = m?.element?.rect,
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

// A closed mark's lines on the screen now
export function placed(m) {
  const scroll = { x: scrollX, y: scrollY },
    at = placer(m.anchor, document, scroll, m.live);
  return m.anchor.ink.map(l => ({
    ...l,
    points: l.points.map(p => {
      const [x, y, ...rest] = at(p);
      return [x - scroll.x, y - scroll.y, ...rest];
    }),
  }));
}

// A pinned mark's element on the screen now (or where it was), for its number
function elementNow(m) {
  const b = m.anchor.el?.box;
  if (!b) return null;
  const [x, y] = placed({ ...m, anchor: { ...m.anchor, ink: [{ points: [[b.x, b.y]] }] } })[0].points[0];
  return { x, y, w: 0, h: 0 };
}

// Where a closed mark is on the screen now: around its lines, or at its element's corner (a pin)
export const whereNow = (m, ink = placed(m)) => (ink.length ? boxOfLines(ink) : elementNow(m));

// Every mark on the page as it is now, with its number, and the lines of the one being made (or a changed note's)
export function paint(r, lines = r.strokes) {
  const c = r.inkCanvas,
    g = inkjs.fit(c);
  // (the sent notes' ink first, as hairlines under the marks.)
  const hairs = hairsNow(r);
  drawHairlines(
    g,
    hairs.flatMap(h => h.lines),
  );
  // (one with an answer not yet ticked shows its slip's corner.)
  for (const h of hairs) if (answered(h.note)) tab(g, boxOfLines(h.lines));
  // (the open notes on the screen now, numbered only where several need telling apart, the one being made among them:
  // notenumbers.js.)
  // (the mark being made, till its note is in the book: then its hairline.)
  const filed = !!r.mark?.filed,
    open = filed ? [] : lines === r.strokes ? openLines(r, lines) : lines,
    pinned = !filed && r.mark?.kind === 'pin' && r.mark.element?.rect,
    making = r.markNumber && (open.length || pinned);
  r.numbers = shownNumbers(making ? [{ id: NEW, n: r.markNumber }] : []);
  const shown = [];
  if (open.length) {
    inkjs.draw(g, open, { halo: true });
    shown.push(...open);
  }
  // (the lines drawn while the last mark goes in: settle.js.)
  if (r.nextLines?.length) {
    inkjs.draw(g, r.nextLines, { halo: true });
    shown.push(...r.nextLines);
  }
  if (r.numbers.get(NEW)) disc(g, open.length ? boxOfLines(open) : pinned, r.numbers.get(NEW));
  // (...and the mark being made's, while its post-it holds them as read.)
  const read = r.mark?.written;
  if (read && open.length && r.text?.value.trim() === read) tag(g, boxOfLines(open), read, TYPE_INK, TYPE);
  inkjs.shown(c, shown, { halo: true });
}
// (the mark being made, among the page's numbers.)
const NEW = 'new';
// Whether a note's mark shows on the screen now: only while what it was drawn on is there (markshows.js). ink: its
// lines placed now, if they're at hand.
export const showsNow = (r, m, ink = placed(m)) =>
  shows(m.anchor, m.live, ink.length ? boxOfLines(ink) : null, (x, y) => under(r, x, y));

// ---- hairlines: the page's notes (sent ones, and those still on their sheet), their ink where it is now. (the open
// ones)
export const hairsNow = r =>
  [...(r.sent ?? []), ...(r.marks ?? [])]
    .filter(n => n.anchor.ink?.length)
    .map(note => ({ note, lines: placed(note) }))
    .filter(h => showsNow(r, h.note, h.lines));
// The number in a red disc, at the top left of what's marked
function disc(g, b, n) {
  const x = Math.max(12, b.x - 6),
    y = Math.max(12, b.y - 6);
  g.save();
  g.beginPath();
  g.arc(x, y, 11, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.beginPath();
  g.arc(x, y, 9.5, 0, Math.PI * 2);
  g.fillStyle = ACCENT;
  g.fill();
  g.fillStyle = '#fff';
  g.font = '700 12px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), x, y + 0.5);
  g.restore();
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

// A mark under a point on the screen (a scribble's, to wipe it): the open one first, then the newest
export function markAt(r, area) {
  const hits = ink => nearLines(area, ink, SCRIBBLE_PX);
  if (r.mode === 'note' && hits(openLines(r))) return 'open';
  // (only a mark that shows)
  return (
    [...(r.marks ?? [])].reverse().find(m => {
      const ink = placed(m);
      return hits(ink) && showsNow(r, m, ink);
    }) ?? null
  );
}

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
  const page = await pageOf(r, owner);
  const { note } = await send('/note', { page: page.id, anchor, words, said, snip, ...(by ? { by } : {}) });
  if (owner) r.lastOwner = owner; // (the sheet review mode's menu names: menu.js.)
  r.marks = [...(r.marks ?? []), { ...markOf(note), page: page.id, live }];
  paint(r);
  if (!by)
    document.dispatchEvent(
      new CustomEvent('pencil:note', { detail: { id: note.id, n: note.n, page: page.id, call: page.call ?? null } }),
    );
  return note;
}
// A sent note's hairline scribbled over: cleared from HQ on this screen (the note stays in the book, sent), and back
// with an undo.
const CLEARED_KEY = '__hq_cleared_hairlines';
const clearedHairs = () => JSON.parse(kept(localStorage, CLEARED_KEY) ?? '[]');
// The sent note whose hairline a scribble over an area crosses, the newest first, or null
export function sentHairAt(r, area) {
  return (
    [...(r.sent ?? [])].reverse().find(n => {
      const ink = placed(n);
      return nearLines(area, ink, SCRIBBLE_PX) && showsNow(r, n, ink);
    }) ?? null
  );
}
// The hairline ring a finger presses inside, with a snip to carry into the book: { now: its points, snip }, or null
export function hairRingAt(r, at) {
  const hit = hairsNow(r).findLast(
    h => h.note.snip && h.lines[0]?.points.length > 2 && insideRing(h.lines[0].points, at),
  );
  return hit ? { now: hit.lines[0].points, snip: hit.note.snip } : null;
}
// (every one kept: a note's id is a few bytes, so a lifetime of scribbles stays far inside the screen's storage, and a
// cleared hairline never comes back unasked.)
export function clearHair(r, n, cleared = true) {
  const ids = clearedHairs().filter(id => id !== n.id);
  keep(localStorage, CLEARED_KEY, JSON.stringify(cleared ? [...ids, n.id] : ids));
  r.sent = cleared ? r.sent.filter(x => x.id !== n.id) : [...r.sent.filter(x => x.id !== n.id), n];
  paint(r);
}
// (a note wiped or back, for whatever else shows the book's notes: a second screen, pair.js.)
const wiped = (id, back) => document.dispatchEvent(new CustomEvent('pencil:wiped', { detail: { id, back } }));
// A note wiped: gone from its sheet, then from the page (load numbers the rest again, as the store has)
export async function wipe(r, m) {
  await send('/note/delete', { id: m.id });
  r.marks = r.marks.filter(x => x.id !== m.id);
  paint(r);
  wiped(m.id, false);
}
// ...and brought back as it was, the same note (its id, writer, words, mark and snip: booknotes.ts restoreNote), last
// on its sheet.
export async function unwipe(r, m) {
  const { note } = await send('/note/restore', { id: m.id });
  r.marks = [...r.marks, { ...markOf(note), live: m.live }];
  wiped(m.id, true);
}
