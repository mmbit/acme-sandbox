// node --test platform/hq/shell/safearea.test.js   (HQ's stylesheets read from the repo; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '../../..');
// HQ's own page and its apps. theme/hq/classic is the classic HQ, a page of its own with no style.css.
const ROOTS = [
  'platform/hq',
  ...readdirSync(join(REPO, 'kits'))
    .map(kit => `kits/${kit}/hq`)
    .filter(dir => existsSync(join(REPO, dir))),
];
const SKIP = new Set(['node_modules', 'screenshots', 'mock']);

const stylesheets = dir =>
  readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap(entry => {
    if (SKIP.has(entry.name)) return [];
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });

// Safari's blurred strip at the top is style.css's --sat (HQ's own controls clear it, and a home-screen app's is taller
// than the safe area): a screen that read env(safe-area-inset-top) itself would sit under the blur.
test('every top clearance in HQ is --sat: env(safe-area-inset-top) only in a --sat definition', () => {
  const files = ROOTS.flatMap(stylesheets);
  assert.ok(files.includes('platform/hq/style.css'), `style.css among ${files.length} stylesheets`);
  const strays = files.flatMap(file => {
    const css = readFileSync(join(REPO, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return css
      .split(/[;{}]/)
      .map(declaration => declaration.trim())
      .filter(declaration => declaration.includes('safe-area-inset-top') && !declaration.startsWith('--sat:'))
      .map(declaration => `${file}: ${declaration}`);
  });
  assert.deepEqual(strays, [], 'use var(--sat) for the top: style.css defines it');
});
