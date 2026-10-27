// node --test src/bookslips.test.ts   (answers on the book's notes at the HTTP edge: the 'book' event, a slip's preview
// and "now", a page sent to the CEO through its routing, a question answered within seconds)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { harness, type Running } from './harness.ts';

// (gift: a product with a cover, the artifact a slip names)
const h = await harness('bookslips', {
  before: repo => {
    mkdirSync(`${repo}/products/gift`);
    writeFileSync(
      `${repo}/products/gift/product.yaml`,
      'name: Gift card\nstatus: preview\nowner: kit\npicture: cover.png\n',
    );
    writeFileSync(`${repo}/products/gift/cover.png`, 'a cover');
  },
});
const { base, agent, db } = h;
const { ORIGIN, PREVIEW } = await import('./config.ts');
const { onPublish } = await import('./events.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');
const DIR = `${h.dataDir}/book`;

// Every slip's 'book' event, with when it came (performance.now()) (a sheet delivered is one too: book.test.ts.
const heard: { e: Record<string, unknown>; at: number }[] = [];
onPublish(e => void (e.type === 'book' && e.text === 'slip' && heard.push({ e: { ...e }, at: performance.now() })));
afterEach(() => {
  heard.length = 0;
  h.cancelQueued();
});

const picture = async (format: 'png' | 'jpeg') => {
  const red = sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } });
  const bytes = await (format === 'png' ? red.png() : red.jpeg()).toBuffer();
  return `data:image/${format};base64,${bytes.toString('base64')}`;
};
const STROKE = {
  color: '#2B2230',
  size: 8,
  points: [
    [10, 20, 0.5, 0],
    [190, 120, 0.6, 16],
  ],
};
const anchor = () => ({
  v: 1,
  url: `${ORIGIN}/?open=shop`,
  el: { selector: '#shop', tag: 'div', text: 'Shop', box: { x: 10, y: 40, w: 300, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
  ink: [STROKE],
});
const newPage = async (body: Record<string, unknown>) =>
  (await h.board('/api/book/page/new', { w: 800, h: 600, ...body })).body;
const addNote = (body: Record<string, unknown>) =>
  h.board('/api/book/note', { anchor: anchor(), said: 'typed', ...body });
const notesOn = async (page: number) => (await h.board(`/api/book/notes?page=${page}`)).body.notes as any[];
// A note on an owner's sheet, sent and delivered, its job claimed: { page, review (its number in the brief), job }
async function sentNote(owner: string, words: string) {
  const page = await newPage({ kind: 'sheet', owner, url: '/?open=shop' });
  const sheet = (await addNote({ page: page.id, words })).body.sheet;
  await h.board('/api/book/send', { id: sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const jobId = (db.prepare('select job from book_sheets where id = ?').get(sheet.id) as any).job;
  const review = (db.prepare('select id from review_notes where job = ?').get(jobId) as any).id as number;
  return { page: page.id as number, review, job: await h.claimJob(jobId) };
}
const answer = (job: Running, body: Record<string, unknown>) => agent('answer', job.token, body);

test("a slip clipped on, ticked or opened again is a 'book' event, with none of its words, kept nowhere", async () => {
  const { page, review, job } = await sentNote('kit', 'Show the price with shipping');
  const slip = (await answer(job, { note: review, text: 'Done: shipping sits under the price' })).body.slip;
  assert.deepEqual(
    heard.map(h => h.e),
    [{ type: 'book', agent: 'kit', text: 'slip', ts: heard[0].e.ts }],
  );
  assert.doesNotMatch(JSON.stringify(heard), /shipping/i, 'no words of the answer or the note');
  await h.board('/api/book/slip/tick', { id: slip.id, ticked: true });
  await h.board('/api/book/slip/tick', { id: slip.id, ticked: false });
  assert.deepEqual(
    heard.map(h => [h.e.type, h.e.agent, h.e.text]),
    [
      ['book', 'kit', 'slip'],
      ['book', 'kit', 'slip'],
      ['book', 'kit', 'slip'],
    ],
  );
  assert.equal((db.prepare("select count(*) n from events where type = 'book'").get() as any).n, 0);
  assert.equal((await notesOn(page))[0].slips.length, 1);
  await h.finish(job);
});

test('--artifact shows its running preview and cover on the slip, pending until it is listed; a bad id is refused', async () => {
  const { page, review, job } = await sentNote('kit', 'A gift card to try');
  const made = (await answer(job, { note: review, text: 'Made: try it', artifact: 'gift' })).body.slip;
  assert.equal(made.preview.name, 'Gift card');
  assert.equal(made.preview.open, `https://gift${PREVIEW}`);
  assert.match(made.preview.picture, /^\/api\/artifacts\/picture\?id=gift&v=[0-9a-z]+$/);
  const later = (await answer(job, { note: review, text: 'And its trailer', artifact: 'gift/films/trailer' })).body
    .slip;
  assert.deepEqual(later.preview, { pending: true }, 'not merged and running yet');
  assert.deepEqual(
    (await notesOn(page))[0].slips.map((s: any) => s.preview),
    [made.preview, { pending: true }],
    'as the book reads it',
  );
  for (const bad of ['../secrets', 'gift/../../x', 'a b', 'x'.repeat(201), '', 7])
    assert.equal((await answer(job, { note: review, text: 'x', artifact: bad })).status, 400, String(bad));
  assert.equal((await notesOn(page))[0].slips.length, 2, 'a refused answer clips nothing');
  // the answer is the note answered: the job ends without marking it, and it doesn't go back to routing
  await h.finish(job);
  assert.ok(!db.prepare('select 1 from note_routes where note = ?').get(review));
});

// (rule zero: nothing cuts one now; those kept before still show.)
test('a slip\'s "now" kept from before is read back and served; nothing takes a new one', async () => {
  const { page, review, job } = await sentNote('kit', 'The basket button');
  const slip = (await answer(job, { note: review, text: 'Bigger now' })).body.slip;
  assert.equal(slip.now, null);
  const file = `slip${slip.id}-now-old.png`;
  writeFileSync(`${DIR}/${file}`, Buffer.from((await picture('png')).split(',')[1], 'base64'));
  db.prepare('update book_slips set now = ?, now_at = ? where id = ?').run(file, new Date().toISOString(), slip.id);
  const [kept] = (await notesOn(page))[0].slips;
  assert.match(kept.now, new RegExp(`^/api/book/slip/now\\?id=${slip.id}&v=[0-9a-z]+$`));
  const served = await fetch(base + kept.now, { headers: { cookie: h.boardCookie } });
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/book/slip/now?id=${slip.id}`)).status, 401, "behind the board's login");
  assert.equal((await h.board('/api/book/slip/now', { id: slip.id, picture: await picture('png') })).status, 404);
  await h.finish(job);
});

test("a free page sent to the CEO goes through the CEO's routing: handed on with hq job --notes, that job answers it", async () => {
  const page = await newPage({ kind: 'free', label: 'Gift card' });
  await h.board('/api/book/page/save', { id: page.id, ink: [STROKE], scraps: [] });
  const sent = (await h.board('/api/book/page/send', { id: page.id, to: 'juno' })).body;
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const checkId = (db.prepare('select job from book_sheets where id = ?').get(sent.id) as any).job;
  const check = db.prepare('select agent, title, is_check from jobs where id = ?').get(checkId) as any;
  assert.deepEqual(
    [check.agent, check.title, check.is_check],
    ['juno', "Route the board's notes", 1],
    'not a page task',
  );
  const review = (db.prepare('select review from book_notes where sheet = ?').get(sent.id) as any).review;
  const route = db.prepare('select owner, place from note_routes where note = ?').get(review) as any;
  assert.deepEqual([route.owner, route.place], ['juno', `page #${page.id} “Gift card” in the board's book`]);

  const routing = await h.claimJob(checkId);
  assert.match(
    routing.prompt,
    new RegExp(`#${review} on page #${page.id} “Gift card” in the board's book: its owner is juno`),
  );
  const task = await agent('job', routing.token, {
    agent: 'kit',
    title: 'The gift card',
    prompt: '',
    notes: [review],
    by: 'none',
  });
  assert.equal(task.status, 200, JSON.stringify(task.body));
  await h.finish(routing);
  const kit = await h.claimJob(task.body.id);
  assert.match(
    kit.prompt,
    new RegExp(`\`hq answer ${review} "\\.\\.\\."\`; it is page #${page.id}[^\\n]*\`hq sketch ${page.id}\``),
  );
  const other = await h.start({ agent: 'juno' });
  assert.equal((await answer(other, { note: review, text: 'Mine' })).status, 404, "the CEO's other job: not its note");
  assert.equal((await answer(kit, { note: review, text: 'Made: the gift card page', artifact: 'gift' })).status, 200);
  assert.deepEqual(
    (await notesOn(page.id))[0].slips.map((s: any) => [s.by, s.text]),
    [['kit', 'Made: the gift card page']],
  );
  await h.finish(kit);
  await h.finish(other);
});

test('a "?" note is answered within seconds: its quick run goes before older queued work, and its slip is a book event', async () => {
  const older = h.queue({ agent: 'wren', engine: 'claude', queuedBy: 'juno' });
  const page = await newPage({ kind: 'sheet', owner: 'wren', url: '/?open=studio' });
  const start = performance.now();
  const asked = (await addNote({ page: page.id, words: 'Is this the new font?' })).body.asked;
  // the worker's chat slot takes the question, though wren's other work was queued first
  const run = (await h.claim('claude', { kind: 'chat' }))!;
  assert.equal(run.id, asked);
  await h.finish(run, { status: 'done', result: 'Yes: Fraunces, since this morning.' });
  assert.equal(heard.length, 1);
  const ms = heard[0].at - start;
  assert.ok(ms < 2_000, `answered in ${Math.round(ms)} ms`);
  assert.deepEqual(heard[0].e, { type: 'book', agent: 'wren', text: 'slip', ts: heard[0].e.ts });
  assert.deepEqual(
    (await notesOn(page.id))[0].slips.map((s: any) => [s.by, s.text]),
    [['wren', 'Yes: Fraunces, since this morning.']],
  );
  // and a work slot's claim never takes a question: it takes the older work
  const work = (await h.claim('claude'))!;
  assert.equal(work.id, older);
  await h.finish(work);
});

test("a sheet sent to the CEO routes each note as its own page's: a product's preview, its place and its return", async () => {
  const at = `https://gift${PREVIEW}/`;
  const page = await newPage({ kind: 'sheet', owner: 'juno', url: '/?open=shop' }); // (the preview, in HQ's viewer)
  const added = await addNote({ page: page.id, words: 'The cover is cut off', anchor: { ...anchor(), url: at } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const sheet = added.body.sheet;
  await h.board('/api/book/send', { id: sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const checkId = (db.prepare('select job from book_sheets where id = ?').get(sheet.id) as any).job;
  const review = (db.prepare('select review from book_notes where sheet = ?').get(sheet.id) as any).review;
  const route = db.prepare('select slug, owner, place, returns from note_routes where note = ?').get(review) as any;
  assert.deepEqual({ ...route }, { slug: 'gift', owner: 'juno', place: 'Gift card (products/gift)', returns: 1 });
  const check = await h.claimJob(checkId);
  assert.match(check.prompt, new RegExp(`#${review} on Gift card \\(products/gift\\)`));
  await h.finish(check);
});

test("an answer is the note answered as hq note's is: one line of what shows, cut whole", async () => {
  const { review, job } = await sentNote('kit', 'Is the price right?');
  const text = `Yes:\u200b\u202e it is\n\n${'é'.repeat(293)}🙂🙂`;
  assert.equal((await answer(job, { note: review, text })).status, 200);
  const answered = (db.prepare('select answered from review_notes where id = ?').get(review) as any).answered;
  assert.equal(answered, `Yes: it is ${'é'.repeat(289)}`);
  const cut = `Yes: ${'é'.repeat(294)}🙂🙂`; // (the first 🙂 at code point 300, its second half the 301st unit)
  const { review: other, job: next } = await sentNote('kit', 'And the shipping?');
  await answer(next, { note: other, text: cut });
  const kept = (db.prepare('select answered from review_notes where id = ?').get(other) as any).answered;
  assert.equal(kept, `Yes: ${'é'.repeat(294)}🙂`, 'an emoji at the cut kept whole, never halved');
  await h.finish(job);
  await h.finish(next);
});

// (the board on call #239: a question typed in a box on the call's page got no answer.)
test('a "?" typed in a box on a page asks too, a call\'s page as any: the answer is typed under it, in the agent\'s ink', async () => {
  const { inkOf } = await import('../../hq/shell/agentink.js');
  const typedEvents: Record<string, unknown>[] = [];
  const stop = onPublish(e => void (e.type === 'book' && e.text === 'page' && typedEvents.push({ ...e })));
  const quickRuns = () => (db.prepare('select count(*) n from quick_runs').get() as { n: number }).n;
  const { call } = await h.liveCall('juno');
  const page = await newPage({ kind: 'call', call });
  const question = { x: 40, y: 60, w: 160, text: 'What time is it?', color: '#2a2352' };
  const save = async (texts: unknown[]) => {
    const since = (await h.board(`/api/book/page?id=${page.id}`)).body.updated;
    const r = await h.board('/api/book/page/save', { id: page.id, ink: [], scraps: [], texts, since });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const before = quickRuns();
  await save([{ ...question, text: 'What time is it' }]);
  assert.equal(quickRuns(), before, 'no question mark, no question');
  await save([question]);
  assert.equal(quickRuns(), before + 1, 'the question mark typed: it asks');
  const asked = db.prepare('select job from book_typed_asks where page = ?').get(page.id) as { job: number };
  const run = await h.claimJob(asked.job);
  assert.equal(run.agent, 'juno', "the call's agent answers");
  assert.match(run.prompt, /What time is it\?/);
  await h.finish(run, { status: 'done', result: 'About twenty to two at night, your time.' });
  for (let i = 0; i < 100 && !typedEvents.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(
    typedEvents.map(e => [e.agent, e.page]),
    [['juno', page.id]],
  );
  const texts = (await h.board(`/api/book/page?id=${page.id}`)).body.texts;
  assert.equal(texts.length, 2);
  const [, answered] = texts;
  assert.deepEqual(
    { ...answered, y: undefined },
    { x: 40, y: undefined, w: 160, text: 'About twenty to two at night, your time.', color: inkOf('juno') },
  );
  assert.ok(
    answered.y >= question.y + 25 && answered.y < question.y + 60,
    `under the question's line: y ${answered.y}`,
  );
  // the box moved, or the page saved again with the answer on it, asks nothing again
  await save([{ ...question, x: 80 }, answered]);
  assert.equal(quickRuns(), before + 1);
  // on a sheet's page its owner answers, on a free page the CEO
  const sheetPage = await newPage({ kind: 'sheet', owner: 'wren', url: '/?open=studio' });
  const free = await newPage({ kind: 'free' });
  for (const [p, agent] of [
    [sheetPage, 'wren'],
    [free, 'juno'],
  ] as const) {
    await h.board('/api/book/page/save', { id: p.id, ink: [], scraps: [], texts: [question] });
    const asked = db.prepare('select job from book_typed_asks where page = ?').get(p.id) as { job: number };
    assert.equal((db.prepare('select agent from jobs where id = ?').get(asked.job) as { agent: string }).agent, agent);
  }
  stop?.();
});
