// node --test platform/hq/shell/ink/notebookplay.test.js   (the Notebook's store played in memory; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notebookPlay } from './notebookplay.js';
import { CHANGED } from './notebookplaygroups.js';
import { ROOM, UNIT_W } from './scrapunit.js';

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

test('no seed: My journal with one blank page, current', () => {
  const { play, notebook, page } = played();
  const shelf = play.route('/api/notebooks');
  assert.deepEqual(
    shelf.shelf.map(n => [n.name, n.kind]),
    [['My journal', 'mine']],
  );
  assert.throws(
    () => play.route('/api/notebooks/archive', {}, { id: notebook, archived: true }),
    refusal(409, 'My journal stays on the shelf'),
  );
  assert.equal(play.route('/api/notebooks/pages', { notebook }).pages.length, 1);
  assert.equal(page, play.route('/api/notebooks/pages', { notebook }).pages[0].id, "a read doesn't make another");
  assert.equal(
    play.route('/api/notebooks/pages/groups', { page }).notebook,
    notebook,
    "a page's groups say its notebook",
  );
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

test("a unit is created at the page's end (in a column) or right after another, as tall as its parts reach", () => {
  const { post, groups, page } = played();
  const a = post('groups/create', { page, ink: [stroke(10, 10)] }),
    b = post('groups/create', { page, ink: [stroke(10, 200)], column: 1 }),
    c = post('groups/create', { page, ink: [stroke(10, 10)], after: a.id, column: 1 });
  assert.deepEqual(
    groups().map(x => x.column),
    [null, null, 1],
    "the column kept only by the page's last",
  );
  assert.deepEqual(
    groups().map(x => x.id),
    [a.id, c.id, b.id],
  );
  assert.ok(a.pos < c.pos && c.pos < b.pos);
  assert.equal(groups().find(x => x.id === a.id).pos, a.pos, 'nothing else moves for it');
  assert.ok(b.h >= b.box.y + b.box.h);
  assert.throws(
    () => post('groups/create', { page, ink: [stroke(0, 0)], after: 999 }),
    refusal(400, 'after is a unit on this page'),
  );
  const d = post('groups/create', { page, ink: [stroke(0, 0)], after: b.id });
  assert.equal(groups().at(-1).id, d.id);
});

test("edit grows a unit when ink goes past its bottom; resize can't cut into its parts", () => {
  const { post, page } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  const grown = post('groups/edit', { id: g.id, since: g.updated, ink: [stroke(10, 10), stroke(10, 300)] });
  assert.ok(grown.h >= 300);
  const tall = post('groups/resize', { id: g.id, since: grown.updated, h: 600 });
  assert.equal(tall.h, 600);
  const kept = post('groups/edit', { id: g.id, since: tall.updated, ink: [stroke(10, 10)] });
  assert.equal(kept.h, 600, 'an edit never shrinks it');
  const short = post('groups/resize', { id: g.id, since: kept.updated, h: 5 });
  assert.ok(short.h >= short.box.y + short.box.h && short.h < 600);
  assert.throws(() => post('groups/resize', { id: g.id, since: kept.updated, h: 400 }), refusal(409, CHANGED));
  for (const h of ['tall', -40, 0])
    assert.throws(
      () => post('groups/resize', { id: g.id, since: short.updated, h }),
      refusal(400, 'h is a positive number'),
    );
});

test('split lifts elements out into a unit right after its own; join is gone', () => {
  const { post, groups, page } = played();
  const a = post('groups/create', {
      page,
      ink: [stroke(10, 10), stroke(200, 300)],
      texts: [{ x: 200, y: 260, w: 120, text: 'hi', color: '#000000' }],
    }),
    b = post('groups/create', { page, ink: [stroke(0, 0)] });
  assert.throws(() => post('groups/join', { ids: [a.id, b.id] }), refusal(404, 'not found'));
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
  assert.deepEqual(
    groups().map(x => x.id),
    [a.id, split.split.id, b.id],
  );
  assert.deepEqual([split.split.box.x, split.split.box.y], [0, 0], 'the lifted unit starts at its own top-left');
  assert.equal(split.group.h, a.h, 'the unit split keeps its height');
});

test('a unit moves to the end of another open page as it was', () => {
  const { post, groups, page, notebook, play } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  const to = play.route('/api/notebooks/pages/create', {}, { notebook }).id,
    there = post('groups/create', { page: to, ink: [stroke(10, 10)] });
  const moved = post('groups/move', { id: g.id, page: to });
  assert.deepEqual([moved.page, moved.box, moved.h], [to, g.box, g.h]);
  assert.equal(groups().length, 0);
  assert.deepEqual(
    groups(to).map(x => x.id),
    [there.id, g.id],
  );
});

test('a page sent: at once, read-only, it stays the last page; open asks set aside on a new page', () => {
  const { post, groups, page, notebook, play, clock } = played();
  const pages = () => play.route('/api/notebooks/pages', { notebook }).pages;
  assert.throws(() => post('pages/send', { id: page }), refusal(409, 'nothing on this page to send'));
  const g = post('groups/create', { page, ink: [stroke(10, 10)] }),
    asking = post('groups/create', { page, ink: [stroke(10, 300)] });
  const sent = post('pages/send', { id: page, aside: [asking.id] });
  assert.deepEqual([sent.sending, sent.sent], [false, new Date(clock.now).toISOString()], 'sent at once');
  assert.deepEqual(
    groups().map(x => [x.id, x.status]),
    [[g.id, 'sent']],
    'the open ask moved off it',
  );
  const after = pages().at(-1).id;
  assert.notEqual(after, page, 'the open ask on a new page');
  assert.deepEqual(
    groups(after).map(x => [x.id, x.status]),
    [[asking.id, 'open']],
  );
  assert.equal(pages().length, 2, 'no other page made');
  assert.throws(
    () => post('groups/edit', { id: g.id, since: groups()[0].updated, ink: [stroke(0, 0)] }),
    refusal(409, 'a sent page is read-only: what the board wrote there stays'),
  );
  assert.throws(
    () => post('groups/create', { page, ink: [stroke(0, 0)] }),
    refusal(409, 'a sent page is read-only: draw on the current page'),
  );
  assert.throws(
    () => post('pages/undo', { id: page }),
    e => e.status === 404,
    'no Undo of a send',
  );
  assert.throws(() => post('pages/send', { id: page }), refusal(409, 'this page has been sent'));
  post('pages/send', { id: after });
  assert.equal(pages().length, 2, 'the last page sent: still no page made after it');
});

test('answers on a group not sent: the one coming, a form answered, a question replied to, the open list', () => {
  const { post, groups, page, play } = played();
  const g = post('groups/create', { page, texts: [{ x: 60, y: 60, w: 260, color: '#2b2230', text: 'which colour?' }] });
  play.asking(g.id, { by: 'moss', spot: { dx: 0, dy: 60, w: 300 } });
  assert.deepEqual(groups()[0].waiting, { by: 'moss', name: 'moss', spot: { dx: 0, dy: 60, w: 300 }, style: 'text' });
  const form = [
    { title: 'Which colour?', options: ['Warm', 'Cool'] },
    { title: 'Anything else?', optional: true },
  ];
  const asked = play.answer(g.id, { by: 'moss', style: 'form', text: 'Two quick ones:', form });
  const shall = play.answer(g.id, { by: 'moss', style: 'question', text: 'One line on phones?' });
  assert.equal(groups()[0].waiting, null, 'the answer came');
  assert.deepEqual(
    groups()[0].children.map(c => [c.kind, c.id, c.grp, c.style]),
    [
      ['answer', asked.id, g.id, 'form'],
      ['answer', shall.id, g.id, 'question'],
    ],
  );
  const open = () => play.route('/api/notebooks/open');
  assert.deepEqual(
    [open().forms.map(i => [i.id, i.group, i.page]), open().questions.map(i => i.id)],
    [[[asked.id, g.id, page]], [shall.id]],
  );
  assert.throws(
    () => post('answers/form', { id: asked.id, answers: ['Warm'] }),
    refusal(400, 'answers is one answer per question, in their order'),
  );
  assert.throws(
    () => post('answers/form', { id: asked.id, answers: ['Red', ''] }),
    refusal(400, "question 1: that answer doesn't fit it"),
  );
  assert.deepEqual(post('answers/form', { id: asked.id, answers: ['Warm', ''] }).answer.form_answer, ['Warm', '']);
  assert.throws(
    () => post('answers/form', { id: asked.id, answers: ['Cool', ''] }),
    refusal(409, 'this form has been answered'),
  );
  post('groups/reply', { answer: shall.id, words: 'Yes please' });
  assert.deepEqual(open(), { forms: [], questions: [] }, 'nothing left open');
});

test("a try's versions coming, made, picked by a tick and moved; a try that made none says why", () => {
  const { post, groups, page, play } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  play.trying(g.id, { by: 'moss', expect: 2, going: true });
  const a = play.answer(g.id, { by: 'moss', style: 'version', version: 'A', text: 'A' });
  assert.equal(groups()[0].try.state, 'coming');
  const b = play.answer(g.id, { by: 'moss', style: 'version', version: 'B', text: 'B' });
  play.trying(g.id, { by: 'moss', expect: 2, going: false });
  assert.deepEqual(groups()[0].try, { state: 'made', expect: 2, by: 'moss', name: 'moss', reason: null });
  const picked = () =>
    groups()[0]
      .children.filter(c => c.picked)
      .map(c => c.id);
  assert.throws(() => post('answers/tick', { id: a.id }), refusal(400, 'ticked is true or false'));
  post('answers/tick', { id: b.id, ticked: true });
  assert.deepEqual(picked(), [b.id]);
  post('answers/tick', { id: a.id, ticked: true });
  assert.deepEqual(picked(), [a.id], 'one pick per try');
  const none = post('groups/create', { page, ink: [stroke(200, 200)] });
  play.trying(none.id, { by: 'moss', expect: 3, going: false });
  assert.equal(
    groups().find(x => x.id === none.id).try.reason,
    "moss's try ended without a version. Write on the scrap to ask again.",
  );
});

test('an answer under a sent group, a reply to it, taken back in its seconds', () => {
  const { post, groups, page, play, clock } = played();
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
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
  assert.equal(children[1].frame, null, 'words alone: no frame');
  // (a reply on a version keeps its frame, and refuses an invalid one)
  const frame = { x: 360, y: 72, w: 300, h: 225 };
  const ringed = post('groups/reply', { answer: slip.id, ink: [stroke(350, 60)], frame: { ...frame, extra: 1 } });
  assert.deepEqual(groups()[0].children.find(c => c.id === ringed.id).frame, frame);
  assert.throws(
    () => post('groups/reply', { answer: slip.id, ink: [stroke(350, 60)], frame: { ...frame, w: 0 } }),
    e => e.status === 400,
  );
  assert.throws(
    () => post('groups/reply', { answer: slip.id, frame: { ...frame, w: 0 } }),
    refusal(400, 'a reply has words or ink'),
    'an empty reply is refused before its frame is read, as in notebooksend.ts replyTo',
  );
  assert.equal(groups()[0].children.length, 3, 'a refused frame leaves no reply');
  post('replies/delete', { id: ringed.id });
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
  const { post, groups, page, play } = played();
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
  // (the page's last unit)
  assert.deepEqual([scrap.kind, scrap.page, scrap.words, groups().at(-1).id], ['scrap', page, 'Warmer?', scrap.id]);
  assert.throws(
    () => post('groups/scrap', { anchor: {}, snip }),
    e => e.status === 400,
  );
});

test('a scrap is a unit at its own top-left with room under it; a note typed is one too', () => {
  const { post, groups, page } = played();
  const anchor = { v: 1, url: '/gazette', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 2 }, ink: [] };
  const snip = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
  const scrap = post('groups/scrap', { anchor, words: 'Warmer?', said: 'spoken', snip });
  assert.deepEqual([scrap.page, scrap.pictures[0].x, scrap.pictures[0].y], [page, 0, 0]);
  assert.ok(scrap.h >= scrap.pictures[0].h + ROOM);
  const typed = post('groups/scrap', { anchor, words: 'Same everywhere', said: 'typed', owner: 'moss' });
  assert.deepEqual(
    [typed.kind, typed.page, typed.words, typed.said, typed.owner, typed.pictures],
    ['note', page, '', 'typed', 'moss', []],
  );
  assert.deepEqual(typed.texts, [{ x: 0, y: 0, w: UNIT_W, text: 'Same everywhere', color: '#1d1a2f' }]);
  assert.ok(typed.h >= typed.box.h + ROOM);
  assert.deepEqual(
    groups().map(x => x.id),
    [scrap.id, typed.id],
  );
  assert.throws(() => post('groups/scrap', { anchor, words: '' }), refusal(400, 'a note with no picture holds words'));
});

test("pages are titled, ordered and archived; dev mode's seed reads whole", () => {
  const seed = JSON.parse(readFileSync(new URL('../../mock/notebook.json', import.meta.url), 'utf8'));
  const { play, notebook, post, groups } = played(seed);
  const shelf = play.route('/api/notebooks').shelf;
  assert.deepEqual(
    shelf.map(n => n.kind),
    ['mine', 'round', 'round', 'round', 'round', 'project', 'project', 'invited'],
  );
  const { pages } = play.route('/api/notebooks/pages', { notebook });
  assert.ok(pages[0].sent && !pages.at(-1).sent, 'a page sent, the newest open');
  const answered = groups(pages[0].id).find(g => g.children.length);
  assert.deepEqual(
    answered.children.map(c => c.kind),
    ['answer', 'reply'],
  );
  assert.equal(answered.owner_name, 'Moss');
  // (the agents' answers the book's answers layer draws: a project book's sent page with a form, a question, a try's
  // versions and an answer still coming; the open list from them.)
  const launch = shelf.find(n => n.name === 'Launch').id,
    asked = groups(play.route('/api/notebooks/pages', { notebook: launch }).pages[0].id);
  assert.deepEqual(
    ['form', 'question', 'version'].map(style => asked.some(g => g.children.some(c => c.style === style))),
    [true, true, true],
  );
  assert.equal(asked.find(g => g.try)?.try.state, 'made');
  assert.ok(asked.some(g => g.waiting));
  const open = play.route('/api/notebooks/open');
  assert.deepEqual([open.forms.length, open.questions.length], [1, 1]);
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

test('a scrap handed to someone keeps its place and wears their tag; the short list puts them first', () => {
  const people = [
    { to: 'guest:14', name: 'Femke Jansen-Okafor', kind: 'guest' },
    { to: 'agent:wiebe', name: 'Wiebe', kind: 'agent' },
    { to: 'guest:11', name: 'Annemieke Bos', kind: 'guest' },
  ];
  const { play, post, groups, page } = played({ people });
  const names = list => list.map(p => p.name);
  assert.deepEqual(names(play.route('/api/notebooks/people').everyone), [
    'Annemieke Bos',
    'Femke Jansen-Okafor',
    'Wiebe',
  ]);
  const g = post('groups/create', { page, ink: [stroke(10, 10)] });
  const given = post('groups/assign', { id: g.id, to: 'agent:wiebe' });
  assert.deepEqual(given.to, people[1]);
  assert.deepEqual(given.group.box, g.box, 'it stays where it is');
  assert.deepEqual(groups()[0].assigned, [{ ...people[1], answered: false }]);
  assert.deepEqual(names(play.route('/api/notebooks/people').recent), [
    'Wiebe',
    'Annemieke Bos',
    'Femke Jansen-Okafor',
  ]);
  assert.throws(
    () => post('groups/assign', { id: g.id, to: 'guest:Nobody' }),
    e => e.status === 400,
  );
  assert.throws(
    () => post('groups/assign', { id: 999, to: 'agent:wiebe' }),
    e => e.status === 404,
  );
  post('pages/send', { id: page });
  assert.throws(
    () => post('groups/assign', { id: g.id, to: 'agent:wiebe' }),
    e => e.status === 409,
  );
});

test("a book's cover given from the shelf, read back with it; anything but a picture refused", () => {
  const play = notebookPlay({ seed: null });
  const mine = play.route('/api/notebooks').shelf[0];
  assert.deepEqual([mine.name, mine.cover, mine.news, mine.asks], ['My journal', null, 0, { open: 0, all: 0 }]);
  const picture = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(play.route('/api/notebooks/cover', {}, { id: mine.id, picture }), { id: mine.id, cover: picture });
  assert.equal(play.route('/api/notebooks').shelf[0].cover, picture);
  assert.throws(
    () => play.route('/api/notebooks/cover', {}, { id: mine.id, picture: 'data:text/plain;base64,aGk=' }),
    refusal(400, 'the picture is a PNG or JPEG data URL'),
  );
});
