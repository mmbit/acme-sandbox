// node --test src/carry.test.ts   (a throwaway work folder)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { carrySession, closingLines, project } from './carry.ts';
import { jobDirs } from './slots.ts';

const work = mkdtempSync(`${tmpdir()}/carry-test-`);
after(() => rmSync(work, { recursive: true, force: true }));
const me = { env: { PATH: process.env.PATH! } }; // (one uid in a test: nothing to hand over)
// The home the worker kept of job `id`, with `file` (its path under the home) written in it
const kept = (id: number, file: string) => {
  const path = `${jobDirs(work, id).home}/${file}`;
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, '{"type":"user"}\n');
};
const claudeSession = (id: number, session: string) =>
  `.claude/projects/${project(jobDirs(work, id).dir)}/${session}.jsonl`;

test("a follow-up goes on in its author's Claude session, under its own clone's project", () => {
  kept(10, claudeSession(10, 'abc-1'));
  assert.equal(
    carrySession(work, { id: 11, engine: 'claude', resumes: { job: 10, session: 'abc-1' } }, 'claude', me),
    'abc-1',
  );
  assert.ok(existsSync(`${jobDirs(work, 11).home}/${claudeSession(11, 'abc-1')}`));
});

// (which seat a session may go on on is the coordinator's call, carryover.ts)
test('a Codex session goes on from its sessions folder, copied under the new home', () => {
  kept(20, '.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-def-2.jsonl');
  const from = { job: 20, session: 'def-2' };
  assert.equal(carrySession(work, { id: 22, engine: 'codex', resumes: from }, 'codex', me), 'def-2');
  assert.ok(existsSync(`${jobDirs(work, 22).home}/.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-def-2.jsonl`));
});

test('a session of another CLI, or one whose home is gone, starts afresh', () => {
  kept(30, claudeSession(30, 'ghi-3'));
  assert.equal(
    carrySession(work, { id: 31, engine: 'claude', resumes: { job: 30, session: 'ghi-3' } }, 'vibe', me),
    null,
  );
  assert.equal(
    carrySession(work, { id: 32, engine: 'claude', resumes: { job: 39, session: 'ghi-3' } }, 'claude', me),
    null,
  );
  assert.equal(
    carrySession(work, { id: 33, engine: 'codex', resumes: { job: 30, session: 'none-here' } }, 'codex', me),
    null,
  );
});

test("a fresh start is briefed with each closing report and the branch's commits", () => {
  const closing = {
    reports: [
      { job: 40, report: 'Built the checkout.\n' },
      { job: 41, report: 'Fixed the notes.' },
    ],
  };
  const lines = closingLines(closing, 'b2c3d4e Bolt: fix the notes\na1b2c3d Bolt: the checkout\n');
  for (const part of [
    "Job #40's closing report",
    'Built the checkout.',
    "Job #41's closing report",
    'Fixed the notes.',
  ])
    assert.ok(lines.includes(part), part);
  assert.ok(lines.indexOf('Built the checkout.') < lines.indexOf('Fixed the notes.'), 'oldest first');
  assert.ok(lines.includes('b2c3d4e Bolt: fix the notes\na1b2c3d Bolt: the checkout'));
});
