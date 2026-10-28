// node --test platform/hq/shell/ink/notebookplay.test.js   (the Notebook's store played in memory; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notebookPlay } from './notebookplay.js';
import { CHANGED } from './notebookplaygroups.js';

// A play on a story's clock, with the events it sends
function played(seed) {
  const clock = { now: Date.parse('2026-10-27T09:00:00Z') };
  const play = notebookPlay({ seed, now: () => clock.now }),
    events = [];
  play.listen(e => events.push(e));
  const notebook = play.route('/api/notebooks').shelf[0].id;
  const page = play.route('/api/notebooks/pages', { notebook }).pages.at(-1).id;
  const post = (path, body) => play.route(`/api/notebooks/${path}`, {}, body);
  const groups = p => play.route('/api/notebooks/pages/groups', { page: p ?? page }).groups;
  return { play, clock, events, notebook, page, post, groups };
}
const stroke = (x, y) => ({
  color: '#2a2352',
  size: 4,
  points: [
    [x, y, 0.5, 0],
    [x + 30, y + 10, 0.5, 16],
  ],
});
const refusal = (status, message) => e => e.status === status && e.message === message;
// A 1×1 PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
);

test('no seed: My Notebook with one blank page, current', () => {
  const { play, notebook, page } = played();
  const shelf = play.route('/api/notebooks');
  assert.deepEqual(
    shelf.shelf.map(n => [n.name, n.kind]),
    [['My Notebook', 'mine']],
  );
  assert.throws(
    () => play.route('/api/notebooks/archive', {}, { id: notebook, archived: true }),
    refusal(409, 'My Notebook stays on the shelf'),
  );
  assert.equal(play.route('/api/notebooks/pages', { notebook }).pages.length, 1);
  assert.equal(page, play.route('/api/notebooks/pages', { notebook }).pages[0].id, "a read doesn't make another");
  assert.throws(() => play.route('/api/notebooks/nothing'), refusal(404, 'not found'));
});

test('a group is drawn, edited with since, and refused when it changed elsewhere (409)', () => {
  const { post, groups, page, events } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  assert.deepEqual(g.box, { x: 8, y: 8, w: 34, h: 14 });
  assert.ok(
    events.some(e => e.page === page),
    'a change is a notebook event with its page',
  );
  const edited = post('groups/edit', { id: g.id, since: g.updated, ink: [stroke(10, 10), stroke(12, 40)] });
  assert.equal(edited.ink.length, 2);
  assert.throws(() => post('groups/edit', { id: g.id, since: g.updated, ink: [] }), refusal(409, CHANGED));
  assert.throws(
    () => post('groups/edit', { id: g.id, since: edited.updated, ink: [] }),
    refusal(400, 'an empty group is deleted instead'),
  );
  assert.throws(
    () => post('groups/create', { page, ink: [] }),
    refusal(400, 'a group holds something: ink, words or a picture'),
  );
  assert.throws(
    () => post('groups/create', { page, ink: [{ color: 'red' }] }),
    e => e.status === 400,
  );
  assert.equal(groups()[0].ink.length, 2);
});

test('delete keeps a group aside, restore brings it back', () => {
  const { post, groups, page } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  assert.deepEqual(post('groups/delete', { id: g.id }), { ok: true, id: g.id });
  assert.equal(groups().length, 0);
  assert.throws(() => post('groups/delete', { id: g.id }), refusal(404, 'not found'));
  assert.equal(post('groups/restore', { id: g.id }).id, g.id);
  assert.deepEqual(
    groups().map(x => x.id),
    [g.id],
  );
  assert.throws(() => post('groups/restore', { id: g.id }), refusal(404, 'not found'));
});

test('join makes one group of many on a page, split lifts elements out again', () => {
  const { post, groups, page, notebook, play } = played();
  const a = post('groups/create', { page, ink: [stroke(10, 10)] }),
    b = post('groups/create', {
      page,
      ink: [stroke(200, 10)],
      texts: [{ x: 200, y: 60, w: 120, text: 'hi', color: '#000000' }],
    });
  assert.throws(() => post('groups/join', { ids: [a.id] }), refusal(400, 'ids is two groups or more'));
  const other = play.route('/api/notebooks/pages/create', {}, { notebook }).id,
    c = post('groups/create', { page: other, ink: [stroke(0, 0)] });
  assert.throws(
    () => post('groups/join', { ids: [a.id, c.id] }),
    refusal(400, "groups join on one page: a group doesn't span pages"),
  );
  const { group, joined } = post('groups/join', { ids: [a.id, b.id] });
  assert.deepEqual([group.id, group.ink.length, group.texts.length, joined], [a.id, 2, 1, [b.id]]);
  assert.deepEqual(
    groups().map(x => x.id),
    [a.id],
  );
  assert.throws(
    () => post('groups/split', { id: a.id, ink: [0, 1], texts: [0] }),
    refusal(400, 'a split leaves something on each side'),
  );
  assert.throws(
    () => post('groups/split', { id: a.id, ink: [5] }),
    e => e.status === 400,
  );
  const split = post('groups/split', { id: a.id, ink: [1], texts: [0] });
  assert.deepEqual([split.group.ink.length, split.split.ink.length, split.split.texts[0].text], [1, 1, 'hi']);
  assert.equal(groups().length, 2);
});

test('a group moves to another open page, shifted', () => {
  const { post, groups, page, notebook, play } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  const to = play.route('/api/notebooks/pages/create', {}, { notebook }).id;
  const moved = post('groups/move', { id: g.id, page: to, dx: 100, dy: 50 });
  assert.deepEqual([moved.page, moved.box.x, moved.box.y], [to, 108, 58]);
  assert.equal(groups().length, 0);
  assert.equal(groups(to).length, 1);
  assert.throws(() => post('groups/move', { id: g.id, page: to, dx: 'far' }), refusal(400, 'dx and dy are numbers'));
});

test('a page sent: sending for its seconds, undone, sent again, then read-only with a fresh page', () => {
  const { post, groups, page, notebook, play, clock } = played();
  const pages = () => play.route('/api/notebooks/pages', { notebook }).pages;
  assert.throws(() => post('pages/send', { id: page }), refusal(409, 'nothing on this page to send'));
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  const sending = post('pages/send', { id: page });
  assert.deepEqual([sending.sending, sending.sent], [true, null]);
  assert.equal(pages().length, 2, 'a fresh page at once');
  assert.equal(groups()[0].status, 'sent');
  assert.throws(
    () => post('groups/edit', { id: g.id, since: groups()[0].updated, ink: [stroke(0, 0)] }),
    refusal(409, 'a sent page is read-only: what the board wrote there stays'),
  );
  assert.throws(
    () => post('groups/create', { page, ink: [stroke(0, 0)] }),
    refusal(409, 'a sent page is read-only: draw on the current page'),
  );
  const undone = post('pages/undo', { id: page });
  assert.deepEqual([undone.sending, undone.sent, pages().length], [false, null, 1], 'the blank fresh page goes');
  assert.equal(groups()[0].status, 'open');
  assert.throws(() => post('pages/undo', { id: page }), refusal(409, "this page hasn't been sent"));
  post('pages/send', { id: page });
  clock.now += 10_001;
  const sent = pages().find(p => p.id === page);
  assert.deepEqual([sent.sending, sent.sent], [false, new Date(clock.now - 1).toISOString()]);
  assert.throws(() => post('pages/undo', { id: page }), refusal(409, 'too late to undo: the page has gone'));
  assert.throws(() => post('pages/send', { id: page }), refusal(409, 'this page has been sent'));
  assert.throws(
    () => post('groups/delete', { id: g.id }),
    refusal(409, 'a sent page is read-only: what the board wrote there stays'),
  );
  const fresh = pages().at(-1).id;
  assert.notEqual(fresh, page);
  assert.equal(post('groups/create', { page: fresh, ink: [stroke(0, 0)] }).page, fresh);
});

test('an answer under a sent group, a reply to it, taken back in its seconds', () => {
  const { post, groups, page, play, clock } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  assert.throws(() => play.answer(g.id, { by: 'moss', text: 'Too soon' }));
  post('pages/send', { id: page });
  clock.now += 10_001;
  const slip = play.answer(g.id, { by: 'moss', name: 'Moss', text: 'Done: have a look.' });
  assert.deepEqual(
    groups()[0].children.map(c => [c.kind, c.id, c.text]),
    [['answer', slip.id, 'Done: have a look.']],
  );
  assert.throws(() => post('groups/reply', { answer: slip.id }), refusal(400, 'a reply has words or ink'));
  assert.throws(() => post('groups/reply', { answer: 999, words: 'hi' }), refusal(404, 'not found'));
  const reply = post('groups/reply', { answer: slip.id, words: 'Lovely, thanks' });
  assert.equal(reply.parent, g.id);
  const children = groups()[0].children;
  assert.deepEqual(
    children.map(c => [c.kind, c.words ?? c.text]),
    [
      ['answer', 'Done: have a look.'],
      ['reply', 'Lovely, thanks'],
    ],
  );
  assert.equal(children[1].answers, slip.id);
  assert.throws(
    () => post('groups/delete', { id: reply.id }),
    refusal(409, 'a reply is taken back with /api/notebooks/replies/delete'),
  );
  assert.deepEqual(post('replies/delete', { id: reply.id }), { ok: true, id: reply.id });
  assert.equal(groups()[0].children.length, 1);
  const late = post('groups/reply', { answer: slip.id, words: 'One more' });
  clock.now += 10_001;
  assert.throws(
    () => post('replies/delete', { id: late.id }),
    refusal(409, 'too late to take back: the reply has gone'),
  );
});

test('a picture uploaded to an open page is placed in a group; a scrap lands on the current page', () => {
  const { post, page, play } = played();
  const kept = play.route('/api/notebooks/pictures', { page }, { bytes: PNG.buffer, type: 'image/png' });
  assert.match(kept.file, new RegExp(`^${page}-g-[0-9a-f]{8}\\.png$`));
  assert.deepEqual(play.picture(kept.file).bytes, PNG);
  assert.equal(play.route('/api/notebooks/pictures', { file: kept.file }).type, 'image/png');
  assert.throws(
    () => play.route('/api/notebooks/pictures', { page }, { bytes: PNG.buffer, type: 'image/gif' }),
    refusal(415, 'a JPEG or PNG only'),
  );
  const placed = { file: kept.file, x: 10, y: 10, w: 40, h: 40, tilt: 0 };
  assert.equal(
    post('groups/create', { page, pictures: [placed] }).pictures[0].url,
    `/api/notebooks/pictures?file=${kept.file}`,
  );
  assert.throws(
    () => post('groups/create', { page, pictures: [{ ...placed, file: 'x.png' }] }),
    refusal(400, 'a picture on the page is one uploaded to this page'),
  );
  const anchor = { v: 1, url: '/gazette', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 2 }, ink: [] };
  const snip = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
  const scrap = post('groups/scrap', { anchor, words: 'Warmer?', said: 'typed', snip });
  assert.deepEqual([scrap.kind, scrap.page, scrap.words, scrap.pictures[0].y], ['scrap', page, 'Warmer?', 82]);
  assert.throws(
    () => post('groups/scrap', { anchor: {}, snip }),
    e => e.status === 400,
  );
});

test("pages are titled, ordered and archived; dev mode's seed reads whole", () => {
  const seed = JSON.parse(readFileSync(new URL('../../mock/notebook.json', import.meta.url), 'utf8'));
  const { play, notebook, post, groups } = played(seed);
  const shelf = play.route('/api/notebooks').shelf;
  assert.deepEqual(
    shelf.map(n => n.kind),
    ['mine', 'invited'],
  );
  const { pages } = play.route('/api/notebooks/pages', { notebook });
  assert.ok(pages[0].sent && !pages.at(-1).sent, 'a page sent, the newest open');
  const answered = groups(pages[0].id).find(g => g.children.length);
  assert.deepEqual(
    answered.children.map(c => c.kind),
    ['answer', 'reply'],
  );
  assert.equal(answered.owner_name, 'Moss');
  const order = pages.map(p => p.id).reverse();
  assert.deepEqual(
    post('pages/order', { notebook, pages: order }).pages.map(p => p.id),
    order,
  );
  assert.throws(
    () => post('pages/order', { notebook, pages: order.slice(1) }),
    e => e.status === 400,
  );
  assert.equal(post('pages/title', { id: order[0], title: '  Menu   ideas ' }).title, 'Menu ideas');
  assert.equal(post('pages/archive', { id: order[0], archived: true }).archived, true);
  assert.equal(play.route('/api/notebooks/pages', { notebook }).archived.length, 1);
  assert.equal(post('archive', { id: shelf[1].id, archived: true }).archived, true);
  assert.equal(play.route('/api/notebooks').archive.length, 1);
});

test("Search: a group's words, its handwriting and the answers under it, as booksearch.ts finds them", () => {
  const { play, page, post } = played();
  const cut = post('groups/scrap', {
    anchor: { v: 1, url: '/gazette', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 2 }, ink: [] },
    ...{ words: 'The tear line is too dark', said: 'spoken' },
    snip: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
  });
  const drawn = post('groups/create', { page, ink: [stroke(10, 10)] });
  post('groups/edit', {
    id: drawn.id,
    since: drawn.updated,
    texts: [{ x: 0, y: 0, w: 90, color: '#2a2352', text: 'tear' }],
  });
  post('pages/send', { id: page });
  play.answer(cut.id, { by: 'moss', text: 'Lighter on the tear line now' });
  const tear = play.route('/api/book/search', { q: 'tear' });
  assert.deepEqual(
    tear.found.map(f => [f.how, f.note, f.n, f.page]),
    [
      ['answer', cut.id, 1, page],
      ['written', drawn.id, 2, page],
      ['spoken', cut.id, 1, page],
    ],
  );
  assert.deepEqual(play.route('/api/book/search', { q: '' }), { q: '', found: [], total: 0 });
});
