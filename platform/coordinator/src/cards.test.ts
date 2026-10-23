// node --test src/cards.test.ts   (the real hq script against the real server: a card is checked as the desk phone
// reads it when it's filed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('cards');
const { ceo } = await import('./company.ts');

const dir = mkdtempSync(`${tmpdir()}/cards-job-`);
const card = (name: string, body: string) => { writeFileSync(`${dir}/${name}`, body); return `${dir}/${name}`; };
const phone = async () => (await h.board('/api/requests')).body as { id: number; title: string; body: string; topic: string | null; changed: string | null; created: string; job: number }[];
const titled = async (title: string) => (await phone()).filter(c => c.title === title);

// Every bullet of the body in one list (no blank line ends it): the card's sums show as more choices
const RUN_ON = `Which first?\n\nChoose:\n${['Option A: 100', 'Option B: two people', 'Both: smaller', 'Product one: 1,000', 'Product two: 500',
  'Product three: 300', 'Every Monday: a report'].map(l => `- ${l}`).join('\n')}\n`;
const GOOD = 'Which first?\n\nChoose:\n- Option A: 100\n- Option B: two people\n\nThe sums:\n- Product one: 1,000\n- Product two: 500\n';

test('hq ask, hq request and hq rewrite refuse a card whose choices would show wrong, and say what the phone would show', async () => {
  const job = { ...await h.start({ agent: 'kit', title: 'Revenue' }), dir };

  const asked = await h.hq(job, 'ask', 'decision', 'today', 'Revenue first?', card('run-on.md', RUN_ON), '--topic', 'numbers');
  assert.equal(asked.code, 1);
  assert.match(asked.out, /"Option A".*"Every Monday"/);
  // (the route itself refuses it too, whatever sends it)
  const direct = await h.agent('request', job.token, { kind: 'decision', title: 'Revenue first?', body: RUN_ON });
  assert.equal(direct.status, 400);
  assert.match(direct.body.error, /"Option A"/);
  assert.deepEqual(await titled('Revenue first?'), [], 'nothing reached the desk phone');

  const parked = await h.hq(job, 'request', 'decision', 'today', 'Revenue first?', card('run-on.md', RUN_ON), '--topic', 'numbers', '--park');
  assert.equal(parked.code, 1);
  assert.equal(existsSync(`${dir}/request.json`), false, 'nothing parked for the worker to file once the job ends');

  // the same card written as one list, its sums after it: filed, then refused as a rewrite back to the run-on list
  assert.equal((await h.hq(job, 'ask', 'decision', 'today', 'Revenue first?', card('good.md', GOOD), '--topic', 'numbers')).code, 0);
  const [filed] = await titled('Revenue first?');
  assert.equal((await h.hq(job, 'rewrite', String(filed.id), card('run-on.md', RUN_ON))).code, 1);
  assert.equal((await titled('Revenue first?'))[0].body, GOOD.trim());
  assert.equal((await h.hq(job, 'request', 'decision', 'today', 'Revenue, again?', card('good.md', GOOD), '--topic', 'numbers', '--park')).code, 0);
  assert.equal(existsSync(`${dir}/request.json`), true);
});

test('hq ask and hq request refuse a card with no text: a body file that is empty, only whitespace or not there', async () => {
  const job = { ...await h.start({ agent: 'kit', title: 'One look' }), dir: mkdtempSync(`${tmpdir()}/cards-empty-`) };
  for (const cmd of ['ask', 'request']) {
    for (const [path, why] of [[card('empty.md', ''), /is empty/], [card('blank.md', ' \n\t\n\n'), /is empty/], [`${dir}/missing.md`, /can't be read/], ['-', /can't be read/]] as const) {
      const filed = await h.hq(job, cmd, 'decision', 'today', 'One look?', path, '--product', 'hello', '--topic', 'rocketlings', '--park');
      assert.equal(filed.code, 1, `${cmd} ${path}`);
      assert.match(filed.out, /Nothing was filed/);
      assert.match(filed.out, why);
    }
  }
  assert.equal(existsSync(`${job.dir}/request.json`), false, 'nothing parked');
  // the routes refuse one too, whatever sends it: hq ask's, a rewrite (and a parked card, below)
  for (const body of [undefined, '', '  \n ']) {
    const direct = await h.agent('request', job.token, { kind: 'decision', title: 'One look?', body, topic: 'rocketlings' });
    assert.equal(direct.status, 400);
    assert.match(direct.body.error, /no text/);
  }
  assert.deepEqual(await titled('One look?'), [], 'nothing reached the desk phone');
  const id = await h.ask(job, { title: 'One look, filed?' });
  assert.equal((await h.agent('request-rewrite', job.token, { id, body: ' ' })).status, 400);
  assert.equal((await titled('One look, filed?'))[0].body, 'Which?');
});

test("a parked request is checked again as it's filed (hq request parks it when its check got no answer): the job goes back with what the phone would show", async () => {
  const job = await h.start({ agent: 'kit', title: 'Revenue, parked' });
  assert.equal((await h.finish(job, { status: 'parked', request: { kind: 'decision', title: 'Revenue, parked?', body: RUN_ON } })).status, 200);
  assert.equal(h.job(job.id).status, 'queued');
  assert.deepEqual(await titled('Revenue, parked?'), []);
  const again = await h.claim(h.job(job.id).engine);
  assert.equal(again?.id, job.id);
  assert.match(JSON.stringify(again), /refused: the desk phone would show 7 choices.*Option A/);
});

test('a card whose text changes leads the desk phone again, as of its change; the same text again changes nothing', async () => {
  const tick = () => new Promise(r => setTimeout(r, 5));
  const scout = await h.start({ agent: 'scout' });
  const file = async (title: string, body: string) => (await h.agent('request', scout.token, { kind: 'decision', title, body })).body.id as number;
  const rewrite = (id: number, body: string) => h.agent('request-rewrite', scout.token, { id, body });
  const older = await file('Changed: older', 'One'); await tick();
  const newer = await file('Changed: newer', 'Two'); await tick();
  const order = async () => (await phone()).map(r => r.id).filter(id => [older, newer].includes(id));
  const row = async (id: number) => (await phone()).find(c => c.id === id)!;
  assert.deepEqual(await order(), [newer, older]);
  assert.equal((await rewrite(older, 'One, sharper')).status, 200);
  assert.deepEqual(await order(), [older, newer]);
  assert.ok((await row(older)).changed! > (await row(newer)).created);
  assert.equal((await rewrite(newer, 'Two')).status, 200);
  assert.equal((await row(newer)).changed, null);
  assert.deepEqual(await order(), [older, newer]);
  // a seat's sign-in card takes its new link quietly: not a changed card, so it doesn't ring again
  const signin = async (link: string) => (h.jobs.createRequest({ kind: 'login', seat: 'seat-x', title: 'Sign in', body: `Open ${link}` }) as { id: number }).id;
  const first = await signin('https://example.com/a'); await tick();
  assert.equal(await signin('https://example.com/b'), first);
  assert.equal((await row(first)).changed, null);
  assert.equal((await row(first)).body, 'Open https://example.com/b');
  assert.equal((await phone())[0].id, first);
});

test("a card's topic: tidied as it's filed (asked or parked), refused when it isn't a word or two, shown to agents, and changed by its agent or the CEO", async () => {
  const scout = await h.start({ agent: 'scout' }), kit = await h.start({ agent: 'kit' }), boss = await h.start({ agent: ceo() });
  const file = (topic: unknown) => h.agent('request', scout.token, { kind: 'decision', title: 'Topic?', body: 'Which?', topic });
  const { id } = (await file('  phone \n line ')).body;
  const topic = async (n: number) => (await phone()).find(c => c.id === n)!.topic;
  assert.equal(await topic(id), 'phone line');
  assert.equal(await topic((await file(undefined)).body.id), null);
  for (const bad of ['', '   ', 'x'.repeat(41), 7, ['ads']]) assert.equal((await file(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await h.agent(`requests?id=${id}`, kit.token)).body[0].topic, 'phone line');

  const set = (job: typeof scout, t: string) => h.agent('request-topic', job.token, { id, topic: t });
  assert.deepEqual((await set(scout, ' Phone line ')).body, { ok: true, topic: 'Phone line' });
  assert.equal((await set(kit, 'ads')).status, 404, "another agent's card");
  assert.equal((await set(scout, ' ')).status, 400);
  assert.equal((await h.hq(boss, 'topic', String(id), 'Shop')).code, 0);
  assert.equal(await topic(id), 'Shop');
  assert.equal((await phone()).find(c => c.id === id)!.changed, null, 'not a new card');

  const parked = await h.start({ agent: 'kit', title: 'Topic, parked' });
  assert.equal(await topic(await h.park(parked, { kind: 'decision', title: 'Topic, parked?', topic: 'Test prints' })), 'Test prints');
});

test("a card's questions are form fields: checked as they're filed (asked or parked), shown to the desk phone, and answered one by one, no typed text needed", async () => {
  const job = await h.start({ agent: 'dex', title: 'Test print' });
  const QUESTIONS = [{ title: 'Is the cut straight?', type: 'yes-no' }, { title: 'How far is the margin off?', type: 'number', unit: 'mm' },
    { title: 'Which finish?', options: ['Matte', 'Gloss'] }, { title: 'Anything else?' }];
  const bad = await h.hq(job, 'ask', 'action', 'today', 'The test print?', card('print.md', 'The test print is in.'), '--topic', 'test prints',
    '--questions', card('bad.json', JSON.stringify([QUESTIONS[0], { title: 'Margin', unit: 'mm' }])));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /question 2: a unit .* goes with type number/);
  assert.match((await h.hq(job, 'ask', 'action', 'today', 'The test print?', card('print.md', 'x'), '--topic', 'test prints', '--questions', card('nope.json', '{'))).out, /isn't JSON/);
  assert.deepEqual(await titled('The test print?'), []);

  const asked = await h.hq(job, 'ask', 'action', 'today', 'The test print?', card('print.md', 'The test print is in.'), '--topic', 'test prints',
    '--photo', 'The cut edge', '--questions', card('good.json', JSON.stringify(QUESTIONS)));
  assert.equal(asked.code, 0, asked.out);
  const [filed] = await titled('The test print?');
  assert.deepEqual((await h.board('/api/requests')).body.find((c: { id: number }) => c.id === filed.id).questions, QUESTIONS);
  assert.match((await h.hq(job, 'requests', String(filed.id))).out, /Questions:\n1\. Is the cut straight\?\n2\. How far is the margin off\?/);

  // the board's answer: every question, as its field takes it; the photo first, as ever; no typed text needed
  const answer = (answers: string[]) => h.answer(filed.id, '', { answers });
  assert.equal((await answer(['yes', 'about three', 'Gloss', 'no'])).status, 400);
  assert.equal((await answer(['yes', '3,5'])).status, 400);
  assert.equal((await answer(['yes', '3,5', 'Gloss', 'Looks good'])).status, 400, 'the photo is still missing');
  // (the board's photo, as its answer uploads it)
  mkdirSync(`${h.dataDir}/photos/${filed.id}`, { recursive: true });
  writeFileSync(`${h.dataDir}/photos/${filed.id}/0.jpg`, 'x');
  assert.equal((await answer(['yes', '3,5', 'Gloss', 'Looks good'])).status, 200);
  assert.equal((await h.agent('request-answer', job.token, { id: filed.id })).body.answer,
    `1. Is the cut straight? → Yes\n2. How far is the margin off? → 3.5 mm\n3. Which finish? → Gloss\n4. Anything else? → Looks good\n\nPhotos: 1 of 1 saved. Fetch them with \`hq photos ${filed.id}\`.`);

  // with text typed too, it follows the answers; a card without questions is as it was
  const file = (more: Record<string, unknown>) => h.agent('request', job.token, { kind: 'action', title: 'Two?', body: 'x', ...more });
  const two = (await file({ questions: [{ title: 'Ok?', type: 'yes-no' }] })).body.id as number;
  assert.equal((await h.answer(two, ' Thanks ', { answers: ['Nee'] })).status, 200);
  assert.equal((await h.agent('request-answer', job.token, { id: two })).body.answer, '1. Ok? → No\n\nThe board added: Thanks');
  // an optional question may be left blank (card #176's "What to change, if anything"); the others still can't
  const skip = (await file({ questions: [{ title: 'Ok?', type: 'yes-no' }, { title: 'What to change, if anything', optional: true }] })).body.id as number;
  assert.equal((await h.answer(skip, '', { answers: ['yes', ''] })).status, 200);
  assert.equal((await h.agent('request-answer', job.token, { id: skip })).body.answer, '1. Ok? → Yes\n2. What to change, if anything → (left blank)');
  const must = (await file({ questions: [{ title: 'Ok?', type: 'yes-no' }, { title: 'Why?' }] })).body.id as number;
  assert.equal((await h.answer(must, '', { answers: ['yes', ''] })).status, 400);
  for (const wrong of [[], 'Ok?', [{ title: 'Ok?', type: 'yes' }], [{ title: 'Ok?', optional: 1 }]]) assert.equal((await file({ questions: wrong })).status, 400, JSON.stringify(wrong));
  assert.equal((await file({ kind: 'credential', secrets: 'A_KEY', questions: [{ title: 'x' }] })).status, 400, 'not with keys');

  // parked: refused as it's filed, the job told why
  const parked = await h.start({ agent: 'dex', title: 'Print, parked' });
  assert.equal((await h.finish(parked, { status: 'parked', request: { kind: 'action', title: 'Parked print?', body: 'x', questions: [{ title: 'Size', type: 'size' }] } })).status, 200);
  assert.deepEqual(await titled('Parked print?'), []);
  assert.match(JSON.stringify(await h.claim(h.job(parked.id).engine)), /refused: its --questions: question 1: a question's type is text, yes-no, number/);
});

test("a parked card without a kind or a title (a worker's malformed .hq/request.json) is refused, 400, and the job left as it was", async () => {
  const job = await h.start({ agent: 'kit', title: 'No kind, parked' });
  assert.equal((await h.finish(job, { status: 'parked', request: { title: 'No kind?', body: 'x' } })).status, 400);
  assert.equal((await h.finish(job, { status: 'parked', request: { kind: 'decision', body: 'x' } })).status, 400);
  assert.equal(h.job(job.id).status, 'running');
  assert.deepEqual(await titled('No kind?'), []);
  // (a card without a body isn't filed, as hq ask files none: the job goes back to write it)
  assert.equal((await h.finish(job, { status: 'parked', request: { kind: 'decision', title: 'No body?' } })).status, 200);
  assert.equal(h.job(job.id).status, 'queued');
  assert.deepEqual(await titled('No body?'), []);
  assert.match(JSON.stringify(await h.claim(h.job(job.id).engine)), /refused: the card has no text/);
});

test("a notice asks nothing: Got it closes it without a word and makes no job, a typed note is heard, a parked asker goes on, and fields are refused", async () => {
  const heard = (title: string) => h.db.prepare('select prompt from jobs where title = ?').all(`The board on: ${title}`) as { prompt: string }[];
  const job = await h.start({ agent: 'dex', title: 'Photo night' });
  const quiet = await h.ask(job, { kind: 'notice', title: 'No more photo work tonight', body: 'The batch is in.' });
  const noted = await h.ask(job, { kind: 'notice', title: 'The batch is in', body: 'All twelve.' });
  for (const more of [{ photos: [{ label: 'x' }] }, { questions: [{ title: 'Ok?', type: 'yes-no' }] }, { secrets: 'A_KEY' }, { approves: 'live:hello' }])
    assert.equal((await h.agent('request', job.token, { kind: 'notice', title: 'Not a notice', body: 'x', ...more })).status, 400, JSON.stringify(more));
  assert.deepEqual(await titled('Not a notice'), []);
  assert.equal((await h.finish(job)).status, 200);

  assert.equal((await h.answer(quiet, '')).status, 200);
  assert.equal((h.db.prepare('select answer from requests where id = ?').get(quiet) as { answer: string }).answer, 'Got it.');
  assert.deepEqual(heard('No more photo work tonight'), [], 'nothing to hear');
  assert.equal((await h.answer(noted, 'Lovely, thanks')).status, 200);
  assert.match(heard('The batch is in')[0]?.prompt ?? '', /Lovely, thanks/);

  // (hq request notice parks the job: Got it lets it go on)
  const parked = await h.start({ agent: 'dex', title: 'Photo night, parked' });
  assert.equal((await h.answer(await h.park(parked, { kind: 'notice', title: 'Parked news' }), '')).status, 200);
  assert.equal(h.job(parked.id).status, 'queued');
  assert.deepEqual(heard('Parked news'), []);
});
