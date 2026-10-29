// node --test src/notebook.test.ts   (the harness: the test company, the real server, the board's session, a job's hq)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { harness, type Running } from './harness.ts';
import { STACK, footprint } from '../../hq/shell/ink/notebookstack.js';

const h = await harness('notebook');
// (after the harness, as every coordinator module: it reads the company as it loads)
const { ANSWER, NARROWER } = await import('./ink/answerspot.ts');
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

test('the old book carried into My Notebook once, nothing lost: its ink in groups, a waiting note an open scrap', async () => {
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
  const free = (await h.board('/api/sketches/create', { w: 800, h: 600 })).body;
  const picture = `data:image/png;base64,${(await red(4, 4)).toString('base64')}`;
  await h.board('/api/sketches/save', {
    id: free.id,
    ink: [stroke(10, 10), stroke(30, 20), stroke(600, 500)],
    picture,
    scraps: [],
  });

  const { shelf: books, archive } = await shelf();
  assert.deepEqual(
    books.map((n: any) => [n.name, n.kind, n.archived]),
    [['My Notebook', 'mine', false]],
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
  const late = (await h.board('/api/sketches/create', { w: 800, h: 600 })).body;
  assert.deepEqual(
    (await pages(books[0].id)).pages.map((p: any) => p.id),
    [kits.id, sheet.id, free.id, late.id],
  );
  assert.equal((await shelf()).shelf.length, 1, 'one My Notebook');
  // (a note written the old way since, onto a page already carried: an open scrap on the current page, under what's
  // there, and every screen told.)
  const drawn = (await draw(late.id, [stroke(20, 300)])).body;
  const told: any[] = [],
    off = onPublish(e => void (e.type === 'book' && told.push(e)));
  await h.board('/api/book/note', { page: sheet.id, anchor: anchor(), words: 'Round it', said: 'typed', snip: SNIP });
  await pages(books[0].id);
  off();
  const landed = (await groups(late.id)).find(g => g.words === 'Round it');
  assert.deepEqual([landed?.kind, landed?.status, landed?.owner], ['scrap', 'open', 'moss']);
  assert.ok(landed.box.y > 300, 'under what was drawn there');
  assert.ok(!db.prepare("select 1 from book_notes where words = 'Round it'").get(), 'off its old sheet');
  assert.ok(
    told.some(e => e.text === 'notebook' && e.page === late.id),
    'the current page read again where it shows',
  );
  for (const g of [drawn, landed]) await h.board('/api/notebooks/groups/delete', { id: g.id });
});

test('groups: drawn, edited (another screen first: read again), joined and split, moved, deleted with undo', async () => {
  const nb = await myNotebook(),
    page = await current(nb);
  const a = (await draw(page, [stroke(10, 10)])).body,
    b = (await draw(page, [stroke(300, 10)])).body;
  assert.deepEqual([a.kind, a.status, a.children], ['drawing', 'open', []]);
  assert.equal((await draw(page, [])).status, 400, 'a group holds something');

  const edited = (
    await h.board('/api/notebooks/groups/edit', { id: a.id, since: a.updated, ink: [stroke(10, 10), stroke(40, 30)] })
  ).body;
  assert.equal(edited.ink.length, 2);
  const stale = await h.board('/api/notebooks/groups/edit', { id: a.id, since: a.updated, ink: [stroke(10, 10)] });
  assert.deepEqual([stale.status, stale.body.error], [409, 'this group changed on another screen: read it again']);

  const joined = (await h.board('/api/notebooks/groups/join', { ids: [a.id, b.id] })).body;
  assert.deepEqual([joined.group.id, joined.group.ink.length, joined.joined], [a.id, 3, [b.id]]);
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [a.id],
  );
  const split = (await h.board('/api/notebooks/groups/split', { id: a.id, ink: [2] })).body;
  assert.deepEqual([split.group.ink.length, split.split.ink.length], [2, 1]);
  assert.equal(
    (await h.board('/api/notebooks/groups/split', { id: a.id, ink: [0, 1] })).status,
    400,
    'something left on each side',
  );

  const other = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body;
  const moved = (await h.board('/api/notebooks/groups/move', { id: split.split.id, page: other.id, dx: 5, dy: -5 }))
    .body;
  assert.equal(moved.page, other.id);
  assert.deepEqual(moved.ink[0].points[0].slice(0, 2), [305, 5]);
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [a.id],
  );

  assert.equal((await h.board('/api/notebooks/groups/delete', { id: a.id })).status, 200);
  assert.deepEqual(await groups(page), []);
  const back = (await h.board('/api/notebooks/groups/restore', { id: a.id })).body;
  assert.deepEqual([back.id, back.page, back.ink.length], [a.id, page, 2]);
  assert.equal(
    (await h.board('/api/notebooks/groups/join', { ids: [a.id, moved.id] })).status,
    400,
    'no group spans pages',
  );
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
  // HQ fits it to a narrower one)
  assert.deepEqual([one.pictures[0].w, one.pictures[0].h], [313, 157], 'no wider than a column');
  assert.equal(STACK.w, NARROWER[0] - ANSWER.rail - STACK.x, 'left of the controls there');
  // (its words under it, one line: 10 px below, 8 above and below them, a 20 px line; then the gap)
  assert.ok(two.box.y >= one.box.y + one.box.h + 46 + 32, 'stacked under, its words and a gap between');
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
  const box = db.prepare('select x, y, w from book_pages where id = ?').get(page) as {
    x: number;
    y: number;
    w: number;
  };
  const k = info.width / box.w,
    at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels).subarray(0, 3)];
  for (const s of scraps) {
    const [r, g, b] = at(Math.round((s.box.x - box.x + 4) * k), Math.round((s.box.y + s.box.h + 14 - box.y) * k));
    assert.ok(r > 245 && g > 235 && b < 185, `scrap ${s.id}'s words on their yellow post-it (${[r, g, b]})`);
  }
  const inked = (y: number) => Array.from({ length: info.width }, (_, x) => at(x, y)[0] < 120).some(Boolean);
  const last = Array.from({ length: info.height }, (_, y) => y).findLast(inked)!;
  assert.ok(last < info.height - 20 * k, `the last note's last line whole, paper under it (${last} of ${info.height})`);
});

// Review mode's note with nothing to show, or a general one (the pin flow, bookreview.ts)
test("a scrap lands under the newest thing on its page, past what's in its way; the pin counts the board's notes there", async () => {
  const { menuOf } = await import('./ink/bookreview.ts'),
    { HQ } = await import('./feedback.ts');
  const nb = await myNotebook();
  await noneOpen(nb);
  assert.equal(menuOf(HQ, '/').notes, 0, 'no page open: no count');
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  assert.equal(menuOf(HQ, '/').notes, 0, 'a blank page: no count');
  await draw(page, [stroke(600, 3000)]);
  const inWay = (await draw(page, [stroke(1550, 330)])).body.box,
    newest = (await draw(page, [stroke(1500, 200)])).body.box;
  const made = (await scrap()).body,
    first = made.box,
    second = (await scrap()).body.box;
  assert.deepEqual(
    [first.x, first.y],
    [Math.round(newest.x), Math.round(inWay.y + inWay.h + STACK.gap)],
    'under the newest drawing and past the one in its way, not under the far one',
  );
  const under = footprint(made);
  assert.deepEqual(
    [second.x, second.y],
    [first.x, Math.round(under.y + under.h + STACK.gap)],
    'the next under it and its post-it words',
  );
  assert.equal(menuOf(HQ, '/').notes, 5, "the board's open notes on the page");
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
  assert.ok(g.box.y >= above.box.y + above.box.h, 'stacked under');
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

test('send a page: undo in its seconds, then each group to its agent, a fresh page, the page read-only but answered', async () => {
  const nb = (await h.board('/api/notebooks')).body.shelf[0].id;
  await noneOpen(nb);
  const page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const cut = (await scrap({ owner: 'moss', words: 'The basket button is tiny' })).body;
  const sketch = (await draw(page, [stroke(600, 600)])).body;
  assert.equal(cut.page, page);

  const sending = (await h.board('/api/notebooks/pages/send', { id: page })).body;
  assert.deepEqual([sending.sending, sending.sent], [true, null]);
  const fresh = await current(nb);
  assert.notEqual(fresh, page, 'a fresh page for new notes');
  assert.equal((await draw(page, [stroke(1, 1)])).status, 409, 'read-only while it sends');
  const own = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  const undone = (await h.board('/api/notebooks/pages/undo', { id: page })).body;
  assert.deepEqual([undone.sending, undone.sent], [false, null]);
  const left = (await pages(nb)).pages.map((p: any) => p.id);
  assert.ok(!left.includes(fresh) && left.includes(own), "the empty fresh page gone with it, the board's own stays");
  await h.board('/api/notebooks/pages/send', { id: page });
  const titled = await current(nb);
  await h.board('/api/notebooks/pages/title', { id: titled, title: 'Next' });
  await h.board('/api/notebooks/pages/undo', { id: page });
  assert.ok(
    (await pages(nb)).pages.some((p: any) => p.id === titled),
    'a titled fresh page stays',
  );
  booksheets.deliverDue(Date.now() + 60_000);
  assert.ok(!db.prepare("select 1 from jobs where agent = 'moss'").get(), 'undone: nothing went');

  await h.board('/api/notebooks/pages/send', { id: page });
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
  const sent = (await pages(nb)).pages.find((p: any) => p.id === page);
  assert.ok(sent.sent && !sent.sending, 'marked sent');
  assert.equal(
    (await h.board('/api/notebooks/pages/undo', { id: page })).body.error,
    'too late to undo: the page has gone',
  );
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: cut.id })).status, 409, "the board's own stays");
  assert.equal((await h.board('/api/notebooks/groups/move', { id: cut.id, page: titled })).status, 409);

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

test("the board's Send of a notebook's last page leaves a fresh page under it; one with a page after it, none", async () => {
  const nb = (await h.board('/api/notebooks')).body.shelf[0].id;
  await noneOpen(nb);
  const make = async () => (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id as number;
  const first = await make(),
    last = await make();
  for (const page of [first, last]) await draw(page, [stroke(40, 40)]);

  await h.board('/api/notebooks/pages/send', { id: first });
  assert.equal(await current(nb), last, 'the page after it is the one under it: no fresh page');
  await h.board('/api/notebooks/pages/undo', { id: first });

  await h.board('/api/notebooks/pages/send', { id: last });
  const fresh = await current(nb);
  assert.notEqual(fresh, last, 'the last page sent: a fresh page under it, though another is open');
  await h.board('/api/notebooks/pages/undo', { id: last });
  assert.ok(!(await pages(nb)).pages.some((p: any) => p.id === fresh), 'undone: the blank fresh page gone with it');
});

test('pages: titled, reordered, archived; a notebook archived, My Notebook stays; nothing of another person', async () => {
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
  assert.deepEqual([refused.status, refused.body.error], [409, 'My Notebook stays on the shelf']);
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

test("two pages sent to one agent in their seconds go as two sheets, and an old book's note keeps to its own", async () => {
  const nb = await myNotebook();
  await noneOpen(nb);
  const first = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id;
  await scrap({ owner: 'kit', words: 'Rounder corners' });
  assert.equal((await h.board('/api/notebooks/pages/send', { id: first })).status, 200);
  const second = await current(nb);
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

  const before = (db.prepare("select count(*) n from jobs where agent = 'kit'").get() as any).n;
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
  assert.deepEqual([shown.id, shown.status, shown.name, shown.desk], [id, 'open', 'Moss', false]);
  assert.match(shown.body, /Choose:/);
  // the desk phone's card opens the book at the group's page, in its notebook
  const card = ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.deepEqual([card.place.page, card.place.notebook, card.place.words], [page, nb, 'Which blue for the basket?']);

  // a key card shows under the group too, answered only on the desk phone
  const keys = await agent('request', job.token, {
    ...{ kind: 'credential', title: 'The basket feed', body: 'Its key.', secrets: 'STRIPE_TEST_KEY' },
    ...{ topic: 'shop', note: review },
  });
  assert.equal(keys.status, 200, JSON.stringify(keys.body));
  assert.deepEqual(
    (await under()).map(a => [a.id, a.desk]),
    [
      [id, false],
      [keys.body.id, true],
    ],
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
