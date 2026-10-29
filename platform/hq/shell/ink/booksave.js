// What the book keeps of a Notebook page: its groups (knowledge/notes/platform/notebook.md). The tools work on a page's
// lists as they always have (page.ink, page.scraps: its pictures, page.texts), each element carrying its group's id
// (el.g); soon after each change the page's change goes to the store, group by group:
//   - an element with no group joins the open group its start lies inside, else the group drawn in last when it's near
//     in time and space, else a new group with the new elements near it (bookgroupmath.js sortNew): create, or edit;
//   - a group whose elements changed is edited, with since (its updated as this screen read it): one changed on
//     another screen meanwhile is refused, and the page is read again, what this screen added to it kept and saved anew;
//   - a group left with nothing is deleted, kept aside by the store; Undo putting its elements back restores it;
//   - a scrap's words typed (bookgroups.js) are edited on their own, kept as typed until the store has them.
// A sent page's own groups are read-only: nothing on it is saved. (groups)
import { createGroup, deleteGroup, editGroup, loadGroups, restoreGroup } from './notebookdata.js';
import { boxOf as boxOfParts, changesOf, emptyParts, keyOf, sortNew } from './bookgroupmath.js';
import { grownTo } from './bookrow.js';
import { nameOf } from './bookhead.js';

// a page is saved this long after its last stroke, so a burst of writing is one save
const SAVE_MS = 600;
// the page's lists and the store's names for them
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };

export function changed(book, page) {
  if (shut(page)) return;
  clearTimeout(page.timer);
  page.timer = setTimeout(() => save(book, page), SAVE_MS);
}
// Saves in the order they were asked for, so an older one never lands over a newer one. One that failed has said why
// on the page (saveNow) and is tried again by what waits on it (a send, a share: saved()), which fails only if that
// fails too; the next save still runs, and saves the page whole again.
function save(book, page) {
  clearTimeout(page.timer);
  page.timer = 0;
  page.saving = (page.saving ?? Promise.resolve()).catch(() => {}).then(() => saveNow(book, page));
  page.saving.catch(() => {}); // (said on the page: the autosave's timer waits on nothing)
  return page.saving;
}
// A scrap's post-it words typed in (or edited with the pen: bookamend.js), saved with the page
export function typed(book, page, id, words) {
  if (shut(page)) return;
  (page.typed ??= new Map()).set(id, words);
  changed(book, page);
}
export const saveAll = book => book.views.forEach(v => v.page.timer && save(book, v.page));
// A page's change saved now (or its last save, which failed, tried again), and every save before it done (before a
// send, a share, a lasso's Group, a group moved)
export const saved = (book, page) =>
  page.timer || page.failed ? save(book, page) : (page.saving ?? Promise.resolve());
// Whether a page's own groups are read-only: it's sending or sent
export const shut = page => !!(page.sending || page.sent || page.readonly);

async function saveNow(book, page) {
  if (!page.groups || shut(page)) return;
  try {
    await put(book, page);
    said(book, page, '');
  } catch (e) {
    page.failed = true;
    if (e.status !== 409) {
      said(book, page, e.message);
      throw e;
    }
    await readNow(book, page);
  }
  page.failed = false;
}
async function put(book, page) {
  const { dev } = book,
    els = elementsOf(page),
    had = page.groups.size;
  // (groups this screen deleted, their elements put back by Undo: restored first, then edited like any other)
  for (const id of new Set(els.map(x => x.el.g)))
    if (page.gone.has(id)) {
      keep(page, await restoreGroup(dev, id));
      page.gone.delete(id);
    }
  // (new elements, or ones carried in from a group not on this page: into groups)
  const news = els.filter(x => !page.groups.has(x.el.g));
  if (news.length) {
    const opened = [...page.groups.values()].map(g => ({ id: g.id, box: boxNow(page, g.id) }));
    const { sorted, recent } = sortNew(news, opened, page.last, Date.now());
    for (const s of sorted) for (const x of s.items) x.el.g = s.id;
    for (const s of sorted.filter(s => s.id === null)) {
      const parts = partsOf(s.items),
        made = await createGroup(dev, page.id, parts);
      s.id = made.id;
      for (const x of s.items) x.el.g = made.id;
      keep(page, made, parts);
    }
    page.last = { id: recent.id, at: Date.now(), box: recent.box };
  }
  const base = new Map([...page.groups.values()].map(g => [g.id, g.base])),
    now = new Map();
  for (const x of elementsOf(page)) {
    if (!now.has(x.el.g)) now.set(x.el.g, emptyParts());
    now.get(x.el.g)[x.kind].push(x.el);
  }
  const { edits, deletes } = changesOf(base, now);
  for (const { id, parts } of edits) {
    const sent = stripped(parts);
    try {
      keep(page, await editGroup(dev, id, page.groups.get(id).updated, sent), sent);
    } catch (e) {
      if (e.status === 409) loosen(page, id);
      throw e;
    }
  }
  for (const id of deletes) {
    await deleteGroup(dev, id);
    page.gone.set(id, page.groups.get(id));
    page.groups.delete(id);
  }
  await putWords(dev, page);
  if (news.length || edits.length || deletes.length || page.groups.size !== had) book.groups?.drawn(page);
}

// A scrap's words typed, as the store keeps them: trimmed, and said as its words first came, else typed. What's typed
// is let go once the store has it (a space at its end under the caret stays in the field: bookgroups.js caretBack),
// unless more was typed meanwhile.
async function putWords(dev, page) {
  for (const [id, words] of page.typed ?? []) {
    const g = page.groups.get(id);
    if (g && g.words !== words.trim())
      keep(page, await editGroup(dev, id, g.updated, { words, said: g.said ?? 'typed' }));
    if (page.typed.get(id).trim() === (page.groups.get(id)?.words ?? words.trim())) page.typed.delete(id);
  }
}

// ---- reading a page

// A page read whole: its groups' elements into its lists, each marked with its group, and the groups kept with what
// they held as read (what a save compares against). What was drawn and not yet in a group stays.
export async function readPage(book, page) {
  const read = await loadGroups(book.dev, page.id);
  named(book, page, read.title);
  fill(page, read.groups);
  return read;
}
// A page the store changed while it's open (another screen, an answer clipped on), read again once any save under way
// is done, unless something on it is being typed in: then after the next save.
export function readAgain(book, page) {
  if (!page.groups) return Promise.resolve();
  // (a save before it that failed is tried again first: one that fails again is said, and the read waits for the next)
  page.saving = saved(book, page).then(() => readNow(book, page).catch(e => said(book, page, e.message)));
  return page.saving.catch(() => {});
}
async function readNow(book, page) {
  const read = await loadGroups(book.dev, page.id);
  named(book, page, read.title);
  if (unchanged(page, read.groups)) return;
  if (book.tools?.editing?.()) return changed(book, page);
  fill(page, read.groups);
  // (what's drawn and not yet in a group, and words typed, kept, are saved again)
  if (elementsOf(page).some(x => x.el.g === undefined) || page.typed?.size) changed(book, page);
  const view = book.views.find(v => v.page === page);
  if (!view) return;
  view.place();
  view.redraw();
  book.tools?.added?.(view);
  book.groups?.drawn(page);
}
export function named(book, page, title) {
  page.label = title;
  const view = book.views.find(v => v.page === page);
  if (view) view.el.ariaLabel = nameOf(page);
  book.controls?.update();
}
// (the page's own saves come back as the store's change too: nothing new in them, nothing's drawn again. Its answers
// and the agents' cards under it are new too: cards.)
const unchanged = (page, groups) =>
  groups.length === page.groups.size &&
  groups.every(g => {
    const had = page.groups.get(g.id);
    return (
      had?.updated === g.updated && JSON.stringify([had.children, had.asks]) === JSON.stringify([g.children, g.asks])
    );
  });
function fill(page, groups) {
  const unsaved = elementsOf(page).filter(x => x.el.g === undefined);
  page.groups = new Map();
  page.gone ??= new Map();
  const lists = { ink: [], texts: [], pictures: [] };
  for (const g of groups) {
    keep(page, g, g);
    for (const kind of Object.keys(LISTS)) lists[kind].push(...g[kind].map(el => ({ ...el, g: g.id })));
    if (g.box) Object.assign(page, grownTo(page, boxOf(g.box)));
  }
  for (const x of unsaved) lists[x.kind].push(x.el);
  for (const [kind, list] of Object.entries(LISTS)) {
    page[list] ??= [];
    page[list].splice(0, page[list].length, ...lists[kind]);
  }
}
// A group whose edit was refused (another screen changed it first): what this screen added to it is drawn and not
// yet in a group again, so the page read again keeps it and the next save sorts it anew
function loosen(page, id) {
  const had = new Set(Object.values(page.groups.get(id).base).flat());
  for (const x of elementsOf(page)) if (x.el.g === id && !had.has(keyOf(x.el))) x.el.g = undefined;
}
// A group as this screen keeps it: the store's answer, and what it held (sent: what was sent for it, the elements as
// the store has them when it's the read itself)
function keep(page, g, sent = g) {
  page.groups.set(g.id, {
    ...g,
    base: Object.fromEntries(Object.keys(LISTS).map(k => [k, (sent[k] ?? []).map(keyOf)])),
  });
}

// ---- the page's lists as groups

// Every element on the page, { kind (the store's name), el }
const elementsOf = page =>
  Object.entries(LISTS).flatMap(([kind, list]) => (page[list] ?? []).map(el => ({ kind, el })));
// A group's elements as they are now on the page, for its box
function boxNow(page, id) {
  const parts = emptyParts();
  for (const x of elementsOf(page)) if (x.el.g === id) parts[x.kind].push(x.el);
  return boxOfParts(parts);
}
// What's sent of new elements: as the store keeps them
const partsOf = items => {
  const parts = emptyParts();
  for (const x of items) parts[x.kind].push(x.el);
  return stripped(parts);
};
const stripped = parts =>
  Object.fromEntries(Object.entries(parts).map(([k, list]) => [k, list.map(el => JSON.parse(keyOf(el)))]));
// (the page grows to hold a group's box)
const boxOf = b => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });

export function said(book, page, words) {
  page.error = words;
  book.views.find(v => v.page === page)?.refuse(words);
}
