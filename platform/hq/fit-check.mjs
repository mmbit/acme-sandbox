#!/usr/bin/env node
// HQ measured for fit where the board looks: in dev mode, in each look the company names (org.yaml review.screens.looks),
// at each of the board's own screens (company/screens.json, its colour scheme too; without one, the generic set of
// shared/browser/screens.mjs), on each of HQ's screens and the notebook beside it at every width the board can drag it
// to. A finding is text running into another element, text cut off with no ellipsis, a line of text under another part
// of its tile, text or a control past the screen's side or under its safe areas (shared/browser/fit.mjs), text drawn
// far bigger or smaller on one screen than on the others, or a case that didn't settle within its budget. Each comes
// with a crop round it in --out; the last line out is { cases, findings, seconds } as JSON, and the check fails on any
// finding.
//   node platform/hq/fit-check.mjs [--out <folder>] [--budget <s>] [--only <words in a case's name>] [--shots] [--again | --touched]
//     [--browsers <n>]
// --browsers: how many browsers measure cases side by side (3: the render helper's cores; 1 here on the worker)
// --out keeps what each case ran (touched.json, shared/browser/touched.mjs), and --again measures only the cases a
// change since then touches, the others kept as they were measured; --touched only lists those cases, here in a
// second with no browser, so --again goes to the helper only when something's touched. On the helper the record goes along with --with,
// from the second run on (git can't add a file that isn't there yet): hq run ... --with .data/fit/touched.json ... --again
// Heavy: run it on the render helper, hq run --kind render --minutes 20 --bring .data/fit -- node
// platform/hq/fit-check.mjs --out .data/fit
import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { casesOf, keep, keptFontsOf, runCase } from './fitcases.mjs';
import { ROOT, mocks, serve, servedFiles } from './serve.mjs';
import { playwright } from '../../shared/browser/browser.mjs';
import { listTouched, recordIn, watch } from '../../shared/browser/touched.mjs';
import { SCREENS_FILE, screensIn } from '../../shared/browser/screens.mjs';

// A text drawn more than high times its usual size on a case, or less than low times it, is out of scale: its median
// over every case of its look. The board's type steps from a phone to a desktop stay inside them (1.3x at most).
const SCALE = { high: 1.35, low: 0.75 };
const args = process.argv.slice(2),
  option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
// (--budget: the slowest case on the render helper took 4.8 s with three browsers side by side, the monitor's notebook
// paging through every chapter; 20 s is four times that, for a helper busy with others' work)
const OUT = option('--out', '/tmp/hq-fit'),
  BUDGET_MS = Number(option('--budget', 20)) * 1000,
  ONLY = option('--only', ''),
  SHOTS = args.includes('--shots'),
  BROWSERS = Number(option('--browsers', 3)),
  AGAIN = args.includes('--again');

const started = Date.now();
const { parse } = await import('../coordinator/node_modules/yaml/dist/index.js');
const looks = parse(readFileSync(join(ROOT, 'company/org.yaml'), 'utf8')).review?.screens?.looks ?? [];
const screens = screensIn(join(ROOT, SCREENS_FILE));
if (!looks.length) throw new Error('company/org.yaml review.screens names no looks to measure HQ in');
mkdirSync(OUT, { recursive: true });
const fonts = keptFontsOf(join(ROOT, 'kits'), join(OUT, '.fonts'));
// (what the check reads itself, the fonts it lays HQ out in among them, touches every case as its code does: the
// screens file too when there's none, so adding one later touches them all)
const record = recordIn(OUT, import.meta.url, [
  'company/org.yaml',
  SCREENS_FILE,
  ...[...fonts.kept.values()].map(file => relative(ROOT, file)),
]);
// --touched: the recorded cases a change since touches, read here in a second, with no server or browser: none, and
// there's nothing to run again (a new case comes with a change to this check's code, which touches every case)
if (args.includes('--touched')) {
  const chosen = record.names().filter(name => name.includes(ONLY));
  listTouched(record, chosen, { check: 'fit-check', noun: ['case', 'cases'], out: OUT, only: ONLY });
  process.exit(0);
}

const cases = casesOf(looks, screens).filter(c => c.name.includes(ONLY));
const { files, sources } = await mocks(),
  server = await serve(undefined, 0, files),
  base = `http://127.0.0.1:${server.address().port}`,
  // (each browser with what its cases ran: touched.mjs follows one case at a time per browser)
  lanes = await Promise.all(
    Array.from({ length: Math.max(1, Math.min(BROWSERS, cases.length)) }, async () => {
      const browser = await playwright().chromium.launch();
      return { browser, watcher: watch(browser, url => servedFiles(url, sources)) };
    }),
  );
const results = await runAll(cases, () => ({ shots: SHOTS }), { recorded: true });
record.write();
await judgeScale(cases, results);
await Promise.all(lanes.map(({ browser }) => browser.close()));
server.close();
keep(OUT, results);
report(cases, results);

// Every case, the lanes' browsers taking the next as each is free, within BUDGET_MS, its crops in OUT: { [case name]:
// its result }. optionsOf: a case → what else its run takes (runCase's shots, judge). recorded: the run that keeps
// what each case ran, and with --again keeps a case no change since touches as it was measured then
async function runAll(list, optionsOf, { recorded = false } = {}) {
  const results = {},
    waiting = [...list];
  const lane = async ({ browser, watcher }) => {
    const abandon = () => watcher.abandon();
    for (let c = waiting.shift(); c; c = waiting.shift()) {
      if (recorded && AGAIN && !record.touches(c.name)) {
        results[c.name] = record.kept(c.name);
        console.log(`${c.name}: kept, untouched since the last run`);
        continue;
      }
      watcher.begin();
      results[c.name] = await runCase({ browser, base, fonts, abandon }, c, {
        budgetMs: BUDGET_MS,
        out: OUT,
        ...optionsOf(c),
      });
      const files = await watcher.end();
      if (recorded && files) record.save(c.name, results[c.name], files);
    }
  };
  await Promise.all(lanes.map(lane));
  return results;
}

// The texts drawn out of scale on a case against the others, run again for their crops
async function judgeScale(list, results) {
  const outliers = outliersOf(list, results);
  if (!outliers.size) return;
  const again = list.filter(c => outliers.has(c.name));
  const scaled = await runAll(again, c => ({ judge: sizes => scaleFindings(outliers.get(c.name), sizes) }));
  // (its scale findings, and what stopped the run again if anything did)
  const kept = new Set(['scale', 'error', 'stalled']);
  for (const c of again) results[c.name].findings.push(...scaled[c.name].findings.filter(f => kept.has(f.kind)));
}

// { case name → [{ key, px, usual, text }] }: per look and text key, each case's size (its instances' median) against
// the median over every case it's on
function outliersOf(list, results) {
  const byKey = new Map();
  for (const c of list)
    for (const [key, sizes] of Map.groupBy(results[c.name].sizes, s => s.key)) {
      const id = `${c.look}|${key}`;
      if (!byKey.has(id)) byKey.set(id, []);
      byKey.get(id).push({ name: c.name, key, px: median(sizes.map(s => s.px)), text: sizes[0].text });
    }
  const outliers = new Map();
  for (const drawn of byKey.values()) {
    if (drawn.length < 3) continue;
    const usual = median(drawn.map(d => d.px));
    for (const d of drawn.filter(d => d.px > usual * SCALE.high || d.px < usual * SCALE.low)) {
      if (!outliers.has(d.name)) outliers.set(d.name, []);
      outliers.get(d.name).push({ ...d, usual });
    }
  }
  return outliers;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The texts out of scale among sizes (one page's measure), a finding for each scale they're drawn at (the texts of a
// page drawn bigger together are one fault), round them on this run
function scaleFindings(outliers, sizes) {
  const here = outliers.filter(o => sizes.some(s => s.key === o.key));
  return [...Map.groupBy(here, o => Math.round((o.px / o.usual) * 10) / 10)].map(([times, texts]) => {
    const [{ text, px, usual }] = texts,
      more = texts.length > 1 ? ` and ${texts.length - 1} more texts with it` : '';
    return {
      kind: 'scale',
      of: `${times}x ${texts[0].key}`,
      line: `"${text}" drawn ${Math.round(px)} px here, ${Math.round(usual)} px on the others (${times}x)${more}`,
      box: union(texts.map(t => sizes.find(s => s.key === t.key).box)),
    };
  });
}
function union(boxes) {
  const x = Math.min(...boxes.map(b => b.x)),
    y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}

// Each case with findings and its lines, then the run as one line of JSON; a finding fails the check. A fault seen on
// several of HQ's screens at one look and screen (a tile on every screen over home) is told once, at its first case.
function report(list, results) {
  const first = new Map();
  for (const c of list)
    for (const f of results[c.name].findings) {
      const fault = `${c.look}|${c.screen.name}|${f.kind}|${f.of ?? f.line}`;
      if (first.has(fault)) first.get(fault).also++;
      else first.set(fault, { case: c.name, ...f, also: 0 });
    }
  const findings = [...first.values()];
  for (const [name, own] of Map.groupBy(findings, f => f.case)) {
    console.log(`${name} (${results[name].seconds} s):`);
    for (const f of own)
      console.log(
        `  ${f.kind}: ${f.line}${f.also ? ` (and in ${f.also} more cases)` : ''}${f.crop ? ` [${f.crop}]` : ''}`,
      );
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${list.length} cases in ${seconds} s, ${findings.length} findings; crops in ${OUT}`);
  const listed = findings.map(({ case: name, kind, line, crop, also }) => ({ case: name, kind, line, crop, also }));
  console.log(JSON.stringify({ cases: list.length, findings: listed, seconds }));
  process.exitCode = findings.length ? 1 : 0;
}
