// book-check.mjs's stories of Select's bar on a Notebook page (shell/ink/bookselectclip.js, bookmoveto.js) on the
// played Notebook seeded as dev mode's (notebook.mjs open): a lone picture is a scrap of its own, and the bar's
// Move to page… and Delete take it. Move to page… takes any pick: everything on the page, or one line of a drawing,
// lifted out of it onto a new page from the list's end. On a phone, every button of that bar on the paper and on one
// line, held sideways too, the bar over the picture. Each in its scrap opened from the grid (bookscrapopen.js), where
// Select picks: the grid itself takes no pick.
import assert from 'node:assert/strict';
import { group, ids, open } from './notebook.mjs';
import { inSight, onPaper, tool } from './notebookscreen.mjs';
import { DESKTOP, openScrap, until } from './kit.mjs';

const PHONE = { width: 390, height: 844 },
  // (held sideways the book opens beside HQ, its paper about 340 px high: the bar's rows go over the picture)
  PHONE_SIDEWAYS = { width: 844, height: 390 };
// the seed's second and newest pages, and the lone picture on the newest (mock/notebook.json)
const SECOND = 2,
  NEWEST = 3,
  SHOT = 11,
  // (its drawing of eight lines)
  DRAWING = 10;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookSelectStories(c) {
  return {
    "the Notebook on a desktop: a lone picture moved to another page and back, and deleted, from Select's bar":
      browser => loneFromBar(browser, c),
    "the Notebook on a desktop: one line of a drawing moved to a new page from Select's bar, the rest left, Undo":
      browser => partToNewPage(browser, c),
    "the Notebook on a phone: Select's bar for a lone picture, Move to page… too, whole on the paper": browser =>
      barOnPhone(browser, c),
    "the Notebook on a phone held sideways: Select's bar over a lone picture low on the paper, whole on it": browser =>
      barOnPhone(browser, c, PHONE_SIDEWAYS),
  };
}

async function loneFromBar(browser, c) {
  const { page, play, errors, done } = await open(browser, c, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 });
  const bar = name => page.locator('#book .bk-sel-bar').getByRole('button', { name, exact: true });
  const pick = async () => {
    await opened(page, SHOT);
    await tool(page, 'Select');
    await page.mouse.click(...(await middle(page, play)));
  };
  try {
    // picked with Select in its opened scrap, its bar moves it to another page, and Undo brings it back
    await pick();
    await bar('Move to page…').click();
    await page.locator(`#book .bk-move-pages [data-page="${SECOND}"]`).click();
    await until(() => group(play, SHOT)?.page === SECOND, 'the picture moved in the store');
    assert.equal(await page.locator('#book .bk-sel').count(), 0, 'and let go of here');
    await page.mouse.move(DESKTOP.width - 200, DESKTOP.height / 2);
    await page.keyboard.press('Control+z');
    await until(() => group(play, SHOT)?.page === NEWEST, 'Undo moves it back');
    // its bar's Delete goes as its clip's menu's does: its toast, and Undo
    await until(async () => (await pick(), bar('Delete').isVisible()), 'picked again once its page is read again');
    await bar('Delete').click();
    await until(() => !ids(play, NEWEST).includes(SHOT), 'the picture deleted in the store');
    await page.locator('#toasts .toast', { hasText: 'Deleted' }).waitFor();
    await page.keyboard.press('Control+z');
    await until(() => ids(play, NEWEST).includes(SHOT), 'Undo restores it');
    // everything on the page picked: Move to page… takes that too, its list the chapter's open pages, then a new page
    await page.mouse.move(...(await middle(page, play)));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+a');
    await bar('Move to page…').click();
    const rows = await page.locator('#book .bk-move-pages [role="menuitem"]').allTextContents();
    assert.equal(rows.at(-1).trim(), 'New page', `the list ends with a new page: ${rows}`);
    assert.ok(rows.length >= 3, 'after this page and the other open pages');
    await c.shot('notebook-move-to-page-list', page);
    await page.keyboard.press('Escape');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A box round one line of the newest page's drawing of eight, Move to page… and New page: that line alone on the new
// page, the drawing's seven left; Undo moves it back as a unit of its own (as a lasso's split)
async function partToNewPage(browser, c) {
  const { page, play, errors, done } = await open(browser, c, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 });
  const pages = () => play.route('/api/notebooks/pages', { notebook: 1 }).pages.map(p => p.id),
    before = pages(),
    lines = n => group(play, DRAWING)?.ink.length === n;
  try {
    await opened(page, DRAWING);
    await tool(page, 'Select');
    const [from, to] = await onPaper(page, aloneBox(group(play, DRAWING).ink));
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up();
    const bar = name => page.locator('#book .bk-sel-bar').getByRole('button', { name, exact: true });
    await bar('Move to page…').click();
    await page.locator('#book .bk-move-pages [data-page="new"]').click();
    const made = () => pages().find(id => !before.includes(id)),
      on = id => play.route('/api/notebooks/pages/groups', { page: id }).groups;
    await until(() => made() && on(made()).length && lines(7), 'a new page, the drawing one line less');
    const there = on(made());
    assert.deepEqual(
      there.map(g => g.ink.length),
      [1],
      'the line alone on the new page, a unit of its own',
    );
    await page.locator('#toasts .toast', { hasText: 'Moved to' }).waitFor();
    await page.mouse.move(DESKTOP.width - 200, DESKTOP.height / 2);
    await page.keyboard.press('Control+z');
    await until(() => ids(play, NEWEST).includes(there[0].id), 'Undo moves it back, a unit of its own');
    assert.ok(lines(7), 'beside the drawing it was lifted out of');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// A box (its corners, in the unit's px) round one line of a drawing, clear of every other line's box
function aloneBox(ink) {
  const boxes = ink.map(s => {
    const xs = s.points.map(p => p[0]),
      ys = s.points.map(p => p[1]);
    return [Math.min(...xs) - 6, Math.min(...ys) - 6, Math.max(...xs) + 6, Math.max(...ys) + 6];
  });
  const apart = (a, b) => a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
  const k = boxes.findIndex((a, i) => boxes.every((b, j) => i === j || apart(a, b)));
  assert.ok(k >= 0, 'a line of the drawing clear of the others');
  return [boxes[k].slice(0, 2), boxes[k].slice(2)];
}

async function barOnPhone(browser, c, screen = PHONE) {
  const upright = screen.height > screen.width;
  const { page, play, errors, done } = await open(browser, c, screen, {
    hasTouch: true,
    isMobile: true,
    folded: upright,
  });
  try {
    await opened(page, SHOT, { tap: at => page.touchscreen.tap(...at) });
    await tool(page, 'Select');
    await page.touchscreen.tap(...(await middle(page, play)));
    await page.locator('#book .bk-sel-bar').getByRole('button', { name: 'Move to page…', exact: true }).waitFor();
    // (on the paper, and none under the pages' row or another control)
    const out = await page.evaluate(() => {
      const bar = document.querySelector('#book .bk-sel-bar'),
        paper = bar.closest('.bk-paper').getBoundingClientRect();
      return [...bar.querySelectorAll('button')]
        .filter(b => b.offsetWidth)
        .map(b => [b.getAttribute('aria-label'), b.getBoundingClientRect(), b])
        .filter(
          ([, r, b]) =>
            r.left < paper.left ||
            r.right > paper.right ||
            r.top < paper.top ||
            r.bottom > paper.bottom ||
            !b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
        )
        .map(([name]) => name);
    });
    assert.deepEqual(out, [], 'every button of the bar on the paper, in view');
    const tops = await page
      .locator('#book .bk-sel-bar button:visible')
      .evaluateAll(bs => [...new Set(bs.map(b => Math.round(b.getBoundingClientRect().top)))]);
    assert.equal(tops.length, 1, 'the bar on one line');
    await c.shot(upright ? 'notebook-phone-select-bar' : 'notebook-phone-sideways-select-bar', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A scrap opened from the grid by its card (tap: a click unless given), unless it's open already
async function opened(page, gid, pen = { tap: ([x, y]) => page.mouse.click(x, y) }) {
  if (await page.locator('#book .bk-sheet').isVisible()) return;
  // (its card slid into view on the grid first)
  await inSight(page, NEWEST, gid, [[0, 0]]);
  const { gid: was } = await openScrap(page, pen, gid);
  assert.equal(was, gid, 'the scrap tapped is the one opened');
}
// The lone picture's middle on the screen, in its opened scrap: the store keeps it in its unit's own px
async function middle(page, play) {
  const p = group(play, SHOT).pictures[0];
  return (await onPaper(page, [[p.x + p.w / 2, p.y + p.h / 2]]))[0];
}
