// node --test src/image.test.ts   (the coordinator as its image holds it, started as its own process on the harness's test company)
// The image takes only what the root .dockerignore lets in (platform/coordinator/Dockerfile: COPY . /app/), the company's
// kits/ with it. A module the coordinator imports that the image leaves out passes every test run in the repo, and stops
// the deployed coordinator at each start, so HQ answers nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness } from './harness.ts';
import { OWN } from '../../../shared/watchalong/mirrorpage.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;

// The .dockerignore's rules as Docker reads them: the last rule that matches a path or one of its folders decides, a
// "!" rule letting it in; * and ? stay within a folder, ** crosses them.
const rules = readFileSync(`${ROOT}.dockerignore`, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(l => {
    const keep = l.startsWith('!'),
      glob = l.slice(keep ? 1 : 0).replace(/^\/|\/$/g, '');
    const source = glob
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map(
        p => ({ '**/': '(.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[p] ?? p.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
      )
      .join('');
    return { keep, re: new RegExp(`^${source}$`) };
  });
const inImage = (file: string) => {
  const paths = file.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  let keep = true;
  for (const r of rules) if (paths.some(p => r.re.test(p))) keep = r.keep;
  return keep;
};

// /app as the image has it, from the repo's files, with the coordinator's installed packages
const app = mkdtempSync(`${tmpdir()}/image-test-`);
test.after(() => rmSync(app, { recursive: true, force: true }));
for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0'))
  if (file && inImage(file) && existsSync(`${ROOT}${file}`)) {
    mkdirSync(dirname(`${app}/${file}`), { recursive: true });
    cpSync(`${ROOT}${file}`, `${app}/${file}`);
  }
symlinkSync(realpathSync(`${ROOT}platform/coordinator/node_modules`), `${app}/platform/coordinator/node_modules`);

// the studio on (and every other part a company may turn on in brand.yaml), its image model's key not in
const h = await harness('image', {
  serve: false,
  before: repo =>
    writeFileSync(
      `${repo}/company/brand.yaml`,
      `${readFileSync(`${repo}/company/brand.yaml`, 'utf8')}
studio:
  keeper: moss
  products: [{ id: mug, name: The mug }]
  styles: [{ id: white, name: Clean white, prompt: On white. }]
`,
    ),
});
const free = createServer().listen(0);
await new Promise(r => free.once('listening', r));
const port = (free.address() as AddressInfo).port;
free.close();

test('the coordinator starts from its image alone, studio on and no key, and keeps answering', async t => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    PUBLIC_HOST: 'localhost',
    STUDIO_WATCH_MS: '100',
  };
  delete env.KITS_DIR; // (the image's own: /app/kits)
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', `${app}/platform/coordinator/src/server.ts`],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', () => out.includes('listening on') && resolve());
    child.on('exit', code => reject(new Error(`the coordinator stopped (${code}) before it listened:\n${out}`)));
  });

  const ask = async (path: string) => {
    const t0 = Date.now(),
      res = await fetch(`http://localhost:${port}${path}`, {
        headers: { cookie: h.boardCookie },
        signal: AbortSignal.timeout(5_000),
      });
    return { status: res.status, body: await res.json(), ms: Date.now() - t0 };
  };
  assert.equal((await ask('/api/brand')).body.studio, true);
  assert.equal((await ask('/api/studio')).body.key, false);
  // a second of the studio's watch, every 100 ms: HQ answers all along, and the studio says nothing without its key
  for (const until = Date.now() + 1_000; Date.now() < until;) {
    const health = await ask('/health');
    assert.equal(health.status, 200);
    assert.ok(health.ms < 1_000, `/health took ${health.ms} ms`);
  }
  assert.equal(child.exitCode, null, out);
  // (the start's CPU line names the busiest source files, studio.ts among them on a busy machine: not the studio speaking)
  const said = out.split('\n').filter(line => !line.startsWith("Coordinator: its start's CPU went to"));
  assert.doesNotMatch(said.join('\n'), /studio/i);
});

// The files the screen's mirror reads for its replay page as it serves them, not imports: one the image leaves out
// stops nothing at the start, and every picture of a shared screen waits its STEP_MS and fails, each time
test("the screen's mirror finds its replay page's own files in the image", () => {
  for (const own of Object.values(OWN)) {
    const file = own.url && own.url.pathname.slice(ROOT.length);
    if (file) assert.ok(inImage(file), `${file} isn't in the image`);
  }
});

// The voice line's image copies its Python modules one by one (platform/voice/Dockerfile, its COPY to /app/): a module
// server.py imports that the list leaves out passes every test in the repo, and stops the line at each start
test("the voice line's image has every module its server and the call agent's tools import", () => {
  const voice = `${ROOT}platform/voice/`;
  const copied = new Set(
    [
      ...readFileSync(`${voice}Dockerfile`, 'utf8')
        .replace(/\\\n/g, ' ')
        .matchAll(/^COPY (.+) \/app\/$/gm),
    ].flatMap(([, sources]) => sources.split(/\s+/).map(s => s.replace(/^voice\//, ''))),
  );
  // from the two scripts the image runs (CMD server.py; guard.py starts hq_tools.py), through their own modules
  const seen = new Set<string>(),
    todo = ['server.py', 'hq_tools.py'];
  for (let file; (file = todo.pop());) {
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(`${voice}${file}`, 'utf8');
    const names = [
      ...[...code.matchAll(/^\s*from (\w+) import /gm)].map(m => m[1]),
      ...[...code.matchAll(/^\s*import ([\w, ]+?)\s*(?:#.*)?$/gm)].flatMap(m => m[1].split(',').map(n => n.trim())),
      ...[...code.matchAll(/with_name\('(\w+)\.py'\)/g)].map(m => m[1]),
    ];
    for (const name of names) if (existsSync(`${voice}${name}.py`)) todo.push(`${name}.py`);
  }
  assert.ok(seen.has('driving.py'), 'the walk found no voice modules');
  for (const file of seen) assert.ok(copied.has(file), `platform/voice/${file} isn't in the voice image`);
});
