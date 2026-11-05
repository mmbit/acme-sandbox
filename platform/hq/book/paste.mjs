// book-check.mjs's stories of what lands in the book from outside, with a mouse on a desktop in Chromium
// (shell/ink/booktape.js, bookbrought.js, booktexts.js put): a picture dragged in by its address from another site (the
// coordinator's fetch played here), a picture file dragged in, pasted words landing as a box at a readable width,
// a pasted web page's HTML keeping its paragraphs, a pasted link landing as its words, a link whose picture didn't come
// or is one HQ can't draw saying why, a file of another kind refused in words, and Undo taking each back. Each asserts what the board sees and what the store keeps.
// A picture dropped on the grid is a scrap of its own there; one dropped in an opened scrap, and words pasted there,
// land in it where they're let go (bookscrapopen.js).
// Pictures dropped side by side in an opened scrap stay apart: the Pencil's tap with Select picks the one tapped, and
// it moves alone.
import assert from 'node:assert/strict';
import { onDesk, freePage, inScrap, savedWhere, colourIn, paperBox, pick, GREEN, BLUE } from './mouse.mjs';
import { closeScrap } from './kit.mjs';
import { hands } from './hands.mjs';

// a picture on another site (never fetched: the coordinator's /api/book/fetch is played)
const SITE_PICTURE = 'https://pictures.example/mug/green.png',
  LINK = 'https://example.com/notes/warmer-mugs',
  // (a picture whose site is down: the coordinator answers 502.)
  DOWN = 'https://down.example/mug/blue.png',
  // (a picture HQ can't draw, a phone's HEIC: the coordinator answers 415, not marked a page.)
  HEIC = 'https://pictures.example/mug/blue.heic';
// (the book's readable width for words put on a page: booktexts.js READ)
const READ = 560,
  // (the boxes of words in the opened scrap)
  TYPED = '#book .bk-page[data-focus] .bk-typed';

// c: book-check.mjs's played store and helpers, as mouseStories gets them
export function pasteStories(c) {
  return {
    'pasted and dropped: a picture dragged in by its address from another site, and a picture file, Undo takes each back':
      browser => pictures(browser, c),
    'pasted words land as a box at a readable width, a page keeps its paragraphs, a link lands as its words': browser =>
      words(browser, c),
    'two pictures dropped in an opened scrap stay apart: the Pencil taps one with Select, it alone is picked and moves':
      browser => apart(browser, c),
  };
}

// ---- the stories

async function pictures(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const asked = await playFetch(page, { [SITE_PICTURE]: await png(page, '#1d9a5b') });
    const paper = await paperBox(page),
      at = { x: paper.x + paper.width * 0.4, y: paper.y + paper.height * 0.55 };
    // an <img> dragged from a web page in another tab onto the grid: Chrome hands over its address and HTML, no file.
    // A scrap of its own, its card the grid's one
    await dropOn(page, at, { 'text/uri-list': SITE_PICTURE, 'text/html': `<img src="${SITE_PICTURE}" alt="">` });
    const placed = await savedWhere(c, free.id, p => p.scraps?.length === 1);
    assert.deepEqual(asked, [SITE_PICTURE], "the coordinator fetched the site's picture, once");
    await page.waitForTimeout(c.settle);
    await onItsCard(page);
    await c.shot('book-paste-dragged-address', page);
    // a picture file dragged in from the desktop beside it, onto that scrap opened: in it where let go
    const sheet = await inScrap(page, c, free),
      there = { x: sheet.x + sheet.width * 0.3, y: sheet.y + sheet.height * 0.75 };
    await dropOn(page, there, {}, await png(page, '#2f6bdc'));
    await savedWhere(c, free.id, p => p.scraps.length === 2);
    await page.waitForTimeout(c.settle);
    const blue = await colourIn(page, BLUE);
    assert.ok(blue.n > 2000 && Math.hypot(blue.x - there.x, blue.y - there.y) < 40, 'the file taped where let go');
    await c.shot('book-paste-dropped-in-scrap', page);
    // Undo takes each back, the last first: the file in the scrap, then the scrap on the grid
    await undo(page);
    await savedWhere(c, free.id, p => p.scraps.length === 1 && p.scraps[0].file === placed.scraps[0].file);
    await closeScrap(page, { tap: ([x, y]) => page.mouse.click(x, y) });
    await page.mouse.move(paper.x + paper.width / 2, paper.y + paper.height / 2);
    await undo(page);
    await savedWhere(c, free.id, p => p.scraps.length === 0);
    await page.waitForTimeout(c.settle);
    assert.ok((await colourIn(page, GREEN)).n < 50 && (await colourIn(page, BLUE)).n < 50, 'both gone from the paper');
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function apart(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const sheet = await inScrap(page, c, free),
      at = f => ({ x: sheet.x + sheet.width * f, y: sheet.y + sheet.height * 0.45 });
    await dropOn(page, at(0.25), {}, await png(page, '#1d9a5b'));
    await savedWhere(c, free.id, p => p.scraps.length === 1);
    await dropOn(page, at(0.75), {}, await png(page, '#2f6bdc'));
    const was = await savedWhere(c, free.id, p => p.scraps.length === 2);
    await page.waitForTimeout(c.settle);
    // the green one tapped with the Pencil, Select in hand: its frame round it alone, the blue one outside it
    await pick(page, 'Select');
    const green = await colourIn(page, GREEN),
      blue = await colourIn(page, BLUE);
    await (await hands(page)).pen.tap([green.x, green.y]);
    const frame = await page.locator('#book .bk-sel').boundingBox(),
      inFrame = p => p.x > frame.x && p.x < frame.x + frame.width && p.y > frame.y && p.y < frame.y + frame.height;
    assert.ok(inFrame(green) && !inFrame(blue), `the tapped picture alone picked: ${JSON.stringify(frame)}`);
    await c.shot('book-paste-one-picked', page);
    // dragged down, it moves alone: the blue one stays where it was
    await page.mouse.move(green.x, green.y);
    await page.mouse.down();
    await page.mouse.move(green.x, green.y + 90, { steps: 8 });
    await page.mouse.up();
    const [g, b] = was.scraps.map(s => s.file),
      of = (p, file) => p.scraps.find(s => s.file === file);
    const moved = await savedWhere(c, free.id, p => of(p, g)?.y > of(was, g).y + 20);
    assert.deepEqual([of(moved, b).x, of(moved, b).y], [of(was, b).x, of(was, b).y], 'the other one stays');
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function words(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const asked = await playFetch(page, {});
    // (in a scrap made by a click on the blank page)
    await inScrap(page, c, free);
    // plain text from a long email, with its paragraphs: one box at a readable width, in view
    const sentence = 'The handle should feel warmer, a little rounder where the thumb rests. ';
    const plain = [1, 2, 3].map(n => `${n}. ${sentence.repeat(5).trim()}`).join('\r\n\r\n');
    await paste(page, { 'text/plain': plain });
    const one = await savedWhere(c, free.id, p => p.texts?.length === 1);
    const [box] = one.texts;
    assert.equal(box.text, plain.replaceAll('\r\n', '\n'), 'the words as pasted, their paragraphs kept');
    assert.ok(box.w <= READ && box.w >= 160, `wrapped at a readable width, not ${box.w} px`);
    await looksWhole(page, 1, c);
    await c.shot('book-paste-words', page);
    // a web page's HTML: its paragraphs and list as plain words
    const html =
      '<meta charset="utf-8"><h2>Mug notes</h2><p>Warmer   glaze,\n softer rim.</p><ul><li>Blue</li><li>Green</li></ul>' +
      '<script>alert(1)</script>';
    await paste(page, { 'text/html': html, 'text/plain': 'Mug notes Warmer glaze, softer rim. Blue Green' });
    const two = await savedWhere(c, free.id, p => p.texts.length === 2);
    assert.equal(two.texts[1].text, 'Mug notes\n\nWarmer glaze, softer rim.\n\n• Blue\n• Green', 'the page made plain');
    // a link alone: not a picture (the coordinator says so), so its words
    await paste(page, { 'text/plain': LINK });
    const three = await savedWhere(c, free.id, p => p.texts.length === 3);
    assert.equal(three.texts[2].text, LINK, 'the link as its words');
    assert.ok(asked.includes(LINK), 'the link was tried as a picture first');
    await looksWhole(page, 3, c);
    await c.shot('book-paste-link', page);
    await refusedSaid(page);
    // Undo takes each back, the last first
    for (const n of [2, 1, 0]) {
      await undo(page);
      await savedWhere(c, free.id, p => p.texts.length === n);
      assert.equal(await page.locator(TYPED).count(), n, `${n} boxes on the paper`);
    }
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// What doesn't land, said in words on the page, with no box added to the 3 there: a link whose picture didn't come, a
// link to a picture HQ can't draw and a file of another kind
async function refusedSaid(page) {
  await paste(page, { 'text/plain': DOWN });
  await page.getByText('That picture didn’t come: the site answered 503 for that picture').first().waitFor();
  assert.equal(await page.locator(TYPED).count(), 3, 'no box for a picture that didn’t come');
  await paste(page, { 'text/plain': HEIC });
  await page.getByText('That picture didn’t come: not a picture HQ can show').first().waitFor();
  assert.equal(await page.locator(TYPED).count(), 3, 'no box for a picture HQ can’t draw');
  await paste(page, {}, { name: 'quote.pdf', type: 'application/pdf' });
  await page.getByText('Only pictures and words land on a page').first().waitFor({ timeout: 5000 });
}

// ---- helpers

// The green picture shown on the grid's one card: a scrap of its own
async function onItsCard(page) {
  const green = await colourIn(page, GREEN),
    cards = await page.locator('#book .bk-page:not([hidden]) .bk-unit').evaluateAll(us =>
      us.map(u => {
        const r = u.getBoundingClientRect();
        return { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
      }),
    );
  assert.ok(green.n > 2000, `the dragged picture shows on the paper (${green.n} px)`);
  assert.equal(cards.length, 1, 'a scrap of its own on the grid');
  assert.ok(
    green.x > cards[0].x && green.x < cards[0].right && green.y > cards[0].y && green.y < cards[0].bottom,
    'on its card',
  );
}

// The coordinator's fetch of a picture on another site, played: the pictures it has by address, a site that's down
// (DOWN), a picture HQ can't draw (HEIC), else "a page, not a picture", as bookfetch.ts says of each. Returns the
// addresses asked, as they're asked.
async function playFetch(page, pictures) {
  const asked = [];
  await page.route('**/api/book/fetch?*', r => {
    const url = new URL(r.request().url()).searchParams.get('url');
    asked.push(url);
    const bytes = pictures[url];
    if (url === DOWN) return r.fulfill({ status: 502, json: { error: 'the site answered 503 for that picture' } });
    if (url === HEIC)
      return r.fulfill({
        status: 415,
        json: { error: 'not a picture HQ can show: a JPEG, PNG, GIF, WebP or AVIF only' },
      });
    return bytes
      ? r.fulfill({ contentType: 'image/png', body: bytes })
      : r.fulfill({ status: 415, json: { error: 'that address is a page, not a picture', page: true } });
  });
  return asked;
}
// A PNG of one colour, 240 × 160, as its bytes
const png = (page, colour) =>
  page
    .evaluate(async colour => {
      const cv = Object.assign(document.createElement('canvas'), { width: 240, height: 160 }),
        g = cv.getContext('2d');
      g.fillStyle = colour;
      g.fillRect(0, 0, 240, 160);
      const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, colour)
    .then(bytes => Buffer.from(bytes));
// A drag from beside let go at a point of the paper: its strings by type, and a picture file's bytes
const dropOn = (page, at, strings, file = null) =>
  page.evaluate(
    ([at, strings, file]) => {
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(strings)) dt.setData(type, value);
      if (file) dt.items.add(new File([new Uint8Array(file)], 'from-desktop.png', { type: 'image/png' }));
      const target = document.elementFromPoint(at.x, at.y);
      for (const type of ['dragenter', 'dragover', 'drop'])
        target.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }),
        );
    },
    [at, strings, file && [...file]],
  );
// Cmd/Ctrl+V of what the clipboard holds: its strings by type, and a file ({ name, type }) of a few bytes
const paste = (page, strings, file = null) =>
  page.evaluate(
    ([strings, file]) => {
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(strings)) dt.setData(type, value);
      if (file) dt.items.add(new File([new Uint8Array(64)], file.name, { type: file.type }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [strings, file],
  );
const undo = page => page.keyboard.press('Control+z');
// The boxes of words on the paper as the board sees them: n of them, within the paper's width, the last landed in
// view, no line of words wider than its box, and none over another
async function looksWhole(page, n, c) {
  const boxes = page.locator(TYPED);
  await page.waitForFunction(([n, typed]) => document.querySelectorAll(typed).length === n, [n, TYPED]);
  await page.waitForTimeout(c.settle); // (the table slides to show what landed)
  const paper = await paperBox(page);
  const seen = await boxes.evaluateAll(els =>
    els.map(el => {
      const box = el.getBoundingClientRect(),
        range = document.createRange(),
        words = el.querySelector('.bk-typed-words'),
        over = [];
      // (each character that shows: a wrapped line's last space hangs past the box, unseen, as pre-wrap sets it)
      const texts = document.createTreeWalker(words, NodeFilter.SHOW_TEXT);
      for (let text = texts.nextNode(); text; text = texts.nextNode())
        for (let i = 0; i < text.length; i++) {
          if (/\s/.test(text.data[i])) continue;
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const r = range.getBoundingClientRect();
          if (r.left < box.left - 1 || r.right > box.right + 1) over.push([text.data[i], Math.round(r.right)]);
        }
      return { box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom }, wider: over.length, over };
    }),
  );
  assert.equal(seen.length, n);
  for (const { box, wider, over } of seen) {
    assert.equal(wider, 0, `no line wider than its box: ${JSON.stringify(over)}`);
    assert.ok(box.x >= paper.x && box.right <= paper.x + paper.width, 'within the paper shown');
  }
  const last = seen.at(-1).box;
  assert.ok(last.y >= paper.y && last.y < paper.y + paper.height, 'the last landed in view');
  for (const [i, a] of seen.entries())
    for (const b of seen.slice(i + 1))
      assert.ok(
        a.box.bottom <= b.box.y || b.box.bottom <= a.box.y || a.box.right <= b.box.x || b.box.right <= a.box.x,
        'no box over another',
      );
}
