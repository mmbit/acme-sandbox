// node --test shared/metrics/visitors.test.ts   (visitors and visits, with the switch on, in a throwaway data folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'metrics-visitors-'));
// live and switched on, with no HQ address: nothing is sent
Object.assign(process.env, {
  METRICS_MODE: 'live',
  METRICS_VISITORS: '1',
  DATA_DIR: DATA,
  METRICS_TIME_ZONE: 'Europe/Amsterdam',
});
delete process.env.METRICS_URL;
const { visitors, MOST_HASHES } = await import('./visitors.ts');
const { metrics, day } = await import('./metrics.ts');

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
const from = (ip: string, ua = PHONE, more: Record<string, string> = {}) => ({
  'x-forwarded-for': ip,
  'user-agent': ua,
  ...more,
});
const noon = new Date(`${day()}T12:00:00+02:00`).getTime(),
  MIN = 60_000;

test('one address and browser is one visitor a day; a new visit after 30 minutes without a page load', () => {
  const file = join(DATA, 'one.json');
  const seen = visitors({ file, day });
  assert.deepEqual(seen.see(from('203.0.113.7'), noon), { visitor: true, visit: true });
  assert.deepEqual(seen.see(from('203.0.113.7'), noon + 29 * MIN), { visitor: false, visit: false });
  // the 30 minutes run from the last page load, not the first
  assert.deepEqual(seen.see(from('203.0.113.7'), noon + 58 * MIN), { visitor: false, visit: false });
  assert.deepEqual(seen.see(from('203.0.113.7'), noon + 89 * MIN), { visitor: false, visit: true });
  // another browser on the same address, or the same browser on another address, is someone else
  assert.deepEqual(seen.see(from('203.0.113.7', 'Mozilla/5.0 (Windows NT 10.0)'), noon + 90 * MIN), {
    visitor: true,
    visit: true,
  });
  assert.deepEqual(seen.see(from('2001:db8::5'), noon + 90 * MIN), { visitor: true, visit: true });
  // Caddy's own entry is the last
  assert.deepEqual(seen.see(from('198.51.100.1, 203.0.113.7'), noon + 91 * MIN), { visitor: false, visit: false });
  seen.save();
  // the file holds the day, its salt and hashes with times: no address, no browser, only the app may read it
  const kept = readFileSync(file, 'utf8');
  for (const s of ['203.0.113', '2001:db8', 'iPhone', 'Windows']) assert.ok(!kept.includes(s), s);
  assert.equal(Object.keys(JSON.parse(kept).seen).length, 3);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a restart keeps the day's visitors; at the Dutch midnight the salt and the list are replaced", () => {
  const file = join(DATA, 'two.json');
  const first = visitors({ file, day });
  first.see(from('203.0.113.8'), noon);
  first.save();
  const salt = JSON.parse(readFileSync(file, 'utf8')).salt;
  assert.deepEqual(visitors({ file, day }).see(from('203.0.113.8'), noon + MIN), { visitor: false, visit: false });
  const tomorrow = new Date(`${day()}T23:59:00+02:00`).getTime() + 2 * 60 * MIN;
  const again = visitors({ file, day });
  assert.deepEqual(again.see(from('203.0.113.8'), tomorrow), { visitor: true, visit: true });
  const next = JSON.parse(readFileSync(file, 'utf8'));
  assert.notEqual(next.salt, salt);
  assert.equal(next.day, day(tomorrow));
  assert.deepEqual(next.seen, {});
});

test("a live page load counts a visitor and a visit with its source; never our own, the door's, a crawler's or a prefetch", () => {
  metrics.setup({ file: { steps: [{ id: 'page' }] }, label: v => (v === 'meta-open-shop' ? v : null) });
  const load = (headers: Record<string, string>, path = '/?c=meta-open-shop') =>
    metrics.serve({ headers }, () => metrics.page(new URL(path, 'http://x')));
  load(from('192.0.2.10'));
  load(from('192.0.2.10'), '/next');
  load(from('192.0.2.11'), '/');
  load(from('192.0.2.12', PHONE, { 'x-own-device': '1' }));
  load(from('192.0.2.13', PHONE, { 'x-preview-door': '1' }));
  load(from('192.0.2.14', 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'));
  load(from('192.0.2.15', PHONE, { 'x-purpose': 'preview' }));
  const n = (step: string, campaign: string) =>
    metrics.snapshot().find(c => c.step === step && c.campaign === campaign && c.day === day())?.n ?? 0;
  // the crawler's and the prefetch count only by where they came from; ours and the door's nothing
  assert.equal(n('page', 'meta-open-shop'), 1);
  assert.deepEqual([n('load', 'none'), n('load', 'agent-gptbot'), n('load', 'prefetch')], [3, 1, 1]);
  assert.equal(n('page', ''), 2);
  assert.deepEqual([n('visitor', 'meta-open-shop'), n('visit', 'meta-open-shop')], [1, 1]);
  assert.deepEqual([n('visitor', ''), n('visit', '')], [1, 1]);
  // an app with counts of its own asks visit()
  assert.equal(metrics.visit({ headers: from('192.0.2.12', PHONE, { 'x-own-device': '1' }) }), null);
  assert.deepEqual(metrics.visit({ headers: from('192.0.2.10') }), { visitor: false, visit: false });
});

// A run of the kit in a process of its own, with these settings and DATA_DIR: its script's output, and how it ended
const METRICS = JSON.stringify(new URL('./metrics.ts', import.meta.url).href);
const run = (env: Record<string, string>, script: string) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const { metrics } = await import(${METRICS});\n${script}`],
    {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    },
  );

test("with the switch off, or off the live site, nothing is hashed, visit() is null and an earlier run's list goes", () => {
  const settings: Record<string, string>[] = [
    { METRICS_MODE: 'live' },
    { METRICS_MODE: 'preview', METRICS_VISITORS: '1' },
  ];
  for (const env of settings) {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-visitors-off-'));
    for (const f of ['visitors.json', 'visitors.json.new'])
      writeFileSync(join(dir, f), '{"day":"2026-10-19","salt":"s"}');
    const r = run(
      { DATA_DIR: dir, ...env },
      `console.log(JSON.stringify(metrics.visit({ headers: { 'x-forwarded-for': '192.0.2.1', 'user-agent': 'Mozilla/5.0' } })));`,
    );
    assert.equal(r.stdout.trim(), 'null', r.stderr);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test("a stop saves the day's list and ends the process, in an app that counts without setup() (the shop's front)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-visitors-stop-'));
  const r = run(
    { DATA_DIR: dir, METRICS_MODE: 'live', METRICS_VISITORS: '1' },
    `metrics.visit({ headers: { 'x-forwarded-for': '192.0.2.1', 'user-agent': 'Mozilla/5.0' } });
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => console.log('still running'), 10_000);`,
  );
  assert.equal(r.signal, 'SIGTERM', r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, 'visitors.json'), 'utf8')).seen).length, 1);
});

test("a day's list at its most counts no one new and says so once; a damaged file is an error, not an empty day", () => {
  const file = join(DATA, 'full.json');
  const seen = visitors({ file, day });
  for (let i = 0; i < MOST_HASHES; i++) seen.see(from(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`), noon);
  const said: string[] = [];
  const error = console.error;
  console.error = (...words: unknown[]) => said.push(words.join(' '));
  try {
    assert.deepEqual(seen.see(from('203.0.113.99'), noon), { visitor: false, visit: false });
    assert.deepEqual(seen.see(from('203.0.113.98'), noon), { visitor: false, visit: false });
  } finally {
    console.error = error;
  }
  assert.equal(said.length, 1);
  assert.match(said[0], /new visitors uncounted today/);
  // someone already on the list still counts
  assert.deepEqual(seen.see(from('10.0.0.0'), noon + 31 * MIN), { visitor: false, visit: true });
  writeFileSync(join(DATA, 'damaged.json'), '{"day":');
  assert.throws(() => visitors({ file: join(DATA, 'damaged.json'), day }), SyntaxError);
});
