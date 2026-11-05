// node --test platform/hq/shell/ink/bookedit.test.js   (Undo and Redo per scrap and per person: two screens on one
// stand-in store; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (review mode's files at /__review/, as the coordinator serves them; the store a stand-in)
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
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, createElement: () => ({}), head: { append() {} } };
globalThis.location = { hostname: '', search: '', pathname: '/' };
const { changed, readAgain, readPage, saved } = await import('./booksave.js');
const { changeOf, edit, redo, sightOf, stepList, swapIn, undo } = await import('./bookedit.js');
const { dried } = await import('./bookwrite.js');

const line = x => ({
  color: '#2a2352',
  size: 4,
  points: [
    [x, 100, 0.5, 0],
    [x + 40, 120, 0.5, 10],
  ],
});
// A store one page's groups are kept in, as the coordinator keeps them (its JSON: what HQ adds to an element dropped)
function storeOf() {
  const groups = new Map(),
    gone = new Map();
  let id = 0,
    at = 0;
  const kept = (gid, parts) => {
    const g = { id: gid, children: [], asks: [], ink: [], texts: [], pictures: [], ...parts, updated: ++at };
    groups.set(gid, structuredClone(g));
    return structuredClone(g);
  };
  return {
    groups,
    loadGroups: async () => ({ title: 'A page', groups: [...groups.values()].map(g => structuredClone(g)) }),
    createGroup: async (page, parts) => kept(++id, { kind: 'drawing', ...parts }),
    editGroup: async (gid, since, parts) => kept(gid, { ...groups.get(gid), ...parts }),
    deleteGroup: async gid => {
      gone.set(gid, groups.get(gid));
      groups.delete(gid);
    },
    restoreGroup: async gid => {
      groups.set(gid, { ...gone.get(gid), updated: ++at });
      return structuredClone(groups.get(gid));
    },
  };
}
// One person's screen showing page 1: its own book, its own steps
function screen() {
  const page = { id: 1, w: 800 },
    view = {
      page,
      el: { querySelector: () => null },
      place() {},
      redraw() {},
      refuse() {},
      addInk() {},
    },
    book = { dev: false, size: { w: 0, h: 0, top: 0, right: 0 }, views: [view], view, undone: [] };
  book.steps = stepList(book);
  // (the pen's hand-over, as bookink.js gives its stroke)
  Object.assign(book, { target: 0, pan: { x: 0, y: 0 }, scale: 1, inking: { size: 4 }, ink: { clear() {} } });
  const hooks = { refresh() {}, changed: p => changed(book, p), lay() {}, inView() {} };
  return { page, view, book, hooks, save: () => saved(book, page), read: () => readAgain(book, page) };
}
// A stroke moved as Select moves it: its new self in its place (bookselectlift.js drop)
const move = (s, from, x) =>
  edit(s.book, s.view, s.hooks, p => swapIn(p, new Map([[from, { ...from, points: line(x).points }]])));
const xs = page => page.ink.map(el => el.points[0][0]);
const stored = store => [...store.groups.values()].flatMap(g => g.ink.map(el => el.points[0][0]));

test("the board's case: Esmee's Undo takes her line from where the board moved it, the board's Undo of the move is skipped, her Redo brings it back there", async () => {
  const store = (globalThis.store = storeOf());
  const esmee = screen(),
    board = screen();
  await readPage(esmee.book, esmee.page);
  dried(esmee.book, line(20), esmee.hooks);
  const hers = esmee.page.ink[0];
  assert.match(hers.id, /^[0-9a-f]{12}$/, 'a new stroke has an id of its own');
  await esmee.save();
  assert.equal([...store.groups.values()][0].ink[0].id, hers.id, 'the store keeps it');

  await readPage(board.book, board.page);
  move(board, board.page.ink[0], 300);
  assert.equal(board.page.ink[0].id, hers.id, 'a move keeps the line’s id');
  await board.save();
  assert.deepEqual(stored(store), [300]);

  await esmee.read();
  assert.equal(esmee.page.ink[0], hers, 'the line read in is the one her step holds');
  assert.deepEqual(xs(esmee.page), [300], '…where the board put it');
  assert.equal(esmee.book.steps.length, 1, 'the board’s move is no step of hers');

  assert.equal(await undo(esmee.book), true);
  assert.deepEqual(xs(esmee.page), [], 'her Undo takes her line, moved or not');
  await esmee.save();
  assert.deepEqual(stored(store), []);

  await board.read();
  assert.deepEqual(xs(board.page), []);
  assert.equal(await undo(board.book), false, 'the board’s Undo of the move is skipped: the line is gone');

  assert.equal(await redo(esmee.book), true);
  assert.deepEqual(xs(esmee.page), [300], 'her Redo brings it back where the board put it');
  await esmee.save();
  assert.deepEqual(stored(store), [300]);
  await board.read();
  assert.deepEqual(xs(board.page), [300]);
  assert.equal(board.book.steps.length, 0, 'what Esmee did is no step of the board’s');
});

test('a copy or an eraser’s piece gets a new id; a move keeps it', () => {
  const s = screen();
  Object.assign(s.page, { ink: [], scraps: [], texts: [], h: 600 });
  s.hooks.changed = () => {};
  const a = { ...line(0), id: 'aaaaaaaaaaaa' };
  s.page.ink.push(a);
  edit(s.book, s.view, s.hooks, p => p.ink.push({ ...a }, { ...a }));
  const ids = s.page.ink.map(el => el.id);
  assert.equal(new Set(ids).size, 3, 'two copies, each its own id');
  move(s, a, 50);
  assert.equal(s.page.ink.find(el => el.points[0][0] === 50).id, 'aaaaaaaaaaaa');
});

test('Undo and Redo take only the open scrap’s steps, and a new step clears Redo only on its own scrap', async () => {
  const pageOf = gid => ({ id: 1, w: 400, h: 400, focus: gid, ink: [], scraps: [], texts: [] }),
    a = pageOf(1),
    b = pageOf(2),
    book = { views: [{ page: a }], cur: 0, size: { w: 0 }, undone: [] };
  book.steps = stepList(book);
  const hooks = { refresh() {}, changed() {} },
    draw = (page, x) => edit(book, { page }, hooks, p => p.ink.push(line(x)));
  draw(a, 0);
  draw(a, 10);
  book.views[0] = { page: b };
  draw(b, 20);
  book.views[0] = { page: a };
  assert.equal(await undo(book), true);
  assert.deepEqual(xs(a), [0], 'the open scrap’s last step');
  assert.deepEqual(xs(b), [20], 'the other scrap’s step stays');
  book.views[0] = { page: b };
  assert.equal(await redo(book), false, 'nothing undone on this scrap');
  draw(b, 30);
  book.views[0] = { page: a };
  assert.equal(await redo(book), true, 'a new step on another scrap leaves this one’s Redo');
  assert.deepEqual(xs(a), [0, 10]);
  assert.equal(await undo(book), true);
  assert.equal(await undo(book), true);
  assert.equal(await undo(book), false, 'none of the other scrap’s steps');
  assert.deepEqual(xs(b), [20, 30]);
});

test('a change out of sight: the view that shows it, zoomed out only as far as it must be', () => {
  const view = { pan: { x: 0, y: 0 }, scale: 2, size: { w: 600, h: 800, top: 40, right: 60 } };
  // (shown: x 0..270, y 20..400 of the scrap's px)
  assert.equal(sightOf({ x: 10, y: 30, w: 100, h: 100 }, view), null, 'in sight: no slide');
  const far = sightOf({ x: 1000, y: 30, w: 100, h: 100 }, view);
  assert.equal(far.scale, 2, 'a small change far off: no zoom');
  assert.equal(far.pan.x + 540 / 2 / far.scale, 1050, 'centred across');
  assert.equal(far.pan.y + 40 / far.scale + 760 / 2 / far.scale, 80, 'and down, below the blur');
  const big = sightOf({ x: 0, y: 0, w: 2000, h: 100 }, view);
  assert.ok(big.scale < 0.3 && 2000 * big.scale <= 540, 'a big one: zoomed out to hold it');
  const step = {
    held: { before: { ink: [], scraps: [], texts: [] }, after: { ink: [line(0)], scraps: [], texts: [] } },
  };
  const box = changeOf(step);
  assert.ok(box.x <= 0 && box.x + box.w >= 40, 'a step’s box is what it put on');
});
