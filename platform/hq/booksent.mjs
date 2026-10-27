// book-check.mjs's story of a sheet's send as the board lives it (shell/booksheet.js, bookplane.js, bookwent.js,
// booksheetlay.js, shared/review/notenumbers.js), on book-check's played store.
// Kit's sheet page holds a sheet sent this morning, the board's handwriting under it, then a new note: the new note
// lies clear of the writing and of the sent one, and no note is numbered (one open note: nothing to tell apart). A
// second note comes: the two open ones are numbered 1 and 2, the sent one none, never two the same. Kit's face is
// ringed, a small plane by it: its tap says for a moment, on the page, what goes to whom ("2 notes to Kit", their two
// snips, the page's writing going beside them); the ring round the plane says it's on its way; then the sheet keeps the
// line "2 notes sent to Kit · 15:36" and the plane steps back. (by the face) The
// send tells the store where each note lies on the page, in its px, so the writing goes beside the nearest
// (bookwriting.ts).
import assert from 'node:assert/strict';

// c: book-check's { browser, hqIn, base, viewport, settled, pages, notes, snips, sentSheets, sheets, renumber, SNIP,
// shot, noErrorsIn, posts }, and look ('&renderer=wire' for Wire)
export async function sentStory(c) {
  const f = fixtures(c);
  const context = await c.hqIn(c.browser, c.viewport),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0${c.look}`);
    await page.waitForSelector('#loading.gone');
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
    await page.click('#book .bk-face[aria-label^="For Kit"]');
    const kits = page.getByRole('region', { name: 'For Kit' });
    await kits.getByRole('group').nth(1).waitFor({ timeout: 5000 });
    await page.waitForTimeout(700);
    await clearOfWriting(page, kits, 'the new note');
    assert.deepEqual(await numbersOn(kits), [], 'one open note, nothing to tell apart: no numbers');
    await c.shot('sent-one-note', page);
    // a second note comes onto Kit's sheet
    c.notes.push(f.second);
    c.renumber();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('book:changed')));
    await kits.getByRole('group').nth(2).waitFor({ timeout: 5000 });
    await page.waitForTimeout(700);
    const numbers = await numbersOn(kits);
    assert.deepEqual(numbers, ['1', '2'], `the open notes numbered 1 and 2, the sent one none: ${numbers}`);
    await clearOfWriting(page, kits, 'the two new notes');
    await planeByFace(page);
    await c.shot('sent-plane-by-face', page);
    await sends(page, kits, c, f);
    c.noErrorsIn(errors);
  } finally {
    putAway(c, f);
    await context.close();
  }
}

// c: as sentStory's, viewport the board's phone. On a phone the folded book's lip
// is all there is of it: with notes waiting it shows the plane and their count, and its tap opens the book at a sheet
// with the plane by its face. (The board found no way to send from the lip: it opened the
// book at its own page, with no plane on it.)
export async function phoneSendStory(c) {
  const f = fixtures(c);
  c.notes.push(f.second);
  c.renumber();
  const context = await c.hqIn(c.browser, c.viewport),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone');
    await c.settled(page, 'folded');
    await c.shot('send-phone-folded', page);
    await (await handleOf(page, c.viewport)).tap();
    await c.settled(page, 'spread');
    // (the handle opens the book where it was: Kit's face turns it to their sheet.)
    await page.locator('#book .bk-face[data-id="kit"]').tap();
    // (the plane by its face, on the screen as the book opens.)
    const plane = page.locator('#book .bk-plane').first();
    await plane.waitFor({ timeout: 5000 });
    await page.waitForTimeout(700);
    const at = await plane.boundingBox();
    assert.ok(
      at && at.y >= 0 && at.x >= 0 && at.x + at.width <= c.viewport.width && at.y + at.height <= c.viewport.height,
      `the plane on the screen as the book opens: ${JSON.stringify(at)}`,
    );
    assert.match(await plane.getAttribute('aria-label'), /^Send to /, 'it says whom it sends to');
    await c.shot('send-phone-open', page);
    c.noErrorsIn(errors);
  } finally {
    putAway(c, f);
    await context.close();
  }
}

// The folded book's handle: on the screen at its edge, big enough to tap, and no count of notes waiting to be sent on
// it, nothing nudging to send
async function handleOf(page, screen) {
  const handle = page.locator('#book .bk-lip'),
    box = await handle.boundingBox();
  assert.doesNotMatch(await handle.getAttribute('aria-label'), /to send/);
  assert.equal((await handle.innerText()).trim(), '', 'words or a count on the handle');
  assert.ok(
    box && box.height >= 44 && Math.abs(box.x + box.width - screen.width) <= 1,
    `the handle at the screen's edge, big enough to tap: ${JSON.stringify(box)}`,
  );
  return handle;
}
// The played store as it was before fixtures(c)
function putAway(c, f) {
  c.pages.splice(c.pages.indexOf(f.sheetPage), 1);
  for (const n of [f.gone, f.first, f.second]) if (c.notes.includes(n)) c.notes.splice(c.notes.indexOf(n), 1);
  c.sentSheets.splice(0, c.sentSheets.length, ...c.sentSheets.filter(s => s.owner !== 'kit'));
  c.sheets.delete('kit');
}

// Kit's sheet page, long, with the board's handwriting (green) across it where a next note would go; a note sent this
// morning; a new note on Kit's open sheet, numbered 1 there as the sent one was on its own; and the one to come
// a line of the board's handwriting across the page at y, in green
const writing = y => ({
  color: '#1d9a5b',
  size: 5,
  points: Array.from({ length: 34 }, (_, i) => [30 + i * 12, y + 6 * Math.sin(i), 0.5, i * 16]),
});
function fixtures(c) {
  const view = { w: 1133, h: 744, x: 0, y: 0, dpr: 2 };
  const sheetPage = {
    id: 9500,
    kind: 'sheet',
    owner: 'kit',
    url: '/?open=shop',
    label: '',
    w: 455,
    h: 1500,
    ink: [215, 255, 295, 335].map(writing),
  };
  const note = (id, n, words, status) => {
    c.snips.set(id, c.SNIP);
    return {
      id,
      n,
      page: sheetPage.id,
      owner: 'kit',
      anchor: { v: 1, url: '/?open=shop', el: null, view, ink: [] },
      words,
      said: 'typed',
      by: 'board',
      snip: `/api/book/snip?id=${id}`,
      status,
      links: [],
      slips: [],
    };
  };
  const gone = note(9501, 1, 'Text gets clipped', 'sent'),
    first = note(9502, 1, 'The basket is too small', 'open'),
    second = note(9503, 2, 'And the price, bigger', 'open');
  c.pages.push(sheetPage);
  c.notes.push(gone, first);
  c.renumber();
  c.sentSheets.unshift({
    id: 9504,
    owner: 'kit',
    name: null,
    page: null,
    status: 'sent',
    send_at: null,
    sent: new Date(Date.now() - 3600_000).toISOString(),
    notes: [gone],
  });
  return { sheetPage, gone, first, second };
}

// The numbers the board reads beside the notes on a sheet page, top to bottom
const numbersOn = region =>
  region
    .getByRole('group')
    .evaluateAll(gs => gs.map(g => g.innerText.trim().split('\n')[0]).filter(t => /^\d+$/.test(t)));

// Every note on the page as the board sees it: none on the handwriting (no green of its ink inside a note), none on
// another, and the handwriting still there to see on the page
async function clearOfWriting(page, region, what) {
  const boxes = [];
  for (const g of await region.getByRole('group').all()) boxes.push(await g.boundingBox());
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1))
      assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y, `two notes overlap: ${JSON.stringify([a, b])}`);
  const paper = await page.getByRole('region', { name: 'The book' }).boundingBox(),
    sheet = await region.boundingBox();
  const all = await greenIn(page, { x: sheet.x, y: paper.y, width: sheet.width, height: paper.height });
  assert.ok(all > 400, `the handwriting shows on the page (${all} of its pixels)`);
  for (const [i, b] of boxes.entries()) {
    const top = Math.max(b.y, paper.y),
      bottom = Math.min(b.y + b.height, paper.y + paper.height);
    if (bottom <= top) continue;
    const green = await greenIn(page, { x: b.x, y: top, width: b.width, height: bottom - top });
    assert.ok(green < 4, `${what}: note ${i + 1} lies on the handwriting (${green} of its pixels)`);
  }
}
// Where each note shows on the page, in the page's px (the region's width on screen is the page's w), by its id
async function spotsOn(page, region, w) {
  const paper = await region.boundingBox(),
    k = w / paper.width,
    out = new Map();
  for (const g of await region.locator('.bs-note').all()) {
    const b = await g.boundingBox();
    out.set(Number(await g.getAttribute('data-id')), {
      x: (b.x - paper.x) * k,
      y: (b.y - paper.y) * k,
      w: b.width * k,
      h: b.height * k,
    });
  }
  return out;
}
// How many of the screen's pixels in a box are the handwriting's green
async function greenIn(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      c.getContext('2d').drawImage(img, 0, 0);
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height),
        near = (i, v) => Math.abs(data[i] - v) < 40;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (near(i, 29) && near(i + 1, 154) && near(i + 2, 91)) n++;
      return n;
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
}

// Kit's sheet shown: Kit's face ringed, the plane right by it saying whom it sends to, nothing over it
async function planeByFace(page) {
  const face = page.locator('#book .bk-face[data-id="kit"]'),
    plane = page.getByRole('button', { name: 'Send to Kit' });
  assert.equal(await face.getAttribute('data-here'), '', "Kit's face says the book is on Kit's sheet");
  const at = await plane.boundingBox(),
    by = await face.boundingBox();
  assert.ok(
    at && Math.abs(at.y + at.height / 2 - (by.y + by.height / 2)) < 4 && by.x - (at.x + at.width) < 6,
    `the plane right by the face: ${JSON.stringify([at, by])}`,
  );
  const top = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
    { x: at.x + at.width / 2, y: at.y + at.height / 2 },
  );
  assert.equal(top, 'Send to Kit', 'the plane is what shows there, nothing over it');
}

// The plane's tap: what goes to whom shows on the page for a moment, a ring round the plane in the seconds to undo;
// then the sheet's line of what went to whom, and no plane
async function sends(page, region, c, f) {
  const from = c.posts.length,
    spots = await spotsOn(page, region, f.sheetPage.w),
    plane = page.locator('#book .bk-plane[data-for="kit"]');
  await plane.click();
  const said = region.getByRole('status');
  await said.waitFor({ timeout: 2000 });
  const text = (await said.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /^2 notes to Kit\b/, `it says what goes to whom: ${text}`);
  assert.match(text, /and any new writing you put beside it\.$/, 'and that the writing on the page goes with them');
  const send = c.posts.slice(from).find(p => p.path === '/api/book/send');
  assert.ok(send, 'the send reached the store');
  assert.deepEqual(
    send.body.spots.map(s => [s.note, s.page]).sort(),
    [
      [f.gone.id, f.sheetPage.id],
      [f.first.id, f.sheetPage.id],
      [f.second.id, f.sheetPage.id],
    ],
    'each note on the page named, the sent one too: writing nearest it stays',
  );
  for (const s of send.body.spots) {
    const shown = spots.get(s.note);
    for (const k of ['x', 'y', 'w', 'h'])
      assert.ok(Math.abs(s[k] - shown[k]) < 2, `note ${s.note}'s place on the page: ${JSON.stringify([s, shown])}`);
  }
  const snips = await said
    .locator('img')
    .evaluateAll(imgs => imgs.filter(i => i.complete && i.naturalWidth > 0).length);
  assert.equal(snips, 2, "each note's snip, small");
  const paper = await page.getByRole('region', { name: 'The book' }).boundingBox(),
    box = await said.boundingBox();
  assert.ok(box.y >= paper.y && box.y + box.height <= paper.y + paper.height, 'on the paper in view');
  await c.shot('sent-going', page);
  assert.match(await plane.getAttribute('aria-label'), /^Sending to Kit/, 'the ringed plane says it’s on its way');
  await said.waitFor({ state: 'detached', timeout: 4000 });
  const line = region.getByText(/^2 notes sent to Kit · \d\d:\d\d$/);
  await line.waitFor({ timeout: 16_000 });
  const earlier = region.getByText(/^1 note sent to Kit · \d\d:\d\d$/);
  assert.ok(await earlier.isVisible(), "the morning's sheet keeps its own line");
  assert.equal(await plane.count(), 0, 'nothing left to send: no plane');
  await c.shot('sent-gone', page);
}
