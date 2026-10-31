// node --test platform/hq/shell/ink/booksave.test.js   (a page's groups saved to a stand-in store; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (the browser has review mode's files at /__review/, as the coordinator serves them, and the sound kit at /foley.js;
// the store is a stand-in here)
const REVIEW = new URL('../../../../shared/review/', import.meta.url);
const module = text => ({ url: `data:text/javascript,${encodeURIComponent(text)}`, shortCircuit: true });
const STORE = module(
  ['createGroup', 'deleteGroup', 'editGroup', 'loadGroups', 'restoreGroup']
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
const { changed, readPage, saved } = await import('./booksave.js');
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
    loadGroups: async () => ({ title: 'A page', handed: 0, groups: [...groups.values()].map(g => structuredClone(g)) }),
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
    el: {},
    place() {},
    redraw: () => view.redraws++,
    redraws: 0,
    refuse: words => (view.said = words),
  };
  return { dev: false, size: { w: 0, h: 0 }, views: [view], view };
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
