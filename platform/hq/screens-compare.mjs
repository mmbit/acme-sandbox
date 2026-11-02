#!/usr/bin/env node
// Whether a change alters what HQ shows the board, found by rendering: the board's screens (screens-shots.mjs) on the
// base's own code and on the working tree's, each its own coordinator on the same test company (screens-seed.mjs),
// compared picture for picture, with a before|after sheet for each screen that changed.
//   node platform/hq/screens-compare.mjs [--base <ref>] [--out <dir>]   (origin/main; a new folder under $TMPDIR)
// The before is where the working tree's commit left the base (their merge base), so main's newer work isn't the change's.
// A change that touches none of HQ's code or config (touchesHq) renders nothing. Its last line on stdout is one JSON
// object: {"rendered":true,"changed":[{screen,look,device,sheet}],"same":<count>,"out":<dir>}, or
// {"rendered":false,"why":<line>} for a change that can't alter a screen. Any exit but 0 means it couldn't run. A side
// that fails to seed or render counts every screen as changed, its sheet the other side's picture alone (sheet null,
// and a why, when neither side has one). Both sides shoot the looks and devices of the working tree's company/org.yaml
// (review.screens: looks, devices). Heavy runs go to the render helper:
//   hq run --kind render --minutes 30 --bring <dir> -- node platform/hq/screens-compare.mjs --out <dir>
// (dir in the checkout; on the helper the base is origin/main, and the paths printed are the helper's: under out)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { linkModules, TOOLS_HOME } from '../../shared/gates/repo.ts';
import { contactSheet } from './room-sheet.mjs';
import { playwright } from '../../shared/browser/browser.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname),
  SIDE = new URL('./screens-side.mjs', import.meta.url).pathname;
const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const BASE = arg('--base') ?? 'origin/main';
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });

const baseCommit = git('merge-base', `${BASE}^{commit}`, 'HEAD').trim();
const touched = [...git('diff', '--name-only', baseCommit).split('\n'), ...untracked()].filter(touchesHq);
if (!touched.length) {
  console.log(JSON.stringify({ rendered: false, why: `nothing HQ runs or reads differs from ${BASE}` }));
  process.exit(0);
}
// From here on in the render's own process, under this machine's browser lock (harness.mjs). Never sent on to the
// render helper by that dispatch, which brings the browser's packages but not the coordinator's: the helper runs it
// under hq run --kind render. (The sides' coordinators have no business with the real HQ either.)
delete process.env.HQ_URL;
delete process.env.HQ_TOKEN;
const { progress } = await import('./harness.mjs');
const { SCREENS } = await import('./screens-shots.mjs');
linkModules(ROOT, TOOLS_HOME, ROOT); // (a job's clone has no packages: the worker image's, as the gates link them)
const { parse } = await import('../coordinator/node_modules/yaml/dist/index.js');
const { looks, devices } = parse(readFileSync(join(ROOT, 'company/org.yaml'), 'utf8')).review?.screens ?? {};
if (!looks?.length || !devices || !Object.keys(devices).length)
  throw new Error('company/org.yaml review.screens names no looks and devices to shoot the screens in');
const OUT = resolve(arg('--out') ?? mkdtempSync(join(tmpdir(), 'screens-compare-'))),
  work = mkdtempSync(join(tmpdir(), 'screens-before-'));
const started = Date.now();
console.log(`Screens: ${touched.length} of HQ's files differ from ${BASE}, rendering both sides`);
try {
  const sides = {
    before: await renderSide('before', beforeTree(work)),
    after: await renderSide('after', ROOT),
  };
  const result = await compare(sides);
  console.log(`Screens: ${result.changed.length} changed, ${result.same} the same, in ${seconds()} s`);
  console.log(JSON.stringify(result));
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(0);

// ---------------------------------------------------------------- what can change a screen
// A coarse test, generous by design: a file HQ's server or pages could run or read (code, styles, markup, pictures,
// fonts and config in the coordinator, HQ, the shared code, the kits, the theme, and the company's settings). It only
// spares a render; the render decides.
function touchesHq(file) {
  const kind = /\.(m?[jt]s|json|css|html|svg|png|jpe?g|webp|gif|woff2?|ya?ml)$/.test(file);
  const place = /^(platform\/(coordinator|hq)|shared|kits|theme)\//.test(file) || /^company\/[^/]+\.ya?ml$/.test(file);
  return kind && place;
}
function untracked() {
  return git('ls-files', '--others', '--exclude-standard').split('\n');
}

// ---------------------------------------------------------------- the two sides
// The base's HQ, coordinator and company parts in a folder of their own, with the working tree's packages
function beforeTree(dir) {
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  const archive = execFileSync('git', ['-C', ROOT, 'archive', baseCommit, 'platform', 'shared', 'kits', 'theme'], {
    maxBuffer: 1 << 30,
  });
  execFileSync('tar', ['-x', '-C', tree], { input: archive });
  linkModules(ROOT, ROOT, tree);
  return tree;
}

// One side's screens: screens-side.mjs on that tree, in a process of its own, its log beside its pictures. A side
// that couldn't run says why, as one that failed to seed does.
async function renderSide(name, tree) {
  const shots = join(OUT, name),
    log = join(OUT, `${name}.log`);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  console.log(`Screens: the ${name} side`);
  const code = await new Promise((done, failed) => {
    const args = [SIDE, tree, shots, join(work, 'fonts'), JSON.stringify({ looks, devices })];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HQ_RENDER_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const lines = [];
    child.stdout.on('data', chunk => lines.push(chunk));
    child.stderr.on('data', chunk => lines.push(chunk));
    child.on('message', () => progress()); // (its harness steps keep the render's watch on this process)
    child.once('error', failed);
    child.once('exit', status => {
      writeFileSync(log, Buffer.concat(lines));
      done(status);
    });
  });
  const outcome = join(shots, 'side.json');
  if (!existsSync(outcome)) return { failed: `the ${name} side exited with ${code} (${log})`, shots: [], errors: [] };
  const side = JSON.parse(readFileSync(outcome, 'utf8'));
  if (side.failed) console.log(`Screens: the ${name} side failed: ${side.failed}`);
  return side;
}

// ---------------------------------------------------------------- the comparison
// Every screen the two sides should both have shot: the same picture, or a sheet of the two (no sheet, and why, when
// neither side has a picture of it)
async function compare(sides) {
  const browser = await playwright().chromium.launch();
  const changed = [];
  let same = 0;
  try {
    for (const screen of Object.keys(SCREENS))
      for (const look of looks)
        for (const device of Object.keys(devices)) {
          const key = { screen, look, device },
            [before, after] = [sides.before, sides.after].map(side => picture(side, key));
          if (before && after && before.equals(after)) {
            same++;
            continue;
          }
          if (!before && !after) {
            changed.push({ ...key, sheet: null, why: missing(sides.after, key) });
            continue;
          }
          const sheet = join(OUT, `${screen}-${look}-${device}-sheet.png`);
          writeFileSync(sheet, await sheetOf(browser, key, { before, after }, sides));
          changed.push({ ...key, sheet });
          progress();
        }
  } finally {
    await browser.close();
  }
  writeFileSync(join(OUT, 'index.md'), indexOf(changed, same, sides));
  return { rendered: true, changed, same, out: OUT };
}

function picture(side, key) {
  const shot = side.shots.find(s => s.screen === key.screen && s.look === key.look && s.device === key.device);
  return shot && readFileSync(shot.file);
}

// A screen's before|after sheet, a side that has no picture of it said in its notes
function sheetOf(browser, { screen, look, device }, pictures, sides) {
  const notes = [`Before: where it left ${BASE} (${baseCommit.slice(0, 9)}). After: the working tree.`];
  for (const [name, png] of Object.entries(pictures))
    if (!png) notes.push(`No ${name} picture: ${missing(sides[name], { screen, look, device })}`);
  const shots = Object.entries(pictures)
    .filter(([, png]) => png)
    .map(([name, png]) => ({ row: 0, column: name === 'before' ? 'Before' : 'After', png }));
  return contactSheet(browser, { title: `${screen}, ${look} on a ${device}`, notes, rows: [screen], shots });
}

// Why a side has no picture of a screen: its failure, or the screen's own error
function missing(side, { screen, look, device }) {
  if (side.failed) return side.failed;
  const where = `${screen}, ${look}, ${device}: `;
  return side.errors.find(e => e.startsWith(where))?.slice(where.length) ?? 'not shot';
}

// index.md under OUT: each changed screen's sheet and pictures, and what went wrong on each side
function indexOf(changed, same, sides) {
  const lines = [
    `# HQ's screens: ${BASE} against the working tree`,
    '',
    `${changed.length} changed, ${same} the same. Before: ${baseCommit}.`,
    '',
    ...changed.flatMap(c => [
      `- ${c.screen}, ${c.look} on a ${c.device}: ${c.sheet ?? `no picture on either side (${c.why})`}`,
      `  (before ${join(OUT, 'before', `${c.screen}-${c.look}-${c.device}.png`)},` +
        ` after ${join(OUT, 'after', `${c.screen}-${c.look}-${c.device}.png`)})`,
    ]),
  ];
  for (const [name, side] of Object.entries(sides)) {
    const problems = [...(side.failed ? [`failed: ${side.failed}`] : []), ...side.errors];
    if (problems.length) lines.push('', `## The ${name} side`, '', ...problems.map(p => `- ${p}`));
  }
  return `${lines.join('\n')}\n`;
}

function seconds() {
  return Math.round((Date.now() - started) / 1000);
}
