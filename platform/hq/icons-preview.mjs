#!/usr/bin/env node
// Preview HQ's icons and skins in every look beside a git ref, using the real shell and icon loader.
// node platform/hq/icons-preview.mjs [--ref origin/main] [--out <dir>] [--record <file>]
// The index lists every before/after pair. The record leaves one judgment per look for the author to fill in.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { lookNames } from './looks.mjs';
import { pin, track, settle, progress } from './harness.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { contactSheet } from './room-sheet.mjs';

const { parse } = await import('../coordinator/node_modules/yaml/dist/index.js');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const ref = process.argv.includes('--ref') ? option('--ref') : 'origin/main';
const out = process.argv.includes('--out') ? resolve(option('--out')) : await mkdtemp(join(tmpdir(), 'icons-preview-'));
const record = process.argv.includes('--record') && resolve(option('--record'));
const git = (...args) => promisify(execFile)('git', ['-C', ROOT, ...args], { maxBuffer: 1 << 26 });
const source = process.env.HQ_RENDER_SOURCE && JSON.parse(process.env.HQ_RENDER_SOURCE);
const baseline = (await git('rev-parse', '--verify', `${ref}^{commit}`)).stdout.trim();
const current = path => readFile(join(ROOT, path));
const previousFiles = new Map();
const previous = path => {
  if (!previousFiles.has(path)) {
    const bytes = promisify(execFile)('git', ['-C', ROOT, 'show', `${baseline}:${path}`], {
      encoding: 'buffer',
      maxBuffer: 1 << 26,
    }).then(answer => answer.stdout);
    previousFiles.set(path, bytes);
  }
  return previousFiles.get(path);
};
const looks = lookNames();
const inventory = await iconNames();
const names = [...new Set([...inventory.before, ...inventory.after])].sort();
const pairs = [];
const problems = [];
const changes = [];
await mkdir(out, { recursive: true });
const browser = await playwright().chromium.launch({ args: ['--font-render-hinting=none'] });
try {
  for (const look of looks) await previewLook(look);
  await writeOutputs();
} finally {
  await browser.close();
}

// Canonical HQ names from both trees include additions and removals. Kit aliases resolve through the real loader.
async function iconNames() {
  const files = [
    (await git('ls-tree', '-r', '--name-only', baseline, 'platform/hq/icons')).stdout,
    (await git('ls-files', '-co', '--exclude-standard', 'platform/hq/icons')).stdout,
  ];
  const removed = new Set((await git('ls-files', '--deleted', 'platform/hq/icons')).stdout.split('\n'));
  const namesOf = paths =>
    paths
      .split('\n')
      .filter(path => path.endsWith('.svg') && !removed.has(path))
      .map(path => path.split('/').at(-1).slice(0, -4));
  const before = files[0]
    .split('\n')
    .filter(path => path.endsWith('.svg'))
    .map(path => path.split('/').at(-1).slice(0, -4));
  const after = namesOf(files[1]);
  assert.ok(before.length && after.length, 'HQ has icons to preview on both sides');
  return { before: [...new Set(before)].sort(), after: [...new Set(after)].sort() };
}

async function previewLook(look) {
  const shots = [];
  const servers = [];
  try {
    for (const [side, read] of [
      ['before', previous],
      ['after', current],
    ]) {
      // Mock content stays shared. The theme chooses icon kits and styles, so it belongs to each side's tree.
      const shared = path => path.includes('/mock/') && !path.endsWith('/mock/brand.json');
      const brand = JSON.parse(await read('theme/hq/mock/brand.json'));
      brand.theme = parse((await read('theme/hq.yaml')).toString());
      const server = await serve(path => (shared(path) ? current(path) : read(path)), 0, {
        'mock/brand.json': JSON.stringify(brand),
      });
      servers.push({ side, server, base: `http://localhost:${server.address().port}` });
    }
    for (const [device, viewport] of [
      ['phone', { width: 390, height: 844 }],
      ['tablet', { width: 1180, height: 820 }],
    ])
      await captureDevice(look, device, viewport, servers, shots);
  } finally {
    for (const { server } of servers)
      await new Promise((done, fail) => server.close(error => (error ? fail(error) : done())));
  }
  const change = lookChanges(look);
  changes.push(change);
  const rows = [...new Set(shots.map(shot => shot.row))];
  const sheet = join(out, `${look}.png`);
  await writeFile(
    sheet,
    await contactSheet(browser, {
      title: look,
      notes: [
        ref,
        'Before on the left, working tree on the right',
        ...changeNotes(change),
        ...(problems.some(problem => problem.look === look) ? ['Missing drawings or page errors: see index.md'] : []),
      ],
      rows,
      shots: shots.map(shot => ({ ...shot, row: rows.indexOf(shot.row) })),
    }),
  );
  console.log(sheet);
}

async function captureDevice(look, device, viewport, servers, shots) {
  const pages = [];
  try {
    for (const { side, base } of servers) {
      const opened = await openCapture(viewport);
      pages.push({ ...opened, side });
      Object.assign(pages.at(-1), await capture(opened, base, look, side));
      const errors = [...new Set([...opened.errors, ...pages.at(-1).missing])];
      problems.push(...errors.map(error => ({ look, side, device, error })));
    }
    const [before, after] = pages;
    const changedIcons = names.filter(name => before.drawings[name] !== after.drawings[name]);
    for (const { page, captures } of pages) {
      await page.$$eval(
        '#icon-catalogue > div',
        (cells, changed) => {
          for (const cell of cells)
            if (changed.includes(cell.dataset.name)) cell.firstElementChild.append(' (changed)');
        },
        changedIcons,
      );
      await settle(page);
      captures.push(['icons', await page.screenshot({ fullPage: true, animations: 'disabled' })]);
    }
    for (let i = 0; i < before.captures.length; i++) {
      const [screen, png] = before.captures[i];
      // Styles redraw icons without changing their markup, so the catalogue's pixels count too.
      const changed = (screen === 'icons' && changedIcons.length > 0) || !png.equals(after.captures[i][1]);
      const pair = { look, device, screen, changed, icons: screen === 'icons' ? changedIcons : [] };
      for (const { side, captures } of pages) {
        const file = `${look}-${device}-${screen}-${side}.png`;
        await writeFile(join(out, file), captures[i][1]);
        pair[side] = file;
        shots.push({ row: `${device}: ${screen}`, column: side, png: captures[i][1] });
      }
      pairs.push(pair);
    }
  } finally {
    for (const { context } of pages) await context.close();
  }
}

async function openCapture(viewport) {
  const opened = await openPage(browser, { viewport });
  // Pin generic fonts before layout, so capture cannot replace them after it measures the page.
  const fonts = await opened.context.newCDPSession(opened.page);
  const fontFamilies = {
    standard: 'Liberation Serif',
    fixed: 'Liberation Mono',
    serif: 'Liberation Serif',
    sansSerif: 'Liberation Sans',
  };
  await fonts.send('Page.setFontFamilies', { fontFamilies, forScripts: [{ script: 'Latn', fontFamilies }] });
  return opened;
}

async function capture({ context, page }, base, look, side) {
  progress();
  track(page);
  await pin(context, Date.parse('2026-06-15T12:00:00Z'));
  await page.goto(`${base}/?intro=0&renderer=${look}&date=2026-06-15&hour=12`);
  await until(page, '#loading.gone');
  await page.evaluate(() => import('/shell/stage.js').then(stage => stage.pause(true)));
  const captures = [];
  const missing = new Set();
  for (const screen of ['projects', 'home', 'icons']) {
    if (screen === 'projects')
      await page.evaluate(() => import('/shell/projects.js').then(shell => shell.openProjects()));
    if (screen === 'home') await page.evaluate(() => import('/shell/desk.js').then(shell => shell.openComputer()));
    if (screen === 'icons') await page.evaluate(catalogue, { names, available: inventory[side] });
    for (const name of await ready(page)) missing.add(`Undrawn icon: ${name}`);
    if (screen !== 'icons') {
      await page.evaluate(() => import('/shell/stage.js').then(stage => stage.frame(2)));
      captures.push([screen, await page.screenshot({ animations: 'disabled' })]);
    }
  }
  const drawings = await page.$$eval('#icon-catalogue > div', cells =>
    Object.fromEntries(
      cells.map(cell => [cell.dataset.name, [...cell.querySelectorAll('svg')].map(svg => svg.outerHTML).join('')]),
    ),
  );
  return { captures, drawings, missing: [...missing] };
}

function lookChanges(look) {
  const changed = pairs.filter(pair => pair.look === look && pair.changed);
  const icons = [...new Set(changed.flatMap(pair => pair.icons))].sort();
  const screens = [...new Set(changed.filter(pair => pair.screen !== 'icons').map(pair => pair.screen))];
  const catalogue = !icons.length && changed.some(pair => pair.screen === 'icons') ? ['icon catalogue'] : [];
  const labels = [
    ...icons,
    ...catalogue,
    ...screens.map(screen => `${screen === 'home' ? 'computer' : screen} screen`),
  ];
  return { look, icons, screens, summary: labels.length ? `changed: ${labels.join(', ')}` : 'unchanged' };
}

function changeNotes(change) {
  const lines = [''];
  for (const word of change.summary.split(' ')) {
    if (lines.at(-1).length + word.length > 100) lines.push(word);
    else lines[lines.length - 1] += `${lines.at(-1) ? ' ' : ''}${word}`;
  }
  return lines;
}

async function ready(page) {
  await page.clock.runFor(1000);
  await settle(page);
  return page.$$eval('svg[data-icon]:not([data-drawn])', icons =>
    icons.map(icon => {
      icon.style.outline = '2px solid currentColor';
      icon.setAttribute('aria-label', `Missing: ${icon.dataset.icon}`);
      const cell = icon.closest('#icon-catalogue > div');
      if (cell && !cell.dataset.missing) {
        cell.dataset.missing = 'true';
        cell.firstElementChild.append(' (missing)');
      }
      return icon.dataset.icon;
    }),
  );
}

// A labelled catalogue, styled by the look on stage. Each name is shown at the shell's small and app icon sizes.
async function catalogue({ names, available }) {
  const { icon } = await import('/shell/icons.js');
  document.querySelector('#tool').hidden = true;
  document.querySelector('#projects').hidden = true;
  const framing = document.createElement('style');
  framing.textContent =
    'html, body { height: auto !important; overflow: visible !important; } body > :not(#icon-catalogue) { display: none !important; }';
  document.head.append(framing);
  const catalogue = document.createElement('section');
  catalogue.id = 'icon-catalogue';
  Object.assign(catalogue.style, {
    position: 'relative',
    zIndex: '10000',
    top: '0',
    left: '0',
    width: '100%',
    padding: '16px',
    boxSizing: 'border-box',
    background: 'var(--cream)',
    color: 'var(--ink)',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
  });
  for (const name of names) {
    const cell = document.createElement('div');
    cell.dataset.name = name;
    const label = document.createElement('div');
    label.textContent = name;
    cell.append(label);
    if (!available.includes(name)) label.append(' (absent)');
    for (const size of available.includes(name) ? [20, 30] : []) {
      const drawing = document.createElement('span');
      drawing.innerHTML = icon(name);
      Object.assign(drawing.firstElementChild.style, { width: `${size}px`, height: `${size}px`, margin: '8px' });
      cell.append(drawing);
    }
    catalogue.append(cell);
  }
  document.body.append(catalogue);
}

async function writeOutputs() {
  const branch = source?.branch ?? (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  const commit = source?.commit ?? (await git('rev-parse', 'HEAD')).stdout.trim();
  const manifest = {
    ref: source?.ref ?? ref,
    baseline,
    branch,
    commit,
    icons: inventory,
    looks,
    changes,
    pairs,
    problems,
  };
  await writeFile(join(out, 'index.json'), JSON.stringify(manifest, null, 2));
  const lines = [
    '# Icon and skin previews',
    '',
    `Baseline: ${manifest.ref} (${baseline}). Working tree: ${branch} (${commit}, including uncommitted changes).`,
    '',
    ...changes.map(change => `- ${change.look}: ${change.summary}. Sheet: ${join(out, `${change.look}.png`)}`),
    '',
    ...pairs.map(
      pair =>
        `- ${pair.look}, ${pair.device}, ${pair.screen}: before ${join(out, pair.before)}; after ${join(out, pair.after)}`,
    ),
    '',
    '## Drawing and page errors',
    '',
    ...(problems.length
      ? problems.map(problem => `- ${problem.look}, ${problem.device}, ${problem.side}: ${problem.error}`)
      : ['None.']),
    '',
    '## What I saw',
    '',
    ...looks.map(look => `- ${look}: `),
    '',
  ];
  await writeFile(join(out, 'index.md'), lines.join('\n'));
  if (record) {
    await mkdir(dirname(record), { recursive: true });
    await writeFile(record, lines.join('\n'));
  }
  console.log(`Open every sheet and compare each look against ${manifest.ref}. Record a judgment for every look.`);
  console.log(`Every pair is listed in ${join(out, 'index.md')}`);
}
