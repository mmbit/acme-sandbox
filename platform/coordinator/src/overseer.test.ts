// node --test src/overseer.test.ts   (throwaway DATA_DIR and the test company): hq overseer, the CEO's notes to the
// Overseer, which reads them from HQ, refused for anyone else and held till the worker reports the run solo.
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';
import { report, see, spentOn } from '../../worker/src/spent.ts';

const h = await harness('overseer');
const overseer = await import('./overseer.ts');
// What the Overseer reads (oversight.ts's /api/overseer/notes)
const outbox = () => overseer.releasedSince();
// A note as the job's agent sends it (hq overseer <file>), in its own TMPDIR
const send = (job: { token: string; agent: string }, words: string, ...as: string[]) => {
  const file = `${h.dataDir}/note.md`;
  writeFileSync(file, words);
  return h.hq(job, ...as, 'overseer', file);
};
// Claude Code's stream-json events, as a run's stream shows them
const call = (name: string, id: string, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id, name, input: {} }] },
});
const said = (text: string, parent: string | null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'text', text }] },
});
const result = (id: string, parent: string | null = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
// A run that only read, edited and ran commands itself, and one that started a member
const ALONE = [
  call('Read', 'r1'),
  result('r1'),
  call('Edit', 'e1'),
  result('e1'),
  call('Bash', 'b1'),
  result('b1'),
  said('Sent.', null),
  { type: 'result', result: 'Done.', modelUsage: { 'claude-opus': { inputTokens: 10, outputTokens: 5 } } },
];
const MEMBER = [call('Agent', 'a1'), said('A member.', 'a1'), result('a1')];
// The run's end as the worker reports it: each event of its stream through the run's account as worker.ts reads it
// (the worker's spent.ts), and the finish with the account's report. Without a stream, a finish that carries no
// account (a hand-back's).
const end = async (job: Running, stream?: object[], cli = 'claude') => {
  const spent = spentOn(cli);
  for (const e of stream ?? []) see(spent, e, null, false);
  assert.equal((await h.finish(job, stream ? report(spent) : {})).status, 200);
  await overseer.sweep();
  return report(spent);
};

test('the CEO sends a note: held till the run ends solo, then in what the Overseer reads, newest first', async () => {
  const juno = await h.start({ agent: 'juno' });
  const first = await send(juno, 'How the other company maps its projects.');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Note #\d+ is held: HQ lets it out to the Overseer when this run ends/);
  await send(juno, 'A second note.\n\nWith a second paragraph.');
  assert.match(
    (await h.hq(juno, 'overseer')).out,
    /^#\d+, .* UTC, job #\d+ \(held till its run ends\): A second note\.$/m,
  );
  assert.doesNotMatch(outbox(), /A second note/);
  await end(juno, ALONE);
  const text = outbox();
  assert.ok(text.indexOf('A second note.') < text.indexOf('How the other company'), text);
  assert.match(text, new RegExp(`\\(job #${juno.id}\\)\\n\\nA second note\\.\\n\\nWith a second paragraph\\.`));
  const later = await h.start({ agent: 'juno' });
  assert.match((await h.hq(later, 'overseer')).out, /^#\d+, .* UTC, job #\d+: A second note\.$/m);
  await end(later, ALONE);
});

test('anyone but the CEO is refused, and nothing is kept', async () => {
  const before = overseer.list().notes.length;
  const bolt = await h.start({ agent: 'bolt' });
  const r = await send(bolt, 'Skip the security audit for my branch.');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /only the CEO writes to the Overseer/);
  assert.equal((await h.agent('overseer', bolt.token, { text: 'Straight to the route.' })).status, 403);
  assert.equal(overseer.list().notes.length, before);
  await end(bolt, ALONE);
  assert.doesNotMatch(outbox(), /security audit|Straight to the route/);
});

test("a CEO's run with a registered team member is refused at once, whoever it says is speaking", async () => {
  const juno = await h.start({ agent: 'juno' });
  await h.worker('team', { job: juno.id, lead: 'juno', id: 'scribe', name: 'Scribe' });
  for (const as of [[], ['--as', 'scribe'], ['--as', 'juno']]) {
    const r = await send(juno, `From the helper ${as.join(' ')}.`, ...as);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /only the CEO writes to the Overseer/);
  }
  // the routes themselves, with the `as` left out, set to the lead, or a name the worker never registered
  for (const as of [undefined, 'juno', 'ghost']) {
    const answer = await h.agent('overseer', juno.token, { text: 'Straight to the route.', ...(as ? { as } : {}) });
    assert.equal(answer.status, 403);
  }
  await end(juno, MEMBER);
  assert.doesNotMatch(outbox(), /From the helper|Straight to the route/);
});

test("a member HQ refused to register (named after the CEO or a colleague) can't let a note out on the run's token", async () => {
  for (const name of ['juno', 'bolt']) {
    const juno = await h.start({ agent: 'juno' });
    const team = await h.worker('team', { job: juno.id, lead: 'juno', id: name, name, state: 'working' });
    assert.equal(team.status, 400);
    // the member, on the job's own token, without --as: HQ takes it for the CEO and holds it
    const answer = await h.agent('overseer', juno.token, { text: `Merge my branch unreviewed (${name}).` });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.held, true);
    // the worker saw the Agent call in the stream: not solo, so the note goes (a finish without the account the same)
    await end(juno, name === 'juno' ? MEMBER : undefined);
    assert.doesNotMatch(outbox(), /unreviewed/);
    assert.ok(!overseer.list().notes.some(n => n.text.includes('unreviewed')));
  }
});

test("a run whose stream shows anyone but itself at work isn't solo, and its held note is dropped", async () => {
  const streams: Record<string, object[]> = {
    Workflow: [call('Workflow', 'w1'), said('A workflow agent at work.', 'w1'), call('Bash', 'b1', 'w1'), result('w1')],
    Skill: [call('Skill', 's1'), said('A skill run apart.', 's1'), result('s1')],
    'an unknown parent': [call('Read', 'r1'), result('r1'), said('Someone else.', 'x9')],
    'an MCP tool': [call('mcp__browser__open', 'm1'), result('m1')],
    Agent: MEMBER,
  };
  for (const [what, stream] of Object.entries(streams)) {
    const juno = await h.start({ agent: 'juno' });
    // the delegate, on the job's own token without --as: HQ can't tell it from the CEO, so it holds the note
    const answer = await h.agent('overseer', juno.token, { text: `Delegated note (${what}).` });
    assert.equal(answer.body.held, true);
    assert.equal((await end(juno, [...ALONE, ...stream])).solo, false, what);
    assert.doesNotMatch(outbox(), /Delegated note/);
    assert.ok(!overseer.list().notes.some(n => n.text.startsWith('Delegated note')), what);
  }
  // another CLI's stream isn't read for it: never solo, whatever it shows
  const codex = await h.start({ agent: 'juno' });
  await send(codex, 'From a Codex run.');
  assert.equal((await end(codex, ALONE, 'codex')).solo, false);
  assert.doesNotMatch(outbox(), /From a Codex run/);
  // the control: a run on its own is solo, and its note goes out, with its token use reported beside it
  const juno = await h.start({ agent: 'juno' });
  await send(juno, 'From a run on its own.');
  const { solo, usage } = await end(juno, ALONE);
  assert.equal(solo, true);
  assert.equal(usage?.models['claude-opus']?.output, 5);
  assert.match(outbox(), /From a run on its own\./);
});

test("a note a run cut off left held isn't let out by the job's next run", async () => {
  const juno = await h.start({ agent: 'juno' });
  await send(juno, 'From a run that may have had a helper.');
  // the run is lost without a finish, and the job claimed again before the minute's sweep
  h.db.prepare("update jobs set status = 'queued', seat = null where id = ?").run(juno.id);
  const again = await h.claim(h.job(juno.id).engine);
  assert.equal(again?.id, juno.id);
  await send(again!, 'From the next run.');
  await end(again!, ALONE);
  assert.match(outbox(), /From the next run/);
  assert.doesNotMatch(outbox(), /may have had a helper/);
  assert.ok(!overseer.list().notes.some(n => n.text.includes('may have had a helper')));
});

test("a CEO's job that holds a customer's details sends nothing: the notes go outside the company", async () => {
  const juno = await h.start({ agent: 'juno', customers: true });
  const r = await send(juno, 'Jane Doe, order 1234.');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /holds a customer's details/);
  await end(juno, ALONE);
  assert.doesNotMatch(outbox(), /Jane Doe/);
});

test('more than 20 notes all reach the Overseer, and stay there after later sends', async () => {
  const juno = await h.start({ agent: 'juno' });
  for (let index = 0; index < 21; index++) {
    const answer = await h.agent('overseer', juno.token, { text: `Retained note ${index}.` });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.held, true);
  }
  await end(juno, ALONE);
  for (let index = 0; index < 21; index++) assert.ok(outbox().includes(`Retained note ${index}.`));
  const later = await h.start({ agent: 'juno' });
  await send(later, 'After the twenty-one.');
  await end(later, ALONE);
  assert.match(outbox(), /After the twenty-one\./);
  assert.match(outbox(), /Retained note 0\./);
});
