// book-check.mjs's story of a lone thing on a Notebook page (shell/ink/bookselectclip.js, bookgroups.js lone) on the
// played Notebook seeded as dev mode's (booknotebook.mjs open): a lone picture is a scrap of its own, and Select's bar
// has its Move to page… and Delete. On a phone, every button of that bar on the
// paper, held sideways too, the bar over the picture.
import assert from 'node:assert/strict';
import { group, ids, open } from './booknotebook.mjs';
import { onPaper, tool } from './booknotebookscreen.mjs';
import { DESKTOP, until } from './bookkit.mjs';

const PHONE = { width: 390, height: 844 },
  // (held sideways the book opens beside HQ, its paper about 340 px high: the bar's rows go over the picture)
  PHONE_SIDEWAYS = { width: 844, height: 390 };
// the seed's second and newest pages, and the lone picture on the newest (mock/notebook.json), its middle
const SECOND = 2,
  NEWEST = 3,
  SHOT = 11,
  MIDDLE = [330, 626];

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookSelectStories(c) {
  return {
    "the Notebook on a desktop: a lone picture moved to another page and back, and deleted, from Select's bar":
      browser => loneFromBar(browser, c),
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
    await tool(page, 'Select');
    await page.mouse.click(...(await onPaper(page, [MIDDLE]))[0]);
  };
  try {
    // picked with Select, its bar moves it to another page, and Undo brings it back
    await pick();
    await bar('Move to page…').click();
    await page.locator(`#book .bk-group-menu [data-page="${SECOND}"]`).click();
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
    // everything on the page picked isn't one whole group: no Move to page… in the bar
    await page.mouse.move(...(await onPaper(page, [MIDDLE]))[0]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+a');
    await bar('Delete').waitFor();
    assert.ok(!(await bar('Move to page…').isVisible()), 'without Move to page…');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function barOnPhone(browser, c, screen = PHONE) {
  const upright = screen.height > screen.width;
  const { page, errors, done } = await open(browser, c, screen, { hasTouch: true, isMobile: true, folded: upright });
  try {
    await tool(page, 'Select');
    await page.touchscreen.tap(...(await onPaper(page, [MIDDLE]))[0]);
    await page.locator('#book .bk-sel-bar').getByRole('button', { name: 'Move to page…', exact: true }).waitFor();
    // (on the paper, and none under the pages' row or another control)
    const out = await page.evaluate(() => {
      const bar = document.querySelector('#book .bk-sel-bar'),
        paper = bar.closest('.bk-paper').getBoundingClientRect();
      return [...bar.querySelectorAll('button')]
        .filter(b => b.offsetWidth)
        .map(b => [b.textContent.trim(), b.getBoundingClientRect(), b])
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
    await c.shot(upright ? 'notebook-phone-select-bar' : 'notebook-phone-sideways-select-bar', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
