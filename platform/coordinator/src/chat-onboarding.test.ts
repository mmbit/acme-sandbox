// node --test src/chat-onboarding.test.ts: a new company's intercom is its onboarding. HQ asks the language before the
// first line, and the CEO's chat follows the company's intake playbook while it has nobody else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('chat-onboarding');
const orgFile = `${h.repo}/company/org.yaml`,
  org = readFileSync(orgFile, 'utf8');
const alone = org.replace(
  /^departments:[\s\S]*?^roles:/m,
  'departments:\n  - id: executive\n    name: Executive\n    room: { kind: office, size: s }\n    agents:\n' +
    '      - { id: juno, name: Juno, role: CEO, engine: claude, look: "round glasses" }\n\nroles:',
);
const chat = async () => (await h.board('/api/chat')).body as { welcome: boolean; messages: unknown[] };
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
