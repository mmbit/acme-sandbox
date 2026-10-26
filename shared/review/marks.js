// The marks on an HQ page (review mode with the book, data-book on its script: pencil.js): each mark a note in the
// book's store (the coordinator's /api/book routes, booknotes.ts), its ink drawn on the page where its element is now
// (anchor.js), with its number in a disc beside it (red for the board's, an agent's own ink for its): the number the
// note has on its sheet, so the page and the sheet point at each other. The note being made shows the number it will
// have. Only the page's open notes show: a sent one is the sheet's. Every change is a step the two-finger tap takes
// back (pencil.js).
import { ACCENT } from './base.js';
import * as inkjs from './ink.js';
import { placer } from './anchor.js';
import { boxOfLines } from './mark.js';

const API = '/api/book';
// A snip: the page around a mark, the ink on it, with this much margin round the ink (the book shows it at its width)
const MARGIN = 24;
const SNIP_MIN = { w: 240, h: 150 };

const json = async res => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
};
const get = path => fetch(API + path, { credentials: 'same-origin' }).then(json);
const send = (path, body) =>
  fetch(API + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);

// HQ's page as the book names it: its path and query, never its fragment
const here = () => location.pathname + location.search;

// Who a page nobody owns is for: the company's CEO. Cached once asked, never a failed ask
const ownerOf = async r => (r.owner ??= (await fetch('/api/org').then(json)).company?.ceo);

// This HQ page's page in today's book (a sheet's page, made at its first note), and who it's for: the company's CEO,
// as a page nobody owns goes to them (the sheets thread gives each screen its owner). On a call, the call's page.
async function pageOf(r) {
  if (r.call) return callPage(r);
  const url = here();
  if (r.bookPage?.url === url) return r.bookPage;
  const [day, owner] = await Promise.all([get(''), ownerOf(r)]);
  const found = day.pages.find(p => p.kind === 'sheet' && p.url === url && p.owner === owner);
  const page =
    found ??
    (await send('/page/new', {
      kind: 'sheet',
      owner,
      url,
      w: Math.min(4000, Math.max(100, innerWidth)),
      h: Math.min(4000, Math.max(100, innerHeight)),
    }));
  return (r.bookPage = { id: page.id, url, owner });
}

// A call's page in today's book (callnotes.js): made at the call's first mark, the board's or its agent's, so a call
// nobody drew on leaves none. Asked once a call, so two first marks make one page.
function callPage(r) {
  const call = r.call.call;
  if (r.bookPage?.call === call) return r.bookPage;
  if (r.callPage?.call !== call)
    r.callPage = {
      call,
      page: (async () => {
        const day = await get('');
        const page =
          day.pages.find(p => p.kind === 'call' && p.call === call) ??
          (await send('/page/new', { kind: 'call', call, label: `Call with ${r.call.name}`, ...size() }));
        return (r.bookPage = { id: page.id, url: null, call });
      })().catch(err => {
        r.callPage = null; // (asked again at the next mark)
        throw err;
      }),
    };
  return r.callPage.page;
}
const size = () => ({
  w: Math.min(4000, Math.max(100, innerWidth)),
  h: Math.min(4000, Math.max(100, innerHeight)),
});

// The page's open notes again, from the store: their marks drawn, each with its number now. On a call, the call's
// page's notes drawn on this HQ page, the board's and its agent's (by).
export async function load(r) {
  const url = here(),
    call = r.call?.call;
  const day = await get('');
  const owner = call ? null : await ownerOf(r);
  const page = day.pages.find(p =>
    call ? p.kind === 'call' && p.call === call : p.kind === 'sheet' && p.url === url && p.owner === owner,
  );
  const moved = () => here() !== url || r.call?.call !== call;
  if (moved()) return;
  if (!page) {
    r.marks = [];
    return paint(r);
  }
  r.bookPage = call ? { id: page.id, url: null, call } : { id: page.id, url, owner: page.owner };
  const { notes } = await get(`/notes?page=${page.id}`);
  if (moved()) return;
  const kept = new Map(r.marks.map(m => [m.id, m.live]));
  r.marks = notes
    .filter(n => n.status === 'open' && !n.answers && (!call || pathOf(n.anchor.url) === url))
    .map(n => ({ id: n.id, n: n.n, anchor: n.anchor, live: kept.get(n.id) ?? null, by: n.by, words: n.words }));
  paint(r);
}
const pathOf = url => {
  const u = new URL(url, location.href);
  return u.pathname + u.search;
};

// The number the mark being made will have: one past its owner's open sheet's notes (counted, no page made for it), or
// on a call, past the call's page's
export async function nextNumber(r) {
  if (r.call) {
    const page = r.bookPage?.call === r.call.call ? r.bookPage : null;
    return page ? (await get(`/notes?page=${page.id}`)).notes.length + 1 : 1;
  }
  const [owner, { open }] = await Promise.all([ownerOf(r), get('/sheets')]);
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
function placed(m) {
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
  for (const m of r.marks ?? []) {
    const ink = placed(m),
      at = whereNow(m, ink);
    if (ink.length) inkjs.draw(g, ink, { halo: true });
    shown.push(...ink);
    const by = theirs(r, m);
    if (at) disc(g, at, m.n, by?.color);
    if (at && by && m.words) tag(g, at, `${by.name}: ${m.words}`, by.color);
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
  inkjs.shown(c, shown, { halo: true });
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
function tag(g, b, words, color) {
  g.save();
  g.font = HAND;
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
  const page = await pageOf(r);
  const { note } = await send('/note', { page: page.id, anchor, words, said, snip, ...(by ? { by } : {}) });
  r.marks = [...(r.marks ?? []), { id: note.id, n: note.n, anchor: note.anchor, live, by: note.by, words: note.words }];
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
// ...and brought back, as a new note with the same anchor, words and snip (noteOf's)
export async function unwipe(r, m, note) {
  const page = await pageOf(r);
  const { note: back } = await send('/note', {
    page: page.id,
    anchor: m.anchor,
    words: note.words,
    said: note.said,
    snip: note.snip,
    ...(m.by && m.by !== 'board' ? { by: m.by } : {}), // (an agent's ring on a call's page stays its)
  });
  r.marks = [...r.marks, { ...m, id: back.id, n: back.n }];
  // (the store gave the note a new id: the step that takes back its sending names it now)
  r.steps = r.steps.map(s => (s.kind === 'note' && s.id === m.id ? { ...s, id: back.id } : s));
  return back;
}
// A note as it is on the store, its snip read as a data URL (a wipe keeps them, to bring it back)
export async function noteOf(r, id) {
  const note = (await get(`/notes?page=${r.bookPage.id}`)).notes.find(n => n.id === id);
  if (!note) throw new Error(`Note ${id} is no longer on this page in the book`);
  if (!note.snip) return note;
  const res = await fetch(note.snip, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`The snip of note ${id}: HTTP ${res.status}`);
  const blob = await res.blob();
  const snip = await new Promise((done, fail) => {
    const f = new FileReader();
    f.onload = () => done(f.result);
    f.onerror = () => fail(f.error);
    f.readAsDataURL(blob);
  });
  return { ...note, snip };
}
