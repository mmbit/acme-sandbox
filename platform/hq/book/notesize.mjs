// book-check.mjs's story of a page's notes at their own size at every book width (shell/ink/masonry.js MOST). A call's
// page of six notes (a masonry: a sketch page is a canvas at the board's zoom), opened on a phone, an iPad both ways up
// and the desktop's book beside HQ about 600 px wide: every note drawn at most its own width, the columns at the page's
// left under its title and as many as the page holds, the width left over paper at its right. Beside HQ, a word
// written in that paper and the book widened by a column: the word covers no note but the one it was written beside.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { atEverySize } from './kit.mjs';
import { bookWide, watchedPage } from './start.mjs';
import { SEED, deskAt } from './unitspage.mjs';
import { OWN_W, anotherColumn, line, opened, savedInto, still, strokesBy, units } from './unitsread.mjs';
import { GAP, MARGIN } from '../shell/ink/masonry.js';
import { UNIT_W } from '../shell/ink/scrapunit.js';

// the six notes on a call's page
const CALL = { ...SEED, pages: SEED.pages.map(p => ({ ...p, kind: 'call', label: '29 Oct, 15:00, The cover' })) };
const SIZES = {
  phone: { width: 390, height: 844 },
  'ipad-upright': { width: 820, height: 1180 },
  'ipad-sideways': { width: 1180, height: 820 },
  // (then a word written beside the notes, and the book widened by a column)
  'desktop-beside-hq': { width: 1440, height: 900, book: 600, widened: 800 },
};

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export const noteSizeStories = c => ({
  "a page's notes at their own size at every book width: a phone, an iPad both ways and the desktop beside HQ, a word beside them covering none as the book widens":
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
    if (size.widened) await widened(page, c, name, size.widened);
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
// A word written in the paper right of the first note, then the book widened by a column (w, the book's CSS px) and
// opened again in two columns: the word covers no note but the one it was written beside
async function widened(page, c, name, w) {
  const all = await still(page),
    first = all.find(u => u.id === SEED.groups[0].id),
    s = first.w / UNIT_W,
    had = strokesBy(page);
  assert.equal(new Set(all.map(u => Math.round(u.x))).size, 1, `one column before the book's widened`);
  // (from the space between columns into the paper beside them: where the next column's notes go once there's one)
  await line(page, first.x + first.w + GAP * s, first.y + 60 * s, 60);
  const into = await savedInto(page, had, 'the word beside the notes saved');
  await c.shot(`notesize-${name}-beside`, page);
  await bookWide(page.context(), page.viewportSize(), w);
  await page.reload();
  await opened(page, all.length);
  const now = await still(page),
    word = lastStrokeOn(
      page,
      now.find(u => u.id === into),
    ),
    covered = now.filter(
      u => u.id !== into && word.x0 < u.x + u.w && u.x < word.x1 && word.y0 < u.bottom && u.y < word.y1,
    );
  await c.shot(`notesize-${name}-widened`, page);
  assert.equal(new Set(now.map(u => Math.round(u.x))).size, 2, `widened, two columns`);
  assert.deepEqual(
    covered.map(u => u.id),
    [],
    `widened, the word written beside note ${into} (${JSON.stringify(word)}) covers no other note`,
  );
}
// The box round a unit's last stroke on screen (CSS px), from the store's points in its own px
function lastStrokeOn(page, unit) {
  const s = unit.w / UNIT_W,
    { points } = page
      .context()
      .notebook.route('/api/notebooks/pages/groups', { page: 1 })
      .groups.find(g => g.id === unit.id)
      .ink.at(-1),
    [xs, ys] = [points.map(p => unit.x + p[0] * s), points.map(p => unit.y + p[1] * s)];
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
