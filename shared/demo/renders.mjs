#!/usr/bin/env node
// Rendered media stays out of git. A film, a recording or a track the kit renders is written where its recipe says,
// and beside it goes `<file>.render.json`: the command that renders it, run from the repo root, and what it rendered
// (its sha256 and size). Anything else that makes one (an ffmpeg re-encode for a deck) runs through `make`, which notes
// it the same way. The JSON is committed with the recipe; the file itself isn't (.gitignore). The worker keeps each
// pushed render, the server puts it back in its checkout (infra/renders.py), so HQ, previews, sites and tools read it
// where they always did, and anyone can render it again from its recipe: the kit's renders are the same on every run.
// A run's raw output (a trace, observations, a frame dump, a log) is kept the same way, without a recipe (`keep`).
//
//   node shared/demo/renders.mjs status [path...]       which renders here are present, missing or changed
//   node shared/demo/renders.mjs fetch <file>...        a render from HQ into this clone (in a job: HQ_URL, HQ_TOKEN),
//                                                       one an unmerged branch pushed too
//   node shared/demo/renders.mjs make <file> -- <command...>   runs the command that makes <file> (an ffmpeg
//                                                       re-encode, a crop, a mix by hand) and notes it
//   node shared/demo/renders.mjs render <file>...       renders it again with the command in its .render.json
//   node shared/demo/renders.mjs check <file>...        renders it again to a temp folder and says whether it's the same
//   node shared/demo/renders.mjs keep <file>...         raw output kept out of git: its .render.json names its sha256
//                                                       and size, and git ignores the file (the worker keeps it)
//   node shared/demo/renders.mjs adopt <file>...        a file committed before renders were kept: its .render.json names
//                                                       its git blob (the server takes it from history), and git forgets
//                                                       the file itself
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SIDE = '.render.json';
// what's a render: video and audio. One over BIG is never committed (shared/gates); smaller ones, a UI's chime, may be
export const MEDIA = /\.(mp4|mov|webm|m4a|wav|mp3|ogg)$/i;
export const BIG = 512 * 1024;
// set by `make` for the command it runs: the file it notes itself
const MAKING = 'DEMO_RENDERS_MAKING';

const inRepo = p => !relative(ROOT, p).startsWith('..') && !isAbsolute(relative(ROOT, p));
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// Called by the kit's tools once `out` is written: its .render.json, with the command that made it (this run's own,
// `node <tool> <args>`). Arguments that name files become repo paths, so the command runs from the repo root. A file
// outside the repo (a temp mix) gets none. Under `make` (a wrapper script that runs a kit tool) the wrapper's command is
// the recipe, so the tool leaves the note to make, with only the prices it shows for make to keep. prices: the ones the
// file shows, with those its inputs' notes record (a copy or a re-encode shows what they did), so the note keeps what
// its own bytes show (prices.mjs)
export function noteRender(out, command = ['node', ...process.argv.slice(1)], cwd = process.cwd(), prices = []) {
  const file = resolve(cwd, out);
  if (!inRepo(file) || !MEDIA.test(file)) return;
  if (process.env[MAKING] === file) {
    if (prices.length) writeFileSync(file + SIDE, JSON.stringify({ prices }, null, 2) + '\n');
    return;
  }
  const repoPath = a => {
    const path = resolve(cwd, a);
    return existsSync(path) && inRepo(path) ? relative(ROOT, path) : a;
  };
  const recipe = command.map((a, i) => (i ? repoPath(a) : a));
  const shown = [
    ...prices,
    ...inputsOf(relative(ROOT, file), recipe).flatMap(input => read(join(ROOT, input + SIDE)).prices ?? []),
  ];
  const note = {
    command: recipe,
    sha256: sha256(file),
    bytes: statSync(file).size,
    ...(shown.length ? { prices: shown } : {}),
  };
  writeFileSync(file + SIDE, JSON.stringify(note, null, 2) + '\n');
  // an empty argument (`--label ""`) is no path, though it joins to the repo's root
  const lost = leftOut(note.command.slice(1).filter(a => a && existsSync(join(ROOT, a)) && !MEDIA.test(a)));
  if (lost.length)
    console.warn(
      `warning: ${relative(ROOT, file)}${SIDE} names ${lost.join(', ')}, which git leaves out, so a clone can't render ` +
        `it again: run what made it through \`node shared/demo/renders.mjs make ${relative(ROOT, file)} -- <command>\``,
    );
}

// the repo paths git ignores (a wrapper's temporary flow file)
function leftOut(paths) {
  if (!paths.length) return [];
  try {
    return execFileSync('git', ['-C', ROOT, 'check-ignore', '--', ...paths], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    if (error.status === 1) return []; // No paths are ignored.
    throw error;
  }
}

// the renders a command makes `file` from (repo paths): every word of it that's a render here (a cp's source, an ffmpeg
// input, a wrapper's), `file` itself left out
export const inputsOf = (file, command = []) => [
  ...new Set(
    command
      .slice(1)
      .flatMap(a => a.split(/\s+/))
      .filter(a => a && a !== file && existsSync(join(ROOT, a + SIDE))),
  ),
];

const sidecar = file => (file.endsWith(SIDE) ? file : file + SIDE);
const target = side => side.slice(0, -SIDE.length);
const read = side => JSON.parse(readFileSync(side, 'utf8'));
const state = side => {
  const n = read(side),
    f = target(side);
  if (!existsSync(f)) return 'missing';
  return statSync(f).size === n.bytes && sha256(f) === n.sha256 ? 'present' : 'changed';
};

// a render's command, run from the repo root
function rerender(side) {
  const [cmd, ...args] = read(side).command ?? [];
  if (!cmd)
    throw new Error(
      `${relative(ROOT, side)} names no command (raw output, or committed before renders were kept): fetch it`,
    );
  make(target(side), [cmd, ...args], ROOT);
}

// make <file> -- <command...>: the command run from where it's typed, noted with its paths from the repo root
function make(file, command, cwd = process.cwd()) {
  if (!file || !command.length) throw new Error('usage: node shared/demo/renders.mjs make <file> -- <command...>');
  const output = resolve(cwd, file),
    side = output + SIDE;
  // the note the kit tool leaves (the prices it shows) is this run's alone: the old one is put back if the run fails
  const was = existsSync(side) ? readFileSync(side) : null;
  rmSync(side, { force: true });
  try {
    execFileSync(command[0], command.slice(1), { cwd, stdio: 'inherit', env: { ...process.env, [MAKING]: output } });
    if (!existsSync(output)) throw new Error(`${file} wasn't made`);
  } catch (error) {
    if (was) writeFileSync(side, was);
    throw error;
  }
  noteRender(output, command, cwd, existsSync(side) ? (read(side).prices ?? []) : []);
}

// A render any job pushed is in the worker's store by its sha256 (HQ_RENDERS), a branch's not yet merged included:
// taken from there, else from HQ's checkout of main. An adopted one is in this clone's own history.
async function fetchRender(side) {
  const { HQ_URL, HQ_TOKEN, HQ_RENDERS } = process.env;
  const { sha256: expectedHash, blob } = read(side);
  const path = relative(ROOT, target(side)),
    tmp = target(side) + '.part';
  const stored = HQ_RENDERS && /^[0-9a-f]{64}$/.test(expectedHash ?? '') ? join(HQ_RENDERS, expectedHash) : null;
  if (stored && existsSync(stored)) copyFileSync(stored, tmp);
  else if (blob)
    writeFileSync(tmp, execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', blob], { maxBuffer: 1 << 30 }));
  else {
    if (!HQ_URL || !HQ_TOKEN) throw new Error('fetch runs in a job (HQ_URL and HQ_TOKEN): elsewhere, render it again');
    const res = await fetch(`${HQ_URL}/api/agent/render?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${HQ_TOKEN}` },
    });
    if (!res.ok) throw new Error(`${path}: HQ has none (${res.status}): render it again`);
    writeFileSync(tmp, Buffer.from((await res.json()).data, 'base64'));
  }
  if (sha256(tmp) !== expectedHash) {
    rmSync(tmp);
    throw new Error(`${path}: the fetched copy isn't what its ${SIDE} names`);
  }
  renameSync(tmp, target(side));
}

function adopt(file) {
  const f = resolve(file),
    path = relative(ROOT, f);
  const blob = execFileSync('git', ['-C', ROOT, 'rev-parse', `HEAD:${path}`], { encoding: 'utf8' }).trim();
  writeFileSync(f + SIDE, JSON.stringify({ blob, sha256: sha256(f), bytes: statSync(f).size }, null, 2) + '\n');
  execFileSync('git', ['-C', ROOT, 'rm', '-q', '--cached', '--', path]);
  ignore(f);
}

// Raw output (no recipe): the worker keeps it by its sha256 when the push names its .render.json
function keep(file) {
  const f = resolve(file),
    path = relative(ROOT, f);
  if (!existsSync(f) || !inRepo(f)) throw new Error(`${file}: no such file in the repo`);
  writeFileSync(f + SIDE, JSON.stringify({ sha256: sha256(f), bytes: statSync(f).size }, null, 2) + '\n');
  execFileSync('git', ['-C', ROOT, 'rm', '-q', '--cached', '--ignore-unmatch', '--', path]);
  ignore(f);
}

// a kept file git doesn't ignore yet (media is, by .gitignore) goes in its folder's .gitignore
function ignore(f) {
  if (leftOut([relative(ROOT, f)]).length) return;
  const list = join(dirname(f), '.gitignore');
  let head = "# Kept out of git: each file's .render.json names it (shared/demo/README.md, Renders)\n";
  if (existsSync(list)) head = readFileSync(list, 'utf8').endsWith('\n') ? '' : '\n';
  appendFileSync(list, `${head}/${basename(f)}\n`);
}

// every .render.json git knows under the paths given (all of them without)
export const tracked = paths =>
  execFileSync(
    'git',
    ['-C', ROOT, 'ls-files', '-z', '--', ...(paths.length ? paths.map(p => relative(ROOT, resolve(p))) : ['.'])],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(p => p.endsWith(SIDE))
    .map(p => join(ROOT, p));

async function main([cmd, ...paths]) {
  if (cmd === 'make') return make(paths[0], paths.indexOf('--') < 0 ? [] : paths.slice(paths.indexOf('--') + 1));
  const sides = paths.map(p => resolve(sidecar(p)));
  if (cmd === 'status') {
    for (const s of tracked(paths)) console.log(`${state(s).padEnd(8)} ${relative(ROOT, target(s))}`);
  } else if (cmd === 'fetch') for (const s of sides) await fetchRender(s);
  else if (cmd === 'render') for (const s of sides) rerender(s);
  else if (cmd === 'check') {
    let same = true;
    // rendered again where it is (tools name their output their own way), with what was there put back after
    for (const s of sides) {
      const dir = mkdtempSync(join(tmpdir(), 'render-check-')),
        was = read(s),
        kept = existsSync(target(s));
      if (kept) renameSync(target(s), join(dir, 'file'));
      try {
        rerender(s);
        const ok = sha256(target(s)) === was.sha256;
        same &&= ok;
        console.log(`${ok ? 'same     ' : 'DIFFERENT'} ${relative(ROOT, target(s))}`);
      } finally {
        if (kept) renameSync(join(dir, 'file'), target(s));
        writeFileSync(s, JSON.stringify(was, null, 2) + '\n');
        rmSync(dir, { recursive: true, force: true });
      }
    }
    process.exitCode = same ? 0 : 1;
  } else if (cmd === 'keep') for (const p of paths) keep(p);
  else if (cmd === 'adopt') for (const p of paths) adopt(p);
  else {
    console.error(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\nimport')[0]
        .replace(/^#!.*\n/, '')
        .replace(/^\/\/ ?/gm, ''),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
