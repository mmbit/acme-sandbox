// A notebook page's groups played in memory (notebookplay.js): notebookgroups.ts's routes with the same answers and
// refusals, on the store's state s. A top-level group is a scrap unit (scrapunit.js): its parts in its own scrap px,
// pos its order on the page and h its height; a reply's pos and h are null.
import { anchorOf, dataUrlPicture, inkOf, picturesOf, refuse, textsOf, wordsOf } from './notebookplaychecks.js';
import { emptyGroup, hasAny, picks, typedBoxes } from './notebookparts.js';
import { boxOf, scrapSize } from './notebookstack.js';
import { ROOM, UNIT_W, heightFor, resized, unitOf } from './scrapunit.js';
import { answersOf } from './notebookplayanswers.js';

export const BOARD = 'board';
export const CHANGED = 'this group changed on another screen: read it again';
const SENT = 'a sent page is read-only: what the board wrote there stays';

// A route's handler for its 'METHOD path': (s, the body)
export const GROUP_ROUTES = {
  'POST /api/notebooks/groups/create': createGroup,
  'POST /api/notebooks/groups/scrap': createScrap,
  'POST /api/notebooks/groups/edit': editGroup,
  'POST /api/notebooks/groups/resize': resizeGroup,
  'POST /api/notebooks/groups/move': moveGroup,
  'POST /api/notebooks/groups/delete': deleteGroup,
  'POST /api/notebooks/groups/restore': restoreGroup,
  'POST /api/notebooks/groups/split': splitGroup,
};
// A drawing on an open page, its parts in its own scrap px: a unit at the page's end, or right after unit `after`
function createGroup(s, b) {
  const p = openPage(s, b?.page),
    parts = elementsOf(s, b, emptyGroup);
  if (!hasAny(parts)) refuse(400, 'a group holds something: ink, words or a picture');
  const pos = b.after == null ? endOf(s, p) : posAfter(s, p, Number(b.after));
  return shown(s, insertGroup(s, p, 'drawing', BOARD, parts, { pos, h: heightFor(parts, 0) }));
}
// An open group's elements changed. since: its updated as the screen last read it (one changed since: 409).
function editGroup(s, b) {
  const g = openGroup(s, b?.id);
  if (b.since !== g.updated) refuse(409, CHANGED);
  const parts = elementsOf(s, b, partsOf(g)),
    said = b.words === undefined ? { words: g.words, said: g.said } : wordsOf(b.words, b.said);
  if (!hasAny(parts) && g.kind !== 'scrap') refuse(400, 'an empty group is deleted instead');
  write(s, g, parts, { ...said, h: g.h === null ? null : heightFor(parts, g.h) });
  return shown(s, g);
}
// An open unit made h tall by hand, down no further than its parts reach. since: as edit's.
function resizeGroup(s, b) {
  const g = openGroup(s, b?.id);
  if (g.parent !== null) refuse(400, "a reply isn't a unit: it has no height of its own");
  if (b.since !== g.updated) refuse(409, CHANGED);
  const h = Number(b.h);
  if (b.h === null || !Number.isFinite(h) || h <= 0) refuse(400, 'h is a positive number');
  write(s, g, partsOf(g), { h: resized(partsOf(g), h) });
  return shown(s, g);
}
// An open unit onto an open page, as it was: its last, right after unit `after` there, or its first for after 'start'
function moveGroup(s, b) {
  const g = openGroup(s, b?.id),
    to = openPage(s, b.page);
  if (b.after != null && b.after !== 'start' && Number(b.after) === g.id)
    refuse(400, "after is another unit on that page, or 'start'");
  const from = g.page,
    pos = b.after == null ? endOf(s, to) : b.after === 'start' ? startOf(s, to) : posAfter(s, to, Number(b.after));
  for (const x of s.groups) if (x.id === g.id || x.parent === g.id) x.page = to.id;
  write(s, g, partsOf(g), { pos });
  s.changed(to.notebook, from);
  s.changed(to.notebook, to.id);
  return shown(s, g);
}
function deleteGroup(s, b) {
  const g = s.group(Number(b?.id));
  const p = g && s.page(g.page);
  if (!p || g.deleted !== null) refuse(404);
  if (g.kind === 'reply') refuse(409, 'a reply is taken back with /api/notebooks/replies/delete');
  if (g.status !== 'open' || s.shut(p)) refuse(409, SENT);
  putAside(s, g, p);
  return { ok: true, id: g.id };
}
// Undo of a delete: on its page if that's still open, else on the notebook's current page
function restoreGroup(s, b) {
  const g = s.group(Number(b?.id));
  const p = g && s.page(g.page);
  if (!p || g.deleted === null) refuse(404);
  if (g.kind === 'reply') refuse(409, "a reply taken back isn't sent again: write it again");
  const page = g.parent === null && s.shut(p) ? s.currentPage(p.notebook) : p.id,
    deleted = g.deleted;
  // (on another page it's that page's last unit)
  if (page !== g.page) g.pos = endOf(s, s.page(page));
  for (const x of s.groups)
    if ((x.id === g.id || x.parent === g.id) && x.deleted === deleted) Object.assign(x, { deleted: null, page });
  s.changed(p.notebook, page);
  return shown(s, g);
}
// A scrap onto the current page of a notebook (My journal by default): a unit at its end, room to write under it
function createScrap(s, b) {
  const nb = b?.notebook === undefined ? s.mine() : (s.notebook(Number(b.notebook)) ?? refuse(404));
  const anchor = anchorOf(b.anchor),
    said = wordsOf(b.words, b.said);
  // (an agent the seed names, or any id when it names none)
  const agent = o => typeof o === 'string' && !!o && (!Object.keys(s.names).length || o in s.names);
  if (b.owner != null && !agent(b.owner)) refuse(400, 'owner is the agent whose work the scrap was cut from, or null');
  // (no snip: a note pinned to nothing is its words typed on the page.)
  if (b.snip == null) return typedNote(s, nb, said, { anchor, said: said.said, owner: b.owner ?? null });
  const snip = dataUrlPicture(b.snip);
  const p = s.page(s.currentPage(nb.id)),
    { w, h } = scrapSize(snip.width, snip.height);
  const picture = { file: keepPicture(s, p.id, snip), x: 0, y: 0, w, h, tilt: 0 },
    unit = unitOf({ ...emptyGroup, pictures: [picture] }, ROOM);
  const more = { anchor, words: said.words, said: said.said, owner: b.owner ?? null, pos: endOf(s, p), h: unit.h };
  return shown(s, insertGroup(s, p, 'scrap', BOARD, unit.parts, more));
}
// A note with no picture: its words typed in the post-it's ink, a unit at the page's end as a scrap is
// (notebookscraps.ts addWords)
function typedNote(s, nb, said, more) {
  if (!said.words) refuse(400, 'a note with no picture holds words');
  const texts = textsOf(typedBoxes(said.words, { x: 0, w: UNIT_W, color: '#1d1a2f' })),
    p = s.page(s.currentPage(nb.id)),
    unit = unitOf({ ...emptyGroup, texts }, ROOM);
  return shown(s, insertGroup(s, p, 'note', BOARD, unit.parts, { ...more, pos: endOf(s, p), h: unit.h }));
}
// The elements named (their indexes in the group) lifted out into a unit of their own right after it
function splitGroup(s, b) {
  const g = openGroup(s, b?.id),
    parts = partsOf(g);
  const out = {
    ink: picks(b.ink, parts.ink),
    texts: picks(b.texts, parts.texts),
    pictures: picks(b.pictures, parts.pictures),
  };
  if (Object.values(out).some(t => t === null))
    refuse(400, "ink, texts and pictures are lists of the group's own indexes");
  const left = {
    ink: parts.ink.filter((_, i) => !out.ink.includes(i)),
    texts: parts.texts.filter((_, i) => !out.texts.includes(i)),
    pictures: parts.pictures.filter((_, i) => !out.pictures.includes(i)),
  };
  if (!hasAny(out) || (!hasAny(left) && g.kind !== 'scrap')) refuse(400, 'a split leaves something on each side');
  write(s, g, left, { h: heightFor(left, g.h) });
  const p = s.page(g.page),
    unit = unitOf({
      ink: out.ink.map(i => parts.ink[i]),
      texts: out.texts.map(i => parts.texts[i]),
      pictures: out.pictures.map(i => parts.pictures[i]),
    });
  const lifted = insertGroup(s, p, 'drawing', g.by, unit.parts, { pos: posAfter(s, p, g.id), h: unit.h });
  return { group: shown(s, g), split: shown(s, lifted) };
}

// ---------------------------------------------------------------- shared
// The elements a request gives, each checked, the rest as they were
const elementsOf = (s, b, was) => ({
  ink: b.ink === undefined ? was.ink : inkOf(b.ink),
  texts: b.texts === undefined ? was.texts : textsOf(b.texts),
  pictures: b.pictures === undefined ? was.pictures : picturesOf(b.pictures, s.ours),
});
function openPage(s, v) {
  const p = s.page(Number(v));
  if (!p) refuse(404, 'no such page');
  if (s.shut(p)) refuse(409, 'a sent page is read-only: draw on the current page');
  return p;
}
function openGroup(s, v) {
  const g = s.group(Number(v));
  const p = g && g.deleted === null && s.page(g.page);
  if (!p) refuse(404, 'no such group');
  if (g.status !== 'open' || s.shut(p)) refuse(409, SENT);
  return g;
}
export function insertGroup(s, p, kind, by, parts, more = {}) {
  const now = s.stamp();
  const g = {
    ...{ id: s.next('group'), page: p.id, parent: null, answers: null, kind, by, ...parts, anchor: null, words: '' },
    ...{ pos: null, h: null },
    ...{ said: null, owner: null, status: 'open', note: null, created: now, updated: now, deleted: null, ...more },
  };
  s.groups.push(g);
  s.changed(p.notebook, p.id);
  return g;
}
function write(s, g, parts, more) {
  Object.assign(g, parts, {
    words: more.words ?? g.words,
    said: more.said === undefined ? g.said : more.said,
    ...{ pos: more.pos ?? g.pos, h: more.h ?? g.h },
    updated: s.stamp(),
  });
  s.changed(s.page(g.page).notebook, g.page);
}
// A group deleted with its children, kept aside for Undo
export function putAside(s, g, p) {
  const deleted = s.now();
  for (const x of s.groups) if (x.id === g.id || x.parent === g.id) x.deleted = deleted;
  s.changed(p.notebook, p.id);
}
const partsOf = g => ({ ink: g.ink, texts: g.texts, pictures: g.pictures });
// A page's units in their order
export const unitsOn = (s, page) =>
  s.groups
    .filter(g => g.page === page && g.parent === null && g.deleted === null)
    .sort((a, b) => a.pos - b.pos || a.id - b.id);
// The pos of a unit at a page's end (past its Undo's deleted units too), at its start, and of one right after unit
// `after` on it, between it and the next: nothing on the page moves for it
const endOf = (s, p) => Math.max(-1, ...s.groups.filter(g => g.page === p.id && g.parent === null).map(g => g.pos)) + 1;
function startOf(s, p) {
  const all = s.groups.filter(g => g.page === p.id && g.parent === null).map(g => g.pos);
  return all.length ? Math.min(...all) - 1 : 0;
}
function posAfter(s, p, after) {
  const units = unitsOn(s, p.id),
    i = units.findIndex(g => g.id === after);
  if (i < 0) refuse(400, 'after is a unit on this page');
  return i === units.length - 1 ? units[i].pos + 1 : (units[i].pos + units[i + 1].pos) / 2;
}
// What HQ reads of a group: its elements, its box, its children (answers and replies, in the order they came) and its
// asks
const shown = (s, g) =>
  groupOf(
    s,
    g,
    s.groups.filter(r => r.parent === g.id && r.deleted === null),
  );
export function groupOf(s, g, replies) {
  const mine = replies.filter(r => r.parent === g.id);
  const { answers, ...about } = answersOf(s, g, mine); // (waiting, try, asks)
  return {
    ...element(g),
    anchor: g.anchor,
    ...about,
    owner: g.owner,
    owner_name: g.owner ? (s.names[g.owner] ?? g.owner) : null,
    children: [
      ...answers.map(a => ({ kind: 'answer', ...a })),
      ...mine.map(r => ({ ...element(r), kind: 'reply', answers: r.answers })),
    ].sort((a, b) => a.created.localeCompare(b.created)),
  };
}
const element = g => ({
  ...{ id: g.id, page: g.page, kind: g.kind, by: g.by, ink: g.ink, texts: g.texts },
  pictures: g.pictures.map(c => ({ ...c, url: pictureUrl(c.file) })),
  ...{ words: g.words, said: g.said, status: g.status, note: g.note, box: boxOf(partsOf(g)) },
  ...{ pos: g.pos, h: g.h },
  ...{ created: g.created, updated: g.updated },
});
// A picture kept for a page's group: its file's name (the coordinator's own pattern, `<page>-g-<8 hex>`)
export function keepPicture(s, page, picture) {
  const file = `${page}-g-${s.next('file').toString(16).padStart(8, '0')}.${picture.type === 'image/png' ? 'png' : 'jpg'}`;
  s.files.set(file, { bytes: picture.bytes, type: picture.type });
  return file;
}
export const pictureUrl = file => `/api/notebooks/pictures?file=${encodeURIComponent(file)}`;

// What a seeded group is unless it says otherwise; one seeded in its page's px, from before units, a unit as the
// store's carry makes it (notebookunits.ts).
const GROUP = { parent: null, answers: null, by: BOARD, ink: [], texts: [], pictures: [], anchor: null, words: '' };
Object.assign(GROUP, { said: null, owner: null, status: 'open', note: null, deleted: null });
export function seededGroup(seeded) {
  const g = { ...GROUP, ...seeded };
  if (g.parent !== null) return { ...g, pos: null, h: null };
  if (g.h != null) return { ...g, pos: g.pos ?? g.id };
  // (one seeded in its page's px, from before units: a unit as the store's carry makes it, notebookunits.ts.)
  const unit = unitOf({ ink: g.ink, texts: g.texts, pictures: g.pictures }, g.by === 'board' ? 0 : ROOM);
  return { ...g, ...unit.parts, pos: g.pos ?? g.id, h: unit.h };
}
