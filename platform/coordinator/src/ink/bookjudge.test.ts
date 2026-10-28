// node --test src/ink/bookjudge.test.ts   (the book's judge on the real server: a board's note or group judged by the
// small model through the worker's claim and answer, its verdict kept with its why and routed to an answer or a try, a
// guest's never judged, the same words not judged twice, the day's bound)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('bookjudge');
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { companyDay } = await import('../company.ts');
const judge = await import('./bookjudge.ts');
const booknotes = await import('./booknotes.ts');
const groups = await import('../notebookgroups.ts');

// Where verdicts went, instead of the quick run and the try run
const routed: { reply: string; target: unknown; verdict: { id: number; why: string } }[] = [];
judge.routeTo({
  answer: (target, verdict) => routed.push({ reply: 'answer', target, verdict }),
  try: (target, verdict) => routed.push({ reply: 'try', target, verdict }),
});

const SNIP = `data:image/png;base64,${(
  await sharp({ create: { width: 320, height: 160, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer()
).toString('base64')}`;
const anchor = { v: 1, url: `${ORIGIN}/?open=shop`, el: null, view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 }, ink: [] };
const scrap = (words: string, said = 'written') =>
  h.board('/api/notebooks/groups/scrap', { anchor, words, said, snip: SNIP, owner: 'kit' });
const claim = async () => (await h.worker('reads/claim')).body;
// The judge's next call, once a note has put one up (null: none came)
async function judged(tries = 40) {
  for (let i = 0; i < tries; i++) {
    const c = await claim();
    if (c.reading) return c;
    await new Promise(res => setTimeout(res, 20));
  }
  return null;
}
const say = (c: { reading: string }, reply: string, why: string) =>
  h.worker('reads/answer', { reading: c.reading, result: { is_error: false, structured_output: { reply, why } } });
const verdicts = () => db.prepare('select * from ink_verdicts order by id').all() as any[];
async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise(res => setTimeout(res, 10));
  assert.ok(ok());
}

test('a scrap of the board’s is judged with its words, page and picture; the verdict is kept with its why and asks for an answer', async () => {
  const g = (await scrap('what does reach count here')).body;
  assert.equal(typeof g.id, 'number', 'the board’s request answered first');
  const c = (await judged())!;
  assert.equal(c.model, 'haiku');
  assert.deepEqual(JSON.parse(c.schema), judge.SCHEMA);
  const [image, text] = c.content;
  assert.equal(image.type, 'image');
  assert.equal(image.source.media_type, 'image/png');
  assert.match(text.text, /"what does reach count here"/);
  assert.match(text.text, /written by hand/);
  assert.match(text.text, /HQ's page \/\?open=shop \(Kit's work\)/);
  assert.equal(await judged(3), null, 'a call under way is no one else’s');
  assert.deepEqual((await say(c, 'answer', 'asks what a figure means')).body, { written: 1 });
  await until(() => routed.length === 1);
  const [v] = verdicts();
  assert.deepEqual(
    [v.grp, v.note, v.reply, v.why, v.words],
    [g.id, null, 'answer', 'asks what a figure means', 'what does reach count here'],
  );
  assert.deepEqual(routed.shift(), { reply: 'answer', target: { grp: g.id }, verdict: { id: v.id, why: v.why } });
  assert.deepEqual(judge.verdictOf({ grp: g.id })?.reply, 'answer');
});

test('a try goes to the try run; none to nothing, kept all the same', async () => {
  const warmer = (await scrap('warmer?')).body;
  await say((await judged())!, 'try', 'wonders about a colour');
  await until(() => routed.length === 1);
  assert.deepEqual(routed.shift()!.target, { grp: warmer.id });
  const typo = (await scrap('fix the typo')).body;
  await say((await judged())!, 'none', 'clear work');
  await until(() => !!judge.verdictOf({ grp: typo.id }));
  assert.equal(judge.verdictOf({ grp: typo.id })!.reply, 'none');
  assert.equal(routed.length, 0);
});

test('an edit with the same words isn’t judged again; new words are, and only the newest counts', async () => {
  const g = (await scrap('maybe a photo')).body;
  await say((await judged())!, 'try', 'a picture');
  await until(() => routed.length === 1);
  routed.length = 0;
  const now = groups.row(g.id)!;
  const moved = await h.board('/api/notebooks/groups/edit', {
    id: g.id,
    since: now.updated,
    words: 'maybe a photo',
    said: 'written',
  });
  assert.equal(moved.status, 200);
  assert.equal(await judged(5), null, 'the same words: nothing to judge');
  const again = groups.row(g.id)!;
  await h.board('/api/notebooks/groups/edit', {
    id: g.id,
    since: again.updated,
    words: 'waarom een foto?',
    said: 'written',
  });
  const c = (await judged())!;
  assert.match(c.content.at(-1).text, /waarom een foto/);
  await say(c, 'answer', 'a plain why');
  await until(() => routed.length === 1);
  assert.equal(routed.shift()!.reply, 'answer');
});

test('an old-book note is judged with what it replies to; a guest’s note never', async () => {
  const page = (await h.board('/api/book/page/new', { kind: 'free', w: 800, h: 600 })).body;
  const res = await h.board('/api/book/note', { page: page.id, anchor, words: 'is this live yet', said: 'typed' });
  assert.equal(res.body.asked, undefined, 'nothing asks in the request');
  const c = (await judged())!;
  assert.match(c.content.at(-1).text, /"is this live yet"/);
  await say(c, 'answer', 'asks whether it shipped');
  await until(() => routed.length === 1);
  assert.deepEqual(routed.shift()!.target, { note: res.body.note.id });
  const guest = booknotes.addNote(
    { page: page.id, anchor, words: 'waarom?', said: 'typed' },
    'board',
    true,
    null,
    'guest:7',
  );
  assert.ok(typeof guest === 'object' && 'note' in guest);
  assert.equal(await judged(10), null, 'a guest’s note waits for the board’s plane');
  const before = verdicts().length;
  assert.equal(await judge.judge({ note: (guest as any).note.id }), null);
  assert.equal(verdicts().length, before);
});

test('JUDGES_A_DAY a day: past it nothing goes to the model', async () => {
  db.prepare('insert or replace into ink_judges (day, judges) values (?, ?)').run(
    companyDay(Date.now()),
    judge.JUDGES_A_DAY,
  );
  await scrap('try this bigger');
  assert.equal(await judged(10), null);
  db.prepare('delete from ink_judges').run();
});

test('a failed call is tried again; an answer that is no verdict leaves the note unjudged', async () => {
  const g = (await scrap('swap')).body;
  const first = (await judged())!;
  await h.worker('reads/answer', { reading: first.reading, error: 'exit 1' });
  const again = (await judged())!;
  assert.equal(again.reading, first.reading);
  await say(again, 'maybe', 'unsure');
  await new Promise(res => setTimeout(res, 50));
  assert.equal(judge.verdictOf({ grp: g.id }), undefined);
  assert.equal(await judged(3), null, 'gone once it failed twice');
});

test('a reply the board wiped unread marks its verdict', async () => {
  const page = (await h.board('/api/book/page/new', { kind: 'free', w: 800, h: 600 })).body;
  const n = (await h.board('/api/book/note', { page: page.id, anchor, words: 'waarom blauw', said: 'written' })).body
    .note;
  await say((await judged())!, 'answer', 'a plain why');
  await until(() => routed.length === 1);
  routed.length = 0;
  const slip = Number(
    db
      .prepare("insert into book_slips (note, by, text, created) values (?, 'kit', 'Blue is the brand', ?)")
      .run(n.id, new Date().toISOString()).lastInsertRowid,
  );
  assert.equal(judge.markWiped(slip), 1);
  assert.ok(judge.verdictOf({ note: n.id })!.wiped);
  assert.equal(judge.markWiped(slip), 0, 'once');
  // writing under the answer: judged with the answer it replies to
  const reply = await h.board('/api/book/slip/reply', { id: slip, words: 'and the old blue?' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const c = (await judged())!;
  assert.match(c.content.at(-1).text, /"and the old blue\?"/);
  assert.match(c.content.at(-1).text, /It replies to an agent's answer: "Blue is the brand"/);
  await say(c, 'none', 'test');
});
