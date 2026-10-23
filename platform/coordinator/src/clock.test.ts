// node --test src/clock.test.ts   (the test company's clock, published in a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixtureRepo } from './fixture.ts';

const repo = fixtureRepo(),
  dataDirectory = mkdtempSync(`${tmpdir()}/clock-`);
const publish = () =>
  execFileSync(process.execPath, [new URL('./clock.ts', import.meta.url).pathname], {
    env: { ...process.env, REPO_DIR: repo, DATA_DIR: dataDirectory },
    stdio: 'pipe',
  });

test("the deploy publishes the company's clock as HQ reads it, and stops on an org.yaml it can't read", () => {
  publish();
  assert.equal(readFileSync(`${dataDirectory}/time-zone`, 'utf8'), 'Europe/Amsterdam');
  writeFileSync(`${repo}/company/org.yaml`, 'company: [');
  assert.throws(publish);
  assert.equal(readFileSync(`${dataDirectory}/time-zone`, 'utf8'), 'Europe/Amsterdam');
});
