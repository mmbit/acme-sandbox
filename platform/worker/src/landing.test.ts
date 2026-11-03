// node --test src/landing.test.ts   (a local bare repo stands in for GitHub)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gitFlow } from './git.ts';
import { pushThrew } from './landing.ts';
import { agentEnv } from './safety.ts';

test("a fix round's landing whose fetch of main can't reach GitHub goes back in the queue with its completed work", async () => {
  const tmp = mkdtempSync(`${tmpdir()}/landing-test-`),
    work = `${tmp}/work`,
    github = `${tmp}/github.git`;
  mkdirSync(`${work}/jobs`, { recursive: true, mode: 0o755 });
  const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...id } }).trim();
  git('init', '-q', '--bare', '-b', 'main', github);
  git('clone', '-q', github, `${tmp}/seed`);
  writeFileSync(`${tmp}/seed/README.md`, 'hi\n');
  git('-C', `${tmp}/seed`, 'add', '-A');
  git('-C', `${tmp}/seed`, 'commit', '-qm', 'seed');
  git('-C', `${tmp}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  const flow = gitFlow({
    mirror: `${work}/mirror.git`,
    remote: github,
    base: 'main',
    clones: () => readdirSync(`${work}/jobs`).map(n => `${work}/jobs/${n}`),
  });
  flow.ensureMirror();
  flow.fetchMirror();
  const job = flow.forAgent({
    uid: process.getuid!(),
    gid: process.getgid!(),
    env: agentEnv(process.env, { HOME: tmp }),
  });
  const dir = `${work}/jobs/7`;
  mkdirSync(dir, { mode: 0o700 });
  job.clone(dir, 'job/7');
  writeFileSync(`${dir}/fix.md`, 'the completed fix\n');
  job.ag(dir, 'add', '-A');
  job.ag(dir, 'commit', '-qm', 'the fix');
  const completed = job.ag(dir, 'rev-parse', 'HEAD');
  // GitHub refusing the worker's token for a moment, at the fetch of main before the push
  const refusing = `${tmp}/token-refused`;
  writeFileSync(
    refusing,
    '#!/bin/sh\necho "fatal: Authentication failed for \'https://github.com/acme/repo.git/\'" >&2\nexit 128\n',
  );
  chmodSync(refusing, 0o755);
  git('--git-dir', `${work}/mirror.git`, 'config', 'remote.origin.uploadpack', refusing);

  const err = await job.pushUpdated(dir, 'job/7').then(
    () => assert.fail('the push went through'),
    (e: unknown) => e,
  );
  const run = {
    job: 7,
    session: 's',
    branch: 'job/7',
    summary: 'Fixed it',
    result: 'The report',
    failure: (report: string, why: string) => `${report}\n\n${why}`,
    log: () => {},
  };
  const ended = pushThrew(run, err);
  assert.equal(ended.status, 'snagged');
  assert.deepEqual('landing' in ended && ended.landing, { summary: 'Fixed it', result: 'The report' });
  assert.match(ended.result, /^The report\n\nmain couldn't be fetched before the push: .*Authentication failed/s);
  assert.equal(job.ag(dir, 'rev-parse', 'HEAD'), completed);
  assert.equal(job.ag(dir, 'status', '--porcelain'), '');
});
