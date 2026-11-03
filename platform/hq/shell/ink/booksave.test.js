// node --test platform/hq/shell/ink/booksave.test.js   (a page's groups saved to a stand-in store; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (the browser has review mode's files at /__review/, as the coordinator serves them, and the sound kit at /foley.js;
// the store is a stand-in here)
const REVIEW = new URL('../../../../shared/review/', import.meta.url);
const module = text => ({ url: `data:text/javascript,${encodeURIComponent(text)}`, shortCircuit: true });
const STORE = module(
  ['createGroup', 'deleteGroup', 'editGroup', 'loadGroups', 'placeGroups', 'restoreGroup']
    .map(name => `export const ${name} = (dev, ...args) => globalThis.store.${name}(...args);`)
    .join('\n'),
);
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === './notebookdata.js' && context.parentURL?.endsWith('/booksave.js')
      ? STORE
      : specifier === '../foley.js'
        ? module('export const foley = () => {};')
        : next(
            specifier.startsWith('/__review/') ? new URL(specifier.slice('/__review/'.length), REVIEW).href : specifier,
            context,
          ),
});
// (what the modules under it read of the browser as they load)
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {} };
globalThis.location = { hostname: '', search: '', pathname: '/' };
const { changed, readAgain, readPage, saved } = await import('./booksave.js');
const { edit, redo, remade, stepList, undo } = await import('./bookedit.js');
const { dried } = await import('./bookwrite.js');
const { pointUnit, unitsOf } = await import('./bookunits.js');
const { GAP, MARGIN, layout, widthFor } = await import('./masonry.js');
const { UNIT_W } = await import('./scrapunit.js');

const line = x => ({
  color: '#2a2352',
  size: 4,
  points: [
    [x, 100, 0.5, 0],
    [x + 40, 120, 0.5, 10],
  ],
});
// A store holding one page's groups, each as the store keeps it; restoring refuses what refuse names
function storeOf(refuse = new Set()) {
  const groups = new Map(),
    gone = new Map();
  let id = 0,
    at = 0;
  const kept = (gid, parts) => {
    const g = { id: gid, updated: ++at, children: [], asks: [], ink: [], texts: [], pictures: [], ...parts };
    groups.set(gid, g);
    return structuredClone(g);
  };
  return {
    groups,
    add: parts => kept(++id, parts),
    loadGroups: async () => ({ title: 'A page', groups: [...groups.values()].map(g => structuredClone(g)) }),
    createGroup: async (page, parts) => kept(++id, { kind: 'drawing', ...parts }),
    editGroup: async (gid, since, parts) => kept(gid, parts),
    deleteGroup: async gid => {
      gone.set(gid, groups.get(gid));
      groups.delete(gid);
    },
    restoreGroup: async gid => {
      if (refuse.has(gid))
        throw Object.assign(new Error('this ask left the desk phone with its card when it was deleted'), {
          status: 409,
        });
      groups.set(gid, gone.get(gid));
      return structuredClone(gone.get(gid));
    },
  };
}
// A book showing the page, its view keeping what it was last told
function bookOf(page) {
  const view = {
    page,
    // (its element: a page not laid, with no head to write its title in)
    el: { querySelector: () => null },
    place() {},
    redraw: () => view.redraws++,
    redraws: 0,
    refuse: words => (view.said = words),
  };
  const book = { dev: false, size: { w: 0, h: 0 }, views: [view], view, undone: [] };
  book.steps = stepList(book);
  return book;
}
const save = (book, page) => (changed(book, page), saved(book, page));
// A line drawn on the page, into the unit it starts on or a new one, as the pen puts it (bookunits.js)
const drawn = (page, x) => {
  const el = line(x);
  el.g = pointUnit(page, x, 100);
  page.ink.push(el);
};

test("an Undo the store refuses takes its scrap off the page, says why, and what's drawn with it and after is saved", async () => {
  const store = (globalThis.store = storeOf(new Set([2])));
  store.add({ ink: [line(0)] });
  store.add({ ink: [line(300)] }); // (an ask's scrap)
  const page = { id: 1, w: 800 },
    book = bookOf(page);
  await readPage(book, page);
  // (the ask's scrap deleted, its card with it)
  const ask = page.ink.find(el => el.g === 2);
  page.ink.splice(page.ink.indexOf(ask), 1);
  await save(book, page);
  assert.deepEqual([...store.groups.keys()], [1]);
  // (Undo puts it back, and a line is drawn far off in the same moment)
  page.ink.push(ask);
  drawn(page, 900);
  await save(book, page);
  assert.ok(!page.ink.some(el => el.g === 2), 'the refused scrap is off the page');
  assert.ok(book.view.redraws > 0, 'and drawn so');
  assert.equal(book.view.said, 'this ask left the desk phone with its card when it was deleted');
  assert.deepEqual([...store.groups.keys()], [1, 3], 'the line drawn with the Undo is stored');
  // (a line drawn later is saved too)
  drawn(page, 1500);
  await save(book, page);
  assert.deepEqual([...store.groups.keys()], [1, 3, 4]);
  assert.equal(book.view.said, '');
});

test('an Undo the store takes puts its group back, and saves on', async () => {
  const store = (globalThis.store = storeOf());
  store.add({ ink: [line(0)] });
  store.add({ ink: [line(300)] });
  const page = { id: 1, w: 800 },
    book = bookOf(page);
  await readPage(book, page);
  const scrap = page.ink.find(el => el.g === 2);
  page.ink.splice(page.ink.indexOf(scrap), 1);
  await save(book, page);
  page.ink.push(scrap);
  drawn(page, 900);
  await save(book, page);
  assert.deepEqual([...store.groups.keys()].sort(), [1, 2, 3]);
  assert.ok(page.ink.some(el => el.g === 2));
  assert.equal(book.view.said, '');
});

test("an edit refused as another screen changed the unit first: only what this screen added is drawn anew, the unit's own ink stays the store's", async () => {
  const store = (globalThis.store = storeOf());
  store.add({ ink: [line(0), line(60)] });
  const page = { id: 1, w: 800 },
    book = bookOf(page);
  await readPage(book, page);
  // (the unit laid at its place on the page: its ink in the page's px, as bookunits.js lays it)
  page.origins = new Map([[1, { x: 50, y: 200 }]]);
  for (const el of page.ink) el.points = el.points.map(([x, y, ...r]) => [x + 50, y + 200, ...r]);
  // (a line written on the unit; meanwhile another screen takes the unit's second line off)
  const added = { ...line(150), g: 1 };
  page.ink.push(added);
  store.groups.set(1, { ...store.groups.get(1), updated: 99, ink: [line(0)] });
  store.editGroup = async () => {
    throw Object.assign(new Error('changed on another screen'), { status: 409 });
  };
  await save(book, page);
  assert.deepEqual(
    page.ink.filter(el => !(el.g > 0)),
    [added],
    'only the line written here waits for its unit again',
  );
  assert.deepEqual(
    page.ink.filter(el => el.g === 1).map(el => el.points[0][0]),
    [50],
    "the unit's ink as the other screen left it, where the unit is",
  );
  assert.equal(added.points[0][0], 150, 'the line where it was written');
});

test('a drawing with nothing above it stays in the column it was drawn in when its page is read again', async () => {
  globalThis.store = storeOf();
  // (two columns, the page not laid since: bookunits.js keeps 8 px off the paper's sides)
  const width = widthFor(2),
    page = { id: 1, w: width + 16, columns: 2, scale: 1, origins: new Map(), places: [], laid: { units: [], width } },
    book = bookOf(page);
  await readPage(book, page);
  drawn(page, 8 + MARGIN + 20);
  drawn(page, 8 + MARGIN + UNIT_W + GAP + 20);
  await save(book, page);
  const again = { id: 1, w: width + 16 };
  await readPage(bookOf(again), again);
  assert.deepEqual(
    layout(unitsOf(again), width).places.map(p => p.column),
    [0, 1],
  );
});

test("the board's Undo takes back only its own: a call agent's change read in between is no step, and stays", async () => {
  const store = (globalThis.store = storeOf());
  store.add({ ink: [line(0)] });
  const page = { id: 1, w: 800 },
    book = bookOf(page);
  await readPage(book, page);
  const own = page.ink[0],
    hooks = { refresh() {}, changed: p => changed(book, p) };
  edit(book, book.view, hooks, p => drawn(p, 900));
  await saved(book, page);
  const mine = page.ink.find(el => el.points[0][0] === 900);
  // (the agent's note on the page, as the store has it now)
  const theirs = store.add({ ink: [line(300)] }).id;
  await readAgain(book, page);
  assert.equal(book.steps.length, 1, "the agent's change is no step of the board's");
  assert.ok(page.ink.includes(own) && page.ink.includes(mine), 'the read keeps the page’s own lines as they were');
  await undo(book);
  await saved(book, page);
  assert.ok(!page.ink.includes(mine), "Undo takes the board's line back");
  assert.ok(
    page.ink.some(el => el.g === theirs) && page.ink.includes(own),
    "the agent's note and the board's first stay",
  );
  assert.ok(store.groups.has(theirs), "the agent's note stays in the store");
  await redo(book);
  await saved(book, page);
  assert.ok(page.ink.includes(mine) && page.ink.some(el => el.g === theirs), 'Redo puts only the board’s line back');
  assert.equal(await undo(book), true);
  assert.equal(await undo(book), false, 'nothing else to take back');
  assert.ok(store.groups.has(theirs));
});

// (a stroke moved as Select moves it: its new self in its place, kept as its replacement, bookselect.js swapIn)
const moved = (book, hooks, from, x) =>
  edit(book, book.view, hooks, p => {
    const now = { ...from, points: line(x).points };
    remade(from, now);
    p.ink.splice(p.ink.indexOf(from), 1, now);
  });
const xs = page => page.ink.map(el => el.points[0][0]);
const stored = store => [...store.groups.values()].flatMap(g => g.ink.map(el => el.points[0][0]));

test("a stroke this screen moved and another moved again stays where the other put it through Undo and Redo, and so it's saved", async () => {
  const store = (globalThis.store = storeOf());
  const { id } = store.add({ ink: [line(20)] });
  const page = { id: 1, w: 800 },
    book = bookOf(page),
    hooks = { refresh() {}, changed: p => changed(book, p) };
  await readPage(book, page);
  moved(book, hooks, page.ink[0], 60);
  await saved(book, page);
  assert.deepEqual(stored(store), [60]);
  // (another screen moves it on)
  store.groups.set(id, { ...store.groups.get(id), updated: 99, ink: [line(100)] });
  await readAgain(book, page);
  assert.deepEqual(xs(page), [100]);
  assert.equal(await undo(book), false, 'the move is no longer this screen’s to take back');
  await saved(book, page);
  assert.deepEqual(xs(page), [100]);
  assert.deepEqual(stored(store), [100], 'the store keeps the other screen’s stroke alone');
  const again = { id: 1, w: 800 };
  await readPage(bookOf(again), again);
  assert.deepEqual(xs(again), [100], 'read again from the store: the one stroke');
});

test("a move this screen took back, the stroke since moved on another, isn't made again by Redo", async () => {
  const store = (globalThis.store = storeOf());
  const { id } = store.add({ ink: [line(20)] });
  const page = { id: 1, w: 800 },
    book = bookOf(page),
    hooks = { refresh() {}, changed: p => changed(book, p) };
  await readPage(book, page);
  moved(book, hooks, page.ink[0], 60);
  await saved(book, page);
  await undo(book);
  await saved(book, page);
  assert.deepEqual(stored(store), [20]);
  store.groups.set(id, { ...store.groups.get(id), updated: 99, ink: [line(100)] });
  await readAgain(book, page);
  assert.equal(await redo(book), false);
  await saved(book, page);
  assert.deepEqual(stored(store), [100]);
});

test('a stroke moved twice here, the last moved on another screen: neither Undo brings back an older one', async () => {
  const store = (globalThis.store = storeOf());
  const { id } = store.add({ ink: [line(20)] });
  store.add({ ink: [line(400)] });
  const page = { id: 1, w: 800 },
    book = bookOf(page),
    hooks = { refresh() {}, changed: p => changed(book, p) };
  await readPage(book, page);
  const other = page.ink.find(el => el.points[0][0] === 400);
  moved(book, hooks, page.ink[0], 60);
  const once = page.ink.find(el => el.points[0][0] === 60);
  moved(book, hooks, once, 80);
  moved(book, hooks, other, 440);
  await saved(book, page);
  store.groups.set(id, { ...store.groups.get(id), updated: 99, ink: [line(100)] });
  await readAgain(book, page);
  assert.equal(book.steps.length, 1, 'only the other stroke’s move is left to take back');
  await undo(book);
  await saved(book, page);
  const both = stored(store).sort((a, b) => a - b);
  assert.deepEqual(both, [100, 400]);
});

test('a stroke the pen drew here, moved here and moved again on another screen: Undo and Redo never bring back the drawn one', async () => {
  const store = (globalThis.store = storeOf());
  const page = { id: 1, w: 800 },
    book = bookOf(page),
    hooks = { refresh() {}, changed: p => changed(book, p), lay() {}, inView() {} };
  await readPage(book, page);
  // (the pen lifted at x=20, as bookink.js hands its stroke over)
  Object.assign(book, { target: 0, pan: { x: 0, y: 0 }, scale: 1, inking: { size: 4 }, ink: { clear() {} } });
  book.view.addInk = () => {};
  dried(book, line(20), hooks);
  await saved(book, page);
  moved(book, hooks, page.ink[0], 60);
  await saved(book, page);
  assert.deepEqual(stored(store), [60]);
  const [id] = store.groups.keys();
  store.groups.set(id, { ...store.groups.get(id), updated: 99, ink: [line(100)] });
  await readAgain(book, page);
  assert.equal(await undo(book), false, 'neither the move nor the drawing is this screen’s to take back');
  assert.equal(await redo(book), false);
  await saved(book, page);
  assert.deepEqual(xs(page), [100]);
  assert.deepEqual(stored(store), [100]);
  const again = { id: 1, w: 800 };
  await readPage(bookOf(again), again);
  assert.deepEqual(xs(again), [100], 'read again from the store: the one stroke');
});
