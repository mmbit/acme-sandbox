// node --test src/screens.test.ts   (as one uid: the uid switch itself is the worker's, slots.test.ts covers it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { keepScreens } from './screens.ts';

const who = { env: { PATH: process.env.PATH! } };
const SHA = 'a'.repeat(40);
const said = (answer: object) => ({ passed: true, report: `Screens: 1 changed\n${JSON.stringify(answer)}\n` });
const lastLine = (report: string) => JSON.parse(report.trim().split('\n').at(-1)!);

test("a push's changed sheets are kept under its commit, and its check's answer names the kept ones", async () => {
  const out = mkdtempSync(`${tmpdir()}/screens-out-`),
    store = mkdtempSync(`${tmpdir()}/screens-store-`);
  writeFileSync(`${out}/projects-brownstone-tablet-sheet.png`, 'before|after');
  mkdirSync(`${store}/${'b'.repeat(40)}`);
  utimesSync(`${store}/${'b'.repeat(40)}`, new Date(0), new Date(0));
  const blank = { screen: 'home', look: 'wire', device: 'phone', sheet: null, why: 'Chromium crashed' };
  const shot = {
    screen: 'projects',
    look: 'brownstone',
    device: 'tablet',
    sheet: `${out}/projects-brownstone-tablet-sheet.png`,
  };
  const kept = await keepScreens(store, who, SHA, said({ rendered: true, changed: [shot, blank], same: 34, out }));
  const sheet = `${store}/${SHA}/projects-brownstone-tablet-sheet.png`;
  assert.equal(kept.passed, true);
  assert.match(kept.report, /^Screens: 1 changed\n/);
  assert.deepEqual(lastLine(kept.report).changed, [{ ...shot, sheet }, blank]);
  assert.equal(readFileSync(sheet, 'utf8'), 'before|after');
  assert.equal(statSync(sheet).mode & 0o777, 0o444);
  assert.equal(statSync(`${store}/${SHA}`).mode & 0o777, 0o755);
  assert.equal(statSync(`${store}/${'b'.repeat(40)}`, { throwIfNoEntry: false }), undefined, 'a week old: pruned');
});

test("one that changes nothing, or couldn't run, is left as it said; a sheet that can't be kept leaves it couldn't tell", async () => {
  const out = mkdtempSync(`${tmpdir()}/screens-out-`),
    store = mkdtempSync(`${tmpdir()}/screens-store-`);
  for (const outcome of [
    said({ rendered: false, why: 'nothing HQ runs differs' }),
    said({ rendered: true, changed: [], same: 36 }),
    { passed: null, report: 'Chromium would not start' },
  ])
    assert.deepEqual(await keepScreens(store, who, SHA, outcome), outcome);
  // (another file than its screen's sheet, or none)
  writeFileSync(`${out}/other.png`, 'x');
  for (const sheet of [`${out}/other.png`, `${out}/news-wire-phone-sheet.png`]) {
    const shot = { screen: 'news', look: 'wire', device: 'phone', sheet };
    const outcome = said({ rendered: true, changed: [shot], same: 35 });
    const kept = await keepScreens(store, who, SHA, outcome);
    assert.equal(kept.passed, null, sheet);
    assert.ok(kept.report.endsWith(outcome.report), 'the check’s own answer below');
  }
});
