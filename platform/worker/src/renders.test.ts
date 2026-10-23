// node --test src/renders.test.ts   (as one uid: the uid switch itself is the worker's, slots.test.ts covers it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { keepRenders } from './renders.ts';

test('a push keeps each render it names, once, by its sha256; one that isn’t what it names, or from history, isn’t kept', async () => {
  const dir = mkdtempSync(`${tmpdir()}/renders-clone-`),
    store = mkdtempSync(`${tmpdir()}/renders-store-`);
  const film = Buffer.from('a film, frame by frame'),
    sha256 = createHash('sha256').update(film).digest('hex');
  const note = (n: object) =>
    JSON.stringify({ command: ['node', 'shared/demo/ad.mjs'], sha256, bytes: film.length, ...n });
  mkdirSync(`${dir}/ads`);
  writeFileSync(`${dir}/ads/ok.mp4`, film);
  writeFileSync(`${dir}/ads/ok.mp4.render.json`, note({}));
  writeFileSync(`${dir}/ads/bad.mp4`, 'something else');
  writeFileSync(`${dir}/ads/bad.mp4.render.json`, note({ sha256: '2'.repeat(64) }));
  writeFileSync(`${dir}/ads/old.mp4.render.json`, JSON.stringify({ blob: 'abc', sha256, bytes: 3 }));
  symlinkSync('/etc/hostname', `${dir}/ads/link.mp4`);
  writeFileSync(`${dir}/ads/link.mp4.render.json`, note({ sha256: '1'.repeat(64) }));
  const who = { env: { PATH: process.env.PATH! } };
  const files = [
    'ads/ok.mp4.render.json',
    'ads/bad.mp4.render.json',
    'ads/old.mp4.render.json',
    'ads/link.mp4.render.json',
    'ads/ok.mp4',
  ];
  const left = await keepRenders(store, who, dir, files);
  assert.deepEqual(left, [
    "ads/bad.mp4.render.json: its render isn't what it names, not kept",
    "ads/link.mp4.render.json: its render isn't what it names, not kept",
  ]);
  assert.deepEqual(readFileSync(`${store}/${sha256}`), film);
  assert.equal(statSync(`${store}/${sha256}`).mode & 0o777, 0o444);
  assert.ok(!existsSync(`${store}/${'1'.repeat(64)}`));
  assert.deepEqual(await keepRenders(store, who, dir, files.slice(0, 1)), [], 'kept once');
});

test('raw output kept without a recipe is kept like a render', async () => {
  const dir = mkdtempSync(`${tmpdir()}/renders-clone-`),
    store = mkdtempSync(`${tmpdir()}/renders-store-`);
  const trace = Buffer.from('{"frames": []}\n'),
    sha256 = createHash('sha256').update(trace).digest('hex');
  writeFileSync(`${dir}/trace.json`, trace);
  writeFileSync(`${dir}/trace.json.render.json`, JSON.stringify({ sha256, bytes: trace.length }));
  assert.deepEqual(await keepRenders(store, { env: { PATH: process.env.PATH! } }, dir, ['trace.json.render.json']), []);
  assert.deepEqual(readFileSync(`${store}/${sha256}`), trace);
});

test('an empty log is kept with an explicit nonnegative integer size', async () => {
  const dir = mkdtempSync(`${tmpdir()}/renders-clone-`),
    store = mkdtempSync(`${tmpdir()}/renders-store-`);
  const sha256 = createHash('sha256').update('').digest('hex');
  const side = 'page-errors.log.render.json';
  const keep = () => keepRenders(store, { env: { PATH: process.env.PATH! } }, dir, [side]);
  writeFileSync(`${dir}/page-errors.log`, '');
  for (const bytes of [undefined, null, '0', -1, 0.5]) {
    writeFileSync(`${dir}/${side}`, JSON.stringify({ sha256, bytes }));
    assert.deepEqual(await keep(), [`${side}: names no sha256 and size a render has`]);
    assert.ok(!existsSync(`${store}/${sha256}`));
  }
  writeFileSync(`${dir}/${side}`, JSON.stringify({ sha256, bytes: 0 }));
  assert.deepEqual(await keep(), []);
  assert.equal(readFileSync(`${store}/${sha256}`).length, 0);
});
