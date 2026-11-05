// book-check.mjs's story of a page's notes at their own size at every book width (shell/ink/masonry.js MOST). A call's
// page of six notes (a masonry: a sketch page is a canvas at the board's zoom), opened on a phone, an iPad both ways up
// and the desktop's book beside HQ about 600 px wide: every note drawn at most its own width, the columns at the page's
// left under its title and as many as the page holds, the width left over paper at its right. (The grid takes no ink:
// a word beside the notes is gone with free drawing, scrapbook.mjs.) Recorded with --shots.
import assert from 'node:assert/strict';
import { atEverySize } from './kit.mjs';
import { watchedPage } from './start.mjs';
import { SEED, deskAt } from './unitspage.mjs';
import { OWN_W, anotherColumn, opened, units } from './unitsread.mjs';
import { MARGIN } from '../shell/ink/masonry.js';

// the six notes on a call's page
const CALL = { ...SEED, pages: SEED.pages.map(p => ({ ...p, kind: 'call', label: '29 Oct, 15:00, The cover' })) };
const SIZES = {
  phone: { width: 390, height: 844 },
  'ipad-upright': { width: 820, height: 1180 },
  'ipad-sideways': { width: 1180, height: 820 },
  'desktop-beside-hq': { width: 1440, height: 900, book: 600 },
};

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export const noteSizeStories = c => ({
  "a page's notes at their own size at every book width: a phone, an iPad both ways and the desktop beside HQ":
    atEverySize(SIZES, (browser, name, size) => atSize(browser, c, name, size)),
});

async function atSize(browser, c, name, size) {
  const context = await deskAt(browser, c, size, CALL);
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await opened(page, SEED.groups.length);
    await page.waitForTimeout(600);
    await c.shot(`notesize-${name}`, page);
    await ownSize(page, name);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`notesize-${name}-failed`, page);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}
// Every note drawn at most its own size, at the page's left under its title (their first edge no further in than the
// title's words), and as many columns as the page holds: no room right of them for another
async function ownSize(page, name) {
  const seen = await page.evaluate(() => {
      const title = document.querySelector('#book .bk-view-head .bk-page-title span').getBoundingClientRect(),
        desk = document.querySelector('#book .bk-desk').getBoundingClientRect();
      return { left: desk.left, right: desk.right, title: title.left };
    }),
    all = await units(page),
    left = Math.min(...all.map(u => u.x)),
    room = seen.right - Math.max(...all.map(u => u.x + u.w)),
    said = `${JSON.stringify(seen)}, notes ${all.map(u => `${Math.round(u.x)}+${Math.round(u.w)}`).join(' ')}`;
  for (const u of all) assert.ok(u.w <= OWN_W, `note ${u.id} ${Math.round(u.w)} px wide (${said})`);
  assert.ok(left <= seen.title + MARGIN, `the notes at the page's left (${said})`);
  assert.ok(room < anotherColumn(left - seen.left), `${Math.round(room)} px spare right of the notes (${said})`);
  console.log(`  ${name}: notes ${Math.round(all[0].w)} px wide, ${Math.round(room)} px of paper right of them`);
}
