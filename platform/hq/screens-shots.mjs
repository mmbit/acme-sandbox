// The board's screens of HQ on a side's real coordinator (screens-side.mjs), in each look on each device the company
// names (org.yaml review.screens), every one a
// pure function of the code and the seed: the page's clock paused and its Math.random seeded (harness.mjs), the
// coordinator's clock set back to the render's minute before each screen, the same fonts on both sides (fulfilFonts),
// the feed's first answer whole (fulfilEvents), and the animations held, each ended at the page's next step (run).
import { mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { pin, track, settle } from './harness.mjs';
import { routeOrigin } from './book/originroute.mjs';
import { shapeOf } from './shell/ink/booklayout.js';
import { fulfilFonts, keptFonts } from './keptfonts.mjs';
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
