// node --test src/ink/bookasks.test.ts   (a desk-phone card about a note or a page: hq ask --note and --page through the
// real hq, the card under its note, one answer closing both; a page's card on the desk phone only. The card under a
// Notebook group: notebook.test.ts)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness, type Running } from '../harness.ts';

const h = await harness('bookasks');
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { onPublish } = await import('../events.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');

const heard: string[] = [];
onPublish(e => void (e.type === 'book' && heard.push(String(e.text))));
afterEach(() => {
  heard.length = 0;
  h.cancelQueued();
});

const anchor = () => ({
  v: 1,
  url: `${ORIGIN}/?open=gazette`,
  el: { selector: '#gazette h1', tag: 'h1', text: 'The kiln is lit', box: { x: 10, y: 40, w: 300, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
  ink: [],
});
// A note on an owner's sheet, sent and delivered, its job claimed: { note (the book's), review (its number in the
// brief), job }. With no owner, a free page's: the sheet nobody owns, its job the CEO's routing check.
async function sentNote(owner: string | null, words: string) {
  const page = (
    await h.board(
      '/api/book/page/new',
      owner ? { w: 800, h: 600, kind: 'sheet', owner, url: '/?open=gazette' } : { w: 800, h: 600, kind: 'free' },
    )
  ).body;
  const made = (await h.board('/api/book/note', { page: page.id, anchor: anchor(), said: 'typed', words })).body;
  await h.board('/api/book/send', { id: made.sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const jobId = (db.prepare('select job from book_sheets where id = ?').get(made.sheet.id) as any).job;
  const review = (db.prepare('select review from book_notes where id = ?').get(made.note.id) as any).review as number;
  return { note: made.note.id as number, page: page.id as number, review, job: await h.claimJob(jobId) };
}
// hq ask, as the agent types it: the request's number, or hq's whole output when nothing was filed
const ask = (job: Running, body: string, ...flags: string[]) => askAs('decision', job, body, ...flags);
async function askAs(kind: string, job: Running, body: string, ...flags: string[]) {
  const file = `${mkdtempSync(`${tmpdir()}/bookasks-`)}/card.md`;
  writeFileSync(file, body);
  const { code, out } = await h.hq(job, 'ask', kind, 'today', 'Gazette headline: which half?', file, ...flags);
  const id = out.match(/Request #(\d+)/)?.[1];
  return code === 0 && id ? Number(id) : out;
}
const sheets = async () => (await h.board('/api/book/sheets')).body;
const asksOn = async (note: number) =>
  [...(await sheets()).sent, ...(await sheets()).open].flatMap((s: any) => s.notes).find((n: any) => n.id === note)
    .asks;
const CARD = `Both halves read well alone. Which stays?

Choose:
- The kiln is lit again: keeps the news.
- The first mugs are out: leads with what people can buy.`;

test('a card with --note shows under its note, with its place on the desk phone; one answer there closes both', async () => {
  const { note, review, job } = await sentNote('lark', 'Too long: half this');
  heard.length = 0;
  const id = await ask(job, CARD, '--note', String(review), '--topic', 'gazette');
  assert.equal(typeof id, 'number', String(id));
  assert.deepEqual(heard, ['ask'], 'the book reads its sheets again');
  const [shown] = await asksOn(note);
  assert.equal(shown.id, id);
  assert.equal(shown.status, 'open');
  assert.equal(shown.name, 'Lark');
  assert.equal(shown.desk, false);
  assert.match(shown.body, /Choose:/);
  const card = ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.equal(card.place.note, note);
  // (a note of the old book's sheets has no group on a Notebook page to open at: notebook.test.ts has one that does)
  assert.deepEqual([card.place.page, card.place.notebook], [null, null]);
  assert.equal(card.place.n, 1);
  assert.equal(card.place.owner, 'lark');
  assert.equal(card.place.words, 'Too long: half this');

  // the book's tap posts the desk phone's own answer
  heard.length = 0;
  assert.equal((await h.board('/api/requests/answer', { id, answer: 'The kiln is lit again' })).status, 200);
  assert.ok(!((await h.board('/api/requests')).body as any[]).some(r => r.id === id), 'off the desk phone');
  const [answered] = await asksOn(note);
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'The kiln is lit again');
  assert.deepEqual(heard, ['ask']);
  await h.finish(job);
});

test('a card with a key field or an upload shows in the book as answered only on the desk phone', async () => {
  const { note, review, job } = await sentNote('lark', 'Hook this up');
  const filed = await h.agent('request', job.token, {
    kind: 'credential',
    title: 'The gazette feed',
    body: 'The key for the gazette feed.',
    secrets: 'STRIPE_TEST_KEY',
    topic: 'gazette',
    note: review,
  });
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const keys = filed.body.id;
  const photo = await ask(
    job,
    'A photo of the print.',
    '--photo',
    'The print',
    '--note',
    String(review),
    '--topic',
    'gazette',
  );
  assert.equal(typeof photo, 'number', String(photo));
  const shown = await asksOn(note);
  assert.deepEqual(
    shown.map((a: any) => [a.id, a.desk]),
    [
      [keys, true],
      [photo, true],
    ],
  );
  await h.finish(job);
});

test('a card with --page stays on the desk phone only; a wrong note, another’s note, a bad page or both are refused', async () => {
  const { review, job } = await sentNote('lark', 'Fine');
  const id = await ask(job, CARD, '--page', '/?open=gazette', '--topic', 'gazette');
  assert.equal(typeof id, 'number', String(id));
  const card = ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.deepEqual(card.place, { url: '/?open=gazette', page: null, notebook: null, note: null });
  for (const flags of [
    ['--note', '999999'],
    ['--page', 'gazette'],
    ['--page', '/a b'],
    ['--note', String(review), '--page', '/?open=gazette'],
  ]) {
    const out = await ask(job, CARD, ...flags, '--topic', 'gazette');
    assert.equal(typeof out, 'string', flags.join(' '));
    assert.match(String(out), /--note names a note/);
  }
  // a note sent to someone else isn't the asker's to ask about
  const other = await sentNote('vera', 'Not Lark’s');
  const theirs = await ask(job, CARD, '--note', String(other.review), '--topic', 'gazette');
  assert.equal(typeof theirs, 'string');
  assert.match(String(theirs), /--note names a note/);
  assert.deepEqual(await asksOn(other.note), []);
  await h.finish(other.job);
  // a note's number is a number: hq stops before anything is filed
  assert.match(String(await ask(job, CARD, '--note', 'n3', '--topic', 'gazette')), /--note is a note's number/);
  const parked = await h.hq(job, 'request', 'decision', 'today', 'x', '/dev/null', '--note', String(review));
  assert.notEqual(parked.code, 0);
  await h.finish(job);
});

test('a card about a note that its agent closes leaves the book too', async () => {
  const { note, review, job } = await sentNote('lark', 'Close me');
  const id = await ask(job, CARD, '--note', String(review), '--topic', 'gazette');
  assert.equal(typeof id, 'number', String(id));
  heard.length = 0;
  assert.equal((await h.hq(job, 'close', String(id))).code, 0);
  assert.ok(heard.includes('ask'), 'the book reads its sheets again');
  assert.deepEqual(await asksOn(note), []);
  await h.finish(job);
});

test('a note from the sheet nobody owns is asked about by the job the CEO hands it to, not by the CEO', async () => {
  const { note, review, job: routing } = await sentNote(null, 'Who does the gift card?');
  assert.equal(routing.agent, 'juno', "the CEO's routing check");
  const task = await h.agent('job', routing.token, {
    agent: 'kit',
    title: 'The gift card',
    prompt: '',
    notes: [review],
    by: 'none',
  });
  assert.equal(task.status, 200, JSON.stringify(task.body));
  await h.finish(routing);
  const kit = await h.claimJob(task.body.id);
  const id = await ask(kit, CARD, '--note', String(review), '--topic', 'gazette');
  assert.equal(typeof id, 'number', String(id));
  assert.deepEqual(
    (await asksOn(note)).map((a: any) => [a.id, a.name]),
    [[id, 'Kit']],
  );
  // the desk phone names the note as the board sent it: to the CEO, whose sheet it was on
  const card = ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.deepEqual([card.place.note, card.place.owner], [note, 'juno']);

  // the CEO's next job doesn't hold the note any more
  const other = await h.start({ agent: 'juno' });
  const theirs = await ask(other, CARD, '--note', String(review), '--topic', 'gazette');
  assert.equal(typeof theirs, 'string');
  assert.match(String(theirs), /--note names a note/);
  await h.finish(kit);
  await h.finish(other);
});
