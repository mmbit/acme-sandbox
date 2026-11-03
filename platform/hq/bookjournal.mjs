// book-check.mjs's My journal, the notebook the tab stories run on (booktabpages.mjs and its kin): two sketch pages,
// its Asks page and twenty calls' notes pages, HQ opened on it, a chapter picked by its bookmark (two taps where they
// lie folded: a page upright) and the page landed on as the bar's count and the bookmarks read it.
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';

const T0 = '2026-10-31T18:00:00.000Z';
export const CALLS = 20;
// (a tap or a wait on the shared machine under load: taps time out at 30 s there, on main too)
export const LOADED_MS = 90_000;
const page = (id, pos, label, more = {}) => ({
  id,
  notebook: 1,
  pos,
  label,
  created: T0,
  updated: T0,
  w: 1200,
  h: 1600,
  ...more,
});
const SEED = {
  notebooks: [
    { id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0, asks: { open: 0, all: 0 } },
  ],
  pages: [
    page(1, 0, 'Ideas'),
    page(2, 1, 'Shop page'),
    page(3, 2, 'Asks', { kind: 'asks' }),
    ...Array.from({ length: CALLS }, (_, i) => page(4 + i, 3 + i, `Call ${i + 1}`, { kind: 'call' })),
  ],
  groups: [],
  slips: [],
  asks: [],
  names: {},
};

// A story on My journal as SEED has it: HQ in a fresh context (options: its own), the book open, then walk(p, { press,
// play, tab }) (press: a tap with touch, else a click; play: the context's played store; tab(chapter): its bookmark
// picked); no page errors. A failure is shot as `${story}-${name}-failed`. init: a script run in the page before HQ's
// own.
export async function onJournal(browser, c, { viewport, name, options, story, init }, walk) {
  const context = await c.hqIn(browser, viewport, { notebooks: structuredClone(SEED), ...options });
  const p = await context.newPage(),
    errors = [];
  if (init) await p.addInitScript(init);
  p.on('pageerror', e => errors.push(e.message));
  const press = loc => (options.hasTouch ? loc.tap({ timeout: LOADED_MS }) : loc.click({ timeout: LOADED_MS }));
  try {
    await opened(p, c.base, press);
    await walk(p, { press, play: context.notebook, tab: chapter => picked(p, press, chapter) });
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`${story}-${name}-failed`, p).catch(() => {});
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// HQ with the book open (tapped open from its lip where it starts folded: an iPad upright) and its tabs drawn
async function opened(p, base, press) {
  await p.goto(`${base}/?intro=0`);
  await p.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  await atRest(p);
  if ((await p.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await press(p.locator('#book .bk-lip'));
    await p.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book), null, {
      timeout: LOADED_MS,
    });
    await atRest(p);
  }
  await until(
    () =>
      p
        .locator('#book .bk-marks button')
        .count()
        .then(n => n === 3),
    'three tabs',
  );
}
const atRest = p =>
  p.waitForFunction(() => document.documentElement.dataset.book && !document.querySelector('#book.bk-swinging'), null, {
    timeout: LOADED_MS,
  });
// A chapter's bookmark picked, as the board does: where they lie folded at the page's left edge (a page upright), a
// tap on them brings them out first, and the pick folds them away again
export async function picked(p, press, chapter) {
  const tab = p.locator(`#book .bk-marks [data-chapter=${chapter}]`),
    out = p.locator('#book .bk-marks[data-out]');
  if (await p.evaluate(() => matchMedia('(orientation: portrait)').matches)) {
    // (the sliver: the tab's icon, the rest of it past the screen's edge. Out already, a pull brought them out.)
    if (!(await out.count())) await press(tab.locator('.bk-mk-icon'));
    await out.waitFor({ timeout: LOADED_MS });
    await press(tab);
    await out.waitFor({ state: 'detached', timeout: LOADED_MS });
  } else await press(tab);
}
// The page shown is title, the bar counting where within its chapter ("2 / 20"), and chapter's bookmark the page's own
export async function landed(p, chapter, title, where, what) {
  const shown = () =>
    p.evaluate(() => ({
      title: document.querySelector('#book .bk-page:not([hidden]) .bk-page-title')?.textContent ?? '',
      where: document.querySelector('#book .bk-where')?.textContent || null,
      here: document.querySelector('#book .bk-marks [aria-current=page]')?.dataset.chapter ?? null,
    }));
  await until(async () => (await shown()).title === title, what, LOADED_MS);
  await until(async () => {
    const s = await shown();
    return s.where === where && s.here === chapter;
  }, `${what}: ${where}, ${chapter} the page's own`);
  assert.deepEqual(await shown(), { title, where, here: chapter }, what);
}
