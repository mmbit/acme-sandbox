// node --test src/carry.test.ts   (a throwaway work folder)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { carrySession, project } from './carry.ts';
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

test("a fix round goes on in its author's Claude session, under its own clone's project, on any seat", () => {
  kept(10, claudeSession(10, 'abc-1'));
  assert.equal(
    carrySession(
      work,
      { id: 11, engine: 'claude', resumes: { job: 10, session: 'abc-1', seat: null } },
      { id: 'claude-2', cli: 'claude' },
      me,
    ),
    'abc-1',
  );
  assert.ok(existsSync(`${jobDirs(work, 11).home}/${claudeSession(11, 'abc-1')}`));
});

test("a Codex session goes on only on the seat it ran on: another seat's account starts afresh", () => {
  kept(20, '.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-def-2.jsonl');
  const from = { job: 20, session: 'def-2', seat: 'codex-1' };
  assert.equal(
    carrySession(work, { id: 21, engine: 'codex', resumes: from }, { id: 'codex-2', cli: 'codex' }, me),
    null,
  );
  assert.equal(
    carrySession(work, { id: 22, engine: 'codex', resumes: from }, { id: 'codex-1', cli: 'codex' }, me),
    'def-2',
  );
  assert.ok(existsSync(`${jobDirs(work, 22).home}/.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-def-2.jsonl`));
});

test('a session of another CLI, or one whose home is gone, starts afresh', () => {
  kept(30, claudeSession(30, 'ghi-3'));
  assert.equal(
    carrySession(
      work,
      { id: 31, engine: 'claude', resumes: { job: 30, session: 'ghi-3', seat: null } },
      { id: 'vibe-1', cli: 'vibe' },
      me,
    ),
    null,
  );
  assert.equal(
    carrySession(
      work,
      { id: 32, engine: 'claude', resumes: { job: 39, session: 'ghi-3', seat: null } },
      { id: 'claude-1', cli: 'claude' },
      me,
    ),
    null,
  );
  assert.equal(
    carrySession(
      work,
      { id: 33, engine: 'codex', resumes: { job: 30, session: 'none-here', seat: 'codex-1' } },
      { id: 'codex-1', cli: 'codex' },
      me,
    ),
    null,
  );
});
