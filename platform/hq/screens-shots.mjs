// The board's screens of HQ on a side's real coordinator (screens-side.mjs), in each look on each device the company
// names (org.yaml review.screens), every one a
// pure function of the code and the seed: the page's clock paused and its Math.random seeded (harness.mjs), the
// coordinator's clock set back to the render's minute before each screen, the same fonts on both sides (fulfilFonts),
// the feed's first answer whole (fulfilEvents), and the animations held, each ended at the page's next step (run).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { pin, track, settle } from './harness.mjs';
import { routeOrigin } from './originroute.mjs';
import { shapeOf } from './shell/ink/booklayout.js';
import { playwright, tap } from '../../shared/browser/browser.mjs';

// Each screen from HQ's start, by the board's own keys. The project and deliverable are screens-seed.mjs's.
export const SCREENS = {
  home: async () => {},
  projects: page => tap(page, '#btn-projects'),
  project: async page => {
    await tap(page, '#btn-projects');
    await tap(page, await waitFor(page, '[data-project=game]'));
  },
  deliverable: async page => {
    await SCREENS.project(page);
    await tap(page, await waitFor(page, '[data-thread="game/levels"]'));
  },
  deskphone: page => tap(page, '#btn-desk'),
  intercom: page => tap(page, '#btn-intercom'),
  news: page => tap(page, '#btn-news'),
  computer: page => tap(page, '#btn-computer'),
  notebook: async () => {}, // (HQ started with its book open beside it: BOOK)
};
// How Ink's book is when HQ starts, by screen: folded but for its own screen, open beside HQ's page as the board left it
// (an open swung at the screen would land HQ's scene in a new building mid-way)
const BOOK = { notebook: 'open' },
  QUERY = 'intro=0&hour=12&weather=clear',
  STEP_MS = 100, // the page's time run on in steps, each settled, so answers land between the same frames
  OPEN_MS = 1500, // a screen's time to open: its first reads, and its animations started
  SHOWN_MS = 60_000, // real time a page has to show what a screen waits for, on a loaded machine
  FONT_MS = 10_000, // Google's answer for a font, or the screen that asked fails on that side
  DAY_MS = 86_400_000;

// Every screen of every look on every device. side: { h, origin, kits, fonts, shots, outcome, at, setClock, looks,
// devices }: the harness, its ORIGIN, the side's kits folder, the run's fonts folder, where the pictures go, the list
// they go on, the render's time, the side's clock, and the looks and devices (Playwright context options, by name).
export async function shoot(side) {
  mkdirSync(side.shots, { recursive: true });
  // (whole tiles: a part of a tile drawn again over its old pixels can round a level off a whole one's)
  const browser = await playwright().chromium.launch({
    args: ['--font-render-hinting=none', '--disable-partial-raster'],
  });
  const fonts = keptFonts(side.kits);
  mkdirSync(side.fonts, { recursive: true });
  try {
    for (const look of side.looks)
      for (const [device, options] of Object.entries(side.devices))
        for (const [screen, open] of Object.entries(SCREENS))
          await shootScreen(browser, side, { screen, look, device, options, open, fonts });
  } finally {
    await browser.close();
  }
}

// The board signed in, on HQ's own address, its book as the screen has it (BOOK) on this device's shape
async function openContext(browser, side, { options, fonts, screen, unfetched }) {
  const context = await browser.newContext({
    ...options,
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  await routeOrigin(context, side.origin, side.h.base);
  await context.route(`${side.origin}/api/events`, route => fulfilEvents(route, side.h.base));
  await context.route(/fonts\.(googleapis|gstatic)\.com/, route => fulfilFonts(route, side, fonts, unfetched));
  const [name, value] = side.h.boardCookie.split('=');
  await context.addCookies([{ name, value, url: side.origin }]);
  const book = `hq.book.${shapeOf(options.viewport.width, options.viewport.height)}`;
  const state = JSON.stringify({ mode: BOOK[screen] ?? 'folded' });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [book, state]);
  await pin(context, side.at);
  return context;
}

// One screen in a browser context of its own, so no screen opens on what the one before it left, and its page's
// clock starts at the render's time
async function shootScreen(browser, side, { screen, look, device, options, open, fonts }) {
  side.setClock(side.at);
  const unfetched = []; // (the fonts Google didn't give it: fulfilFonts)
  const context = await openContext(browser, side, { options, fonts, screen, unfetched }),
    page = track(await context.newPage()),
    where = `${screen}, ${look}, ${device}`;
  page.on('pageerror', error => side.outcome.errors.push(`${where}: ${error.message}`));
  try {
    await holdAnswers(context, page);
    const hold = await holdAnimations(context, page);
    await page.goto(`${side.origin}/?renderer=${look}&${QUERY}`);
    await hold(); // (again for the page's new document)
    await waitFor(page, '#loading.gone');
    await still(page);
    await open(page);
    await still(page);
    if (unfetched.length) throw new Error(`its fonts didn't load: ${unfetched.join('; ')}`);
    const file = join(side.shots, `${screen}-${look}-${device}.png`);
    await page.screenshot({ path: file, caret: 'hide' }); // (the animations held: holdAnimations)
    side.outcome.shots.push({ screen, look, device, file });
  } catch (error) {
    side.outcome.errors.push(`${where}: couldn't open (${error.message.split('\n')[0]})`);
  } finally {
    // (its routes let go first: a route still fetching when its context closes throws)
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
}

// HQ's feed as it opens (its latest events, then who's at work now: the statuses), whole, and no more: the browser's
// own timer, which the page's paused clock doesn't hold, would bring the rest at a moment of its choosing. So the
// feed asks to be reconnected a day later.
function fulfilEvents(route, base) {
  return new Promise((done, failed) => {
    const asked = request(`${base}/api/events`, { headers: route.request().headers() }, answer => {
      let text = '';
      answer.setEncoding('utf8');
      answer.on('data', chunk => {
        text += chunk;
        if (!/"type":"statuses"[^\n]*\n\n$/.test(text)) return;
        answer.destroy();
        const body = `retry: ${DAY_MS}\n\n${text}`;
        done(route.fulfill({ status: answer.statusCode, contentType: 'text/event-stream', body }));
      });
      answer.on('error', failed);
    });
    asked.on('error', failed);
    asked.end();
  });
}

// The page's time run on until selector finds an element, which it returns. Its real time is bounded, so a page that
// never shows it fails its own screen rather than the run.
async function waitFor(page, selector) {
  for (const stop = Date.now() + SHOWN_MS; !(await page.$(selector));) {
    if (Date.now() > stop) throw new Error(`${selector} didn't show in ${SHOWN_MS / 1000} s`);
    await run(page, STEP_MS);
  }
  return selector;
}

// The page's time run on till what it opened is in and no animation is left playing
async function still(page) {
  await run(page, OPEN_MS);
  for (const stop = Date.now() + SHOWN_MS; await endAnimations(page);) {
    if (Date.now() > stop) throw new Error(`animations still started after ${SHOWN_MS / 1000} s`);
    await run(page);
  }
}

// The page's time run on by ms, a step at a time. After each, every finite animation it started is ended as it would
// end (holdAnimations keeps them from moving on their own), and its requests answered (holdAnswers keeps them till
// then) and its pictures and fonts in.
async function run(page, ms = STEP_MS) {
  for (let t = 0; t < ms; t += STEP_MS) {
    page.answers.hold();
    await page.clock.runFor(STEP_MS);
    page.answers.release();
    await endAnimations(page);
    await settle(page, { held: true });
  }
}
// The finite animations playing, ended: how many there were
const endAnimations = page =>
  page.evaluate(() => {
    const playing = document
      .getAnimations()
      .filter(a => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity);
    for (const animation of playing) animation.finish();
    return playing.length;
  });

// The page's requests while its time runs on, sent on once the step is over (page.answers: hold, release): an answer
// that came in the middle of a step would land between different frames on each run.
async function holdAnswers(context, page) {
  let held = null,
    release = () => {};
  page.answers = {
    hold: () => (held = new Promise(go => (release = go))),
    release: () => release(),
  };
  await context.route('**/*', async route => {
    await held;
    return route.fallback();
  });
}

// The page's animations (CSS and Web Animations) held where they are: they run on the document's own timeline, which
// the paused clock doesn't hold, so they would end after a different number of the page's steps on each run, and what
// waits for them (the book's slide, HQ's page coming back beside it) with them. run ends them at each step instead.
async function holdAnimations(context, page) {
  const devtools = await context.newCDPSession(page),
    hold = () => devtools.send('Animation.setPlaybackRate', { playbackRate: 0 });
  await devtools.send('Animation.enable');
  await hold();
  return hold;
}

// The font files the company keeps in its kits (kits/<kit>/fonts/<family>.woff2, the family's name in lower case with
// dashes), by family
export function keptFonts(kits) {
  const files = new Map();
  for (const kit of existsSync(kits) ? readdirSync(kits) : []) {
    const folder = join(kits, kit, 'fonts');
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(n => n.endsWith('.woff2')))
      files.set(name.slice(0, -'.woff2'.length), join(folder, name));
  }
  return files;
}

// A Google Fonts stylesheet answered with the kept files of the families it asks for, each at a Google address of its
// own (/kept/<name>.woff2, answered here: HQ's CSP takes fonts only from 'self' and fonts.gstatic.com, never data:),
// any other font request with what Google answered the first side that asked (side.fonts keeps it, both sides'). One
// Google doesn't give goes on `unfetched`, so its screen fails on that side rather than shot in another typeface.
export async function fulfilFonts(route, side, kept, unfetched) {
  const url = new URL(route.request().url());
  if (url.hostname === 'fonts.gstatic.com' && url.pathname.startsWith('/kept/'))
    return route.fulfill({ contentType: 'font/woff2', body: readFileSync(kept.get(url.pathname.slice(6, -6))) });
  const families = url.searchParams.getAll('family').map(f => f.split(':')[0]),
    names = families.map(family => family.toLowerCase().replaceAll(' ', '-'));
  if (names.length && names.every(name => kept.has(name))) {
    const faces = families.map(
      (family, i) =>
        `@font-face { font-family: '${family}'; src: url(https://fonts.gstatic.com/kept/${names[i]}.woff2) format('woff2'); font-weight: 100 900; }`,
    );
    return route.fulfill({ contentType: 'text/css', body: faces.join('\n') });
  }
  const file = join(side.fonts, createHash('sha256').update(url.href).digest('hex'));
  if (!existsSync(file)) {
    const answer = await route.fetch({ timeout: FONT_MS }).catch(error => error);
    const cause = answer instanceof Error ? answer.message.split('\n')[0] : !answer.ok() && `HTTP ${answer.status()}`;
    if (cause) {
      unfetched.push(`font ${url.href}: ${cause}`);
      return route.abort();
    }
    writeFileSync(file, await answer.body());
    writeFileSync(`${file}.type`, answer.headers()['content-type'] ?? 'text/css');
  }
  return route.fulfill({ contentType: readFileSync(`${file}.type`, 'utf8'), body: readFileSync(file) });
}
