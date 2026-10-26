// node --test src/answers.test.ts   (needed colleague answers through messages, sorting and worker claims)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('answers', {
  before: repo =>
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: game, name: The game, owner: wren }\n'),
});
const { db } = h;
const projects = await import('./projects.ts');

beforeEach(() => {
  h.cancelQueued();
  db.exec(`delete from runs; delete from jobs; delete from threads; delete from thread_needs; delete from plan_changes;
    delete from waits; delete from wakes; delete from proposals; delete from messages; delete from sorts`);
});

const thread = (slug: string) => {
  const made = projects.createThread({ project: 'game', name: `Thread ${slug}`, goal: 'It works', slug });
  assert.equal(typeof made, 'object');
  return `game/${slug}`;
};

test('an explicitly needed answer can be claimed while its caller runs, while ordinary hand-offs stay in order', async () => {
  const caller = await h.start({ agent: 'bolt', thread: thread('caller') });
  const owner = await h.start({ agent: 'wren' });
  const asked = await h.agent('message', caller.token, {
    to: 'kit',
    text: 'Which revision failed?',
    needsAnswer: true,
  });
  assert.equal(asked.status, 200);
  const answer = asked.body.job;
  const sort = async (job: number, title: string, code: string) => {
    const { proposal } = db.prepare('select proposal from sorts where job = ?').get(job) as { proposal: number };
    const accepted = await h.agent('proposals/accept', owner.token, { id: proposal, title, code });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  };
  assert.equal(await h.claim('claude'), null, 'the answer still needs its owner to sort it');
  await sort(answer, 'Identify the failed revision', 'REVISION');
  const answering = await h.claim('claude');
  assert.equal(answering?.id, answer, 'the needed answer must not wait for the caller to finish');
  assert.equal(h.job(caller.id).status, 'running');
  assert.notEqual(h.job(answer).thread, h.job(caller.id).thread);
  assert.equal(projects.findThread(h.job(answer).thread)?.project, 'game');
  await h.finish(answering!);

  const handed = await h.agent('message', caller.token, { to: 'kit', text: 'An answer is needed after the build.' });
  await sort(handed.body.job, 'Check the build after its author finishes', 'BUILD');
  assert.equal(h.job(handed.body.job).thread, h.job(caller.id).thread);
  assert.equal(await h.claim('claude'), null, 'ordinary hand-offs still wait for the caller');
  await h.finish(caller);
  assert.equal((await h.claim('claude'))?.id, handed.body.job);
});

test('an unread answer request keeps its independent plan, and joins only other answer requests', async () => {
  const caller = await h.start({ agent: 'bolt', thread: thread('unread') });
  const recipient = await h.start({ agent: 'kit', engine: 'claude' });
  const owner = await h.start({ agent: 'wren' });
  const handed = await h.agent('message', caller.token, { to: 'kit', text: 'Check the completed build.' });
  const asked = await h.hq(caller, 'say', '--needs-answer', 'kit', 'Which revision failed?');
  assert.equal(asked.code, 0, asked.out);
  const sent = async () => (await h.agent('sent', caller.token)).body;
  const answerMessage = (await sent())[0].id;
  assert.equal((await sent())[0].job, recipient.id);
  const offered = (await h.agent('inbox', recipient.token, {})).body;
  assert.equal(offered.find((m: any) => m.message === answerMessage).needsAnswer, true);
  assert.equal(offered.find((m: any) => m.message === handed.body.id).needsAnswer, undefined);
  await h.finish(recipient);
  const recovered = await sent();
  const answer = recovered.find((m: any) => m.id === answerMessage).became;
  const handoff = recovered.find((m: any) => m.id === handed.body.id).became;
  assert.notEqual(answer, handoff, 'an answer cannot join an ordinary hand-off');
  const correction = await h.agent('message', caller.token, {
    to: 'kit',
    text: 'Use the latest refusal.',
    needsAnswer: true,
  });
  assert.equal(correction.body.job, answer, 'answer corrections join the existing unstarted answer job');
  const later = await h.agent('message', caller.token, { to: 'kit', text: 'Also check its release notes.' });
  assert.equal(later.body.job, handoff, 'ordinary additions still join their original hand-off');
  for (const [job, title, code] of [
    [answer, 'Identify the refused revision', 'REFUSAL'],
    [handoff, 'Check the build and release notes', 'RELEASE'],
  ] as const) {
    const { proposal } = db
      .prepare(
        "select s.proposal from sorts s join proposals p on p.id = s.proposal where s.job = ? and p.status = 'open'",
      )
      .get(job) as { proposal: number };
    const accepted = await h.agent('proposals/accept', owner.token, { id: proposal, title, code });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  }
  assert.equal((await h.claim('claude'))?.id, answer);
  assert.equal(h.job(caller.id).status, 'running');
  assert.equal(h.job(handoff).status, 'queued');
});
