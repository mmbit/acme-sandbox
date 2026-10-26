// The marks on an HQ page (review mode with the book, data-book on its script: pencil.js): each mark a note in the
// book's store (the coordinator's /api/book routes, booknotes.ts), its ink drawn on the page where its element is now
// (anchor.js), with its number in a disc beside it (red for the board's, an agent's own ink for its): the number the
// note has on its sheet, so the page and the sheet point at each other. The note being made shows the number it will
// have. A mark goes on the sheet of the agent whose work it's on (data-owner on HQ's page; nobody's: the CEO's), on that
// agent's page in today's book; a sent one stays as a hairline. On a call, the call's page. Every change is a step the
// two-finger tap takes back (pencil.js).
import { ACCENT } from './base.js';
import * as inkjs from './ink.js';
import { placer } from './anchor.js';
import { boxOfLines } from './mark.js';
import { REACH, cardOpen, drawHairlines, hairAt, hideCard, showCard } from './hairline.js';
import { get, here, onThisPage, ownerOf, pageOf, send } from './markpage.js';
import { answered, answeredNow, slipActs, tab } from './markslips.js';

// A snip: the page around a mark, the ink on it, with this much margin round the ink (the book shows it at its width)
const MARGIN = 24;
const SNIP_MIN = { w: 240, h: 150 };

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
  r.sent = shown.filter(n => n.status === 'sent');
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
    g = inkjs.fit(c),
    shown = [];
  // (the sent notes' ink first, as hairlines under the marks.)
  const hairs = hairsNow(r);
  drawHairlines(
    g,
    hairs.flatMap(h => h.lines),
  );
  // (one with an answer not yet ticked shows its slip's corner.)
  for (const h of hairs) if (answered(h.note)) tab(g, boxOfLines(h.lines));
  for (const m of r.marks ?? []) {
    const ink = placed(m),
      at = whereNow(m, ink);
    if (ink.length) inkjs.draw(g, ink, { halo: true });
    shown.push(...ink);
    const by = theirs(r, m);
    if (at) disc(g, at, m.n, by?.color);
    if (at && answered(m)) tab(g, at);
    if (at && by && m.words) tag(g, at, `${by.name}: ${m.words}`, by.color);
    // (the board's handwriting, read: its words as type beside it.)
    else if (at && m.said === 'written' && m.words) tag(g, at, m.words, TYPE_INK, TYPE);
  }
  const open = lines === r.strokes ? openLines(r, lines) : lines;
  if (open.length) {
    inkjs.draw(g, open, { halo: true });
    shown.push(...open);
  }
  // (on a call, the lines drawn while the last mark goes in: callnotes.js.)
  if (r.callLines?.length) {
    inkjs.draw(g, r.callLines, { halo: true });
    shown.push(...r.callLines);
  }
  const pinned = r.mark?.kind === 'pin' && r.mark.element?.rect;
  if (r.markNumber && (open.length || pinned)) disc(g, open.length ? boxOfLines(open) : pinned, r.markNumber);
  // (...and the mark being made's, while its post-it holds them as read.)
  const read = r.mark?.written;
  if (read && open.length && r.text?.value.trim() === read) tag(g, boxOfLines(open), read, TYPE_INK, TYPE);
  inkjs.shown(c, shown, { halo: true });
}

// ---- hairlines: the page's sent notes, their ink where it is now.
const hairsNow = r =>
  (r.sent ?? []).filter(n => n.anchor.ink?.length).map(note => ({ note, lines: placed({ anchor: note.anchor }) }));
// When a sent note went: its sheet's sending time (the book's latest sent sheets, asked once a tap needs one), else the
// last time the note changed
async function sentAt(r, note) {
  r.sentTimes ??= get('/sheets').then(
    ({ sent }) => new Map(sent.map(s => [s.id, s.sent])),
    () => new Map(),
  );
  return (await r.sentTimes).get(note.sheet) ?? note.updated ?? note.created;
}
// A finger's tap on a hairline opens its card there; a tap anywhere else closes it and stays the page's. A tap that lands
// on one is the card's alone: the page hears its touch cancelled, as when the browser takes a touch to scroll, and
// no click.
const TAP = { px: 10, ms: 500 };
export function hairTaps(r) {
  let down = null;
  const swallowClick = c => c.isTrusted && c.stopPropagation();
  addEventListener(
    'pointerdown',
    e => {
      const path = e.composedPath();
      if (cardOpen(r) && !path.includes(r.host)) hideCard(r);
      down =
        e.pointerType === 'touch' && e.isPrimary && !path.includes(r.host) && path.includes(document.body)
          ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
          : null;
    },
    true,
  );
  addEventListener(
    'pointerup',
    e => {
      if (!down || e.pointerId !== down.id) return;
      const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP.px && e.timeStamp - down.t < TAP.ms;
      down = null;
      if (!tap || r.covered || !r.veil.hidden) return;
      const hit = hairAt([...hairsNow(r), ...answeredNow(r)], [e.clientX, e.clientY], REACH);
      if (!hit) return;
      e.stopPropagation();
      e.target.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          isPrimary: true,
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
          composed: true,
        }),
      );
      addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallowClick, true), 400);
      const open = !(r.sent ?? []).includes(hit.note); // (a mark: a note still on its sheet)
      showCard(r, hit.note, [e.clientX, e.clientY], open ? null : sentAt(r, hit.note), slipActs);
    },
    true,
  );
  addEventListener('scroll', () => hideCard(r), { capture: true, passive: true });
}

// The number in a red disc (an agent's in its own ink), at the top left of what's marked
function disc(g, b, n, color = ACCENT) {
  const x = Math.max(12, b.x - 6),
    y = Math.max(12, b.y - 6);
  g.save();
  g.beginPath();
  g.arc(x, y, 11, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.beginPath();
  g.arc(x, y, 9.5, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.fillStyle = '#fff';
  g.font = '700 12px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), x, y + 0.5);
  g.restore();
}
// An agent's mark on a call's page: who drew it, in what ink (its ring's); null for the board's own.
function theirs(r, m) {
  if (!m.by || m.by === 'board') return null;
  return { name: m.by === r.call?.agent ? r.call.name : m.by, color: m.anchor.ink[0]?.color ?? ACCENT };
}
// An agent's words beside its ring, in its ink and a hand of its own, a white edge under them so they read on any page
const HAND = '600 15px "Bradley Hand", "Segoe Print", "Chalkboard SE", "Comic Sans MS", cursive',
  TAG_W = 240;
// (the board's handwriting read into type: set in the page's own kind of type, dark, so it reads as the words and the
// ink beside it as the hand.)
const TYPE = '500 14px system-ui, -apple-system, "Segoe UI", sans-serif',
  TYPE_INK = '#2b2230';
function tag(g, b, words, color, font = HAND) {
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
  const hits = (ink, pad = 10) => {
    if (!ink.length) return false;
    const b = boxOfLines(ink);
    return (
      area.x < b.x + b.w + pad && area.x + area.w > b.x - pad && area.y < b.y + b.h + pad && area.y + area.h > b.y - pad
    );
  };
  if (r.mode === 'note' && hits(openLines(r))) return 'open';
  return [...(r.marks ?? [])].reverse().find(m => hits(placed(m))) ?? null;
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
  const page = await pageOf(r, r.call ? null : await ownerOf(r, live));
  const { note } = await send('/note', { page: page.id, anchor, words, said, snip, ...(by ? { by } : {}) });
  r.marks = [...(r.marks ?? []), { ...markOf(note), page: page.id, live }];
  paint(r);
  if (!by)
    document.dispatchEvent(
      new CustomEvent('pencil:note', { detail: { id: note.id, n: note.n, page: page.id, call: page.call ?? null } }),
    );
  return note;
}
// A note wiped: gone from its sheet, then from the page (load numbers the rest again, as the store has)
export async function wipe(r, m) {
  await send('/note/delete', { id: m.id });
  r.marks = r.marks.filter(x => x.id !== m.id);
  paint(r);
}
// ...and brought back as it was, the same note (its id, writer, words, mark and snip: booknotes.ts restoreNote), last
// on its sheet.
export async function unwipe(r, m) {
  const { note } = await send('/note/restore', { id: m.id });
  r.marks = [...r.marks, { ...markOf(note), live: m.live }];
}
