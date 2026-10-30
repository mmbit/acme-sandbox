// book-check.mjs's story of My shelf (shell/ink/bookshelf.js, bookshelfbooks.js, bookshelfcover.js): big books with
// covers, as the deck's shelf. The board gives My journal a cover from its menu (a picture picked on the device); a
// project's book wears its project's cover, another a quiet drawing; each says its one line under its name and counts
// its asks on its corner; a round back from Lyra stands there in its envelope. At a phone, an iPad mini upright and
// sideways, and a desktop with a narrow and a wide notebook: every book whole on the paper, clear of the controls and
// of each other, its name and line unclipped, standing on its board; a book opens to its pages as before.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../shared/browser/browser.mjs';
import { DESKTOP, MINI } from './bookkit.mjs';

const PHONE = { width: 390, height: 844 },
  UPRIGHT = { width: 744, height: 1133 };
const DAY = 86_400_000,
  at = ms => new Date(ms).toISOString();

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function myShelfStories(c) {
  return {
    "My shelf: My journal's cover uploaded from its menu, project books with covers, a round's envelope; big books on boards at a phone, an iPad mini both ways and a desktop, nothing overlapping":
      browser => shelves(browser, c),
  };
}

async function shelves(browser, c) {
  const picture = await lighthouse(browser);
  for (const [label, viewport, wider] of [
    ['mini-upright', UPRIGHT, 0],
    ['phone', PHONE, 0],
    ['mini-sideways', MINI, 0],
    ['desktop-narrow', DESKTOP, 0],
    ['desktop-wide', DESKTOP, 900],
  ])
    await shelfAt(browser, c, { label, viewport, wider, picture, upload: label === 'mini-upright' });
}

async function shelfAt(browser, c, { label, viewport, wider, picture, upload }) {
  const seed = shelfSeed(upload ? null : `data:image/png;base64,${picture.toString('base64')}`);
  const touch = viewport.width < 800;
  const context = await c.hqIn(browser, viewport, { notebooks: seed, hasTouch: touch, isMobile: touch });
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    const far = await openShelf(page, c, wider);
    if (upload) await giveCover(page, far, c, label, picture);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#book .bk-cover-frame img')].every(i => i.complete && i.naturalWidth),
    );
    shelfChecked(await shelfSeen(page), label);
    await c.shot(`myshelf-${label}`, page);
    // a book opens to its pages as before
    await far.getByRole('button', { name: /^My journal,/ }).click();
    await page.waitForTimeout(c.settle);
    assert.equal(await page.evaluate(() => document.querySelector('#book .bk-far').dataset.level), 'pages');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// HQ's book open (lifted where it starts folded), made wider by dx if asked, and the overview on My shelf
async function openShelf(page, c, wider) {
  await page.goto(`${c.base}/?intro=0&renderer=wire`);
  await until(page, '#loading.gone');
  if ((await page.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await page.locator('#book .bk-lip').click();
    await page.waitForFunction(() => !['folded', undefined].includes(document.documentElement.dataset.book));
  }
  await page.waitForFunction(() => !document.querySelector('#book.bk-swinging'));
  if (wider) await widen(page, wider);
  await page
    .locator('#book')
    .getByRole('button', { name: /^The overview/ })
    .click();
  await page.waitForTimeout(c.settle);
  const far = page.getByRole('list', { name: 'The overview' });
  await far.getByRole('button', { name: /^The Shelf/ }).click();
  await page.waitForTimeout(c.settle);
  assert.equal(await far.locator('.bk-shelf-title').textContent(), 'My shelf');
  assert.equal(await far.locator('.bk-shelf-count').textContent(), '5 books');
  return far;
}

// My journal's menu opened, Change cover pressed and the picture picked: on its front, and kept as a JPEG
async function giveCover(page, far, c, label, picture) {
  await far.getByRole('button', { name: 'More: My journal', exact: true }).click();
  await c.shot(`myshelf-menu-${label}`, page);
  const chooser = page.waitForEvent('filechooser');
  await far.getByRole('menuitem', { name: 'Change cover' }).click();
  await (await chooser).setFiles({ name: 'lighthouse.png', mimeType: 'image/png', buffer: picture });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#book .bk-book[data-book="1"] .bk-cover-frame img')].some(
      i => i.complete && i.naturalWidth,
    ),
  );
  assert.match(page.context().notebook.route('/api/notebooks').shelf[0].cover, /^data:image\/jpeg;base64,/);
}

// Each book's name, line, count and cover as the deck has them; whole on the paper, on its board, clear of the others
function shelfChecked(seen, label) {
  assert.deepEqual(
    seen.books.map(b => [b.title, b.line]),
    [
      ['My journal', '1 new answer'],
      ['Rocketlings', '2 asks wait on you'],
      ['Carrel', 'all read'],
      ['Recurring', 'quiet this week'],
      [null, null],
    ],
    `${label}: each book's name and line`,
  );
  assert.deepEqual(
    seen.books.slice(0, 4).map(b => b.disc),
    ['', '2 red', '14', ''],
    `${label}: the counts`,
  );
  assert.deepEqual(
    seen.books.slice(0, 3).map(b => b.picture),
    [true, true, true],
    `${label}: covers`,
  );
  for (const b of seen.books) {
    assert.ok(b.left >= seen.paper.left && b.right <= seen.paper.right, `${label}: on the paper ${JSON.stringify(b)}`);
    assert.ok(!b.clipped, `${label}: ${b.title}'s name and line whole`);
    assert.ok(Math.abs(b.bottom - b.board) <= 10, `${label}: ${b.title ?? 'the envelope'} stands on its board`);
  }
  for (const [i, a] of seen.books.entries())
    for (const b of seen.books.slice(i + 1))
      assert.ok(
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        `${label}: ${a.title} and ${b.title} apart`,
      );
  assert.ok(seen.width >= 170 && seen.width <= 300, `${label}: big books, never too wide (${seen.width} px)`);
  const [envelope] = seen.books.slice(-1);
  assert.ok(
    seen.books.slice(0, -1).every(b => b.board < envelope.board),
    `${label}: the envelope on its own board`,
  );
  console.log(`  ${label}: books ${seen.width} px, ${seen.across} to a row`);
}

// The cover's edge dragged left by dx: the notebook wider
async function widen(page, dx) {
  const r = await page.locator('#book [role=separator]').boundingBox(),
    x = r.x + r.width / 2,
    y = page.viewportSize().height * 0.66;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - dx, y, { steps: 12 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(600);
}

// What the Shelf shows: the paper's span clear of the controls, and each book's box, name, line, count, picture and
// the board it stands on
const shelfSeen = page =>
  page.evaluate(() => {
    const far = document.querySelector('#book .bk-far'),
      r = far.getBoundingClientRect(),
      style = getComputedStyle(far);
    const books = [...far.querySelectorAll('.bk-book')].map(el => {
      const b = el.getBoundingClientRect(),
        row = el.closest('.bk-shelf-row').getBoundingClientRect(),
        title = el.querySelector('.bk-cover-title'),
        line = el.querySelector('.bk-cover-line'),
        disc = el.querySelector('.bk-asks');
      return {
        title: title?.textContent ?? null,
        line: line?.textContent ?? null,
        disc: disc ? `${disc.textContent}${disc.hasAttribute('data-open') ? ' red' : ''}` : '',
        picture: !!el.querySelector('.bk-cover-frame img'),
        clipped: [title, line].some(t => t && t.scrollWidth > t.clientWidth + 1),
        left: Math.round(b.left),
        right: Math.round(b.right),
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
        board: Math.round(row.bottom - 12),
      };
    });
    return {
      paper: {
        left: Math.round(r.left + parseFloat(style.paddingLeft) - 12),
        right: Math.round(r.right - parseFloat(style.paddingRight) + 12),
      },
      books,
      width: Math.round(far.querySelector('.bk-book .bk-cover').getBoundingClientRect().width),
      across: Number(far.querySelector('.bk-shelf-row').dataset.cols),
    };
  });

// The Shelf as the deck draws it: My journal (its cover given here, or already), Rocketlings and Carrel with their
// projects' covers, Recurring quiet, and the shop round back from Lyra
function shelfSeed(cover) {
  const now = Date.now(),
    book = (id, kind, name, more) => ({ id, kind, name, created: at(now - 30 * DAY), updated: at(now - DAY), ...more });
  return {
    notebooks: [
      book(1, 'mine', 'My journal', { news: 1, updated: at(now), ...(cover && { cover }) }),
      book(2, 'project', 'Rocketlings', {
        updated: at(now - 3600_000),
        cover: 'covers/rocketlings.png',
        asks: { open: 2, all: 3 },
      }),
      book(3, 'project', 'Carrel', { cover: 'covers/carrel.png', asks: { open: 0, all: 14 } }),
      book(4, 'project', 'Recurring', { updated: at(now - 10 * DAY) }),
      book(5, 'round', 'shop round', {
        updated: at(now - 12 * DAY),
        round: { state: 'back', guests: [], asksOpen: 0, closed: at(now - 3 * DAY), back: at(now - DAY) },
      }),
    ],
    pages: [{ id: 1, notebook: 1, pos: 0, created: at(now - DAY), updated: at(now - DAY), w: 1200, h: 1600 }],
  };
}

// The board's own picture for My journal: a lighthouse drawn in the line style, as a phone's photo would come (PNG)
async function lighthouse(browser) {
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  try {
    await page.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 200 200">
<rect width="200" height="200" fill="#dfe9ee"/><circle cx="150" cy="44" r="16" fill="#f4d36b"/>
<g fill="none" stroke="#1d1b17" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
<path d="M84 160 L91 72 L109 72 L116 160 Z" fill="#fbf8f2"/><path d="M86 136h28M88 108h24" />
<rect x="90" y="52" width="20" height="20" rx="2" fill="#fbf8f2"/><path d="M86 52 L100 38 L114 52 Z" fill="#c2402e"/>
<path d="M88 58 L50 46 M88 66 L50 78 M112 58 L150 46 M112 66 L150 78" stroke-dasharray="5 6"/>
<path d="M10 164 q 14 -10 28 0 t 28 0 t 28 0 t 28 0 t 28 0 t 28 0 t 28 0" />
<path d="M24 180 q 14 -10 28 0 t 28 0 t 28 0 t 28 0 t 28 0 t 28 0" /></g></svg></body>`);
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}
