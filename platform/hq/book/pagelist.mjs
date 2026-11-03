// book-check.mjs's story of the page list showing only the tab's pages (shell/ink/bookcontrols.js), on journal.mjs's
// My journal (two sketch pages, its Asks page, twenty calls): on an iPad mini with touch, on its side and upright, and on
// a desktop, the book opens on the last call's page (20 / 20), and the page count tapped lists the twenty calls by
// their titles, numbered 1 to 20, the last marked; the third chosen turns to 3 / 20 in Calls. On Sketch 1 / 2 it lists
// Ideas and Shop page as 1 and 2, and Shop page chosen is Sketch 2 / 2; on Asks 1 / 1 it lists Asks alone. Never another
// tab's page, never the book's own numbering.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, until } from './kit.mjs';
import { CALLS, landed, onJournal } from './journal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function pageListStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    "the page list shows only the tab's pages, numbered as the counter, on an iPad mini on its side": browser =>
      listed(browser, c, MINI, 'mini', touch),
    "the page list shows only the tab's pages, numbered as the counter, on an iPad mini upright": browser =>
      listed(browser, c, UPRIGHT, 'mini-upright', touch),
    "the page list shows only the tab's pages, numbered as the counter, on a desktop": browser =>
      listed(browser, c, DESKTOP, 'desktop', mouse),
  };
}

const listed = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'pagelist' }, (p, { press, tab }) =>
    walk(p, c, name, { press, tab }),
  );

// The last call page's list, the third call chosen from it; Sketch 1 / 2's, Shop page chosen; Asks 1 / 1's
async function walk(p, c, name, { press, tab }) {
  const calls = Array.from({ length: CALLS }, (_, i) => `Call ${i + 1}`);
  await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
  await list(p, press, calls, `Call ${CALLS}`, `${name}: Calls' list`);
  await c.shot(`pagelist-${name}-calls`, p);
  await choose(p, press, 'Call 3');
  await landed(p, 'calls', 'Call 3', `3 / ${CALLS}`, `${name}: Call 3 chosen from the list`);
  await tab('sketch');
  await landed(p, 'sketch', 'Ideas', '1 / 2', `${name}: Sketch's first page`);
  await list(p, press, ['Ideas', 'Shop page'], 'Ideas', `${name}: Sketch's list`);
  await c.shot(`pagelist-${name}-sketch`, p);
  await choose(p, press, 'Shop page');
  await landed(p, 'sketch', 'Shop page', '2 / 2', `${name}: Shop page chosen from the list`);
  await tab('asks');
  await landed(p, 'asks', 'Asks', '1 / 1', `${name}: Asks`);
  await list(p, press, ['Asks'], 'Asks', `${name}: Asks' list`);
  await choose(p, press, 'Asks');
  await landed(p, 'asks', 'Asks', '1 / 1', `${name}: Asks chosen, still on it`);
}
// The page count pressed, its list reading names numbered 1 on, the shown page marked
async function list(p, press, names, shown, what) {
  await press(p.locator('#book .bk-where'));
  const rows = () =>
    p.locator('#book .bk-pages-menu [role=menuitem]').evaluateAll(bs =>
      bs.map(b => ({
        at: b.querySelector('small').textContent,
        name: b.textContent.slice(b.querySelector('small').textContent.length),
        current: b.getAttribute('aria-current') === 'page',
      })),
    );
  const want = names.map((n, i) => ({ at: String(i + 1), name: n, current: n === shown }));
  await until(async () => (await rows()).length === names.length, `${what}: ${names.length} pages`);
  assert.deepEqual(await rows(), want, what);
}
const choose = (p, press, name) =>
  press(p.locator('#book .bk-pages-menu [role=menuitem]').filter({ hasText: new RegExp(`^\\d+${name}$`) }));
