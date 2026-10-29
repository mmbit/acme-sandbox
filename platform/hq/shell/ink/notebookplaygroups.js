// A notebook page's groups played in memory (notebookplay.js): notebookgroups.ts's routes with the same answers and
// refusals, on the store's state s.
import { anchorOf, dataUrlPicture, inkOf, picturesOf, refuse, textsOf, wordsOf } from './notebookplaychecks.js';
import { emptyGroup, hasAny, joined, picks, shifted, typedBoxes } from './notebookparts.js';
import { boxOf, nextScrap, scrapSize, STACK } from './notebookstack.js';

export const BOARD = 'board';
export const CHANGED = 'this group changed on another screen: read it again';
const SENT = 'a sent page is read-only: what the board wrote there stays';

// A route's handler for its 'METHOD path': (s, the body)
export const GROUP_ROUTES = {
  'POST /api/notebooks/groups/create': createGroup,
  'POST /api/notebooks/groups/scrap': createScrap,
  'POST /api/notebooks/groups/edit': editGroup,
  'POST /api/notebooks/groups/move': moveGroup,
  'POST /api/notebooks/groups/delete': deleteGroup,
  'POST /api/notebooks/groups/restore': restoreGroup,
  'POST /api/notebooks/groups/join': joinGroups,
  'POST /api/notebooks/groups/split': splitGroup,
};
// A drawing on an open page
function createGroup(s, b) {
  const p = openPage(s, b?.page),
    parts = elementsOf(s, b, emptyGroup);
  if (!hasAny(parts)) refuse(400, 'a group holds something: ink, words or a picture');
  return shown(s, insertGroup(s, p, 'drawing', BOARD, parts, {}));
}
// An open group's elements changed. since: its updated as the screen last read it (one changed since: 409).
function editGroup(s, b) {
  const g = openGroup(s, b?.id);
  if (b.since !== g.updated) refuse(409, CHANGED);
  const parts = elementsOf(s, b, partsOf(g)),
    said = b.words === undefined ? { words: g.words, said: g.said } : wordsOf(b.words, b.said);
  if (!hasAny(parts) && g.kind !== 'scrap') refuse(400, 'an empty group is deleted instead');
  write(s, g, parts, said);
  return shown(s, g);
}
// An open group onto another open page, shifted by dx, dy
function moveGroup(s, b) {
  const g = openGroup(s, b?.id),
    to = openPage(s, b.page);
  const dx = Number(b.dx ?? 0),
    dy = Number(b.dy ?? 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) refuse(400, 'dx and dy are numbers');
  const from = g.page;
  for (const x of s.groups) if (x.id === g.id || x.parent === g.id) x.page = to.id;
  write(s, g, shifted(partsOf(g), dx, dy), {});
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
  for (const x of s.groups)
    if ((x.id === g.id || x.parent === g.id) && x.deleted === deleted) Object.assign(x, { deleted: null, page });
  s.changed(p.notebook, page);
  return shown(s, g);
}
// A scrap onto the current page of a notebook (My Notebook by default), stacked under what's on it
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
  const picture = { file: keepPicture(s, p.id, snip), ...stackSpot(s, p, h), w, h, tilt: 0 };
  const more = { anchor, words: said.words, said: said.said, owner: b.owner ?? null };
  return shown(s, insertGroup(s, p, 'scrap', BOARD, { ...emptyGroup, pictures: [picture] }, more));
}
// A note with no picture: its words typed in the post-it's ink, a post-it stacked as a scrap is (notebookscraps.ts
// stackWords)
function typedNote(s, nb, said, more) {
  if (!said.words) refuse(400, 'a note with no picture holds words');
  const texts = textsOf(typedBoxes(said.words, { x: 0, w: STACK.w, color: '#1d1a2f' })),
    p = s.page(s.currentPage(nb.id)),
    typed = { ...emptyGroup, texts },
    { x, y } = stackSpot(s, p, boxOf(typed).h);
  return shown(s, insertGroup(s, p, 'note', BOARD, shifted(typed, x, y), more));
}
// Open groups of one page as one, the first's (or the scrap's): the others deleted, for Undo's split
function joinGroups(s, b) {
  const ids = Array.isArray(b?.ids) ? [...new Set(b.ids.map(Number))] : [];
  if (ids.length < 2) refuse(400, 'ids is two groups or more');
  const all = ids.map(i => openGroup(s, i));
  if (all.some(g => g.page !== all[0].page)) refuse(400, "groups join on one page: a group doesn't span pages");
  if (all.some(g => g.kind === 'reply')) refuse(400, 'a reply stays under its answer');
  if (all.filter(g => g.kind === 'scrap').length > 1) refuse(400, 'a group holds one scrap at most');
  const into = all.find(g => g.kind === 'scrap') ?? all[0],
    rest = all.filter(g => g !== into);
  const deleted = s.now();
  for (const g of rest) g.deleted = deleted;
  write(s, into, rest.map(partsOf).reduce(joined, partsOf(into)), {});
  return { group: shown(s, into), joined: rest.map(g => g.id) };
}
// The elements named (their indexes in the group) lifted out into a drawing of their own
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
  write(s, g, left, {});
  const lifted = insertGroup(s, s.page(g.page), 'drawing', g.by, {
    ink: out.ink.map(i => parts.ink[i]),
    texts: out.texts.map(i => parts.texts[i]),
    pictures: out.pictures.map(i => parts.pictures[i]),
  });
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
// Where the next scrap on a page goes, h tall (notebookstack.js)
function stackSpot(s, p, h) {
  const groups = s.groups.filter(g => g.page === p.id && g.parent === null && g.deleted === null);
  const { x, y } = nextScrap(
    groups.map(g => ({ id: g.id, kind: g.kind, words: g.words, box: boxOf(partsOf(g)) })),
    h,
    p.kind,
  );
  return { x, y };
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
  const notes = [g, ...mine].flatMap(x => (x.note ? [x.note] : []));
  const answers = notes.flatMap(n => s.slips.filter(a => a.note === n));
  return {
    ...element(g),
    anchor: g.anchor,
    owner: g.owner,
    owner_name: g.owner ? (s.names[g.owner] ?? g.owner) : null,
    children: [
      ...answers.map(a => ({ kind: 'answer', ...a })),
      ...mine.map(r => ({ ...element(r), kind: 'reply', answers: r.answers })),
    ].sort((a, b) => a.created.localeCompare(b.created)),
    // (the agents' desk-phone cards about its notes: bookasks.ts.)
    asks: notes.flatMap(n => s.asks.filter(a => a.note === n)),
  };
}
const element = g => ({
  ...{ id: g.id, page: g.page, kind: g.kind, by: g.by, ink: g.ink, texts: g.texts },
  pictures: g.pictures.map(c => ({ ...c, url: pictureUrl(c.file) })),
  ...{ words: g.words, said: g.said, status: g.status, note: g.note, box: boxOf(partsOf(g)) },
  ...{ created: g.created, updated: g.updated },
});
// A picture kept for a page's group: its file's name (the coordinator's own pattern, `<page>-g-<8 hex>`)
export function keepPicture(s, page, picture) {
  const file = `${page}-g-${s.next('file').toString(16).padStart(8, '0')}.${picture.type === 'image/png' ? 'png' : 'jpg'}`;
  s.files.set(file, { bytes: picture.bytes, type: picture.type });
  return file;
}
export const pictureUrl = file => `/api/notebooks/pictures?file=${encodeURIComponent(file)}`;
