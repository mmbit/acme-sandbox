#!/usr/bin/env node
// A film render() draws on a machine the board lends rather than beside the agents on the server. In a job, render()
// (core.mjs) sends the frames' work to the company's `render` kind of run
// (`hq run`, platform/helper/README.md) with the page and its film's inputs, brings the film back and notes it as its
// own. The page's other files go as it asks for them: a file the job has and the run lacks stops the run, which says
// which, and the next run takes it too. With no machine to take it (no render kind, the machine off, or one lost the
// run) `hq run --fallback here` draws it in the job.
//   node shared/demo/away.mjs <spec.json>     draws the film a spec names (the run's own command)
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, rendered } from './core.mjs';
import * as drawn from './drawn.mjs';
import { pricesFor } from './prices.mjs';
import { MEDIA, ROOT, SIDE, noteRender } from './renders.mjs';

const KIND = 'render';
// the spec, the job's files and the film, in a folder git ignores (the clone's own exclude list)
const AWAY = '.demo-away';
// the slowest a lent machine draws a film, frames a second: it sets the run's limit
const SLOWEST_FPS = 2;
const MIN_MINUTES = 20;

// render() in a job: the film drawn by a run and brought back, then noted as render() notes it
export async function send(options) {
  const t0 = Date.now();
  const out = resolve(options.out);
  const shown = await pricesFor(options.prices, options.lang);
  const folder = join(ROOT, AWAY, randomUUID());
  ignored();
  mkdirSync(join(folder, 'back'), { recursive: true });
  try {
    const where = await drawAway(folder, { ...options, shown });
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(join(folder, 'back', 'film.mp4'), out);
    noteRender(out, options.recipe, undefined, shown);
    return rendered(out, t0, where);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Runs until one has every file the page asks for: each that lacked some names them, and the next takes them too, with
// the files beside them. The page's own folder goes from the start, and so does what it needed in this clone before.
async function drawAway(folder, options) {
  const page = pageFile(options.page);
  const { spec, audio } = specOf(folder, options);
  const files = jobFiles();
  writeFileSync(join(folder, 'files.txt'), files.join('\n'));
  const known = [page, ...learned(page)];
  const needed = new Set([...known, ...alongside(files, known)]);
  const frames = Math.round(options.duration * (options.fps ?? 30));
  const minutes = Math.max(MIN_MINUTES, Math.ceil(frames / SLOWEST_FPS / 60));
  for (;;) {
    const carried = [relative(ROOT, folder), audio, ...needed].filter(Boolean);
    const flags = ['--kind', KIND, '--fallback', 'here', '--paths', 'shared/demo', '--with', carried.join(',')];
    const back = ['--bring', relative(ROOT, join(folder, 'back')), '--minutes', String(minutes)];
    const ran = await hqRun([...flags, ...back], ['node', 'shared/demo/away.mjs', spec]);
    const missing = join(folder, 'back', 'missing.json');
    if (ran.status === drawn.MISSING_EXIT && existsSync(missing)) {
      const lacked = JSON.parse(readFileSync(missing, 'utf8')).filter(path => !needed.has(path));
      if (!lacked.length) throw new Error(`${options.out}: the run lacked files it had been sent`);
      for (const path of [...lacked, ...alongside(files, lacked)]) needed.add(path);
      learn(page, lacked);
      rmSync(missing);
      continue;
    }
    if (ran.status !== 0) throw new Error(`${options.out}: the render's run ended ${ran.status}`);
    return / running it here$/m.test(ran.stdout) ? '' : ` on ${machineOf(ran.stdout)}`;
  }
}

// The run's spec, its paths from the repo's root: the film goes in the folder's back/, the audio as an input of its
// own. { spec, audio }: the spec's path and the audio's
function specOf(folder, options) {
  const audio = options.audio && relative(ROOT, inputOf(folder, resolve(options.audio)));
  const out = relative(ROOT, join(folder, 'back', 'film.mp4'));
  const spec = join(folder, 'spec.json');
  writeFileSync(spec, JSON.stringify({ ...options, out, audio, recipe: undefined }));
  return { spec: relative(ROOT, spec), audio };
}

// The files in the same folders as these, but renders: a render goes only when it's asked for, as a folder of films
// can be big
const alongside = (files, paths) => {
  const folders = new Set(paths.map(dirname));
  return files.filter(file => folders.has(dirname(file)) && !MEDIA.test(file));
};

// What a page needed in earlier runs from this clone, in git's own folder
const learnedFile = () => resolve(ROOT, git(['rev-parse', '--git-path', 'demo-away.json']));
const learnedAll = () => (existsSync(learnedFile()) ? JSON.parse(readFileSync(learnedFile(), 'utf8')) : {});
const learned = page => (learnedAll()[page] ?? []).filter(path => existsSync(join(ROOT, path)));

function learn(page, paths) {
  const all = learnedAll();
  all[page] = [...new Set([...(all[page] ?? []), ...paths])];
  writeFileSync(learnedFile(), JSON.stringify(all));
}

// hq run from the repo's root, its output passed on as it comes and kept: { status, stdout }
function hqRun(flags, command) {
  const child = spawn('hq', ['run', ...flags, '--', ...command], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    stdout += chunk;
  });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('close', status => done({ status, stdout }));
  });
}

// The repo file a page's URL path serves
const pageFile = url => decodeURIComponent(new URL(url, 'http://x').pathname).slice(1);

// A film input the run takes with it: a file in the repo as it is, one outside it (a mix in a temp folder) copied in
function inputOf(folder, file) {
  if (!relative(ROOT, file).startsWith('..')) return file;
  const copy = join(folder, `input-${basename(file)}`);
  copyFileSync(file, copy);
  return copy;
}

// Every file this job's tree has: git's (committed or new) and the renders present beside their notes
function jobFiles() {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const renders = listed.filter(path => path.endsWith(SIDE)).map(path => path.slice(0, -SIDE.length));
  return [...listed, ...renders].filter(path => existsSync(join(ROOT, path)));
}

// The run's folder is one git leaves out in every clone, so a job ended mid-render leaves nothing to commit
function ignored() {
  const exclude = resolve(ROOT, git(['rev-parse', '--git-path', 'info/exclude']));
  const line = `/${AWAY}/`;
  if (existsSync(exclude) && readFileSync(exclude, 'utf8').split('\n').includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `\n${line}\n`);
}

const git = args => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();

// The machine hq run says it was done on
const machineOf = output => /^hq run #\d+: done on (.+)$/m.exec(output)[1];

// The run's own command: the film its spec names, drawn in this tree
async function main(specFile) {
  const folder = dirname(resolve(specFile));
  drawn.start(folder, new Set(readFileSync(join(folder, 'files.txt'), 'utf8').split('\n')));
  await render(JSON.parse(readFileSync(specFile, 'utf8'))).catch(drawn.failed);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
