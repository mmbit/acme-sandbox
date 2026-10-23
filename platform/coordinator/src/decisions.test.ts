// node --test src/decisions.test.ts   (throwaway DATA_DIR and the test company): a decision of the board's named ahead of
// its card, the work that waits for it, and only the board letting it go.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { projectsHarness } from './projects.fixture.ts';

const { h, thread, engineOf } = await projectsHarness('decisions');
const { db } = h;
const pauses = await import('./pauses.ts');

const startsNow = async (id: number) => (await h.claim(engineOf(id)))?.id === id;

beforeEach(() =>
  db.exec(
    'delete from jobs; delete from threads; delete from pauses; delete from pause_until; delete from decisions; delete from requests',
  ),
);

test("a decision with no card yet holds a project; the card tied later, the board's answer lets it all go; unrelated work runs", async () => {
  const [levels, art, till] = [thread('levels', 'game'), thread('art', 'game'), thread('till', 'shop')];
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  const made = await h.hq(juno, 'decision', "Pick Rocketlings' art direction", '--blocks', 'game');
  assert.equal(made.code, 0, made.out);
  const id = Number(/^Decision #(\d+): game wait for it\./.exec(made.out)![1]);
  const work = h.queue({ agent: 'kit', thread: levels });
  const review = h.queue({ agent: 'quill', kind: 'review', thread: art, pr: 9001, round: 1 });
  const other = h.queue({ agent: 'kit', thread: till });
  assert.equal(await startsNow(work), false, 'its work waits');
  assert.equal(await startsNow(review), false, 'its reviews too');
  assert.equal(await startsNow(other), true, 'unrelated work runs');
  assert.match(
    (await h.agent('summary', juno.token)).body.text,
    new RegExp(
      `^Held for the board's decision:\\n- decision #${id} "Pick Rocketlings' art direction", since .* UTC, holds game \\(2 queued\\): no card yet: file it with hq ask \\.\\.\\. --decides ${id}`,
      'm',
    ),
  );

  // nobody but the board ends it, the CEO included
  for (const agent of [juno, await h.start({ agent: 'wren', title: 'The levels' })]) {
    const resumed = await h.agent('pauses/resume', agent.token, { project: 'game' });
    assert.equal(resumed.status, 400);
    assert.match(resumed.body.error, /waits for the board's decision/);
  }
  // the card, once it's filed: its answer releases what waits
  const card = await h.ask(juno, { title: 'Which art direction?', decides: id });
  assert.equal(db.prepare('select request from decisions where id = ?').get(id)!.request, card);
  const board = await h.board('/api/projects');
  assert.deepEqual(board.body.projects.find((p: any) => p.id === 'game').pause.decision, {
    id,
    name: "Pick Rocketlings' art direction",
    card,
  });
  assert.equal(await startsNow(work), false, 'a card on the desk phone is no answer');
  assert.equal((await h.answer(card, 'The paper cut-outs')).status, 200);
  assert.equal(await startsNow(work), true, "the board's answer lets its work go");
  assert.equal(await startsNow(review), true);
  pauses.sweep();
  assert.ok(db.prepare('select resumed from pauses where decision = ?').get(id)!.resumed, 'recorded as resumed');
  assert.doesNotMatch((await h.agent('summary', juno.token)).body.text, /Held for the board's decision/);
});

test('a decision holds all it names or nothing; only the CEO names one or ties its card, a card still open', async () => {
  const levels = thread('levels', 'game');
  const juno = await h.start({ agent: 'juno', title: 'x' }),
    wren = await h.start({ agent: 'wren', title: 'y' });
  const refused = await h.agent('decisions', juno.token, { name: 'Two', blocks: [levels, 'game/none'] });
  assert.equal(refused.status, 400);
  assert.deepEqual(db.prepare('select * from decisions').all(), [], 'nothing named');
  assert.equal(pauses.open().length, 0, 'nothing paused');
  assert.equal((await h.agent('decisions', wren.token, { name: 'Mine', blocks: [levels] })).status, 400, "the CEO's");
  const made = await h.agent('decisions', juno.token, { name: 'Two', blocks: [levels, 'shop'] });
  assert.deepEqual(made.body.blocks, [levels, 'shop']);
  const theirs = await h.agent('request', wren.token, {
    kind: 'decision',
    title: 'Mine?',
    body: 'b',
    decides: made.body.id,
  });
  assert.equal(theirs.status, 400, "a colleague's card doesn't decide it");
  const card = await h.ask(wren, { title: 'Which?' });
  assert.equal((await h.agent('decisions/link', wren.token, { id: made.body.id, card })).status, 400);
  assert.equal(
    (await h.hq(juno, 'decision', 'link', String(made.body.id), String(card))).code,
    0,
    'the CEO ties any open card',
  );
  await h.answer(card, 'This one');
  assert.equal(pauses.open().length, 0, 'both let go');
});
