#!/usr/bin/env node
// node platform/hq/icons-preview-check.mjs (runs the preview CLI on the browser helper and checks its artifacts)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { workingTree } from '../../shared/gates/repo.ts';
import { join, resolve } from 'node:path';
import './harness.mjs';
import { ROOT } from './serve.mjs';
import { lookNames } from './looks.mjs';

const { parse, stringify } = await import('../coordinator/node_modules/yaml/dist/index.js');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const out = resolve(option('--out'));
const record = join(out, 'record.md');

test('the preview CLI pairs every look, screen and device against its ref and leaves a judgment for each look', async () => {
  const phone = await readFile(join(ROOT, 'platform/hq/icons/pixel/phone.svg'), 'utf8');
  const ref = await fixtureRef({
    'platform/hq/icons/pixel/phone.svg': phone.replace('</svg>', '<rect x="0" y="0" width="2" height="2"/></svg>'),
  });
  const { stdout } = await promisify(execFile)(process.execPath, [
    join(ROOT, 'platform/hq/icons-preview.mjs'),
    '--ref',
    ref,
    '--out',
    out,
    '--record',
    record,
  ]);
  console.log(stdout);
  const manifest = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  const baseline = await promisify(execFile)('git', ['-C', ROOT, 'rev-parse', `${ref}^{commit}`]);
  assert.equal(manifest.baseline, baseline.stdout.trim());
  assert.deepEqual(manifest.looks, lookNames());
  const expected = manifest.looks.flatMap(look =>
    ['phone', 'tablet'].flatMap(device => ['projects', 'home', 'icons'].map(screen => `${look}/${device}/${screen}`)),
  );
  assert.deepEqual(manifest.pairs.map(pair => `${pair.look}/${pair.device}/${pair.screen}`).sort(), expected.sort());
  await checkArtifacts(manifest);
  assert.deepEqual(
    manifest.changes.filter(change => change.icons.length).map(change => change.look),
    ['brownstone'],
  );
  assert.deepEqual(manifest.changes.find(change => change.look === 'brownstone').icons, ['phone']);
  for (const pair of manifest.pairs.filter(pair => pair.screen === 'icons'))
    assert.deepEqual(pair.icons, pair.look === 'brownstone' ? ['phone'] : []);
  for (const pair of manifest.pairs) {
    const before = await readFile(join(out, pair.before));
    const after = await readFile(join(out, pair.after));
    assert.equal(pair.changed, pair.icons.length > 0 || !before.equals(after));
  }
  const written = await readFile(record, 'utf8');
  const index = await readFile(join(out, 'index.md'), 'utf8');
  for (const change of manifest.changes) {
    assert.ok(written.includes(`- ${change.look}: ${change.summary}`));
    assert.ok(index.includes(`- ${change.look}: ${change.summary}`));
  }
  const errors = manifest.problems.map(problem => JSON.stringify(problem));
  assert.equal(new Set(errors).size, errors.length);
  const judgments = written.split('## What I saw')[1];
  for (const look of manifest.looks) assert.ok(judgments.includes(`- ${look}:`));
  for (const problem of manifest.problems) assert.ok(written.includes(problem.error));
});

test('a change only to theme/hq.yaml is visible in every look, screen and catalogue', async () => {
  const theme = parse(await readFile(join(ROOT, 'theme/hq.yaml'), 'utf8'));
  theme.styles.push(`data:text/css,${encodeURIComponent('body { filter: grayscale(1) !important; }')}`);
  const ref = await fixtureRef({
    'theme/hq.yaml': stringify(theme),
  });
  const output = join(out, 'theme');
  await promisify(execFile)(process.execPath, [
    join(ROOT, 'platform/hq/icons-preview.mjs'),
    '--ref',
    ref,
    '--out',
    output,
  ]);
  const manifest = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'));
  assert.deepEqual(
    manifest.changes.map(change => change.look),
    lookNames(),
  );
  for (const pair of manifest.pairs) assert.equal(pair.changed, true, `${pair.look}/${pair.device}/${pair.screen}`);
  for (const change of manifest.changes) {
    assert.deepEqual(change.icons, []);
    assert.deepEqual(change.screens.sort(), ['home', 'projects']);
    assert.ok(change.summary.includes('icon catalogue'), change.summary);
  }
});

async function checkArtifacts(manifest) {
  const paths = [];
  for (const pair of manifest.pairs) {
    assert.notEqual(pair.before, pair.after);
    paths.push(pair.before, pair.after);
  }
  paths.push(...manifest.looks.map(look => `${look}.png`));
  for (const path of paths) {
    const png = await readFile(join(out, path));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', path);
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, path);
  }
}

// An isolated index records the working tree plus a fixture as an unreferenced commit. No branch or work file changes.
async function fixtureRef(files) {
  const scratch = await mkdtemp(join(tmpdir(), 'icon-preview-ref-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(scratch, 'index'),
    GIT_AUTHOR_NAME: 'Preview check',
    GIT_AUTHOR_EMAIL: 'preview@example.com',
    GIT_COMMITTER_NAME: 'Preview check',
    GIT_COMMITTER_EMAIL: 'preview@example.com',
  };
  const git = (args, input) => execFileSync('git', ['-C', ROOT, ...args], { env, input, encoding: 'utf8' }).trim();
  try {
    git(['read-tree', workingTree(ROOT)]);
    for (const [path, contents] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], contents);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    return git(['commit-tree', git(['write-tree']), '-m', 'Icon preview fixture']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
