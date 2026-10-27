// node --test src/chat-onboarding.test.ts: a new company's intercom is its onboarding. HQ asks the language before the
// first line, and the CEO's chat follows the company's intake playbook while it has nobody else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // (the intake's cards.)
import { harness } from './harness.ts';

const h = await harness('chat-onboarding');
const orgFile = `${h.repo}/company/org.yaml`,
  org = readFileSync(orgFile, 'utf8');
const alone = org.replace(
  /^departments:[\s\S]*?^roles:/m,
  'departments:\n  - id: executive\n    name: Executive\n    room: { kind: office, size: s }\n    agents:\n' +
    '      - { id: juno, name: Juno, role: CEO, engine: claude, look: "round glasses" }\n\nroles:',
);
type Line = { who: string; text: string; card?: { kind: string; switches?: { name: string; on: boolean }[] } };
const chat = async () => (await h.board('/api/chat')).body as { welcome: boolean; messages: Line[] };
const turn = async () => (await h.claim('claude', { seat: 'claude-1', util: 0, kind: 'chat' }))!;

test('a company with a team has no welcome: its intercom opens as it always does', async () => {
  assert.equal((await chat()).welcome, false);
});

test("a new company's intercom asks the language first, then its CEO follows the intake playbook", async () => {
  writeFileSync(orgFile, alone);
  try {
    assert.equal((await chat()).welcome, true, 'nothing said yet: HQ opens the intercom on the language');
    assert.equal((await h.board('/api/chat', { text: 'Nederlands' })).status, 200);
    assert.equal((await chat()).welcome, false, 'the language picked is the first line');
    const job = await turn();
    assert.equal(job.kind, 'chat');
    assert.match(job.prompt as string, /company\/playbooks\/intake\.md/);
    await h.finish(job, { result: 'Welkom!' });
  } finally {
    writeFileSync(orgFile, org);
  }
});

test("the CEO's turn puts the intake's cards on its reply: the switches with its picks, then the ask keys", async () => {
  const dir = mkdtempSync(`${tmpdir()}/intake-`),
    file = `${dir}/switches.json`;
  writeFileSync(
    file,
    JSON.stringify({
      title: 'What runs by itself',
      says: 'Runs by itself',
      none: 'Nothing runs by itself for now',
      switches: [
        { name: 'Care', what: 'Answers customers in a chat on your sites', on: true },
        { name: 'Photo studio', what: 'Edits product photos you take into shop pictures', on: false },
      ],
    }),
  );
  writeFileSync(orgFile, alone);
  try {
    await h.board('/api/chat', { text: 'Mostly kids and their parents.' });
    const job = await turn();
    const set = await h.hq(job, 'intake', 'switches', file);
    assert.equal(set.code, 0, set.out);
    await h.finish(job, { result: 'Last part: what should run by itself? Flip anything, then send.' });
    const reply = (await chat()).messages.at(-1)!;
    assert.equal(reply.card?.kind, 'switches', 'the reply carries the card');
    assert.deepEqual(
      reply.card?.switches?.map(s => [s.name, s.on]),
      [
        ['Care', true],
        ['Photo studio', false],
      ],
      "with the CEO's picks set",
    );
    assert.notEqual((await h.hq(job, 'intake', 'asks')).code, 0, 'a turn that has ended puts no card anywhere');

    await h.board('/api/chat', { text: 'Runs by itself: Care.' });
    const next = await turn();
    writeFileSync(`${dir}/none.json`, JSON.stringify({ title: 'What runs by itself', switches: [] }));
    assert.notEqual(
      (await h.hq(next, 'intake', 'switches', `${dir}/none.json`)).code,
      0,
      'a card without its words and switches is refused, and nothing is set',
    );
    assert.equal((await h.hq(next, 'intake', 'asks')).code, 0);
    await h.finish(next, { result: 'Is there anything else you’d like me to research or set up?' });
    const lines = (await chat()).messages;
    assert.deepEqual(
      lines.slice(-3).map(m => m.card?.kind ?? null),
      ['switches', null, 'asks'],
      "each card stays on its own reply, the board's line has none",
    );
  } finally {
    writeFileSync(orgFile, org);
  }
});
