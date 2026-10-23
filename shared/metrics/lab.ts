// Core Web Vitals in the lab: a page loaded on a throttled phone, held to Google's lines (README.md).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { createSecureServer, type ServerHttp2Session } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { createGzip } from 'node:zlib';
import { playwright as findPlaywright } from '../demo/core.mjs';

// Google's "good" lines (web.dev/articles/vitals, and Lighthouse's for TBT): LCP and TBT in ms, CLS unitless
export const GOOD = { lcp: 2500, cls: 0.1, tbt: 200 };
export type Vitals = typeof GOOD;
const METRICS = Object.keys(GOOD) as (keyof Vitals)[];
// What a product's test holds a page to: the good lines, but TBT at Lighthouse's "poor" line. On a shared worker other
// jobs' work lands inside the page's tasks, and the same page's best TBT over five loads ran from about 100 to 270 ms;
// LCP and CLS hold steady. The report still reads TBT against the good line.
export const CHECKED = { ...GOOD, tbt: 600 };

// Lighthouse's mobile defaults (its config/constants.js): throughput in bytes per second for CDP
const PHONE = { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true };
const NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: (1638.4 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
};
const CPU_SLOWDOWN = 4;
// The benchmarkIndex that 4× is tuned for: Lighthouse's CPU slowdown calculator gives 4× at 1533, a high-end desktop
// (lighthouse-cpu-throttling-calculator.vercel.app, from github.com/GoogleChrome/lighthouse docs/throttling.md)
const SLOWDOWN_INDEX = 1533;
// Lighthouse's own wait for a page's load event
const LOAD_MS = 45_000;
// TBT counts until the page is quiet: QUIET_MS without a long task, or QUIET_CAP_MS after its load at the latest
const QUIET_MS = 2_000;
const QUIET_CAP_MS = 10_000;
// a check's most loads of a page, and the report's loads of each
const CHECK_LOADS = 5;
const LOADS = 3;

const playwright = loadPlaywright();
// why this machine can't run the lab, for a test's skip option, or false where it can
export const missing: string | false = !playwright
  ? "Playwright isn't installed here"
  : !existsSync(playwright.chromium.executablePath())
    ? "Playwright's Chromium isn't installed here (npx playwright install chromium)"
    : false;

// Each page on base (a path), loaded until each metric's best is within its line, at most CHECK_LOADS times. Throws with each failing
// page's best values and the lines.
export async function checkPages(base: string, paths: string[]) {
  const [browser, front] = await Promise.all([playwright.chromium.launch(), servedAsCaddyDoes(base)]);
  const failures: string[] = [];
  try {
    for (const path of paths) {
      const failure = await checkPage(browser, new URL(path, front.base).href, { ignoreHTTPSErrors: true });
      if (failure) failures.push(failure);
    }
  } finally {
    await Promise.all([browser.close(), front.close()]);
  }
  if (failures.length) throw new Error(`over the lab's lines on a throttled phone:\n${failures.join('\n')}`);
}

// Each of urls loaded LOADS times, as a Markdown table of its median values against the lines
export async function report(urls: string[]) {
  const browser = await playwright.chromium.launch();
  const rows = ['| Page | LCP | CLS | TBT |', '| --- | --- | --- | --- |'];
  try {
    for (const url of urls) rows.push(`| ${url} | ${(await reportRow(browser, url)).join(' | ')} |`);
  } finally {
    await browser.close();
  }
  return rows.join('\n');
}

async function checkPage(browser: any, url: string, options: object) {
  const path = new URL(url).pathname;
  const loads: Load[] = [];
  const best = (m: keyof Vitals) => Math.min(...loads.map(v => v[m]));
  while (loads.length < CHECK_LOADS) {
    const vitals = await load(browser, url, options);
    loads.push(vitals);
    console.log(
      `lab: ${path}: ${described(vitals)} (benchmarkIndex ${vitals.benchmarkIndex}, CPU ${vitals.cpuSlowdown.toFixed(1)}×)`,
    );
    if (METRICS.every(m => best(m) <= CHECKED[m])) return null;
  }
  const overs = METRICS.filter(m => best(m) > CHECKED[m]).map(
    m => `${m.toUpperCase()} ${shown(m, best(m))} (line ${shown(m, CHECKED[m])})`,
  );
  return `${path}: over a line at its best in ${CHECK_LOADS} loads: ${overs.join(', ')}`;
}

async function reportRow(browser: any, url: string) {
  const loads: Load[] = [];
  try {
    while (loads.length < LOADS) loads.push(await load(browser, url));
  } catch (e) {
    return [`didn't load: ${(e as Error).message.split('\n')[0]}`, '', ''];
  }
  const median = (m: keyof Vitals) => loads.map(v => v[m]).sort((a, b) => a - b)[Math.floor(LOADS / 2)];
  return METRICS.map(m => `${shown(m, median(m))} ${median(m) <= GOOD[m] ? 'ok' : 'over'} (line ${shown(m, GOOD[m])})`);
}

type Load = Vitals & { benchmarkIndex: number; cpuSlowdown: number };

// options: the context's own, past the phone's
async function load(browser: any, url: string, options = {}): Promise<Load> {
  const major = browser.version().split('.')[0];
  const userAgent = `Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
  const context = await browser.newContext({ ...PHONE, userAgent, ...options });
  try {
    const page = await context.newPage();
    // before the page's own scripts, or their long tasks go unseen
    await page.addInitScript(watch);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    const benchmarkIndex = await page.evaluate(computeBenchmarkIndex);
    const cpuSlowdown = Math.min(CPU_SLOWDOWN, Math.max(1, (CPU_SLOWDOWN * benchmarkIndex) / SLOWDOWN_INDEX));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    const response = await page.goto(url, { waitUntil: 'load', timeout: LOAD_MS });
    if (!response.ok()) throw new Error(`${url}: ${response.status()}`);
    const vitals = await page.evaluate(vitalsOnceQuiet, { quietMs: QUIET_MS, capMs: QUIET_CAP_MS });
    if (!vitals) throw new Error(`${url}: no contentful paint`);
    return { ...vitals, benchmarkIndex, cpuSlowdown };
  } finally {
    await context.close();
  }
}

// In the blank page, unthrottled: Lighthouse's benchmarkIndex (core/lib/page-functions.js computeBenchmarkIndex), the mean
// of a string-building and an array-copying loop's rounds a second, each run for 500 ms
function computeBenchmarkIndex() {
  const roundsPerSecond = (round: () => void, every: number) => {
    const start = Date.now();
    let rounds = 0;
    while (rounds % every !== 0 || Date.now() - start < 500) {
      round();
      rounds++;
    }
    return Math.round(rounds / 10 / ((Date.now() - start) / 1000));
  };
  const building = () => {
    let text = '';
    for (let j = 0; j < 10000; j++) text += 'a';
    // a string nobody reads could be optimised away, as Lighthouse's own check keeps it
    if (text.length === 1) throw new Error('never');
  };
  const a: number[] = [],
    b: number[] = [];
  for (let i = 0; i < 100000; i++) a[i] = b[i] = i;
  let copies = 0;
  const copying = () => {
    const [from, to] = copies++ % 2 === 0 ? [a, b] : [b, a];
    for (let j = 0; j < from.length; j++) to[j] = from[j];
  };
  // Lighthouse checks the clock only every 10th copy: some Intel CPUs slow down otherwise (V8 issue 10954)
  return (roundsPerSecond(building, 1) + roundsPerSecond(copying, 10)) / 2;
}

// In the page, before its scripts: its long tasks, layout shifts and LCP candidates, kept on window.__lab
function watch() {
  const lab: Record<string, any> = { observers: [] };
  for (const type of ['longtask', 'layout-shift', 'largest-contentful-paint']) {
    const entries: PerformanceEntry[] = (lab[type] = []);
    const observer = new PerformanceObserver(list => entries.push(...list.getEntries()));
    observer.observe({ type, buffered: true });
    lab.observers.push({ observer, entries });
  }
  (window as any).__lab = lab;
}

// In the page, once it's loaded: its vitals once it's quiet, or null without a contentful paint
function vitalsOnceQuiet({ quietMs, capMs }: { quietMs: number; capMs: number }) {
  const lab = (window as any).__lab;
  const loaded = performance.now();
  return new Promise<Vitals | null>(done => {
    const tick = () => {
      for (const { observer, entries } of lab.observers) entries.push(...observer.takeRecords());
      const tasks = lab.longtask;
      const lastTask = Math.max(0, ...tasks.map((t: PerformanceEntry) => t.startTime + t.duration));
      const now = performance.now();
      if (now - Math.max(loaded, lastTask) < quietMs && now - loaded < capMs) return void setTimeout(tick, 100);
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
      const lcp = lab['largest-contentful-paint'].at(-1)?.startTime;
      if (fcp === undefined || lcp === undefined) return done(null);
      // Lighthouse's blocking time: a long task clipped to after the first paint, less its first 50 ms
      const blocking = (t: PerformanceEntry) => Math.max(0, t.startTime + t.duration - Math.max(t.startTime, fcp) - 50);
      const tbt = tasks.reduce((sum: number, t: PerformanceEntry) => sum + blocking(t), 0);
      done({ lcp, cls: largestShiftWindow(lab['layout-shift']), tbt });
    };
    // web.dev's CLS: the largest burst of shifts not caused by input, each less than 1 s after the last, within 5 s
    const largestShiftWindow = (shifts: any[]) => {
      let largest = 0;
      let burst = { start: 0, last: 0, sum: 0 };
      for (const shift of shifts.filter(s => !s.hadRecentInput)) {
        const joins = burst.sum > 0 && shift.startTime - burst.last < 1000 && shift.startTime - burst.start < 5000;
        burst = joins
          ? { ...burst, last: shift.startTime, sum: burst.sum + shift.value }
          : { start: shift.startTime, last: shift.startTime, sum: shift.value };
        largest = Math.max(largest, burst.sum);
      }
      return largest;
    };
    tick();
  });
}

const described = (v: Vitals) => METRICS.map(m => `${m} ${shown(m, v[m])}`).join(', ');
const shown = (metric: keyof Vitals, value: number) =>
  metric === 'cls' ? value.toFixed(3) : `${Math.round(value).toLocaleString('en')} ms`;

// What Caddy's `encode gzip` compresses (its defaults, above 512 bytes), on every public host (infra/Caddyfile)
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|xhtml\+xml|manifest\+json|wasm)|image\/svg\+xml)/;
const COMPRESS_FROM_BYTES = 512;
// What HTTP/2 doesn't carry (RFC 9113 8.2.2): an HTTP/1.1 answer's own connection headers
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'];

// An app's own server as its public host serves it: over HTTP/2 with TLS, its text compressed. On a slow phone network
// an uncompressed stylesheet holds up the first paint by seconds that no visitor waits, and over HTTP/1.1 the browser
// keeps six requests in flight where Caddy's HTTP/2 starts them all at once: the throttle shares the bandwidth among
// what's in flight, so the stylesheet that holds the first paint gets less of it. Its certificate is a throwaway, the browser told to accept it.
async function servedAsCaddyDoes(base: string) {
  const target = new URL(base);
  // key and certificate in one PEM: each reader takes its own block
  const pem = execFileSync(
    'openssl',
    'req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=lab -keyout -'.split(' '),
  );
  const proxy = createSecureServer({ key: pem, cert: pem }, (req, res) => {
    // HTTP/2's own :method, :path and the like stay here, :authority becomes the host
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !name.startsWith(':')));
    const options = {
      host: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: { ...headers, host: req.authority },
    };
    const upstream = request(options, answer => {
      const { 'content-length': length, ...rest } = answer.headers;
      for (const name of HOP_BY_HOP) delete rest[name];
      const zip =
        COMPRESSIBLE.test(rest['content-type'] ?? '') &&
        !rest['content-encoding'] &&
        Number(length ?? Infinity) >= COMPRESS_FROM_BYTES &&
        /\bgzip\b/.test(String(req.headers['accept-encoding']));
      if (zip) {
        res.writeHead(answer.statusCode!, { ...rest, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
        answer.pipe(createGzip()).pipe(res);
      } else {
        res.writeHead(answer.statusCode!, length === undefined ? rest : { ...rest, 'content-length': length });
        answer.pipe(res);
      }
      // the browser can drop a stream mid-answer (a navigation, a closed context)
      res.on('close', () => answer.destroy());
    });
    upstream.on('error', e => res.writeHead(502).end(`${target.host}: ${e.message}`));
    req.pipe(upstream);
  });
  const sessions = new Set<ServerHttp2Session>();
  proxy.on('session', session => sessions.add(session.on('close', () => sessions.delete(session))));
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done));
  const { port } = proxy.address() as AddressInfo;
  const close = () =>
    new Promise(done => {
      proxy.close(done);
      for (const session of sessions) session.destroy();
    });
  return { base: `https://127.0.0.1:${port}`, close };
}

function loadPlaywright(): any {
  try {
    return findPlaywright();
  } catch {
    /* not installed: the tests skip and say so */
    return null;
  }
}

if (import.meta.main) {
  if (missing) throw new Error(missing);
  console.log(await report(process.argv.slice(2)));
}
