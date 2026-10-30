// HQ's page as the board's browser gets it, checked on the server after each deploy: infra/hq-up.sh asks GET /health/page
// from inside this container, and a page that doesn't assemble is a deploy that didn't bring HQ up (/health answers all
// the same: 27 October, a module importing a name its target no longer exported; 28 October, a redirect to a 404).
// Each look HQ ships opens in the coordinator's own Chromium, every request it makes answered from this server as the
// board's (a session made for the check and gone after it, never in the browser): GETs only, so the check changes
// nothing, and the live feed answered empty. A problem is the page's code not loading, as both times: a script or
// stylesheet refused, or a module that doesn't parse or link (a SyntaxError); one the second try doesn't see again was
// the moment's, not the page's. Other page errors and the loading veil still up after ASSEMBLED_MS are notes, for the
// deploy's log: a slow start or the data can bring those, which no revert mends.
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { launch, type Browser } from '../../../shared/chromium/chromium.ts';
import { lookNames } from '../../hq/looks.mjs';
import { ORIGIN } from './config.ts';
import { db } from './db.ts';

const ASSEMBLED_MS = 30_000;
const ANSWER_MS = 15_000;
type As = { port: number; token: string };
type Got = { status: number; type: string; body: Buffer; location?: string };

type Found = { problems: string[]; notes: string[] };

let running: Promise<{ checked: boolean } & Found> | undefined;
// (one check at a time: a second asker waits for the one under way. port: this server's, as the check was asked on it)
export const check = (port: number) =>
  (running ??= (async () => {
    try {
      const first = await inEveryLook(port);
      if (!first?.problems.length) return { checked: !!first, problems: [], notes: first?.notes ?? [] };
      const again = await inEveryLook(port);
      const problems = again?.problems.filter(p => first.problems.includes(p)) ?? [];
      return { checked: !!again, problems, notes: again?.notes ?? [] };
    } finally {
      running = undefined;
    }
  })());

// What the page shows in every look, or null when there's no Chromium here to check with
async function inEveryLook(port: number): Promise<Found | null> {
  const token = `check-${randomBytes(16).toString('hex')}`;
  db.prepare('insert into sessions (token, expires) values (?, ?)').run(token, Date.now() + 5 * 60_000);
  const browser = await launch().catch(err => (console.error('pagecheck: no Chromium:', err.message), null));
  try {
    if (!browser) return null;
    const all: Found = { problems: [], notes: [] };
    for (const look of lookNames()) {
      const found = await inLook(browser.tab, look, { port, token });
      for (const k of ['problems', 'notes'] as const) all[k].push(...found[k].map(p => `${look}: ${p}`));
    }
    return all;
  } finally {
    await browser?.close();
    db.prepare('delete from sessions where token = ?').run(token);
  }
}

async function inLook(open: Browser['tab'], look: string, as: As): Promise<Found> {
  const found: string[] = [],
    notes: string[] = [];
  const tab = await open(
    async ({ url, method }) => {
      if (method !== 'GET' || !url.startsWith(`${ORIGIN}/`)) return null;
      const path = url.slice(ORIGIN.length);
      if (path.split('?')[0] === '/api/events') return { type: 'text/event-stream', body: Buffer.alloc(0) };
      const got = await follow(path, as).catch(err => ({
        status: 0,
        type: '',
        body: Buffer.alloc(0),
        why: err.message,
      }));
      if (got.status >= 200 && got.status < 300) return { type: got.type, body: got.body };
      if (/\.(m?js|css)$/.test(path.split('?')[0]))
        found.push(`${path} refused (${got.status || (got as { why?: string }).why})`);
      return null;
    },
    (method, params) => {
      if (method !== 'Runtime.exceptionThrown') return;
      const { exception, text } = params.exceptionDetails ?? {};
      (exception?.className === 'SyntaxError' ? found : notes).push(`page error: ${exception?.description ?? text}`);
    },
  );
  try {
    await tab.send('Runtime.enable');
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.send('Page.navigate', { url: `${ORIGIN}/?renderer=${look}` });
    const by = Date.now() + ASSEMBLED_MS;
    let unveiled = false;
    // (code that didn't load is the answer already)
    while (!unveiled && !found.length && Date.now() < by) {
      await new Promise(r => setTimeout(r, 250));
      const answer = await tab
        .send('Runtime.evaluate', { expression: UNVEILED, returnByValue: true })
        .catch(() => null);
      unveiled = answer?.result?.value === true;
    }
    if (!unveiled && !found.length) notes.push(`still "Assembling the building" after ${ASSEMBLED_MS / 1000} s`);
    return { problems: [...new Set(found)], notes: [...new Set(notes)] };
  } finally {
    await tab.close();
  }
}

// A GET from this server as the board, through its redirects on HQ's own origin
async function follow(path: string, as: As, hops = 3): Promise<Got> {
  const got = await get(path, as);
  if (got.status >= 300 && got.status < 400 && got.location && hops) {
    const next = new URL(got.location, ORIGIN);
    if (next.origin === new URL(ORIGIN).origin) return follow(next.pathname + next.search, as, hops - 1);
  }
  return got;
}

const get = (path: string, { port, token }: As) =>
  new Promise<Got>((resolve, reject) => {
    const asked = request(
      { host: '127.0.0.1', port, path, headers: { host: new URL(ORIGIN).host, cookie: `s=${token}` }, agent: false },
      res => {
        const parts: Buffer[] = [];
        res.on('data', part => parts.push(part));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? 'application/octet-stream'),
            body: Buffer.concat(parts),
            location: res.headers.location,
          }),
        );
        res.on('error', reject);
      },
    );
    asked.setTimeout(ANSWER_MS, () => asked.destroy(new Error(`no answer in ${ANSWER_MS / 1000} s`)));
    asked.on('error', reject);
    asked.end();
  });

// (in the page) whether HQ's loading veil is gone: its words faded out or not on screen
const UNVEILED = `(() => {
  const shown = el => !el || (Number(getComputedStyle(el).opacity) > 0.05 && shown(el.parentElement));
  return document.readyState === 'complete' && ![...document.querySelectorAll('body *')].some(
    el => el.childElementCount === 0 && /Assembling the building/.test(el.textContent ?? '') && shown(el));
})()`;
