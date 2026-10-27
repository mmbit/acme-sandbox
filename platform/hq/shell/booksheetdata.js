// The book's sheets from the coordinator's store (booknotes.ts, booksheets.ts, booksend.ts), or in dev mode from mock/book-sheets.json,
// played in memory as the store would: numbered notes, ten seconds to undo a send, moves, wipes, order and links.
//   sheets: { open: [sheet], sent: [sheet] }; a sheet { id, owner, name, status, send_at, sent, page, notes: [note] };
//   a note { id, sheet, page, n, by, anchor, words, said, snip, status, slips, links, guest, owner, onCall }
import { act as call, copy, get, refused } from './data.js';

// Each write told on the document (book:wrote), for a second screen's book to read again.
const act = (url, body) =>
  call(url, body).then(answer => {
    if (body !== undefined) document.dispatchEvent(new CustomEvent('book:wrote'));
    return answer;
  });

// the store's ten seconds (booknotes.ts SEND_MS)
export const SEND_MS = 10_000;

export const loadSheets = dev => (dev ? mockSheets() : act('/api/book/sheets'));
// The sheets of these call pages' notes (dev mode's book has no calls).
export const loadCalls = (dev, pages) =>
  dev ? Promise.resolve([]) : act(`/api/book/calls?pages=${pages.join()}`).then(answer => answer.calls);
// Each answers as the store does: a sheet, or { note, sheet }
// (spots: where its notes lie on their pages, for the board's writing beside them.)
export const sendSheet = (dev, id, spots) => (dev ? mockSend(id) : act('/api/book/send', { id, spots }));
export const undoSend = (dev, id) => (dev ? mockUndo(id) : act('/api/book/undo', { id }));
export const editNote = (dev, id, words) =>
  dev ? mockEdit(id, words) : act('/api/book/note/edit', { id, words, said: 'typed' });
export const moveNote = (dev, id, to) => (dev ? mockMove(id, to) : act('/api/book/note/move', { id, to }));
export const wipeNote = (dev, id) => (dev ? mockWipe(id) : act('/api/book/note/delete', { id }));
export const orderSheet = (dev, id, notes) =>
  dev ? mockOrder(id, notes) : act('/api/book/sheet/order', { id, notes });
export const linkNotes = (dev, id, to, linked) =>
  dev ? mockLink(id, to, linked) : act('/api/book/note/link', { id, to, linked });
export const sendPage = (dev, id, to) => (dev ? mockSendPage(id, to) : act('/api/book/page/send', { id, to }));
// Undo of a wipe: the store brings the same note back as it was, on its owner's open sheet ({ note, sheet })
export const restoreNote = (dev, id) => (dev ? mockRestore(id) : act('/api/book/note/restore', { id }));
// An answer's slip ticked (its note closed) or not ({ slip, note }), and a reply written under it: a new note on its
// owner's open sheet, a question asked now ({ note, sheet, asked }).
export const tickSlip = (dev, id, ticked) => (dev ? mockTick(id, ticked) : act('/api/book/slip/tick', { id, ticked }));
export const replySlip = (dev, id, words) => (dev ? mockReply(id, words) : act('/api/book/slip/reply', { id, words }));

// ---- dev mode
let mock = null,
  ids = 1000;
async function state() {
  mock ??= await get('mock/book-sheets.json').then(s => [...s.open, ...s.sent]);
  return mock;
}
const sheetOf = async id => (await state()).find(s => s.id === Number(id)) ?? Promise.reject(refused(404, 'not found'));
async function noteOf(id) {
  for (const s of await state()) for (const n of s.notes) if (n.id === Number(id)) return { s, n };
  throw refused(404, 'not found');
}
const opened = s => s.notes.filter(n => n.status === 'open');
const number = s => opened(s).forEach((n, i) => (n.n = i + 1));
// a send whose seconds are over goes, as GET sheets does on the store
async function mockSheets() {
  const all = await state();
  for (const s of all)
    if (s.status === 'sending' && s.send_at <= Date.now()) {
      Object.assign(s, { status: 'sent', sent: new Date().toISOString(), send_at: null });
      for (const n of opened(s)) n.status = 'sent';
    }
  return copy({
    open: all.filter(s => s.status !== 'sent'),
    sent: all.filter(s => s.status === 'sent').reverse(),
  });
}
async function mockSend(id) {
  const s = await sheetOf(id);
  if (s.status === 'sent') throw refused(404, 'not found');
  if (s.status === 'open') Object.assign(s, { status: 'sending', send_at: Date.now() + SEND_MS });
  return copy(s);
}
async function mockUndo(id) {
  const s = await sheetOf(id);
  if (s.status !== 'sending' || s.send_at <= Date.now()) throw refused(409, 'too late to undo: the sheet has gone');
  if (s.page) {
    mock.splice(mock.indexOf(s), 1);
    return { id: s.id, status: 'undone' };
  }
  Object.assign(s, { status: 'open', send_at: null });
  return copy(s);
}
async function mockEdit(id, words) {
  const { n } = await noteOf(id);
  Object.assign(n, { words, said: words ? 'typed' : null });
  return copy({ note: n });
}
// an owner's open batch, made if there's none
async function batchOf(owner) {
  const all = await state();
  const found = all.find(s => s.owner === owner && s.status !== 'sent' && !s.page);
  if (found) return found;
  const s = { id: ++ids, owner, name: null, status: 'open', send_at: null, sent: null, page: null, notes: [] };
  all.push(s);
  return s;
}
async function mockMove(id, to) {
  const { s, n } = await noteOf(id),
    into = await batchOf(to);
  if (into === s) return copy({ note: n, sheet: s });
  s.notes.splice(s.notes.indexOf(n), 1);
  number(s);
  unlinked(n);
  into.notes.push(Object.assign(n, { sheet: into.id, links: [] }));
  number(into);
  return copy({ note: n, sheet: into });
}
// (a wiped note kept for its Undo, by id, with its sheet's owner)
const wiped = new Map();
async function mockWipe(id) {
  const { s, n } = await noteOf(id);
  s.notes.splice(s.notes.indexOf(n), 1);
  unlinked(n);
  number(s);
  wiped.set(id, { n, owner: s.owner });
  return { ok: true };
}
async function mockRestore(id) {
  const w = wiped.get(id);
  if (!w) throw refused(404, 'not found');
  wiped.delete(id);
  const s = await batchOf(w.owner);
  s.notes.push(Object.assign(w.n, { sheet: s.id, links: [] }));
  number(s);
  return copy({ note: w.n, sheet: s });
}
async function mockOrder(id, order) {
  const s = await sheetOf(id);
  s.notes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  number(s);
  return copy(s);
}
async function mockLink(id, to, linked) {
  const [a, b] = [await noteOf(id), await noteOf(to)];
  if (a.s !== b.s) throw refused(400, 'notes go together on one sheet');
  const tie = (x, y) =>
    (x.links = linked ? [...new Set([...(x.links ?? []), y.id])] : (x.links ?? []).filter(i => i !== y.id));
  tie(a.n, b.n);
  tie(b.n, a.n);
  return copy(a.s);
}
function unlinked(n) {
  for (const s of mock) for (const m of s.notes) m.links = (m.links ?? []).filter(i => i !== n.id);
}
async function mockSendPage(id, to) {
  const all = await state(),
    page = { id: ++ids, owner: to, name: null, status: 'sending', send_at: Date.now() + SEND_MS, sent: null, page: id };
  const anchor = {
    v: 1,
    url: `/api/book/picture?id=${id}`,
    el: null,
    view: { x: 0, y: 0, w: 1, h: 1, dpr: 2 },
    ink: [],
  };
  page.notes = [
    { id: ++ids, sheet: page.id, page: id, n: 1, by: 'board', anchor, words: '', status: 'open', links: [] },
  ];
  all.push(page);
  return copy(page);
}
async function slipOf(id) {
  for (const s of await state())
    for (const n of s.notes) for (const slip of n.slips ?? []) if (slip.id === Number(id)) return { s, n, slip };
  throw refused(404, 'not found');
}
async function mockTick(id, ticked) {
  const { n, slip } = await slipOf(id);
  slip.ticked = ticked ? new Date().toISOString() : null;
  if (n.status !== 'open') n.status = n.slips.some(x => !x.ticked) ? 'sent' : 'closed';
  return copy({ slip, note: n });
}
async function mockReply(id, words) {
  const { s, n, slip } = await slipOf(id),
    into = await batchOf(s.owner);
  const note = { id: ++ids, sheet: into.id, page: n.page, n: 0, by: 'board', anchor: n.anchor, words, said: 'written' };
  into.notes.push(Object.assign(note, { status: 'open', answers: slip.id, slips: [], links: [] }));
  number(into);
  return copy({ note, sheet: into, asked: null });
}
