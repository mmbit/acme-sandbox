// What the book keeps of a Notebook page: its groups (knowledge/notes/platform/notebook.md). The tools work on a page's
// lists as they always have (page.ink, page.scraps: its pictures, page.texts), each element carrying its group's id
// (el.g); soon after each change the page's change goes to the store, group by group:
//   - a page's groups are its scrap units (bookunits.js): an element goes to the unit it's drawn on or beside, and one
//     drawn below them all makes a new unit, the page's last; what's saved is in its unit's own px;
//   - a group whose elements changed is edited, with since (its updated as this screen read it): one changed on
//     another screen meanwhile is refused, and the page is read again, what this screen added to it kept and saved anew;
//   - a group left with nothing is deleted, kept aside by the store; Undo putting its elements back restores it;
//   - a scrap's words typed (bookgroups.js) are edited on their own, kept as typed until the store has them.
// A sent page's own groups are read-only: nothing on it is saved. (groups)
import { createGroup, deleteGroup, editGroup, loadGroups, restoreGroup } from './notebookdata.js';
import { changesOf, emptyParts, keyOf, sameParts } from './bookgroupmath.js';
import { arrive } from './bookarrive.js';
import { laidOf, localOf, madeUnit } from './bookunits.js';
import { nameOf } from './bookhead.js';
import { forget } from './bookedit.js';

// a page is saved this long after its last stroke, so a burst of writing is one save
const SAVE_MS = 600;
// the page's lists and the store's names for them
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };

export function changed(book, page) {
  if (shut(page)) return;
  // (counted, so a read on its way meanwhile knows the page changed under it: readNow.)
  page.edits = (page.edits ?? 0) + 1;
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
// A scrap's post-it words typed in, saved with the page
export function typed(book, page, id, words) {
  if (shut(page)) return;
  (page.typed ??= new Map()).set(id, words);
  changed(book, page);
}
export const saveAll = book => book.views.forEach(v => v.page.timer && save(book, v.page));
// A page's change saved now (or its last save, which failed, tried again), and every save before it done (before a
// send, a share, a lasso's Group, a group moved). A grid's page waits on its opened scraps' records first
// (bookscrapopen.js), one put back down too: its failed save is tried again, and once it's in, a closed one's group is
// the grid's.
export async function saved(book, page) {
  for (const scrap of [...(page.scrapViews?.values() ?? [])].map(v => v.page)) {
    await savedOwn(book, scrap);
    const g = scrap.groups?.get(scrap.focus);
    if (g && page.groups?.has(scrap.focus) && !book.views.some(v => v.page === scrap)) page.groups.set(scrap.focus, g);
  }
  return savedOwn(book, page);
}
// (a page record's own saves only: a read of a grid's page never waits on its scraps')
const savedOwn = (book, page) => (page.timer || page.failed ? save(book, page) : (page.saving ?? Promise.resolve()));
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
    await readNow(book, page, page.edits);
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
    await deleteGroup(dev, id, page.groups.get(id).updated);
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
// The units drawn here, below the last: made in the store as the page's last kept in the column they're drawn in (on a
// sketch page, at the place they're drawn), their elements in their own px (bookunits.js); the ones made.
async function makeUnits(dev, page, els) {
  const news = [...(page.pending ?? [])];
  for (const unit of news) {
    const items = els.filter(x => x.el.g === unit.id);
    if (!items.length) {
      page.pending = page.pending.filter(p => p !== unit);
      continue;
    }
    const parts = partsOf(page, items),
      made = await createGroup(dev, page.id, {
        ...parts,
        // (one lifted out of an opened scrap right after it: bookunits.js newUnit.)
        ...(unit.after ? { after: unit.after } : { column: unit.column }),
      });
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
  const read = await groupsOf(book, page);
  named(book, page, read.title);
  fill(page, read.groups);
  return read;
}
// A page's groups as the store has them: an opened scrap's its one (bookscrapopen.js).
async function groupsOf(book, page) {
  const read = await loadGroups(book.dev, page.id);
  return { ...read, groups: ownGroups(page, read.groups) };
}
// (an opened scrap's view has its grid page's id: of the page's groups, only its own.)
export const ownGroups = (page, groups) => (page.focus ? groups.filter(g => g.id === page.focus) : groups);
// A page the store changed while it's open (another screen, an answer clipped on), read again once any save under way
// is done. While the board types in a box the read waits, and comes as the box is left (boxLeft); a caret
// alone, from a click on a note, gives way to it.
export function readAgain(book, page) {
  if (!page.groups) return Promise.resolve();
  // (a save before it that failed is tried again first: one that fails again is said, and the read waits for the next.
  // What's drawn from here on, during that save too, isn't in the read.)
  const edits = page.edits;
  page.saving = savedOwn(book, page).then(() => readNow(book, page, edits).catch(e => said(book, page, e.message)));
  return page.saving.catch(() => {});
}
// A box typed in left: what the store changed meanwhile on any page, read now.
export function boxLeft(book) {
  for (const { page } of book.views)
    if (page.unread) {
      page.unread = false;
      readAgain(book, page);
    }
}
async function readNow(book, page, edits) {
  const read = await groupsOf(book, page);
  named(book, page, read.title);
  if (unchanged(page, read.groups)) return;
  // (something drawn here while the read was on its way is in its unit and not in the store yet: the read would take
  // it for a line another screen rubbed out and drop it. It's saved first, then the page read again: a guest's page is
  // read every second, so a read is often on its way as the pen draws.)
  if (page.edits !== edits) return void readAgain(book, page);
  if (book.tools?.typing()) return void (page.unread = true);
  const back = book.tools?.leave();
  // (what came in a group new to the page, and wasn't on it before, arrives: not the board's own things regrouped)
  const had = new Set([...page.groups.keys(), ...(page.gone?.keys() ?? [])]),
    keys = new Set(elementsOf(page).map(x => keyOf(x.el)));
  // (someone else's hand changed it since this screen read it, a call's agent's: no step of this screen's, so its Undo
  // never takes it back, and what it replaced of this screen's leaves the steps: bookedit.js forget.)
  forget(book, page, fill(page, read.groups));
  // (what's drawn and not yet in a group, and words typed, kept, are saved again)
  if (elementsOf(page).some(x => !(x.el.g > 0)) || page.typed?.size) changed(book, page);
  drawn(book, page);
  back?.();
  const view = book.views.find(v => v.page === page);
  if (view)
    arrive(
      book,
      view,
      elementsOf(page)
        .map(x => x.el)
        .filter(el => !had.has(el.g) && !keys.has(keyOf(el))),
      { show: true }, // (the store's: slid into sight on an idle page.)
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
  // (and on the view and the bar: bookviewhead.js, bookcontrols.js.)
  book.controls?.update();
}
// (the page's own saves come back as the store's change too: nothing new in them, nothing's drawn again. Its answers,
// one coming, the agents' cards under it and who it was handed to are new too.)
const unchanged = (page, groups) =>
  groups.length === page.groups.size &&
  groups.every(g => {
    const had = page.groups.get(g.id),
      around = x => JSON.stringify([x.children, x.waiting, x.asks, x.assigned]);
    return had?.updated === g.updated && around(had) === around(g);
  });
// (the store's elements where their units are laid on the page, a unit new to it in its own px until the page lays it:
// bookunits.js. What's drawn here and not yet in the store, in a unit drawn here, stays where it is: all in the page's
// px, so a line let go by a refused edit and homed again moves only with its unit. One the page holds already, the same
// in the same unit, stays the same object: the steps of this screen's Undo hold them. One another screen moved or
// resized, the same id, stays the same object too, now as the store has it, so a step holding it holds it where it
// went: bookedit.js. One with the id of an element this screen changed and hasn't saved, its edit refused (loosen),
// waits: this screen's save puts its own in its place.) → those the page held that the store no longer has (another
// screen rubbed or deleted them, or moved one with no id)
function fill(page, groups) {
  const unsaved = elementsOf(page).filter(x => !(x.el.g > 0)),
    ids = new Set(groups.map(g => g.id)),
    held = new Map(),
    byId = new Map(),
    sameAs = (kind, g, el) => `${kind} ${g} ${sameKey(el)}`,
    idOf = (kind, el) => el.id !== undefined && `${kind} ${el.id}`;
  for (const x of elementsOf(page))
    if (x.el.g > 0) {
      const k = sameAs(x.kind, x.el.g, localOf(page, x.kind, x.el));
      held.set(k, [...(held.get(k) ?? []), x.el]);
      if (idOf(x.kind, x.el)) byId.set(idOf(x.kind, x.el), x.el);
    }
  const changing = new Set(unsaved.map(x => idOf(x.kind, x.el)).filter(Boolean));
  page.groups = new Map();
  page.gone ??= new Map();
  page.origins = new Map([...(page.origins ?? [])].filter(([id]) => id < 0 || ids.has(id)));
  const lists = { ink: [], texts: [], pictures: [] },
    fresh = [];
  for (const g of groups) {
    keep(page, g, g);
    for (const kind of Object.keys(LISTS))
      for (const el of g[kind]) {
        if (changing.has(idOf(kind, el))) continue;
        const same = held.get(sameAs(kind, g.id, el))?.shift();
        if (same) lists[kind].push(same);
        else fresh.push({ kind, at: lists[kind].push(laidOf(page, kind, { ...el, g: g.id })) - 1 });
      }
  }
  const left = new Set([...held.values()].flat());
  for (const { kind, at } of fresh) {
    const now = lists[kind][at],
      was = byId.get(idOf(kind, now));
    if (!was || !left.has(was)) continue;
    left.delete(was);
    lists[kind][at] = becomes(was, now);
  }
  for (const x of unsaved) lists[x.kind].push(x.el);
  for (const [kind, list] of Object.entries(LISTS)) {
    page[list] ??= [];
    page[list].splice(0, page[list].length, ...lists[kind]);
  }
  return [...left];
}
// What makes two elements of a kind and group the same element, whatever their ids: what the store keeps of it and its
// picture's address.
const sameKey = el => `${keyOf(el)} ${el.url ?? ''}`;
// The object a page holds for an element now (of one kind and group), taken out of had and made as now, else now: the
// same element, else the same id, as fill matches a read's (bookscrapopen.js backOnGrid, an opened scrap put back).
export function takenFrom(had, now) {
  let k = had.findIndex(x => sameKey(x) === sameKey(now));
  if (k < 0 && now.id !== undefined) k = had.findIndex(x => x.id === now.id);
  return k < 0 ? now : becomes(had.splice(k, 1)[0], now);
}
// An element the page holds made the same as now in place, so the steps holding it hold it as it is now (bookedit.js),
// its photo kept while it's the same file. → it
function becomes(was, now) {
  const img = was.file === now.file ? was.img : undefined;
  for (const k of Object.keys(was)) delete was[k];
  return Object.assign(was, now, img && { img });
}
// A group whose edit was refused (another screen changed it first): what this screen added to it is drawn and not
// yet in a group again, so the page read again keeps it and the next save sorts it anew (compared in its unit's own
// px, as the store keeps it: what it had stays the store's.)
function loosen(page, id) {
  const had = new Set(Object.values(page.groups.get(id).base).flat());
  for (const x of elementsOf(page))
    if (x.el.g === id && !had.has(keyOf(localOf(page, x.kind, x.el)))) x.el.g = undefined;
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

// (an opened scrap's record put back down says it on its grid's page)
export function said(book, page, words) {
  page.error = words;
  (book.views.find(v => v.page === page) ?? book.views.find(v => v.page === page.parent))?.refuse(words);
}
