// node --test src/ink/bookanswer.test.ts   (an agent's answers on the board's notebook: on a group not sent yet, the
// dots while the quick run goes, a typed question judged and answered, a form answered (not on a deleted group), an ink
// reply, a tick and a pick, the open list)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness, until } from '../harness.ts';

const { commitFile } = await import('../fixture.ts');
// (the test company's checkout a git repository, as the server's is: a version's patch applies over its HEAD)
const h = await harness('bookanswer', {
  before: repo => commitFile('products/README.md', 'Products\n', 'Products', { repo }),
});
const { agent, db } = h;
const { answerNow } = await import('./bookanswer.ts');
const { ORIGIN } = await import('../config.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');
const { onPublish } = await import('../events.ts');
afterEach(() => h.cancelQueued());

const heard: Record<string, unknown>[] = [];
onPublish(e => void (e.type === 'book' && e.text === 'notebook' && heard.push({ ...e })));

const stroke = (x: number, y: number) => ({
  color: '#2B2230',
  size: 6,
  points: [
    [x, y, 0.5, 0],
    [x + 80, y + 20, 0.6, 16],
  ],
});
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
const currentPage = async () =>
  (await h.board(`/api/notebooks/pages?notebook=${await myNotebook()}`)).body.pages.at(-1).id as number;
const groups = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const groupOn = async (page: number, id: number) => (await groups(page)).find(g => g.id === id);
const draw = async (page: number, x: number, y: number, texts: unknown[] = []) =>
  (await h.board('/api/notebooks/groups/create', { page, ink: [stroke(x, y)], texts })).body;
const open = async () => (await h.board('/api/notebooks/open')).body;
// How many px of a page's picture are in an agent's ink
async function inkIn(page: number, by: string) {
  const { inkOf } = await import('../../../hq/shell/ink/agentink.js');
  const [R, G, B] = [1, 3, 5].map(i => parseInt((inkOf(by) as string).slice(i, i + 2), 16));
  const res = await fetch(`${h.base}/api/book/picture?id=${page}`, { headers: { cookie: h.boardCookie } });
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (Math.abs(data[i] - R) + Math.abs(data[i + 1] - G) + Math.abs(data[i + 2] - B) < 60) n++;
  return n;
}
// A group's quick run, started as the judge starts it, and claimed on the worker's chat slot
async function asked(texts: string) {
  const page = await currentPage();
  const g = await draw(page, 40, 60 + 400 * Math.random(), [{ x: 40, y: 100, w: 200, text: texts, color: '#2a2352' }]);
  const job = answerNow({ grp: g.id }, { id: 1, why: 'a plain question' })!;
  assert.ok(job, 'a quick run');
  return { page, g, run: await h.claimJob(job) };
}
// The jobs a reply to an agent's answer became, once its seconds are up
const repliesTo = (by: string) => {
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  return db.prepare('select prompt from jobs where agent = ? and kind != ? order by id').all(by, 'chat') as any[];
};

test("an answer on a group not sent yet: the owner's face and dots under it while it goes, then the answer there", async () => {
  const { page, g, run } = await asked('What does reach count?');
  const prompt = (db.prepare('select prompt from jobs where id = ?').get(run.id) as any).prompt;
  assert.match(prompt, /What does reach count\?/);
  assert.match(prompt, new RegExp(`hq sketch ${page}`), 'the way to see it');
  assert.match(prompt, new RegExp(`hq answer g${g.id}`));
  const waiting = (await groupOn(page, g.id)).waiting;
  assert.equal(waiting.style, 'text');
  assert.equal(waiting.by, run.agent);
  assert.equal(waiting.spot, null, 'under its scrap, no spot of its own');
  heard.length = 0;
  await h.finish(run, { status: 'done', result: 'People who saw it at least once this week.' });
  const after = await groupOn(page, g.id);
  assert.equal(after.waiting, null, 'the dots go');
  const [answer] = after.children;
  assert.equal(answer.kind, 'answer');
  assert.equal(answer.style, 'text');
  assert.equal(answer.text, 'People who saw it at least once this week.');
  assert.equal(answer.grp, g.id);
  assert.equal(answer.note, null, 'not sent: no note');
  assert.equal(answer.spot, null, 'it slips under its scrap, where the dots were');
  assert.ok(
    heard.some(e => e.page === page),
    "a 'book' event for the page",
  );
});

test('a quick run that ends without an answer says so where the answer would lie', async () => {
  const { page, g, run } = await asked('Is this live yet?');
  await h.finish(run, { status: 'failed' });
  const after = await groupOn(page, g.id);
  assert.deepEqual(after.children, [], 'no answer');
  assert.deepEqual([after.waiting.reason, after.waiting.by], ["I couldn't answer that. Ask again.", run.agent]);
  assert.equal(after.waiting.spot, null, 'under its scrap, where the dots were');
});

test("a reply under an answer whose group is deleted, kept for Undo, is refused; after Undo it's taken", async () => {
  const { page, g, run } = await asked('Is the sale on?');
  await h.finish(run, { status: 'done', result: 'Until Sunday.' });
  const [answer] = (await groupOn(page, g.id)).children;
  const replies = () => (db.prepare('select id from notebook_groups where parent = ?').all(g.id) as any[]).length;
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: g.id })).status, 200);
  const stale = await h.board('/api/notebooks/groups/reply', { answer: answer.id, words: 'And after?' });
  assert.deepEqual([stale.status, replies()], [404, 0], "a stale tab's reply: refused, nothing written");
  assert.equal((await h.board('/api/notebooks/groups/restore', { id: g.id })).status, 200);
  const reply = await h.board('/api/notebooks/groups/reply', { answer: answer.id, words: 'And after?' });
  assert.deepEqual([reply.status, reply.body.parent, replies()], [200, g.id, 1]);
});

test('a form: answered by the board, kept, and gone to the agent as a reply; the open list shows it until then', async () => {
  const { page, g, run } = await asked('Which colour?');
  const form = [
    { title: 'Warmer or cooler?', options: ['Warmer', 'Cooler'] },
    { title: 'How much?', type: 'number', unit: '%' },
  ];
  const refused = await agent('answer', run.token, { grp: g.id, text: 'Two things first', form: [{ title: '' }] });
  assert.equal(refused.status, 400);
  // (the page's picture agents read: the form clipped onto the answer, in its agent's ink.)
  const inked = await inkIn(page, run.agent);
  const clipped = (await agent('answer', run.token, { grp: g.id, text: 'Two things first', form })).body.slip;
  assert.equal(clipped.style, 'form');
  const asking = await inkIn(page, run.agent);
  assert.ok(asking > inked + 1500, `its questions' chips and line in the ink (${inked}, ${asking})`);
  await h.finish(run, { status: 'done', result: 'I asked two things.' });
  const children = (await groupOn(page, g.id)).children;
  assert.deepEqual(
    children.map((c: any) => c.style),
    ['form'],
    "its final message isn't clipped too",
  );
  const listed = await open();
  const item = listed.forms.find((f: any) => f.id === clipped.id);
  assert.deepEqual(
    [item.group, item.page, item.by, item.text],
    [g.id, page, run.agent, 'Two things first'],
    'the open list has the form',
  );
  assert.equal(
    (await h.board('/api/notebooks/answers/form', { id: clipped.id, answers: ['Hotter', '5'] })).status,
    400,
  );
  const answered = (await h.board('/api/notebooks/answers/form', { id: clipped.id, answers: ['Warmer', '5 %'] })).body;
  assert.deepEqual(answered.answer.form_answer, ['Warmer', '5']);
  const said = await inkIn(page, run.agent);
  assert.ok(said > inked + 300 && said < asking, `answered: the board's answers in the ink, no chips (${said})`);
  assert.equal(
    (await h.board('/api/notebooks/answers/form', { id: clipped.id, answers: ['Warmer', '5'] })).status,
    409,
  );
  assert.ok(!(await open()).forms.some((f: any) => f.id === clipped.id), 'answered: off the list');
  const [reply] = repliesTo(run.agent).filter(j => /Warmer or cooler/.test(j.prompt));
  assert.ok(reply, 'the answers reach the agent');
  assert.match(reply.prompt, /1\. Warmer or cooler\? → Warmer/);
});

test("a form on a group deleted, kept for Undo: off the open list, a stale tab's answers refused and nothing kept; after Undo it's back, answered and gone to the agent", async () => {
  const { g, run } = await asked('Which size?');
  const form = [{ title: 'Big or small?', options: ['Big', 'Small'] }];
  const clipped = (await agent('answer', run.token, { grp: g.id, text: 'One thing first', form })).body.slip;
  await h.finish(run, { status: 'done', result: 'I asked one thing.' });
  const listed = async () => (await open()).forms.some((f: any) => f.id === clipped.id);
  const kept = () => (db.prepare('select form_answer from book_slips where id = ?').get(clipped.id) as any).form_answer;
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: g.id })).status, 200);
  assert.equal(await listed(), false, 'deleted: off the open list');
  const stale = await h.board('/api/notebooks/answers/form', { id: clipped.id, answers: ['Big'] });
  assert.deepEqual([stale.status, kept()], [404, null], "a stale tab's answers: refused, nothing kept");
  assert.equal((await h.board('/api/notebooks/groups/restore', { id: g.id })).status, 200);
  assert.equal(await listed(), true, 'undone: back on the list');
  const answered = await h.board('/api/notebooks/answers/form', { id: clipped.id, answers: ['Big'] });
  assert.deepEqual([answered.status, answered.body.answer.form_answer], [200, ['Big']]);
  assert.ok(
    repliesTo(run.agent).some(j => /Big or small\? → Big/.test(j.prompt)),
    'the answers reach the agent',
  );
});

test("an ink-only reply on a group's answer goes to who answered; an agent's question is open until replied to", async () => {
  const { page, g, run } = await asked('Is this live yet?');
  const question = (
    await agent('answer', run.token, { grp: g.id, text: 'Live for everyone, or just you?', asks: true })
  ).body.slip;
  assert.equal(question.style, 'question');
  await h.finish(run, { status: 'done', result: 'x' });
  assert.ok(
    (await open()).questions.some((q: any) => q.id === question.id),
    'its question waits on the board',
  );
  const before = repliesTo(run.agent).length;
  const reply = await h.board('/api/notebooks/groups/reply', { answer: question.id, ink: [stroke(400, 300)] });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.parent, g.id, 'under the group');
  assert.ok(!(await open()).questions.some((q: any) => q.id === question.id), 'replied: off the list');
  assert.equal(repliesTo(run.agent).length, before + 1, 'a task for who answered');
  const kids = (await groupOn(page, g.id)).children.map((c: any) => [c.kind, c.answers ?? c.id]);
  assert.deepEqual(kids, [
    ['answer', question.id],
    ['reply', question.id],
  ]);
});

test("a wiped note's question leaves the open list, which still reads; the note's Undo brings it back", async () => {
  const page = (
    await h.board('/api/book/page/new', { w: 800, h: 600, kind: 'sheet', owner: 'wren', url: '/?open=shop' })
  ).body;
  const anchor = {
    v: 1,
    url: `${ORIGIN}/?open=shop`,
    el: { selector: '#shop', tag: 'div', text: 'Shop', box: { x: 10, y: 40, w: 300, h: 40 } },
    view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
    ink: [],
  };
  const made = (
    await h.board('/api/book/note', { page: page.id, anchor, said: 'typed', words: 'Is this the new font?' })
  ).body.note;
  const run = await h.claimJob(answerNow({ note: made.id }, { id: 1, why: 'a plain question' })!);
  const review = (db.prepare('select review from book_notes where id = ?').get(made.id) as any).review;
  const question = (await agent('answer', run.token, { note: review, text: 'On the shop only?', asks: true })).body
    .slip;
  await h.finish(run, { status: 'done', result: 'x' });
  assert.ok(
    (await open()).questions.some((q: any) => q.id === question.id),
    'its question waits on the board',
  );
  assert.equal((await h.board('/api/book/note/delete', { id: made.id })).status, 200);
  const wiped = await h.board('/api/notebooks/open');
  assert.equal(wiped.status, 200, JSON.stringify(wiped.body));
  assert.ok(!wiped.body.questions.some((q: any) => q.id === question.id), 'wiped: off the list');
  assert.equal((await h.board('/api/book/slip/tick', { id: question.id, ticked: true })).status, 404);
  assert.equal((await h.board('/api/book/note/restore', { id: made.id })).status, 200);
  assert.ok(
    (await open()).questions.some((q: any) => q.id === question.id),
    'undone: back on the list',
  );
});

test('a tick closes an answer; a tick on a version picks it; only the run asked may answer a group', async () => {
  const { page, g, run } = await asked('Why this font?');
  await h.finish(run, { status: 'done', result: 'It reads at a glance.' });
  const [answer] = (await groupOn(page, g.id)).children;
  const ticked = (await h.board('/api/notebooks/answers/tick', { id: answer.id, ticked: true })).body.answer;
  assert.ok(ticked.ticked);
  // (a try run's version, on the group: booktry.ts records its run)
  const tryRun = await h.start({ agent: 'juno' });
  const other = await h.start({ agent: 'juno' });
  db.prepare('update notebook_groups set tried = ? where id = ?').run(tryRun.id, g.id);
  const png = `data:image/png;base64,${Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64')}`;
  assert.equal((await agent('answer', other.token, { grp: g.id, text: 'Me too' })).status, 404, 'not asked');
  const expect = (await agent('answer', tryRun.token, { grp: g.id, expect: 3 })).body;
  assert.equal(expect.expect, 3);
  // (its versions coming under the group, as many frames as it said: groupanswers.ts tryOf)
  assert.deepEqual((await groupOn(page, g.id)).try, {
    state: 'coming',
    expect: 3,
    by: 'juno',
    name: 'Juno',
    reason: null,
  });
  assert.equal((await groupOn(page, g.id)).waiting, null);
  const patch =
    'diff --git a/products/README.md b/products/README.md\n--- a/products/README.md\n+++ b/products/README.md\n@@ -1 +1 @@\n-Products\n+Warm products\n';
  const v = (await agent('answer', tryRun.token, { grp: g.id, version: 'Warm paper', picture: png, patch })).body.slip;
  assert.deepEqual([v.style, v.version, v.patch, v.spot], ['version', 'Warm paper', true, null]);
  const picked = (await h.board('/api/notebooks/answers/tick', { id: v.id, ticked: true })).body.answer;
  assert.ok(picked.picked && !picked.ticked, 'picked');
  // a tick on another version moves the pick: one per try, and the run hears which
  const w = (await agent('answer', tryRun.token, { grp: g.id, version: 'Cool slate', picture: png })).body.slip;
  await h.board('/api/notebooks/answers/tick', { id: w.id, ticked: true });
  const pickedNow = (await groupOn(page, g.id)).children.filter((c: any) => c.picked).map((c: any) => c.id);
  assert.deepEqual(pickedNow, [w.id]);
  const told = db.prepare('select text from messages where job = ?').all(tryRun.id) as { text: string }[];
  assert.match(told.at(-1)!.text, /The board picked your version “Cool slate”/);
  await h.finish(tryRun);
  await h.finish(other);
});

test('hq answer: a group by g<id>, a form and ink from files, --asks; a bad form and an unknown flag refused', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(`${h.dataDir}/hq-answer-`);
  const { page, g, run } = await asked('Which one?');
  writeFileSync(`${dir}/form.json`, JSON.stringify([{ title: 'Left or right?', options: ['Left', 'Right'] }]));
  writeFileSync(`${dir}/bad.json`, JSON.stringify([{ title: '' }]));
  writeFileSync(`${dir}/ink.json`, JSON.stringify([stroke(0, 0)]));
  const formed = await h.hq(run, 'answer', `g${g.id}`, 'Pick one', '--form', `${dir}/form.json`);
  assert.equal(formed.code, 0, formed.out);
  assert.match(formed.out, new RegExp(`Answer clipped onto group g${g.id}`));
  assert.notEqual((await h.hq(run, 'answer', `g${g.id}`, 'Pick', '--form', `${dir}/bad.json`)).code, 0);
  assert.equal((await h.hq(run, 'answer', `g${g.id}`, '--ink', `${dir}/ink.json`)).code, 0, 'ink alone');
  const giant = {
    ...stroke(0, 0),
    points: [
      [0, 0, 0.5, 0],
      [0, 1e12, 0.5, 16],
    ],
  };
  const refused = await agent('answer', run.token, { grp: g.id, ink: [giant] });
  assert.equal(refused.status, 400, "ink taller than a page can grow: refused, so it's never placed");
  assert.match(refused.body.error, /at most 20000 px a side/);
  const far = {
    ...stroke(0, 0),
    points: [
      [0, 100_000, 0.5, 0],
      [1, 100_000, 0.5, 16],
    ],
  };
  const offset = await agent('answer', run.token, { grp: g.id, ink: [far] });
  assert.equal(
    offset.status,
    400,
    "a small drawing far from the answer's top-left: refused, so its picture stays a page's",
  );
  assert.match(offset.body.error, /at most 20000 px a side, from the answer's top-left/);
  assert.equal((await h.hq(run, 'answer', `g${g.id}`, 'Now or later?', '--asks')).code, 0);
  assert.notEqual((await h.hq(run, 'answer', `g${g.id}`, '--bogus', 'x')).code, 0, 'an unknown flag: the usage');
  const styles = (await groupOn(page, g.id)).children.map((c: any) => c.style);
  assert.deepEqual(styles, ['form', 'drawing', 'question']);
  await h.finish(run);
});

test("a failed answer says why until the thread moves on: the next ask's face, then its answer", async () => {
  const { page, g, run } = await asked('Is the new page live?');
  await h.finish(run, { status: 'done', result: 'Yes: it went live this morning.' });
  const slip = (await groupOn(page, g.id)).children.find((c: any) => c.kind === 'answer');
  const reply = async (words: string) => {
    const r = (await h.board('/api/notebooks/groups/reply', { answer: slip.id, words })).body;
    return answerNow({ grp: r.id }, { id: 1, why: 'a plain question' })!;
  };
  await h.finish(await h.claimJob(await reply('And the old one?')), { status: 'failed', result: 'x' });
  assert.equal((await groupOn(page, g.id)).waiting.reason, "I couldn't answer that. Ask again.");
  const again = await reply('Is the old one gone?');
  assert.equal((await groupOn(page, g.id)).waiting.reason, 'Waiting for my turn to answer.', "the next ask's face");
  const writing = await h.claimJob(again);
  assert.deepEqual(
    [(await groupOn(page, g.id)).waiting.reason, (await groupOn(page, g.id)).waiting.style],
    [undefined, 'text'],
    'its dots',
  );
  await h.finish(writing, { status: 'done', result: 'Yes: gone since noon.' });
  assert.equal((await groupOn(page, g.id)).waiting, null, 'no failure left under the note');
});

// A question typed on the current page and the judge's call on it, an answer (any other words it reads first, none:
// bookjudge.ts), until the note shows a face
async function typedQuestion(words: string) {
  const page = await currentPage();
  const made = (
    await h.board('/api/notebooks/groups/create', {
      page,
      ink: [],
      texts: [{ x: 40, y: 60, w: 300, text: words, color: '#2a2352' }],
    })
  ).body;
  await until(async () => {
    const c = (await h.worker('reads/claim')).body;
    if (!c.reading || !JSON.parse(c.schema).properties.reply) return false;
    const mine = c.content.at(-1).text.includes(JSON.stringify(words));
    const structured_output = { reply: mine ? 'answer' : 'none', why: 'The board asks a plain question.' };
    await h.worker('reads/answer', { reading: c.reading, result: { is_error: false, structured_output } });
    return mine;
  }, `the judge's reading of ${words}`);
  const group = () => groupOn(page, made.id);
  await until(async () => (await group()).waiting, 'its face');
  return group;
}

test('a typed question says it waits for its turn, shows the dots once the worker takes it, then its answer', async () => {
  const group = await typedQuestion('What time is it?');
  assert.equal((await group()).waiting.reason, 'Waiting for my turn to answer.');
  const run = (await h.claim('claude', { kind: 'chat' }))!;
  assert.ok(run.quickReplyUntil > Date.now(), 'the worker is given the end of its turn');
  assert.equal((await group()).waiting.reason, undefined, 'the dots');
  await h.finish(run, { result: 'It is 16:35 in Amsterdam.' });
  const answered = await group();
  assert.equal(answered.waiting, null);
  assert.equal(answered.children.at(-1).text, 'It is 16:35 in Amsterdam.');
});

test('an answer the worker stopped at the end of its turn says so, and is not tried again', async () => {
  const group = await typedQuestion('How long is a quick answer?');
  const run = (await h.claim('claude', { kind: 'chat' }))!;
  await h.finish(run, { status: 'failed', overtime: true, result: 'Stopped at its quick-run deadline' });
  const unanswered = await group();
  assert.equal(
    unanswered.waiting.reason,
    "That took longer than a quick answer can, so I stopped. Send the page and I'll answer it as work.",
  );
  assert.equal(unanswered.children.length, 0);
  assert.equal(await h.claim('claude', { kind: 'chat' }), null, 'not tried again');
});

test("the page's picture shows an answer on its slip under its scrap, and grows down to it", async () => {
  const { page, run } = await asked('Which colour for the header?');
  const before = await fetch(`${h.base}/api/book/picture?id=${page}`, { headers: { cookie: h.boardCookie } });
  const words = 'The indigo one: it reads on the paper and on HQ alike. '.repeat(6);
  await h.finish(run, { status: 'done', result: words });
  const res = await fetch(`${h.base}/api/book/picture?id=${page}`, { headers: { cookie: h.boardCookie } });
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true });
  // (a slip's paper, bookrender.ts's)
  const [R, G, B] = [0xff, 0xfd, 0xf6];
  let paper = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i] === R && data[i + 1] === G && data[i + 2] === B) paper++;
  assert.ok(paper > 2000, `its slip under the scrap (${paper} px)`);
  const was = (await sharp(Buffer.from(await before.arrayBuffer())).metadata()).height!;
  assert.ok(info.height > was, `the picture reaches down to it (${was} → ${info.height})`);
});

test('hq answer --source: kept with its picture and read back; refused without a picture, or longer than a line', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(`${h.dataDir}/hq-source-`);
  const { page, g, run } = await asked('Is the pen getting faster?');
  const png = await sharp({ create: { width: 400, height: 260, channels: 3, background: '#fbf8f2' } })
    .png()
    .toBuffer();
  writeFileSync(`${dir}/chart.png`, png);
  const source = "From HQ's speed checker,\n  last 7 days";
  const clipped = await h.hq(
    run,
    'answer',
    `g${g.id}`,
    'Yes: down to 17 ms',
    '--picture',
    `${dir}/chart.png`,
    '--source',
    source,
  );
  assert.equal(clipped.code, 0, clipped.out);
  const [answer] = (await groupOn(page, g.id)).children;
  assert.equal(answer.source, "From HQ's speed checker, last 7 days", 'one line, trimmed');
  const alone = await agent('answer', run.token, { grp: g.id, text: 'Faster', source: 'HQ' });
  assert.equal(alone.status, 400);
  assert.match(alone.body.error, /a source goes under a picture/);
  const long = await agent('answer', run.token, {
    grp: g.id,
    picture: `data:image/png;base64,${png.toString('base64')}`,
    source: 'x'.repeat(201),
  });
  assert.equal(long.status, 400);
  await h.finish(run);
});
