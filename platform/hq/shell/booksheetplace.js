// The sheets on the book's pages as plain data: which notes each sheet page shows, its plane's sheet, a send's seconds,
// where a lifted note lands, and the agents to send a free page to. No DOM, so node tests it.
import { MONTHS } from '../util.js';

// Whose a sheet is, as its page and its face say: nobody's is the CEO's
export const whose = (sheet, ceo) => sheet.owner ?? ceo;
// a batch: an owner's sheet of notes (a free page sent on its own is a one-off sheet, its page's, never a batch)
const batch = s => !s.page;

// The notes each sheet page of a day's row shows, page id → [{ sheet, notes: [{ note, away }] }], sent sheets first
// (oldest first), then the open ones, each in its sheet's order. A note shows on its own page when that page is its
// sheet owner's; one moved to another owner's open sheet shows on that owner's page in the row; one with no such page
// stays on its own, away: whose it is now. A call's notes show on its call's page (calls: the sheets of the row's call
// pages, booksheet.js withCalls.)
export function notesOnPages({ open = [], sent = [], calls = [] }, pages, ceo) {
  const sheetPages = pages.filter(p => p.kind === 'sheet' && p.id),
    home = owner => sheetPages.find(p => p.owner === owner),
    on = new Map(sheetPages.map(p => [p.id, []]));
  const put = (page, sheet, note, away) => {
    const groups = on.get(page.id);
    let g = groups.find(x => x.sheet === sheet);
    if (!g) groups.push((g = { sheet, notes: [] }));
    g.notes.push({ note, away });
  };
  for (const sheet of [...[...sent].reverse(), ...open].filter(batch)) {
    const owner = whose(sheet, ceo);
    for (const note of [...sheet.notes].sort((a, b) => a.n - b.n)) {
      const own = sheetPages.find(p => p.id === note.page);
      if (own?.owner === owner) put(own, sheet, note, null);
      else if (sheet.status !== 'sent' && home(owner)) put(home(owner), sheet, note, null);
      else if (own) put(own, sheet, note, owner);
    }
  }
  for (const sheet of calls)
    for (const note of [...sheet.notes].sort((a, b) => a.n - b.n)) {
      const own = pages.find(p => p.kind === 'call' && p.id === note.page);
      if (!own) continue;
      if (!on.has(own.id)) on.set(own.id, []);
      put(own, sheet, note, null);
    }
  return on;
}

// The sheet a sheet page's plane sends: its owner's open batch (or the one in its seconds to undo) when the page shows
// notes of it (groups: notesOnPages' for the page), or null. (The CEO's page may show the CEO's own and nobody's: the
// first.)
export function planeSheet({ open = [] }, page, ceo, groups = []) {
  const mine = open.filter(s => batch(s) && whose(s, ceo) === page.owner && s.notes.some(n => n.status === 'open'));
  return mine.find(s => groups.some(g => g.sheet === s)) ?? null;
}
// A free page's sends: the one in its seconds to undo, and the last that went
export function pageSends({ open = [], sent = [] }, pageId) {
  return {
    sending: open.find(s => s.page === pageId && s.status === 'sending') ?? null,
    sent: sent.find(s => s.page === pageId) ?? null,
  };
}

// The seconds left to undo a send, 0 to 1 of SEND_MS (1: just tapped)
export const leftOf = (sendAt, now, total) => Math.min(1, Math.max(0, (sendAt - now) / total));

// "Sent 08:16" in the board's own time, the day too when it isn't today ("Sent 25 Oct 08:16"); prefix: its first
// words ("Sent to Kit")
export function sentLine(iso, now = new Date(), prefix = 'Sent') {
  const d = new Date(iso),
    time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString()
    ? `${prefix} ${time}`
    : `${prefix} ${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

// What a send carries, in words: "2 notes", "1 note"; the plane's "Send 2 notes to Juno"; and the line a sent sheet
// keeps, "3 notes sent to Bolt · 15:36" (the day too when it isn't today).
export const notesWord = k => `${k} note${k === 1 ? '' : 's'}`;
export const sendWords = (k, to) => `Send ${notesWord(k)} to ${to}`;
export const sentTo = (k, to, iso, now = new Date()) => sentLine(iso, now, `${notesWord(k)} sent to ${to} ·`);

// Where a lifted note lands among the others: before the first whose middle is below y (their middles top to bottom),
// or after them all
export const slotAt = (middles, y) => middles.filter(m => m < y).length;
// A sheet's notes in their new order (ids, in their order now): `id` moved to slot `slot` among `shown` (the notes the
// page shows of it, in order, id among them), the sheet's notes on other pages kept where they are
export function reordered(ids, shown, id, slot) {
  const rest = shown.filter(x => x !== id),
    before = rest[slot],
    out = ids.filter(x => x !== id);
  const at = before !== undefined ? out.indexOf(before) : out.indexOf(rest[rest.length - 1]) + 1;
  out.splice(at < 0 ? out.length : at, 0, id);
  return out;
}

// A line drawn from one disc to another: the two notes (ids) it joins, or null. discs: [{ id, x, y }] in the page's
// px; reach: how near the line's ends must start and stop
export function joined(points, discs, reach = 18) {
  if (points.length < 2) return null;
  const near = ([x, y]) => discs.find(d => Math.hypot(d.x - x, d.y - y) <= reach);
  const a = near(points[0]),
    b = near(points[points.length - 1]);
  return a && b && a.id !== b.id ? [a.id, b.id] : null;
}

// Every agent to send a free page to: the rail's faces first (their order), then everyone else by name.
// agents: [{ id, name }]
export function sendOrder(agents, faces) {
  const first = faces.filter(id => agents.some(a => a.id === id));
  const rest = agents.filter(a => !first.includes(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  return [...first.map(id => agents.find(a => a.id === id)), ...rest];
}
