#!/usr/bin/env node
// Checks the run away.mjs sends to a lent machine, as it runs there: on a copy of the demo kit with no server and no
// job's token, a page asking for a file the job has and the run lacks stops it, naming that file, whatever the page does
// with its 404 meanwhile; given the file, it draws the film and leaves the note to the job. And the job's side: the film
// sent again with the file it lacked, brought back, noted and the file learned; a clip the job has only the note of
// fetched and sent the same way
//   node shared/demo/away-check.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERE } from './core.mjs';
import { sha256 } from './renders.mjs';

let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

// The demo kit and what it imports (core.mjs: shared/browser), as away.mjs sends them, in a tree of its own
const kit = tree => {
  for (const folder of ['demo', 'browser'])
    cpSync(join(HERE, '..', folder), join(tree, 'shared', folder), {
      recursive: true,
      filter: from => !/\.(mp4|wav|webm)$/.test(from),
    });
};

// A page whose look and data are files of its own: its ready waits for the data, and fails without it
const page = `<!doctype html><link rel=stylesheet href="look.css"><div id=box></div><script>
  window.ready = fetch('words.json').then((r) => r.json()).then((w) => { box.textContent = w.hello; });
  window.frame = (t) => { box.style.translate = (t * 100) + 'px 0'; };
</script>`;

// The run's side, on a copy of the kit: a page lacking its data, then given it
function runSide() {
  const tree = mkdtempSync(join(tmpdir(), 'away-check-'));
  try {
    kit(tree);
    mkdirSync(join(tree, 'scene'));
    writeFileSync(join(tree, 'scene/film.html'), page);
    writeFileSync(join(tree, 'scene/look.css'), '#box { width: 80px; height: 80px; background: #c63; }');
    const folder = join(tree, '.demo-away/one');
    mkdirSync(join(folder, 'back'), { recursive: true });
    const spec = {
      page: '/scene/film.html',
      out: '.demo-away/one/back/film.mp4',
      width: 320,
      height: 180,
      duration: 1,
      fps: 10,
    };
    writeFileSync(join(folder, 'spec.json'), JSON.stringify(spec));
    writeFileSync(join(folder, 'files.txt'), ['scene/film.html', 'scene/look.css', 'scene/words.json'].join('\n'));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tree, LANG: 'C.UTF-8' };
    const draw = () =>
      spawnSync('node', ['shared/demo/away.mjs', '.demo-away/one/spec.json'], { cwd: tree, env, encoding: 'utf8' });

    const lacking = draw();
    const missing = join(folder, 'back/missing.json');
    check(
      lacking.status === 3,
      'a run lacking a file the page asks for stops with its own code',
      `exit ${lacking.status}`,
    );
    check(
      existsSync(missing) && readFileSync(missing, 'utf8') === '["scene/words.json"]',
      'and names that file alone',
      existsSync(missing) ? readFileSync(missing, 'utf8') : 'no list',
    );
    check(!existsSync(join(folder, 'back/film.mp4')), 'and draws no film');

    rmSync(missing);
    writeFileSync(join(tree, 'scene/words.json'), '{ "hello": "hi" }');
    const whole = draw();
    check(whole.status === 0, 'given the file, the run draws the film', whole.status ? whole.stderr.slice(-400) : '');
    check(existsSync(join(folder, 'back/film.mp4')), 'which is where the spec says');
    check(!existsSync(join(folder, 'back/film.mp4.render.json')), 'with no note: the job notes it');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

// The job's side: render() in a job sends the film through hq run (a stand-in, below), learns the file the first run
// lacked, sends it with the second, and notes the film it brings back as its own
function jobSide() {
  const tree = mkdtempSync(join(tmpdir(), 'away-check-job-'));
  const bin = mkdtempSync(join(tmpdir(), 'away-check-bin-'));
  try {
    kit(tree);
    mkdirSync(join(tree, 'scene'));
    mkdirSync(join(tree, 'data'));
    writeFileSync(join(tree, 'scene/film.html'), page.replace("'words.json'", "'/data/words.json'"));
    writeFileSync(join(tree, 'scene/look.css'), '#box { width: 80px; height: 80px; background: #c63; }');
    writeFileSync(join(tree, 'data/words.json'), '{ "hello": "hi" }');
    const git = (...args) => spawnSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'tree');
    writeFileSync(join(bin, 'hq'), STAND_IN, { mode: 0o755 });
    const log = join(bin, 'sent.log');
    const film = "{ page: '/scene/film.html', out: 'scene/film.mp4', width: 320, height: 180, duration: 1, fps: 10 }";
    const script = `import { render } from './shared/demo/core.mjs'; await render({ ...${film}, recipe: ['node', 'make.mjs'] });`;
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: tmpdir(), SENT_LOG: log };
    const sent = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: tree,
      env: { ...env, HQ_URL: 'http://hq.invalid', HQ_TOKEN: 'stand-in' },
      encoding: 'utf8',
    });
    check(
      sent.status === 0,
      'a film rendered in a job comes back from its runs',
      sent.status ? sent.stderr.slice(-400) : '',
    );
    const runs = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const carried = runs.map(line => line.split(','));
    check(runs.length === 2, 'in two runs', `${runs.length}`);
    check(
      !carried[0]?.includes('data/words.json') && carried[1]?.includes('data/words.json'),
      'the second with the file the first lacked',
    );
    const note = join(tree, 'scene/film.mp4.render.json');
    check(existsSync(join(tree, 'scene/film.mp4')), 'the film is where the job asked for it');
    check(
      existsSync(note) && JSON.parse(readFileSync(note, 'utf8')).command.join(' ') === 'node make.mjs',
      'noted with its recipe',
    );
    const learned = JSON.parse(readFileSync(join(tree, '.git/demo-away.json'), 'utf8'));
    check(
      learned['scene/film.html']?.includes('data/words.json'),
      "and the page's file is learned for its next render",
    );
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

// A page playing a clip (demo.clip, /__clipinfo and /__clip) the job has only the note of, as one kept by another job:
// the run names it, the job fetches it from the worker's store and sends it with the next run
function clipSide() {
  const tree = mkdtempSync(join(tmpdir(), 'away-check-clip-'));
  const bin = mkdtempSync(join(tmpdir(), 'away-check-bin-'));
  const store = mkdtempSync(join(tmpdir(), 'away-check-store-'));
  try {
    kit(tree);
    mkdirSync(join(tree, 'scene'));
    const clip = join(tree, 'scene/real.mp4');
    const footage = [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=10:duration=1',
      '-pix_fmt',
      'yuv420p',
    ];
    execFileSync('ffmpeg', [...footage, clip]);
    const hash = sha256(clip);
    writeFileSync(`${clip}.render.json`, JSON.stringify({ sha256: hash, bytes: readFileSync(clip).length }));
    renameSync(clip, join(store, hash));
    writeFileSync(
      join(tree, 'scene/film.html'),
      `<!doctype html><img id=shot style="width:160px;height:90px"><script>
        window.frame = (t) => window.demo.clip(shot, 'real.mp4', t);
      </script>`,
    );
    const git = (...args) => spawnSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'tree');
    writeFileSync(join(bin, 'hq'), STAND_IN, { mode: 0o755 });
    const log = join(bin, 'sent.log');
    const film = "{ page: '/scene/film.html', out: 'scene/film.mp4', width: 320, height: 180, duration: 1, fps: 10 }";
    const script = `import { render } from './shared/demo/core.mjs'; await render({ ...${film}, recipe: ['node', 'make.mjs'] });`;
    const sent = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: tree,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        TMPDIR: tmpdir(),
        SENT_LOG: log,
        HQ_URL: 'http://hq.invalid',
        HQ_TOKEN: 'stand-in',
        HQ_RENDERS: store,
      },
      encoding: 'utf8',
    });
    check(
      sent.status === 0,
      'a film playing a clip the job has only the note of comes back',
      sent.status ? sent.stderr.slice(-400) : '',
    );
    const carried = (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []).map(line => line.split(','));
    check(
      carried.length === 2 && !carried[0].includes('scene/real.mp4') && carried[1].includes('scene/real.mp4'),
      'the clip fetched and sent with the second run',
      `${carried.length} runs`,
    );
    check(existsSync(clip) && sha256(clip) === hash, 'and left in the clone, as its note names it');
  } finally {
    for (const folder of [tree, bin, store]) rmSync(folder, { recursive: true, force: true });
  }
}

// hq run as a lent machine runs it: the command in a tree of what was sent alone, with no job's token, and --bring
// brought back. Each run's --with goes in the log.
const STAND_IN = `#!/usr/bin/env node
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const words = process.argv.slice(3), dashes = words.indexOf('--');
const flags = Object.fromEntries(words.slice(0, dashes).flatMap((w, i, all) => (i % 2 ? [] : [[w.slice(2), all[i + 1]]])));
appendFileSync(process.env.SENT_LOG, flags.with + '\\n');
const bundle = mkdtempSync(join(tmpdir(), 'away-check-bundle-'));
for (const path of [...flags.paths.split(','), ...flags.with.split(',')]) cpSync(path, join(bundle, path), { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() };
const ran = spawnSync(words[dashes + 1], words.slice(dashes + 2), { cwd: bundle, stdio: 'inherit', env });
cpSync(join(bundle, flags.bring), flags.bring, { recursive: true });
console.log('hq run #1: done on the stand-in');
process.exit(ran.status);
`;

runSide();
jobSide();
clipSide();
process.exitCode = failed ? 1 : 0;
