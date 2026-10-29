// node --test src/extras.test.ts   (uses a throwaway DATA_DIR)
// Every module HQ's pages import and every page they open, asked of the coordinator as the board's browser asks it. One it doesn't answer stops
// HQ's start for the board, while every page check passes on the dev server (serve.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('extras');
const { ORIGIN } = await import('./config.ts');
const { HQ_DIR } = await import('./files.ts');

// What a file loads: a module's static imports (and exports from), its dynamic imports, the pages it opens by a written
// address and the files it names beside itself (a worker's script), and a page's scripts
const LOADS = [
  /^\s*(?:import|export)\s[\w\s{},*$]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  /['"`](\/[\w./-]+\.html)['"`]/g,
  /<script\b[^>]*\bsrc=["']([^"']+)["']/g,
];
const loadsOf = (code: string) => LOADS.flatMap(pattern => [...code.matchAll(pattern)].map(match => match[1]));

// What the board's browser on HQ's host sends: its session, and its Host (review mode's parts go to the board there)
const asBoard = { cookie: h.boardCookie, host: new URL(ORIGIN).host };

test("every module and page HQ's pages load, and every one those load, is answered for the board", async () => {
  // HQ's browser code and pages: its shell, world, looks and apps (its .mjs files are Node's: the servers and the checks;
  // and its .test.js files, which run in Node)
  const modules = readdirSync(HQ_DIR, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.(js|html)$/.test(file) && !file.endsWith('.test.js'))
    .map(file => ({ address: `/${file}`, code: readFileSync(`${HQ_DIR}/${file}`, 'utf8') }));
  const asked = new Set(modules.map(module => module.address)),
    own = modules.length,
    unanswered: string[] = [];
  for (const module of modules)
    for (const specifier of loadsOf(module.code)) {
      const url = new URL(specifier, ORIGIN + module.address);
      if (url.origin !== ORIGIN || asked.has(url.pathname)) continue;
      asked.add(url.pathname);
      const answer = await h.send(url.pathname, asBoard);
      if (answer.status === 200) modules.push({ address: url.pathname, code: answer.text });
      else unanswered.push(`${url.pathname}, loaded by ${module.address}: ${answer.status}`);
    }
  assert.deepEqual(unanswered, []);
  assert.ok(modules.length > own, 'the walk reaches the files outside platform/hq');
});
