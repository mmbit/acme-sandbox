// book-check.mjs's stories of a scrap and an answer slip with a picture on the Notebook's grid (shell/ink/bookunits.js,
// bookgroups.js): each takes its real height as its page comes in, whatever came late (a picture, the font) and
// whenever its page was laid out of sight, on the played Notebook seeded as dev mode's (mock/notebook.json):
//   - an iPad mini sideways and upright, and a phone: the Launch notebook's "Launch questions" page (Lyra's slip with a
//     picture under "how does pricing look on a phone?", the versions under the note after it) and the Cover ideas
//     page (a post-it with a picture, its words under it), each picture a second late. No card, nor what hangs under
//     one, lies over another's; a post-it's words stay on its card. Again after the page was turned away and back.
//   - the same sizes, a call's notes page read and left for another (as the board goes through the chapters on a call):
//     the call agent's post-it (a snip, its words under it) arriving there out of sight, then opened from All pages;
//     another arriving in sight, and one with the book shut. Each post-it's words on its card, nothing over another.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { open } from './notebook.mjs';
import { turnTo } from './notebookscreen.mjs';
import { shutBy } from './open.mjs';
import { MINI, OVERVIEW, UPRIGHT, until } from './kit.mjs';

const PHONE = { width: 390, height: 844 };
// the seed's Cover ideas page (a post-it with a picture, group 3) and Launch questions page, put in My journal as its
// last and open so the book opens beside them; and the two as the book counts them
const COVER = 1,
  LAUNCH = 5,
  AT = { cover: 1, launch: 4 };
// a call's notes page, empty, that a call's agent writes its post-its on: nothing on it whose own height changing lays
// the page again by chance (no versions), and older than Launch questions so the book still opens there
const CALL = 9500;
// (how late each picture comes, ms)
const LATE = 1200;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function picturedHeightStories(c) {
  const sizes = {
    'an iPad mini sideways': ['mini-sideways', MINI, {}],
    'an iPad mini upright': ['mini-upright', UPRIGHT, { folded: true }],
    'a phone': ['phone', PHONE, { isMobile: true, folded: true }],
  };
  return Object.fromEntries(
    Object.entries(sizes).map(([on, [size, viewport, more]]) => [
      `a scrap or slip with a picture takes its real height as its page comes in, on ${on}`,
      browser => heights(browser, c, size, viewport, { ...more, hasTouch: true }),
    ]),
  );
}

// size: the shots' name for the size
async function heights(browser, c, size, viewport, more) {
  const seed = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
  const launch = seed.pages.find(p => p.id === LAUNCH);
  Object.assign(launch, { notebook: 1, pos: 4, send_at: null });
  seed.pages.push({
    ...launch,
    id: CALL,
    pos: 3,
    kind: 'call',
    label: 'Call with Juno',
    created: '2026-10-01T19:53:00.000Z',
  });
  // (every picture on a scrap or slip a while late, as on a phone's network, from the book's first read)
  const hqIn = async (...args) => {
    const context = await c.hqIn(...args);
    await context.route(
      url => /book-snip|review-shot|notebook-version|ask-spot/.test(url.href),
      r => new Promise(go => setTimeout(go, LATE)).then(() => r.fallback()),
    );
    return context;
  };
  const { page, play, errors, done } = await open(browser, { ...c, hqIn }, viewport, { ...more, notebooks: seed });
  try {
    const name = `pictured-heights-${size}`;
    for (const [at, step] of [
      [AT.launch, 'in'],
      [AT.cover, 'in'],
      [AT.launch, 'back'],
    ]) {
      await turnTo(page, at);
      await whole(page, c, `${name}-${at}-${step}`, `page ${at} (${step})`);
    }
    await arrivals(page, play, c, name, more.folded);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// A call agent's post-its arriving on its call's page: out of sight (the page read, then left for the Cover page, the
// board in All pages), on the page shown, and with the book shut
async function arrivals(page, play, c, name, folded) {
  // (the call's page read where the board starts, then left for another page, as for a chapter's on the call)
  await fromOverview(page, CALL);
  await fromOverview(page, COVER);
  await fromOverview(page, CALL, async () => {
    noted(play, CALL, 'Out of sight: the pricing table as a phone shows it, three plans stacked, yearly first.');
    await page.waitForTimeout(1500);
  });
  await whole(page, c, `${name}-arrived-hidden`, 'a post-it arrived out of sight');
  noted(play, CALL, 'In sight: the checkout button on a phone, under the plans, full width and green.');
  await page.waitForTimeout(3000);
  await whole(page, c, `${name}-arrived-shown`, 'a post-it arrived on the page shown');
  await shutBy(page, c);
  noted(play, CALL, 'While shut: the header in terracotta over a cream page, the buttons a shade darker.');
  await page.waitForTimeout(1500);
  await page.locator('#book .bk-lip').tap();
  await c.settled(page, folded ? 'spread' : 'open');
  await whole(page, c, `${name}-arrived-shut`, 'a post-it arrived with the book shut');
}
// The shown page with its pictures in, shot, and nothing on it over another
async function whole(page, c, shot, what) {
  await settledPictures(page);
  await c.shot(shot, page);
  assert.deepEqual(await overlaps(page), [], `${what}: nothing over another`);
}
// The page id opened from All pages, its tile tapped, as the board comes back to a page; meanwhile() while All pages
// shows
async function fromOverview(page, id, meanwhile = () => {}) {
  await page.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).tap();
  const tile = page.locator(`#book .bk-tile[data-id="${id}"] .bk-tile-open`).first();
  await tile.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await meanwhile();
  await tile.tap();
  await page.waitForFunction(() => !document.querySelector('#book')?.dataset.far, null, { timeout: 10_000 });
}
// A call agent's post-it on a page: a snip of a screen, words under it
function noted(play, page, words) {
  const g = play.note(page, 'juno', { pictures: [{ file: 'book-snip-1.svg', x: 0, y: 0, w: 313, h: 176, tilt: 0 }] });
  play.route('/api/notebooks/groups/edit', {}, { id: g.id, since: g.updated, words, said: 'typed' });
}
// The shown page's pictures in (a lazy one far out of sight may wait to be near), and a frame or two past it
async function settledPictures(page) {
  await until(
    () =>
      page.evaluate(() => {
        const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
        return (
          !!shown?.querySelector('.bk-unit') &&
          [...shown.querySelectorAll('img')].every(i => i.complete || i.loading === 'lazy')
        );
      }),
    'the pictures in',
  );
  await page.waitForTimeout(400);
}
// (in the page) On the shown page: each card, and what hangs under one, that lies over another group's, and each
// post-it's words past its own card (CSS px, 1 px allowed for rounding)
const overlaps = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      box = el => el.getBoundingClientRect(),
      boxes = [...shown.querySelectorAll('.bk-unit[data-unit], :scope > .bk-groups > .bk-under[data-g]')]
        .map(el => ({ g: el.dataset.unit ?? el.dataset.g, what: el.className, b: box(el) }))
        .filter(({ b }) => b.height > 0),
      over = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1,
      found = [];
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1))
        if (a.g !== b.g && over(a.b, b.b)) found.push(`${a.what} ${a.g} over ${b.what} ${b.g}`);
    for (const words of shown.querySelectorAll(':scope > .bk-groups > .bk-words[data-g]')) {
      const card = shown.querySelector(`.bk-unit[data-unit="${words.dataset.g}"]`),
        w = box(words),
        u = card && box(card);
      if (u && w.bottom > u.bottom + 1) found.push(`the words of ${words.dataset.g} past its card's foot`);
    }
    return found;
  });
