// node --test src/ink/bookanswer.test.ts   (an agent's answers on the board's notebook: on a group not sent yet, the
// dots while the quick run goes, a form answered, an ink reply, a tick and a pick, the open list)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('bookanswer');
const { agent, db } = h;
const { answerNow } = await import('./bookanswer.ts');
const { ANSWER } = await import('./answerspot.ts');
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
const over = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
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

test("an answer on a group not sent yet: the owner's face and dots at its spot while it goes, then the answer there", async () => {
  const { page, g, run } = await asked('What does reach count?');
  const prompt = (db.prepare('select prompt from jobs where id = ?').get(run.id) as any).prompt;
  assert.match(prompt, /What does reach count\?/);
  assert.match(prompt, new RegExp(`hq sketch ${page}`), 'the way to see it');
  assert.match(prompt, new RegExp(`hq answer g${g.id}`));
  const waiting = (await groupOn(page, g.id)).waiting;
  assert.equal(waiting.style, 'text');
  assert.equal(waiting.by, run.agent);
  assert.deepEqual(
    Object.keys(waiting.spot).sort(),
    ['dx', 'dy', 'h', 'narrow', 'w'],
    'and a narrow spot for the narrowest paper',
  );
  assert.ok(waiting.spot.dx >= g.box.w, 'beside it on free paper');
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
  const across = (s: any) => [s.dx, s.dy, s.w, s.narrow?.dx, s.narrow?.dy, s.narrow?.w];
  assert.deepEqual(
    across(answer.spot),
    across(waiting.spot),
    'it lands where the dots were, on any screen: nothing jumps',
  );
  assert.ok(
    heard.some(e => e.page === page),
    "a 'book' event for the page",
  );
});

test("answers never lie over the board's groups: one beside, the next one under it", async () => {
  const page = await currentPage();
  const g = await draw(page, 300, 3000);
  await draw(page, 300 + 80 + 40, 2960); // (the board's ink just right of it)
  const job = answerNow({ grp: g.id }, { id: 1, why: 'x' })!;
  const run = await h.claimJob(job);
  await h.finish(run, { status: 'done', result: 'Yes.' });
  const [answer] = (await groupOn(page, g.id)).children;
  assert.equal(answer.spot.dx, 0, 'the right strip is taken: below it');
  assert.ok(answer.spot.dy >= g.box.h);
});

test("an answer lies inside the page's paper, left of its controls: a note near its right edge gets it below", async () => {
  const page = await currentPage();
  const g = await draw(page, 900, 5000);
  const run = await h.claimJob(answerNow({ grp: g.id }, { id: 1, why: 'x' })!);
  await h.finish(run, { status: 'done', result: 'Yes: it went live this morning.' });
  const [answer] = (await groupOn(page, g.id)).children;
  const p = (await h.board(`/api/notebooks/pages?notebook=${await myNotebook()}`)).body.pages.find(
    (x: any) => x.id === page,
  );
  const left = g.box.x + answer.spot.dx;
  assert.ok(answer.spot.dy >= g.box.h, 'no room beside it: below it');
  assert.ok(left >= p.x && left + answer.spot.w <= p.x + p.w - ANSWER.rail, `inside: ${JSON.stringify(answer.spot)}`);
});

test("a note the board writes later on an answer's narrow spot (a wide book doesn't draw it there): it moves clear", async () => {
  const page = await currentPage();
  const g = await draw(page, 40, 9000);
  const run = await h.claimJob(answerNow({ grp: g.id }, { id: 1, why: 'x' })!);
  await h.finish(run, { status: 'done', result: 'Yes: it went live this morning.' });
  const [{ spot }] = (await groupOn(page, g.id)).children;
  assert.ok(spot.dx > 0 && spot.narrow, `beside it, a narrow spot below: ${JSON.stringify(spot)}`);
  const at = (s: any) => ({ x: g.box.x + s.dx, y: g.box.y + s.dy, w: s.w, h: s.h });
  const narrow = at(spot.narrow),
    wide = at(spot),
    later = await draw(page, narrow.x, Math.max(narrow.y, wide.y + wide.h) + 10);
  assert.ok(over(later.box, narrow) && !over(later.box, wide), 'on the narrow spot, clear of the wide one');
  const [{ spot: after }] = (await groupOn(page, g.id)).children;
  assert.deepEqual([after.dx, after.dy, after.w], [spot.dx, spot.dy, spot.w], 'the wide spot where it was');
  const moved = at(after.narrow);
  assert.ok(!over(moved, later.box), `clear of the later note: ${JSON.stringify([moved, later.box])}`);
});

test("a note the board writes later on an answer's wide spot (a narrower book draws the narrow one): it moves clear", async () => {
  const page = await currentPage();
  const g = await draw(page, 40, 11000);
  const run = await h.claimJob(answerNow({ grp: g.id }, { id: 1, why: 'x' })!);
  await h.finish(run, { status: 'done', result: 'Yes: it went live this morning.' });
  const [{ spot }] = (await groupOn(page, g.id)).children;
  assert.ok(spot.dx > 0 && spot.narrow, `beside it, a narrow spot below: ${JSON.stringify(spot)}`);
  const at = (s: any) => ({ x: g.box.x + s.dx, y: g.box.y + s.dy, w: s.w, h: s.h });
  const wide = at(spot),
    later = await draw(page, wide.x + 10, wide.y + 10);
  assert.ok(!over(later.box, at(spot.narrow)), 'clear of the narrow spot');
  const [{ spot: after }] = (await groupOn(page, g.id)).children;
  assert.deepEqual(after.narrow, spot.narrow, 'the narrow spot where it was');
  const moved = at(after);
  assert.deepEqual([moved.x, moved.w, moved.h], [wide.x, wide.w, wide.h], 'as wide and tall, further down');
  assert.ok(!over(moved, later.box), `clear of the later note: ${JSON.stringify([moved, later.box])}`);
});

test("an answer keeps its real height with its spot: a portrait picture's foot, and the next answer below it", async () => {
  const { g, run } = await asked('Show me the phone screen');
  const portrait = await sharp({ create: { width: 390, height: 844, channels: 3, background: '#88aacc' } })
    .png()
    .toBuffer();
  const picture = `data:image/png;base64,${portrait.toString('base64')}`;
  const first = (await agent('answer', run.token, { grp: g.id, picture })).body.slip;
  assert.ok(first.spot.h >= Math.round((844 * first.spot.w) / 390), `as tall as its picture drawn: ${first.spot.h}`);
  const second = (await agent('answer', run.token, { grp: g.id, text: 'And the desktop one.' })).body.slip;
  const box = (s: any) => ({ x: g.box.x + s.spot.dx, y: g.box.y + s.spot.dy, w: s.spot.w, h: s.spot.h });
  const [a, b] = [box(first), box(second)];
  assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'not over the picture');
  await h.finish(run);
});

test('a form: answered by the board, kept, and gone to the agent as a reply; the open list shows it until then', async () => {
  const { page, g, run } = await asked('Which colour?');
  const form = [
    { title: 'Warmer or cooler?', options: ['Warmer', 'Cooler'] },
    { title: 'How much?', type: 'number', unit: '%' },
  ];
  const refused = await agent('answer', run.token, { grp: g.id, text: 'Two things first', form: [{ title: '' }] });
  assert.equal(refused.status, 400);
  const clipped = (await agent('answer', run.token, { grp: g.id, text: 'Two things first', form })).body.slip;
  assert.equal(clipped.style, 'form');
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
  assert.equal(
    (await h.board('/api/notebooks/answers/form', { id: clipped.id, answers: ['Warmer', '5'] })).status,
    409,
  );
  assert.ok(!(await open()).forms.some((f: any) => f.id === clipped.id), 'answered: off the list');
  const [reply] = repliesTo(run.agent).filter(j => /Warmer or cooler/.test(j.prompt));
  assert.ok(reply, 'the answers reach the agent');
  assert.match(reply.prompt, /1\. Warmer or cooler\? → Warmer/);
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
  const { name: _name, ...waiting } = (await groupOn(page, g.id)).waiting;
  assert.deepEqual(waiting, { by: 'juno', spot: null, style: 'versions', count: 3 });
  const v = (
    await agent('answer', tryRun.token, { grp: g.id, version: 'Warm paper', picture: png, patch: 'diff --git a b' })
  ).body.slip;
  assert.deepEqual([v.style, v.version, v.patch, v.spot], ['version', 'Warm paper', true, null]);
  const picked = (await h.board('/api/notebooks/answers/tick', { id: v.id, ticked: true })).body.answer;
  assert.ok(picked.picked && !picked.ticked, 'picked');
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
  assert.equal((await h.hq(run, 'answer', `g${g.id}`, 'Now or later?', '--asks')).code, 0);
  assert.notEqual((await h.hq(run, 'answer', `g${g.id}`, '--bogus', 'x')).code, 0, 'an unknown flag: the usage');
  const styles = (await groupOn(page, g.id)).children.map((c: any) => c.style);
  assert.deepEqual(styles, ['form', 'drawing', 'question']);
  await h.finish(run);
});
