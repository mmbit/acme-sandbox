// What the book keeps of a Notebook page: its groups (knowledge/notes/platform/notebook.md). The tools work on a page's
// lists as they always have (page.ink, page.scraps: its pictures, page.texts), each element carrying its group's id
// (el.g); soon after each change the page's change goes to the store, group by group:
//   - a page's groups are its scrap units (bookunits.js): an element goes to the unit it starts on, and one started
//     between units makes a new unit, created right after the unit above it; what's saved is in its unit's own px;
//   - a group whose elements changed is edited, with since (its updated as this screen read it): one changed on
//     another screen meanwhile is refused, and the page is read again, what this screen added to it kept and saved anew;
//   - a group left with nothing is deleted, kept aside by the store; Undo putting its elements back restores it;
//   - a scrap's words typed (bookgroups.js) are edited on their own, kept as typed until the store has them.
// A sent page's own groups are read-only: nothing on it is saved. (groups)
import { createGroup, deleteGroup, editGroup, loadGroups, restoreGroup } from './notebookdata.js';
import { changesOf, emptyParts, keyOf } from './bookgroupmath.js';
import { arrive } from './bookarrive.js';
import { localOf, madeUnit } from './bookunits.js';
import { nameOf } from './bookhead.js';
import { arrived } from './bookedit.js';

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
    // (a restore the store refused says why)
    said(book, page, await put(book, page));
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
    had = page.groups.size,
    refused = await restoreGone(dev, page);
  // (a refused restore's elements left the page's lists: drawn again)
  if (refused) drawn(book, page);
  const news = await makeUnits(dev, page, elementsOf(page));
  const base = new Map([...page.groups.values()].map(g => [g.id, g.base])),
    now = new Map();
  for (const x of elementsOf(page)) {
    // (one not in a unit the store has yet waits for the next save)
    if (!(x.el.g > 0)) continue;
    if (!now.has(x.el.g)) now.set(x.el.g, emptyParts());
    // (in its unit's own px: bookunits.js)
    now.get(x.el.g)[x.kind].push(localOf(page, x.kind, x.el));
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
  return refused;
}

// Groups this screen deleted, their elements put back by Undo: restored first, then edited like any other. A restore
// the store refuses (409) is final, a reply taken back or an ask whose card went with it: its elements leave the page
// again and it's no longer this screen's to restore, and the save goes on without it. → the refusal's words, or ''.
async function restoreGone(dev, page) {
  let refused = '';
  for (const id of new Set(elementsOf(page).map(x => x.el.g)))
    if (page.gone.has(id)) {
      try {
        keep(page, await restoreGroup(dev, id));
      } catch (e) {
        if (e.status !== 409) throw e;
        for (const list of Object.values(LISTS))
          page[list]?.splice(0, page[list].length, ...page[list].filter(el => el.g !== id));
        refused = e.message;
      }
      page.gone.delete(id);
    }
  return refused;
}
// The units drawn here, a stroke between units or below the last: made in the store right after the unit above them,
// their elements in their own px (bookunits.js); the ones made.
async function makeUnits(dev, page, els) {
  const news = [...(page.pending ?? [])];
  for (const unit of news) {
    const items = els.filter(x => x.el.g === unit.id);
    if (!items.length) {
      page.pending = page.pending.filter(p => p !== unit);
      continue;
    }
    const parts = partsOf(page, items),
      after = unit.after === null || unit.after > 0 ? unit.after : undefined,
      made = await createGroup(dev, page.id, after == null ? parts : { ...parts, after });
    madeUnit(page, unit.id, made.id);
    keep(page, made, parts);
  }
  return news;
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
  page.handed = read.handed;
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
  if (unchanged(page, read.groups)) return void (page.handed = read.handed);
  if (book.tools?.editing?.()) return changed(book, page);
  // (what came in a group new to the page, and wasn't on it before, arrives: not the board's own things regrouped)
  const had = new Set([...page.groups.keys(), ...(page.gone?.keys() ?? [])]),
    keys = new Set(elementsOf(page).map(x => keyOf(x.el)));
  // (someone else's hand changed it since this screen read it, a call's agent's: what the read brings is one step for
  // Undo, bookedit.js arrived)
  const fillIn = () => {
    fill(page, read.groups);
  };
  if (read.handed > page.handed)
    arrived(
      book,
      page,
      { changed: p => changed(book, p), refresh: p => drawn(book, p), words: (id, w) => typed(book, page, id, w) },
      fillIn,
    );
  else fillIn();
  page.handed = read.handed;
  // (what's drawn and not yet in a group, and words typed, kept, are saved again)
  if (elementsOf(page).some(x => !(x.el.g > 0)) || page.typed?.size) changed(book, page);
  drawn(book, page);
  const view = book.views.find(v => v.page === page);
  if (view)
    arrive(
      book,
      view,
      elementsOf(page)
        .map(x => x.el)
        .filter(el => !had.has(el.g) && !keys.has(keyOf(el))),
    );
}
// A page's lists drawn again where it shows, after a read or a step put them back
function drawn(book, page) {
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
// (the store's elements in their units' own px, until the page lays them: bookunits.js. What's drawn here and not
// yet in the store, in a unit drawn here, stays where it is.)
function fill(page, groups) {
  const unsaved = elementsOf(page).filter(x => !(x.el.g > 0));
  page.groups = new Map();
  page.gone ??= new Map();
  page.origins = new Map([...(page.origins ?? [])].filter(([id]) => id < 0));
  const lists = { ink: [], texts: [], pictures: [] };
  for (const g of groups) {
    keep(page, g, g);
    for (const kind of Object.keys(LISTS)) lists[kind].push(...g[kind].map(el => ({ ...el, g: g.id })));
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
// What's sent of new elements: as the store keeps them
const partsOf = (page, items) => {
  const parts = emptyParts();
  for (const x of items) parts[x.kind].push(localOf(page, x.kind, x.el));
  return stripped(parts);
};
const stripped = parts =>
  Object.fromEntries(Object.entries(parts).map(([k, list]) => [k, list.map(el => JSON.parse(keyOf(el)))]));

export function said(book, page, words) {
  page.error = words;
  book.views.find(v => v.page === page)?.refuse(words);
}
