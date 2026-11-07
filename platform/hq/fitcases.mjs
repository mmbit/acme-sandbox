// fit-check.mjs's cases: HQ in dev mode in one look, at one of the board's screens, on one of HQ's screens opened by
// the board's own buttons, measured by shared/browser/fit.mjs. A case is { name, look, screen, view, book, open }, and
// runCase runs one in a context of its own and gives its { findings, sizes, seconds } or what stopped it, so a runner
// can pick which cases to run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fit } from '../../shared/browser/fit.mjs';
import { tap, withinBudget } from '../../shared/browser/browser.mjs';
import { BOOK, bookWidth, layout, shapeOf } from './shell/ink/booklayout.js';
import { fulfilFonts, keptFonts } from './keptfonts.mjs';

// HQ's screens from its start, by the board's own buttons, the book folded
const VIEWS = {
  home: async () => {},
  projects: page => tap(page, '#btn-projects'),
  'desk phone': page => tap(page, '#btn-desk'),
  intercom: page => tap(page, '#btn-intercom'),
  news: page => tap(page, '#btn-news'),
  computer: page => tap(page, '#btn-computer'),
};
// The book is as wide as the board drags it, so its cases step through the widths a screen allows this far apart
const BOOK_STEP_PX = 70;
const QUERY = 'intro=0&hour=12&weather=clear',
  SETTLE_POLL_MS = 150, // how often a settling page is asked whether it's still changing
  PAD_PX = 16; // round a finding's crop

// Every case of each look at each screen. screens: company/screens.json's ({ name, width, height, ratio, touch, inset,
// colorScheme }).
export function casesOf(looks, screens) {
  return looks
    .flatMap(look =>
      screens.flatMap(screen => [
        ...Object.entries(VIEWS).map(([view, open]) => ({ look, screen, view, book: { mode: 'folded' }, open })),
        ...booksOf(screen).map(book => ({ look, screen, view: 'notebook', book, open: everyChapter })),
      ]),
    )
    .map(c => ({ ...c, name: nameOf(c) }));
}
const nameOf = ({ look, screen, view, book }) =>
  `${look}, ${screen.name}, ${view}${view !== 'notebook' ? '' : book.mode === 'spread' ? ' spread' : ` ${book.book} px wide`}`;

// The book spread over HQ, and open beside it at every width the screen allows (from its narrowest to its widest, its
// default among them) where that keeps HQ's page beside it
function booksOf({ width, height }) {
  const least = BOOK.min,
    most = bookWidth(width, Infinity),
    steps = Math.max(1, Math.round((most - least) / BOOK_STEP_PX)),
    widths = Array.from({ length: steps + 1 }, (_, i) => Math.round(least + ((most - least) * i) / steps));
  const open = [...new Set([...widths, bookWidth(width)])]
    .sort((a, b) => a - b)
    .filter(book => layout(width, height, { mode: 'open', book }).mode === 'open');
  return [{ mode: 'spread', book: null }, ...open.map(book => ({ mode: 'open', book }))];
}

// The book's every chapter with pages in turn, by its bookmarks, each measured
async function everyChapter(page, measure) {
  const tabs = page.locator('#book .bk-mk-tab:not([data-empty])');
  for (let i = 0, n = await tabs.count(); i < n; i++) {
    await tabs.nth(i).click();
    await measure();
  }
}

// The fonts the company keeps (keptFonts), and the folder the others are kept in once Google has given them
export function keptFontsOf(kits, folder) {
  mkdirSync(folder, { recursive: true });
  return { kept: keptFonts(kits), folder };
}

// A case in a browser context of its own, within budgetMs: its findings (each with its crop in out), its texts' sizes,
// and how long it took. Past the budget it's stalled: one finding saying so, and the run goes on. run: { browser, base,
// fonts, abandon } (fonts: keptFontsOf's; abandon: its browser's Watcher's, which closes the context under a stalled
// case, unread: a page stuck in its own script answers nothing); judge: more findings from the sizes it measures
// (sizes → findings).
export async function runCase(run, c, { budgetMs, out, shots, judge = () => [] }) {
  const started = Date.now(),
    unfetched = [],
    context = await openContext(run, c.screen, unfetched);
  try {
    const page = await context.newPage(),
      measured = await withinBudget(
        measureCase(page, c, { base: run.base, unfetched, out, shots, judge }),
        budgetMs,
        run.abandon,
      );
    return { ...measured, seconds: seconds(started) };
  } catch (error) {
    const line = error.stalled ? error.message : `couldn't open: ${error.message.split('\n')[0]}`;
    return { findings: [{ kind: error.stalled ? 'stalled' : 'error', line }], sizes: [], seconds: seconds(started) };
  } finally {
    await context.close();
  }
}

// The screen's size, scheme and touch, and HQ's fonts as the board gets them
async function openContext({ browser, fonts }, screen, unfetched) {
  const context = await browser.newContext({
    viewport: { width: screen.width, height: screen.height },
    deviceScaleFactor: screen.ratio ?? 1,
    hasTouch: !!screen.touch,
    isMobile: Math.min(screen.width, screen.height) < 500, // (a phone)
    colorScheme: screen.colorScheme ?? 'light',
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
    serviceWorkers: 'block',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, route =>
    fulfilFonts(route, { fonts: fonts.folder }, fonts.kept, unfetched),
  );
  return context;
}
const seconds = since => Math.round((Date.now() - since) / 100) / 10;

async function measureCase(page, c, { base, unfetched, out, shots, judge }) {
  const key = `hq.book.${shapeOf(c.screen.width, c.screen.height)}`,
    inset = c.screen.inset ?? [0, 0, 0, 0];
  // (the screen's safe areas as env(safe-area-inset-*) gives them on the board's, a status bar and a home indicator;
  const [top, right, bottom, left] = inset,
    cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, right, bottom, left } });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify(c.book)]);
  await page.goto(`${base}/?renderer=${c.look}&${QUERY}`);
  await page.waitForSelector('#loading.gone', { state: 'attached' });
  if (c.screen.inset) await page.evaluate(asApp);
  await settle(page);
  const findings = [],
    sizes = [];
  // (each finding once, by what it's about, cropped as it's found: the next chapter shows another page)
  const measure = async () => {
    await settle(page);
    const fitted = await page.evaluate(fit, inset),
      found = [...fitted.findings, ...judge(fitted.sizes)].filter(f => !findings.some(g => sameFinding(f, g)));
    await crop(page, c, found, out, findings.length);
    findings.push(...found);
    sizes.push(...fitted.sizes);
    if (shots) await page.screenshot({ path: join(out, `${fileOf(c)}-${++shot}.png`) });
  };
  let shot = 0;
  await c.open(page, measure);
  if (c.open !== everyChapter) await measure();
  if (unfetched.length) findings.push({ kind: 'error', line: `fonts didn't load: ${unfetched[0]}` });
  return { findings, sizes };
}

// HQ as the home-screen app it is on a screen with safe areas (company/screens.json's source): its own stylesheets'
// (display-mode: standalone) rules in force, which Chromium has no way to emulate.
function asApp() {
  const own = [...document.styleSheets].filter(sheet => !sheet.href || new URL(sheet.href).origin === location.origin),
    rules = own.flatMap(sheet => [...sheet.cssRules]).filter(rule => rule instanceof CSSMediaRule);
  const css = rules
    .filter(rule => /display-mode:\s*standalone/.test(rule.conditionText))
    .flatMap(rule => [...rule.cssRules].map(inner => inner.cssText));
  document.head.append(Object.assign(document.createElement('style'), { textContent: css.join('\n') }));
}

const sameFinding = (a, b) => a.kind === b.kind && (a.of ?? a.line) === (b.of ?? b.line);

// Till nothing finite is animating and the page's words and elements have stopped changing
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  for (let last = null; ; await page.waitForTimeout(SETTLE_POLL_MS)) {
    const now = await page.evaluate(() => {
      const playing = document
        .getAnimations()
        .some(a => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity);
      return playing ? null : `${document.body.innerText}|${document.getElementsByTagName('*').length}`;
    });
    if (now !== null && now === last) return;
    last = now;
  }
}

// Each finding's box on the screen, padded, as a picture of its own (finding.crop: its file's name)
async function crop(page, c, findings, out, before) {
  const { width, height } = c.screen;
  for (const [i, finding] of findings.entries()) {
    if (!finding.box) continue;
    const x = Math.max(0, finding.box.x - PAD_PX),
      y = Math.max(0, finding.box.y - PAD_PX),
      w = Math.min(width, finding.box.x + finding.box.w + PAD_PX) - x,
      h = Math.min(height, finding.box.y + finding.box.h + PAD_PX) - y;
    if (w <= 0 || h <= 0) continue;
    finding.crop = `${fileOf(c)}-${finding.kind}-${before + i + 1}.png`;
    await page.screenshot({ path: join(out, finding.crop), clip: { x, y, width: w, height: h } });
  }
}
export const fileOf = c => c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Every case's result beside the crops (cases.json): its findings and the sizes the scale is judged on
export const keep = (out, results) => writeFileSync(join(out, 'cases.json'), JSON.stringify(results, null, 1));
