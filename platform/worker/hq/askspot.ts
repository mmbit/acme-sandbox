// hq ask's --at <address> --spot <selector>: the work a design ask is about, opened in the job's own Chromium with the
// thing in the middle of the screen, shot, and anchored as review mode anchors a mark (shared/review/anchor.js, which
// HQ serves at /__review/anchor.js), for the coordinator to ring and keep as the ask's scrap (coordinator/src/ink/askspot.ts).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as api from './api.ts';
import { stop } from './output.ts';

// The screen it's shot on: a laptop's at 1.5 device px a CSS px, so the shot (1920 × 1200) keeps under the 2000 px a
// scrap's picture may have on its long side (coordinator pagescraps.ts tooBig)
const VIEW = { width: 1280, height: 800 },
  DPR = 1.5;
// A preview's host is <slug>.preview.<zone> (coordinator config.ts PREVIEW): the job gets a view-only pass to it
const PREVIEW_HOST = /^([a-z0-9][a-z0-9-]*)\.preview\./;
const ANCHOR_JS = '/__review/anchor.js';

export type Spot = { snip: string; anchor: unknown };

// The ask's spot, or a stop that says what's wrong (nothing filed): the page at `at` with `selector`'s element on it
export async function shootSpot(at: string, selector: string): Promise<Spot> {
  const url = addressOf(at);
  const cookie = await passFor(url);
  const anchorJs = await reviewAnchor();
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR });
    if (cookie) await context.addCookies([cookie]);
    // (anchor.js as HQ has it, on the page's own origin, so the page's own rules for scripts let it in)
    await context.route(`${url.origin}${ANCHOR_JS}`, (route: any) =>
      route.fulfill({ body: anchorJs, contentType: 'text/javascript; charset=utf-8' }),
    );
    const page = await context.newPage();
    await opened(page, url);
    await inView(page, selector, url);
    const anchor = await page.evaluate(anchorIn, { selector, module: ANCHOR_JS });
    const shot: Buffer = await page.screenshot({ type: 'jpeg', quality: 85 });
    return { snip: `data:image/jpeg;base64,${shot.toString('base64')}`, anchor };
  } finally {
    await browser.close();
  }
}

// --at as an address the board's HQ opens: a preview's page (in HQ's own viewer), or a live site's
function addressOf(at: string) {
  const url = URL.canParse(at) ? new URL(at) : null;
  if (url?.protocol !== 'https:')
    stop(
      `Nothing was filed: --at is the https address of the page the ask is about, as the board opens it (a preview's: https://<slug>.preview.<zone>/path), not "${at}".`,
    );
  return url;
}

// review mode's anchor.js, from HQ, which serves it to anyone
async function reviewAnchor() {
  const answer = await fetch(`${process.env.HQ_URL}${ANCHOR_JS}`).catch(() => null);
  if (!answer?.ok) stop(`Nothing was filed: HQ didn't hand over ${ANCHOR_JS} to anchor the spot. Try again.`);
  return answer.text();
}

// A view-only pass to a preview's host (hq preview's), as the cookie the job's browser carries; none for a live site.
// The cookie goes only to the origin HQ issued it for: a slug's name under another domain would hand it to that server.
async function passFor(url: URL) {
  const slug = PREVIEW_HOST.exec(url.host)?.[1];
  if (!slug) return null;
  const answer = await api.orNoAnswer(
    api.call('preview-passes', { body: api.withSpeaker({ slug }), timeoutMs: 30_000 }),
  );
  const pass = api.isSuccess(answer.status) ? api.parseOrNull(answer.body) : null;
  if (typeof pass?.cookie !== 'string' || typeof pass.url !== 'string')
    stop(`Nothing was filed: no pass to ${url.host} (${api.errorIn(answer.body, `HTTP ${answer.status}`)}).`);
  const issued = new URL(pass.url).origin;
  if (issued !== url.origin)
    stop(`Nothing was filed: --at ${url.origin} isn't ${slug}'s preview, which is ${issued}. Give its address there.`);
  const at = pass.cookie.indexOf('=');
  return {
    ...{ name: pass.cookie.slice(0, at), value: pass.cookie.slice(at + 1), url: issued },
    ...{ httpOnly: true, secure: true, sameSite: 'Lax' as const },
  };
}

// Chromium, from the Playwright npm installed in the worker's image (its Dockerfile)
function launch() {
  const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
  return createRequire(join(globalRoot, '/'))('playwright').chromium.launch();
}

// The page loaded, or a stop with why
async function opened(page: any, url: URL) {
  const loaded = await page.goto(url.href, { waitUntil: 'load' }).catch((error: Error) => error);
  const why =
    loaded instanceof Error
      ? loaded.message.split('\n')[0]
      : !loaded || loaded.status() >= 400
        ? `HTTP ${loaded?.status() ?? 'no answer'}`
        : '';
  if (why) stop(`Nothing was filed: --at ${url.href} didn't load (${why}).`);
}

// The selector's element in the middle of the screen, its pictures and fonts in, or a stop with why
async function inView(page: any, selector: string, url: URL) {
  const why = await page.evaluate(async (selector: string) => {
    let el;
    try {
      el = document.querySelector(selector);
    } catch {
      return 'is not a CSS selector';
    }
    if (!el) return 'matches nothing';
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return 'matches an element that is not shown (it has no size)';
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await document.fonts.ready;
    const shown = [...document.images].filter(img => {
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    });
    await Promise.all(
      shown.map(img =>
        img.decode().catch(() => {
          /* a broken picture is shot as it shows */
        }),
      ),
    );
    await new Promise(next => requestAnimationFrame(() => requestAnimationFrame(next)));
    return '';
  }, selector);
  if (why) stop(`Nothing was filed: --spot "${selector}" ${why} on ${url.href}.`);
}

// (in the page) the element's anchor as review mode writes a mark's, with the screen as it is
async function anchorIn({ selector, module }: { selector: string; module: string }) {
  const { anchorOf } = await import(module);
  const view = { w: innerWidth, h: innerHeight, x: scrollX, y: scrollY, dpr: devicePixelRatio };
  return anchorOf(document.querySelector(selector), { url: location.href, view });
}
