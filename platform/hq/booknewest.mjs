// book-check.mjs's stories of a note the board sends from review mode finding it in the Notebook (shell/ink/booknewest.js,
// notebookstack.js; shared/review/menu.js), on the played Notebook seeded as dev mode's (mock/notebook.json):
//   - a desktop and an iPad mini: a scrap sent while the book is shut, on another notebook (a desktop) or turned to
//     another page (an iPad mini), lands under the newest thing on My Notebook's current page (on a desktop its ink in
//     the folded book's handle); the pull tab opens the book there, the scrap in view; turned away again, the pin
//     menu's Open the Notebook turns back to it in the open book, its count the board's notes on that page, and on a
//     desktop a preview's own tab opens HQ there;
//   - a phone: the book folded onto HQ with the pin, the menu's Open the Notebook opens it at the scrap.
import assert from 'node:assert/strict';
import { open } from './booknotebook.mjs';
import { where } from './booknotebookscreen.mjs';
import { DESKTOP, MINI, ui, until } from './bookkit.mjs';

const PHONE = { width: 390, height: 844 };
// the seed's second page and its newest, the current page (mock/notebook.json)
const SECOND = 2,
  NEWEST = 3,
  ESMEE = { notebook: 2, page: 4, name: 'Menu ideas' }; // (an invited notebook and its page)

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots, org
export function newestStories(c) {
  return {
    "a note sent from review mode, on a desktop: it lands under the newest thing on the page, the book opens to it, and the pin menu's Open the Notebook turns to it":
      browser => beside(browser, c, DESKTOP, 'desktop'),
    "a note sent from review mode, on an iPad mini: the book opens to it, and the pin menu's Open the Notebook turns to it":
      browser => beside(browser, c, MINI, 'mini'),
    "a note sent from review mode, on a phone: the pin menu's Open the Notebook opens the folded book at it": browser =>
      onPhone(browser, c),
  };
}

// The book beside HQ: a desktop with a mouse, an iPad mini with touch
async function beside(browser, c, viewport, name) {
  const touch = name === 'mini',
    { page, play, errors, done } = await open(
      browser,
      c,
      viewport,
      touch ? { hasTouch: true } : { deviceScaleFactor: 1 },
    );
  try {
    // (away from the current page: on a desktop in another notebook, as the board opens one from its shelf)
    const away = () => (touch ? turnBack(page, SECOND) : otherNotebook(page));
    await menuReads(page, play, c);
    await away();
    await tap(page, '#book .bk-lip');
    await atRest(page, 'folded');
    const sent = await sendScrap(page, play);
    // (on a desktop its ink lands in the folded book's handle, whose tap opens at it: the landed note's path)
    if (!touch) await landed(page, sent);
    await tap(page, '#book .bk-lip');
    await atRest(page, 'open');
    await inView(page, play, sent.id, 'the pull tab opens the book at the scrap');
    await c.shot(`newest-${name}-opened`, page);
    // turned away in the open book, the pin's menu turns back to it
    await away();
    await openTheNotebook(page, play, c, `newest-${name}-menu`);
    await inView(page, play, sent.id, "the menu's Open the Notebook turns the open book to the scrap");
    if (!touch) await inATab(page, play, c, sent.id, errors, away);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// Left away from the current page, the menu's Open the Notebook in a preview's own tab: HQ opened at the scrap
async function inATab(page, play, c, id, errors, away) {
  await away();
  await page.waitForTimeout(500); // (the place the book remembers)
  const tab = await page.context().newPage();
  tab.on('pageerror', e => errors.push(e.message));
  await tab.goto(`${c.base}/?intro=0&open=book&owner=${c.org.company.ceo}`);
  await atRest(tab, 'open');
  await inView(tab, play, id, "a tab's Open the Notebook opens HQ at the scrap");
}

async function onPhone(browser, c) {
  const { page, play, errors, done } = await open(browser, c, PHONE, { hasTouch: true, isMobile: true, folded: true });
  try {
    await menuReads(page, play, c);
    // the book's pin control folds the book onto HQ with the pin
    await tap(page, '#book .bk-pin');
    await atRest(page, 'folded');
    const sent = await sendScrap(page, play);
    await openTheNotebook(page, play, c, 'newest-phone-menu');
    await atRest(page, 'spread');
    await inView(page, play, sent.id, "the menu's Open the Notebook opens the folded book at the scrap");
    await c.shot('newest-phone-opened', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// ---- review mode

// Review mode's menu reads whose Notebook and how many of the board's notes are on its current page, as the
// coordinator answers (ink/bookreview.ts menuOf), from the played store
async function menuReads(page, play, c) {
  const owner = c.org.company.ceo;
  await page
    .context()
    .route(/\/__review\/mine(\?.*)?$/, r =>
      r.fulfill({ json: { book: { owner, name: owner }, notes: boardsNotes(play) } }),
    );
}
// A ring's note saved as review mode saves it: a scrap on the current page, which lands under its newest group
async function sendScrap(page, play) {
  const before = groupsOn(play, NEWEST),
    snip = await page.evaluate(() => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 480, height: 240 });
      const pen = canvas.getContext('2d');
      pen.fillStyle = '#2f6bdc';
      pen.fillRect(0, 0, 480, 240);
      return canvas.toDataURL('image/png');
    });
  const anchor = {
    v: 1,
    url: 'https://hq.example/?open=shop',
    el: null,
    view: { w: 1440, h: 900, x: 0, y: 0, dpr: 1 },
    ink: [],
  };
  const sent = play.route(
    '/api/notebooks/groups/scrap',
    {},
    { anchor, words: 'The basket hides', said: 'typed', snip },
  );
  assert.equal(sent.page, NEWEST, 'on the current page');
  under(sent.box, before);
  return sent;
}
// A scrap's box under the newest of a page's groups (the highest id), at its left edge, and clear of every group
function under(box, groups) {
  const boxes = groups.filter(g => g.box),
    newest = boxes.reduce((a, b) => (b.id > a.id ? b : a)).box;
  assert.equal(box.x, Math.round(newest.x), "at the newest thing's left edge");
  assert.ok(box.y >= newest.y + newest.h, `under the newest thing on the page (${box.y} by ${newest.y + newest.h})`);
  const over = boxes.filter(
    ({ box: b }) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h,
  );
  assert.deepEqual(
    over.map(g => g.id),
    [],
    'over nothing already on the page',
  );
}
// The scrap's ink lifted into the folded book as review mode's lift.js asks ('pencil:landing', a Notebook scrap's), the
// handle then reading that a note just landed
async function landed(page, { id, page: on }) {
  await page.evaluate(
    ({ id, page }) => {
      const from = { x: 600, y: 400, w: 120, h: 60 },
        ask = { id, page, snip: null, from, land: null, aim: null, arrived: null, group: true };
      document.dispatchEvent(new CustomEvent('pencil:landing', { detail: ask }));
      ask.arrived?.();
    },
    { id, page: on },
  );
  assert.match(
    await page.locator('#book .bk-lip').getAttribute('aria-label'),
    /a note just landed/,
    'the handle holds the landed note',
  );
}
// The pin's menu opened, its count the board's notes on the current page, and its Open the Notebook tapped
async function openTheNotebook(page, play, c, look) {
  await page.locator(ui('.more')).dispatchEvent('click');
  await page.waitForSelector(ui('.menu:not([hidden])'));
  const n = boardsNotes(play);
  await until(
    () =>
      page
        .locator(ui('.menu .cap'))
        .textContent()
        .then(t => t === `${n} on your Notebook’s newest page`),
    'the menu counting the notes on the current page',
  );
  assert.equal(await page.locator(ui('.more .count')).textContent(), String(n), 'its badge the same');
  await c.shot(look, page);
  await page.locator(ui('[data-open-book]')).dispatchEvent('click');
}

// The pages' row turned back to page n, its arrow's own click in the page (tap)
async function turnBack(page, n) {
  const at = () => where(page).then(w => Number(/(\d+) \/ \d+$/.exec(w)?.[1]));
  for (let i = 0; i < 8 && (await at()) > n; i++) {
    const was = await at();
    await page.locator('#book').getByRole('button', { name: 'The page before' }).dispatchEvent('click');
    await until(async () => (await at()) !== was, 'the page turned', 30_000);
  }
  assert.equal(await at(), n, `turned to page ${n}`);
}
// Esmee's notebook open in the book at its page, by the path a card's Open in the book takes (book.js)
async function otherNotebook(page) {
  await page.evaluate(at => document.dispatchEvent(new CustomEvent('book:find', { detail: at })), ESMEE);
  await until(async () => (await where(page)).startsWith(ESMEE.name), "Esmee's notebook open", 30_000);
}
// The book at rest in a mode, its swing landed: on a loaded machine HQ's scene in software takes a swing many seconds
const atRest = (page, mode) =>
  page.waitForFunction(
    mode => document.documentElement.dataset.book === mode && !document.querySelector('#book.bk-swinging'),
    mode,
    { timeout: 120_000 },
  );
// A control's own click in the page: on a loaded machine HQ's scene in software keeps Playwright's click waiting for
// frames that come seconds late
const tap = (page, selector) => page.locator(selector).dispatchEvent('click');

// ---- reading

const groupsOn = (play, page) => play.route('/api/notebooks/pages/groups', { page }).groups;
const boardsNotes = play => groupsOn(play, NEWEST).filter(g => g.by === 'board' && g.status === 'open').length;
// The group whole in the paper's view on its page, shown (its groups' layer: a lone scrap has no clip), clear of the tool
// strip, the islands and the pages' row (the book slides there: wait on it, as frames come late on a loaded machine)
async function inView(page, play, id, what) {
  const on = NEWEST,
    box = groupsOn(play, on).find(g => g.id === id).box;
  const seen = () =>
    page.evaluate(
      ([on, box]) => {
        const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
        if (!shown?.querySelector(`:scope > .bk-groups[data-page="${on}"]`)) return false;
        const o = shown.getBoundingClientRect(),
          k = o.width / shown.offsetWidth,
          r = { left: o.left + box.x * k, right: o.left + (box.x + box.w) * k, top: o.top + box.y * k };
        r.bottom = r.top + box.h * k;
        const desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
          over = [
            // (the tool's name beside the strip is never in a press's way, and fades: bookstrip.css)
            ...document.querySelectorAll(
              '#book .bk-strip > :not(.bk-now), #book .bk-islands > *, #book .bk-controls > .bk-island',
            ),
          ]
            .filter(el => el.offsetWidth)
            .map(el => el.getBoundingClientRect())
            .filter(b => b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom);
        return r.left >= desk.left - 1 &&
          r.right <= desk.right + 1 &&
          r.top >= desk.top - 1 &&
          r.bottom <= desk.bottom + 1
          ? over.length === 0
          : false;
      },
      [on, box],
    );
  await until(seen, what, 60_000);
}
