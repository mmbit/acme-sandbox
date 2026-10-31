// node --test src/notebook.test.ts   (the harness: the test company, the real server, the board's session, a job's hq)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { harness, type Running } from './harness.ts';
import { boxOf } from '../../hq/shell/ink/notebookstack.js';
import { ROOM, UNIT_W } from '../../hq/shell/ink/scrapunit.js';
import { GAP, MARGIN, widthFor } from '../../hq/shell/ink/masonry.js';

const h = await harness('notebook');
// (after the harness, as every coordinator module: it reads the company as it loads)
const { toUnits } = await import('./notebookunits.ts');
const { agent, db } = h;
const { ORIGIN } = await import('./config.ts');
const booknotes = await import('./ink/booknotes.ts');
const booksheets = await import('./ink/booksheets.ts');
const { onPublish } = await import('./events.ts');
const DIR = `${h.dataDir}/book`;

const stroke = (x: number, y: number) => ({
  color: '#2B2230',
  size: 6,
  points: [
    [x, y, 0.5, 0],
    [x + 80, y + 20, 0.6, 16],
  ],
});
const red = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
const SNIP = `data:image/png;base64,${(await red(720, 360)).toString('base64')}`;
const anchor = () => ({
  v: 1,
  url: `${ORIGIN}/?open=shop`,
  el: { selector: '#basket', tag: 'button', text: 'Basket', box: { x: 10, y: 40, w: 120, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
  ink: [stroke(20, 50)],
});

const shelf = async () => (await h.board('/api/notebooks')).body;
const myNotebook = async () => (await shelf()).shelf[0].id as number;
const pages = async (notebook: number) => (await h.board(`/api/notebooks/pages?notebook=${notebook}`)).body;
const groups = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const current = async (notebook: number) => (await pages(notebook)).pages.at(-1).id as number;
// Every open page of a notebook archived: the next one made is its only open page
async function noneOpen(notebook: number) {
  for (const p of (await pages(notebook)).pages)
    if (!p.sending && !p.sent && !p.tries) await h.board('/api/notebooks/pages/archive', { id: p.id, archived: true });
}
const draw = (page: number, ink: unknown[]) => h.board('/api/notebooks/groups/create', { page, ink });
const scrap = (body: Record<string, unknown> = {}) =>
  h.board('/api/notebooks/groups/scrap', {
    anchor: anchor(),
    words: 'The basket hides',
    said: 'typed',
    snip: SNIP,
    ...body,
  });
// A sent group's note delivered and its job claimed: the review note's number and the job
async function delivered(group: number) {
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const { note } = db.prepare('select note from notebook_groups where id = ?').get(group) as any;
  const { job } = db
    .prepare('select s.job from book_notes n join book_sheets s on s.id = n.sheet where n.id = ?')
    .get(note) as any;
  const review = (db.prepare('select id from review_notes where job = ?').get(job) as any).id as number;
  return { review, job: await h.claimJob(job) };
}
const answer = (job: Running, body: Record<string, unknown>) => agent('answer', job.token, body);

test('the old book carried into My journal once, nothing lost: its ink in groups, a waiting note an open scrap', async () => {
  // (a sheet sent, answered and replied to: the reply waits on kit's open sheet)
  const kits = (
    await h.board('/api/book/page/new', { w: 800, h: 600, kind: 'sheet', owner: 'kit', url: '/?open=shop' })
  ).body;
  const asked = (
    await h.board('/api/book/note', { page: kits.id, anchor: anchor(), words: 'Cheaper', said: 'typed', snip: SNIP })
  ).body.note;
  const kitSheet = (db.prepare('select sheet from book_notes where id = ?').get(asked.id) as any).sheet as number;
  await h.board('/api/book/send', { id: kitSheet });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const { job: kitJob } = db.prepare('select job from book_sheets where id = ?').get(kitSheet) as any;
  const kitRun = await h.claimJob(kitJob);
  const { review } = db.prepare('select review from book_notes where id = ?').get(asked.id) as any;
  const slip = (await answer(kitRun, { note: review, text: 'It is 4 euros now' })).body.slip;
  await h.board('/api/book/slip/reply', { id: slip.id, words: 'Make it 3' });
  await h.finish(kitRun);
  const sheet = (
    await h.board('/api/book/page/new', { w: 800, h: 600, kind: 'sheet', owner: 'moss', url: '/?open=shop' })
  ).body;
  await h.board('/api/book/note', {
    page: sheet.id,
    anchor: anchor(),
    words: 'Bigger basket',
    said: 'typed',
    snip: SNIP,
  });
  // (a free page at the book's routes, the Sketchbook's gone.)
  const free = (await h.board('/api/book/page/new', { kind: 'free', w: 800, h: 600 })).body;
  await h.board('/api/book/page/save', {
    id: free.id,
    ink: [stroke(10, 10), stroke(30, 20), stroke(600, 500)],
    scraps: [],
  });

  const { shelf: books, archive } = await shelf();
  assert.deepEqual(
    books.map((n: any) => [n.name, n.kind, n.archived]),
    [['My journal', 'mine', false]],
  );
  assert.deepEqual(archive, []);
  const listed = await pages(books[0].id);
  assert.deepEqual(
    listed.pages.map((p: any) => p.id),
    [kits.id, sheet.id, free.id],
    'in the order they were made, the newest the current page',
  );
  const [kitNote, waiting] = await groups(kits.id);
  assert.deepEqual([kitNote.status, kitNote.children.map((c: any) => c.kind)], ['sent', ['answer']]);
  assert.deepEqual(
    [waiting.kind, waiting.status, waiting.owner, waiting.words],
    ['scrap', 'open', 'kit', 'Make it 3'],
    'a waiting reply an open scrap, sent with its page',
  );
  await h.board('/api/notebooks/pages/send', { id: kits.id });
  assert.equal(await current(books[0].id), free.id, 'no fresh page while another is open');
  const { job: replyRun } = await delivered(waiting.id);
  const replyJob = db.prepare('select agent, prompt from jobs where id = ?').get(replyRun.id) as any;
  assert.equal(replyJob.agent, 'kit', 'it goes to kit');
  assert.match(replyJob.prompt, /Make it 3/);
  await h.finish(replyRun);
  const [note] = await groups(sheet.id);
  assert.deepEqual(
    [note.kind, note.status, note.owner, note.words, note.pictures.length, note.note],
    ['scrap', 'open', 'moss', 'Bigger basket', 1, null],
  );
  assert.ok(
    !db.prepare('select 1 from book_notes where page = ?').get(sheet.id),
    'off its sheet: it goes with its page',
  );
  assert.deepEqual(
    (await groups(free.id)).map(g => [g.kind, g.ink.length]),
    [
      ['drawing', 2],
      ['drawing', 1],
    ],
    'strokes near each other one group, the far one its own',
  );
  // (a page made by a screen without the Notebook yet: carried at the next read)
  const late = (await h.board('/api/book/page/new', { kind: 'free', w: 800, h: 600 })).body;
  assert.deepEqual(
    (await pages(books[0].id)).pages.map((p: any) => p.id),
    [kits.id, sheet.id, free.id, late.id],
  );
  assert.equal((await shelf()).shelf.length, 1, 'one My journal');
  // (a note written the old way since, onto a page already carried: an open scrap, the current page's last, and every
  // screen told.)
  const drawn = (await draw(late.id, [stroke(20, 300)])).body;
  const told: any[] = [],
    off = onPublish(e => void (e.type === 'book' && told.push(e)));
  await h.board('/api/book/note', { page: sheet.id, anchor: anchor(), words: 'Round it', said: 'typed', snip: SNIP });
  await pages(books[0].id);
  off();
  const landed = (await groups(late.id)).find(g => g.words === 'Round it');
  assert.deepEqual([landed?.kind, landed?.status, landed?.owner], ['scrap', 'open', 'moss']);
  assert.equal((await groups(late.id)).at(-1).id, landed.id, "the page's last");
  assert.ok(!db.prepare("select 1 from book_notes where words = 'Round it'").get(), 'off its old sheet');
  assert.ok(
    told.some(e => e.text === 'notebook' && e.page === late.id),
    'the current page read again where it shows',
  );
  for (const g of [drawn, landed]) await h.board('/api/notebooks/groups/delete', { id: g.id });
});

test('groups: units in order, edited (another screen first: read again), resized, split, moved, deleted with undo', async () => {
  const nb = await myNotebook(),
    page = await current(nb);
  const a = (await draw(page, [stroke(10, 10)])).body,
    b = (await h.board('/api/notebooks/groups/create', { page, ink: [stroke(300, 10)], column: 1 })).body;
  assert.deepEqual([a.kind, a.status, a.children], ['drawing', 'open', []]);
  assert.deepEqual([a.column, b.column], [null, 1], "the page's last kept in the column it was drawn in");
  assert.ok(b.pos > a.pos, "a new unit the page's last");
  assert.ok(a.h >= a.box.y + a.box.h, 'as tall as its ink');
  assert.equal((await draw(page, [])).status, 400, 'a group holds something');
  const after = (await h.board('/api/notebooks/groups/create', { page, ink: [stroke(0, 0)], after: a.id })).body;
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [a.id, after.id, b.id],
    'or right after the one named',
  );
  assert.equal((await h.board('/api/notebooks/groups/create', { page, ink: [stroke(0, 0)], after: 0 })).status, 400);

  const edited = (
    await h.board('/api/notebooks/groups/edit', { id: a.id, since: a.updated, ink: [stroke(10, 10), stroke(40, 300)] })
  ).body;
  assert.equal(edited.ink.length, 2);
  assert.ok(edited.h >= edited.box.y + edited.box.h, 'taller with what reaches past it');
  const stale = await h.board('/api/notebooks/groups/edit', { id: a.id, since: a.updated, ink: [stroke(10, 10)] });
  assert.deepEqual([stale.status, stale.body.error], [409, 'this group changed on another screen: read it again']);

  const resize = (body: object) => h.board('/api/notebooks/groups/resize', { id: a.id, ...body });
  const tall = (await resize({ since: edited.updated, h: 900 })).body;
  assert.equal(tall.h, 900, 'room to write dragged down');
  assert.equal((await resize({ since: edited.updated, h: 400 })).status, 409, 'read again first');
  assert.equal((await resize({ since: tall.updated, h: 'tall' })).status, 400);
  const short = (await resize({ since: tall.updated, h: 1 })).body;
  assert.equal(short.h, Math.ceil(short.box.y + short.box.h), 'no shorter than its ink');

  const split = (await h.board('/api/notebooks/groups/split', { id: a.id, ink: [1] })).body;
  assert.deepEqual([split.group.ink.length, split.split.ink.length], [1, 1]);
  assert.deepEqual([split.split.box.x, split.split.box.y], [0, 0], 'a unit of its own, from its top-left');
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [a.id, split.split.id, after.id, b.id],
    'right after the one it came out of',
  );
  assert.equal(
    (await h.board('/api/notebooks/groups/split', { id: a.id, ink: [0] })).status,
    400,
    'something left on each side',
  );

  const other = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body;
  await draw(other.id, [stroke(0, 0)]);
  const moved = (await h.board('/api/notebooks/groups/move', { id: split.split.id, page: other.id })).body;
  assert.deepEqual([moved.page, moved.ink, moved.h], [other.id, split.split.ink, split.split.h], 'as it was');
  assert.equal((await groups(other.id)).at(-1).id, moved.id, "the other page's last");
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [a.id, after.id, b.id],
  );

  assert.equal((await h.board('/api/notebooks/groups/delete', { id: a.id })).status, 200);
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [after.id, b.id],
  );
  const back = (await h.board('/api/notebooks/groups/restore', { id: a.id })).body;
  assert.deepEqual([back.id, back.page, back.ink.length], [a.id, page, 1]);
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [a.id, after.id, b.id],
    'back in its place',
  );
});

test("a unit put right after the same one again and again goes right after it every time, or at a page's start", async () => {
  const nb = await myNotebook(),
    page = await current(nb);
  await draw(page, [stroke(0, 0)]);
  const anchor = (await draw(page, [stroke(0, 0)])).body;
  await draw(page, [stroke(0, 0)]);
  for (let i = 0; i < 60; i++) {
    const put = (await h.board('/api/notebooks/groups/create', { page, ink: [stroke(0, 0)], after: anchor.id })).body;
    const order = (await groups(page)).map(g => g.id);
    assert.equal(order[order.indexOf(anchor.id) + 1], put.id, `insertion ${i + 1}`);
  }
  const other = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body;
  await h.board('/api/notebooks/groups/move', { id: anchor.id, page: other.id });
  await h.board('/api/notebooks/groups/move', { id: anchor.id, page, after: 'start' });
  assert.equal((await groups(page))[0].id, anchor.id, 'back as the first');
});

test("groups from before units: each its own unit, nothing lost, in the order its page read, room under an agent's", async () => {
  const nb = await myNotebook();
  await noneOpen(nb);
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  // (createGroup writes units, so each is put back in the page's px as the store kept groups before)
  const old = async (ink: unknown[], by = 'board') => {
    const g = (await draw(page, ink)).body;
    db.prepare('update notebook_groups set ink = ?, by = ?, pos = null, h = null where id = ?').run(
      JSON.stringify(ink),
      by,
      g.id,
    );
    return g.id as number;
  };
  const below = await old([stroke(20, 300), stroke(60, 340)]),
    right = await old([stroke(500, 40)], 'kit'),
    left = await old([stroke(20, 40)]),
    wide = await old([
      {
        ...stroke(20, 600),
        size: 2.5,
        points: [
          [20, 600, 0.5, 0],
          [2000, 640, 0.5, 16],
        ],
      },
    ]);
  toUnits();
  const units = await groups(page);
  assert.deepEqual(
    units.map(g => g.id),
    [left, right, below, wide],
    'top to bottom, then left to right',
  );
  assert.deepEqual(
    units.map(g => g.ink.map((s: any) => s.points.length)),
    [[2], [2], [2, 2], [2]],
    'every stroke and point kept',
  );
  for (const g of units) {
    const box = boxOf(g)!;
    assert.deepEqual([Math.round(box.x), Math.round(box.y)], [0, 0], `#${g.id} from its own top-left`);
    assert.ok(g.h >= box.y + box.h, `#${g.id} as tall as what's on it`);
  }
  assert.ok(boxOf(units[3])!.w <= 320 + 1, 'a wide one scaled down to a unit');
  const again = { id: wide, since: units[3].updated, ink: units[3].ink };
  assert.equal((await h.board('/api/notebooks/groups/edit', again)).status, 200, 'its thin pen saves again');
  assert.equal(units[1].h, Math.ceil(boxOf(units[1])!.h) + ROOM, "room to write under the agent's");
  assert.equal(units[0].h, Math.ceil(boxOf(units[0])!.h), "none under the board's own");
});

test('a scrap lands on the current page, under what is there; its picture is served; a changed page is a book event', async () => {
  const nb = await myNotebook(),
    page = await current(nb);
  const heard: any[] = [],
    deaf = onPublish(e => void (e.type === 'book' && heard.push(e)));
  const one = (await scrap()).body,
    two = (await scrap({ owner: 'kit' })).body;
  deaf();
  assert.deepEqual([one.page, two.page, one.kind, two.owner], [page, page, 'scrap', 'kit']);
  // (a readable width, clear of the controls on the widest narrower paper the board reads on, as an answer's spot is;
  // HQ fits it to a narrower one. Those papers come from the company's screens, so a wider one leaves room to spare.)
  assert.deepEqual([one.pictures[0].w, one.pictures[0].h], [313, 157], 'no wider than a column');
  assert.ok(two.pos > one.pos, "the page's last");
  assert.equal(one.h, one.pictures[0].h + ROOM, 'room to write under it');
  assert.ok(heard.length && heard.every(e => e.text === 'notebook' && e.page === page), 'every screen reads it again');
  assert.doesNotMatch(JSON.stringify(heard), /basket/i, 'none of its words');
  const res = await fetch(h.base + one.pictures[0].url, { headers: { cookie: h.boardCookie } });
  assert.deepEqual([res.status, res.headers.get('content-type')], [200, 'image/png']);
  assert.equal((await fetch(h.base + one.pictures[0].url)).status, 401, "the board's own");
  assert.equal((await scrap({ owner: 'nobody' })).status, 400);
  const drawn = await fetch(`${h.base}/api/book/picture?id=${page}`, { headers: { cookie: h.boardCookie } });
  assert.equal(drawn.status, 200, 'the page drawn whole, groups and all');
});

test("a page's picture is the page as the board sees it: each scrap's words under it, the last long note whole", async () => {
  const nb = await myNotebook();
  await noneOpen(nb);
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const said = (n: number) => `Scrap ${n}: its words on a post-it under it, long enough to wrap onto a second line`;
  const scraps = [];
  for (let n = 1; n <= 8; n++) scraps.push((await scrap({ words: said(n) })).body);
  // (typed notes as a call's agent leaves them, each long enough to wrap)
  const note = 'A promise for the board: the export shows the page whole, nothing cut off at the bottom. '.repeat(3);
  for (let n = 0; n < 5; n++) assert.equal((await scrap({ snip: null, words: note })).status, 200);
  const res = await fetch(`${h.base}/api/book/picture?id=${page}`, { headers: { cookie: h.boardCookie } });
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true });
  // (two columns of units, each scrap's post-it its own down the left of its column: none hidden under another unit)
  const k = info.width / widthFor(2),
    at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels).subarray(0, 3)];
  const yellow = (x: number, y: number) => {
    const [r, g, b] = at(Math.round(x * k), y);
    return r > 245 && g > 235 && b < 185;
  };
  const postIts = [MARGIN, MARGIN + UNIT_W + GAP].map(x => {
    let runs = 0;
    for (let y = 1; y < info.height; y++) if (yellow(x + 4, y) && !yellow(x + 4, y - 1)) runs++;
    return runs;
  });
  assert.equal(postIts[0] + postIts[1], scraps.length, `each scrap's words on their own post-it (${postIts})`);
  assert.ok(
    postIts.every(n => n > 0),
    'in both columns',
  );
  const inked = (y: number) => Array.from({ length: info.width }, (_, x) => at(x, y)[0] < 120).some(Boolean);
  const last = Array.from({ length: info.height }, (_, y) => y).findLast(inked)!;
  assert.ok(last < info.height - 20 * k, `the last note's last line whole, paper under it (${last} of ${info.height})`);
});

// Review mode's note with nothing to show, or a general one (the pin flow, bookreview.ts)
test("a scrap lands as its page's last unit, its picture at the unit's top-left", async () => {
  const nb = await myNotebook();
  await noneOpen(nb);
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const drawn = [];
  for (const x of [600, 1550, 1500]) drawn.push((await draw(page, [stroke(x, 200)])).body.id);
  const first = (await scrap()).body,
    second = (await scrap()).body;
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [...drawn, first.id, second.id],
    'after what was there, in the order they came',
  );
  assert.deepEqual([first.pictures[0].x, first.pictures[0].y], [0, 0]);
});

test('a scrap with no picture is its words typed on the current page, stacked, kept where it was written; none without words', async () => {
  const nb = await myNotebook(),
    page = await current(nb);
  const above = (await scrap()).body;
  const res = await scrap({ snip: null, owner: 'kit', words: 'Same on every page', said: 'spoken' });
  assert.equal(res.status, 200);
  const g = res.body;
  assert.deepEqual(
    [g.page, g.kind, g.pictures, g.texts.map((t: any) => t.text), g.owner, g.anchor.url],
    [page, 'note', [], ['Same on every page'], 'kit', anchor().url],
  );
  assert.ok(g.pos > above.pos, "the page's last");
  assert.equal(g.h, Math.ceil(g.box.y + g.box.h) + ROOM, 'room to write under its words');
  // words past a typed box's 2,000 characters go on in boxes under it, together the words whole
  const long = `${'Let the header breathe. '.repeat(100)}The end.`;
  const boxes = (await scrap({ snip: undefined, words: long })).body.texts as any[];
  assert.deepEqual([boxes.length, boxes.map(t => t.text).join('')], [2, long]);
  assert.ok(boxes[1].y > boxes[0].y, 'one under the other');
  for (const words of ['', '   ']) {
    const none = await scrap({ snip: null, words });
    assert.deepEqual(
      [none.status, none.body.error],
      [400, 'a note with no picture holds words'],
      JSON.stringify(words),
    );
  }
  // sent, it goes to its owner with its words as said
  assert.equal((await h.board('/api/notebooks/pages/send', { id: page })).status, 200);
  const { job } = await delivered(g.id);
  assert.equal((db.prepare('select agent from jobs where id = ?').get(job.id) as any).agent, 'kit');
  const { note } = db.prepare('select note from notebook_groups where id = ?').get(g.id) as any;
  const sent = db.prepare('select words, said, anchor from book_notes where id = ?').get(note) as any;
  assert.deepEqual(
    [sent.words, sent.said, JSON.parse(sent.anchor).url],
    ['Same on every page', 'spoken', anchor().url],
  );
  await h.finish(job);
});

test('send a page: at once, each group to its agent, no page made, the page read-only but answered', async () => {
  const nb = (await h.board('/api/notebooks')).body.shelf[0].id;
  await noneOpen(nb);
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const cut = (await scrap({ owner: 'moss', words: 'The basket button is tiny' })).body;
  const sketch = (await draw(page, [stroke(600, 600)])).body;
  assert.equal(cut.page, page);
  const before = (await pages(nb)).pages.length;

  const went = (await h.board('/api/notebooks/pages/send', { id: page })).body;
  assert.ok(went.sent && !went.sending, 'sent at once: no seconds to undo');
  assert.equal((await pages(nb)).pages.length, before, 'no page made after it');
  assert.equal((await draw(page, [stroke(1, 1)])).status, 409, 'read-only');
  assert.equal((await h.board('/api/notebooks/pages/undo', { id: page })).status, 404, 'no Undo of a send');
  const { review, job } = await delivered(cut.id);
  assert.equal(job.agent ?? (db.prepare('select agent from jobs where id = ?').get(job.id) as any).agent, 'moss');
  assert.match(
    (db.prepare('select prompt from jobs where id = ?').get(job.id) as any).prompt,
    /The basket button is tiny/,
  );
  const routed = db
    .prepare(
      'select s.job from notebook_groups g join book_notes n on n.id = g.note join book_sheets s on s.id = n.sheet where g.id = ?',
    )
    .get(sketch.id) as any;
  assert.equal(
    (db.prepare('select agent from jobs where id = ?').get(routed.job) as any).agent,
    'juno',
    'the rest: the routing check',
  );
  const other = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: cut.id })).status, 409, "the board's own stays");
  assert.equal((await h.board('/api/notebooks/groups/move', { id: cut.id, page: other })).status, 409);

  // the answer lands under its group; the board's reply goes to who answered, with its seconds to take it back
  const slip = (await answer(job, { note: review, text: 'Made it bigger: look again?' })).body.slip;
  const [answered] = (await groups(page)).filter(g => g.id === cut.id);
  assert.deepEqual(
    answered.children.map((c: any) => [c.kind, c.id]),
    [['answer', slip.id]],
  );
  const taken = (await h.board('/api/notebooks/groups/reply', { answer: slip.id, words: '✖' })).body;
  const reply = (await h.board('/api/notebooks/groups/reply', { answer: slip.id, words: '✔' })).body;
  assert.equal(reply.parent, cut.id, 'two replies to one agent in their seconds, each its own');
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: taken.id })).status, 409);
  assert.equal(
    (await h.board('/api/notebooks/replies/delete', { id: taken.id })).status,
    200,
    'taken back in its seconds',
  );
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const replied = (await groups(page)).find(g => g.id === cut.id).children.map((c: any) => [c.kind, c.words ?? c.text]);
  assert.deepEqual(replied, [
    ['answer', 'Made it bigger: look again?'],
    ['reply', '✔'],
  ]);
  const jobs = db.prepare("select prompt from jobs where agent = 'moss' order by id").all() as any[];
  assert.equal(jobs.length, 2, 'the reply a task for moss; the one taken back none');
  assert.match(jobs[1].prompt, /✔/);
  await h.finish(job);
});

test('a page sent with asks still open on it: those groups moved to a new page first, open, and the rest sent', async () => {
  const nb = (await h.board('/api/notebooks')).body.shelf[0].id;
  await noneOpen(nb);
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const kept = (await draw(page, [stroke(40, 40)])).body,
    asking = (await draw(page, [stroke(40, 400)])).body;
  const went = (await h.board('/api/notebooks/pages/send', { id: page, aside: [asking.id] })).body;
  assert.ok(went.sent, 'the page sent');
  const moved = db.prepare('select page, status from notebook_groups where id = ?').get(asking.id) as any;
  assert.notEqual(moved.page, page, 'the open ask on a page of its own');
  assert.equal(moved.status, 'open', 'still open, to answer there');
  assert.equal(await current(nb), moved.page, "the new page at the notebook's end");
  assert.equal(
    (db.prepare('select status from notebook_groups where id = ?').get(kept.id) as any).status,
    'sent',
    'the rest sent',
  );
  const onlyAsks = (await h.board('/api/notebooks/pages/send', { id: moved.page, aside: [asking.id] })).body;
  assert.equal(onlyAsks.error, 'nothing on this page to send', 'a page of asks alone has nothing to send');
});

test('pages: titled, reordered, archived; a notebook archived, My journal stays; nothing of another person', async () => {
  const nb = await myNotebook();
  const before = await pages(nb),
    all = [...before.pages, ...before.archived].map((p: any) => p.id);
  const titled = (await h.board('/api/notebooks/pages/title', { id: all[0], title: '  Shop  ideas ' })).body;
  assert.equal(titled.title, 'Shop ideas');
  assert.equal((await h.board(`/api/notebooks/pages/groups?page=${all[0]}`)).body.notebook, nb, 'its notebook said');
  const reversed = [...all].reverse();
  assert.deepEqual(
    (await h.board('/api/notebooks/pages/order', { notebook: nb, pages: reversed })).body.pages.map((p: any) => p.id),
    reversed.filter(id => before.pages.some((p: any) => p.id === id)),
  );
  assert.equal((await h.board('/api/notebooks/pages/order', { notebook: nb, pages: reversed.slice(1) })).status, 400);
  const archived = (await h.board('/api/notebooks/pages/archive', { id: all[0], archived: true })).body;
  assert.equal(archived.archived, true);
  const listed = await pages(nb);
  assert.ok(listed.archived.some((p: any) => p.id === all[0]) && !listed.pages.some((p: any) => p.id === all[0]));
  const refused = await h.board('/api/notebooks/archive', { id: nb, archived: true });
  assert.deepEqual([refused.status, refused.body.error], [409, 'My journal stays on the shelf']);
  assert.equal((await h.board('/api/notebooks/pages?notebook=999')).status, 404);
  assert.equal((await h.board('/api/notebooks/pages/groups?page=999')).status, 404);
  assert.ok(!existsSync(`${DIR}/nothing`));
});

test("a page's zoom kept by the book's shape, as the board left it, without changing the page", async () => {
  const id = await current(await myNotebook()),
    zoom = (body: Record<string, unknown>) => h.board('/api/notebooks/pages/zoom', { id, ...body }),
    was = (await pages(await myNotebook())).pages.find((p: any) => p.id === id);
  assert.deepEqual(was.zooms, {}, 'a page never zoomed opens at 100%');
  await zoom({ shape: 'wide', zoom: 0.72 });
  const kept = (await zoom({ shape: 'narrow', zoom: 1.25 })).body;
  assert.deepEqual(kept.zooms, { wide: 0.72, narrow: 1.25 });
  assert.equal((await zoom({ shape: 'wide', zoom: 1 })).body.zooms.wide, 1, 'back to 100% kept too');
  assert.equal(kept.updated, was.updated, 'its picture and other screens read it as it was');
  assert.equal((await zoom({ shape: 'huge', zoom: 1 })).status, 400);
  assert.equal((await zoom({ shape: 'wide', zoom: 'big' })).status, 400);
  assert.equal((await zoom({ shape: 'narrow', zoom: 0.02 })).body.zooms.narrow, 0.02, "a long page's least on a phone");
  assert.equal((await zoom({ shape: 'wide', zoom: 5 })).status, 400, 'past the closest the book zooms in');
  assert.equal((await h.board('/api/notebooks/pages/zoom', { id: 999, shape: 'wide', zoom: 1 })).status, 404);
});

test("two pages sent to one agent go as two sheets, and an old book's note keeps to its own", async () => {
  const nb = await myNotebook();
  await noneOpen(nb);
  const before = (db.prepare("select count(*) n from jobs where agent = 'kit'").get() as any).n;
  const first = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  await scrap({ owner: 'kit', words: 'Rounder corners' });
  assert.equal((await h.board('/api/notebooks/pages/send', { id: first })).status, 200);
  const second = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const cut = (await scrap({ owner: 'kit', words: 'Warmer red' })).body;
  assert.equal(cut.page, second);
  assert.equal((await h.board('/api/notebooks/pages/send', { id: second })).status, 200);
  const old = (await h.board('/api/book/page/new', { w: 800, h: 600, kind: 'sheet', owner: 'kit', url: '/?open=shop' }))
    .body;
  const added = (await h.board('/api/book/note', { page: old.id, anchor: anchor(), words: 'Old book', said: 'typed' }))
    .body.note;
  const sheetOf = (note: number) =>
    (db.prepare('select sheet from book_notes where id = ?').get(note) as any).sheet as number;
  const { note: firstNote } = db.prepare('select note from notebook_groups where id = ?').get(cut.id) as any;
  assert.notEqual(sheetOf(added.id), sheetOf(firstNote), "the old book's note on kit's own open sheet");
  assert.equal((await h.board('/api/book/undo', { id: sheetOf(firstNote) })).status, 409, 'undone on its page');

  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const after = db.prepare("select prompt from jobs where agent = 'kit' order by id desc limit 2").all() as any[];
  assert.equal((db.prepare("select count(*) n from jobs where agent = 'kit'").get() as any).n, before + 2);
  assert.deepEqual(
    after.map(j => /Rounder corners/.test(j.prompt) !== /Warmer red/.test(j.prompt)),
    [true, true],
    'each page its own task',
  );
  assert.equal(
    (db.prepare('select status from book_sheets where id = ?').get(sheetOf(added.id)) as any).status,
    'open',
    "kit's old sheet waits for its own send",
  );
});

// (the agents' cards under their group)
test("an agent's card about a sent group's note: under the group, Open in the book at its page, answered either place", async () => {
  const nb = await myNotebook();
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const cut = (await scrap({ owner: 'moss', words: 'Which blue for the basket?' })).body;
  await h.board('/api/notebooks/pages/send', { id: page });
  const { review, job } = await delivered(cut.id);
  const told: any[] = [],
    off = onPublish(e => void (e.type === 'book' && e.text === 'ask' && told.push(e)));
  const file = `${mkdtempSync(`${tmpdir()}/notebook-ask-`)}/card.md`;
  writeFileSync(file, 'Two blues read well. Which stays?\n\nChoose:\n- Teal: calmer.\n- Navy: stronger.');
  const filed = await h.hq(
    job,
    'ask',
    'decision',
    'today',
    'The basket: which blue?',
    file,
    '--note',
    String(review),
    '--topic',
    'shop',
  );
  const id = Number(filed.out.match(/Request #(\d+)/)?.[1]);
  assert.ok(id, filed.out);
  assert.deepEqual(
    told.map(e => e.page),
    [page],
    "the group's page read again",
  );
  const under = async () => (await groups(page)).find(g => g.id === cut.id).asks as any[];
  const [shown] = await under();
  assert.deepEqual([shown.id, shown.status, shown.name], [id, 'open', 'Moss']);
  assert.match(shown.body, /Choose:/);
  // the desk phone's card opens the book at the group's page, in its notebook
  const card = ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.deepEqual([card.place.page, card.place.notebook, card.place.words], [page, nb, 'Which blue for the basket?']);

  // a key card stays on the desk phone, out of the book
  const keys = await agent('request', job.token, {
    ...{ kind: 'credential', title: 'The basket feed', body: 'Its key.', secrets: 'STRIPE_TEST_KEY' },
    ...{ topic: 'shop', note: review },
  });
  assert.equal(keys.status, 200, JSON.stringify(keys.body));
  assert.deepEqual(
    (await under()).map(a => a.id),
    [id],
  );

  // the book's chip posts the desk phone's own answer: off the desk phone, answered under the group
  told.length = 0;
  assert.equal((await h.board('/api/requests/answer', { id, answer: 'Teal' })).status, 200);
  off();
  assert.ok(!((await h.board('/api/requests')).body as any[]).some(r => r.id === id), 'off the desk phone');
  const answered = (await under()).find(a => a.id === id);
  assert.deepEqual([answered.status, answered.answer], ['answered', 'Teal']);
  assert.deepEqual(
    told.map(e => e.page),
    [page],
  );
  await h.finish(job);
});
