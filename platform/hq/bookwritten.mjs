// book-check.mjs's handwriting story (shared/review/written.js, the coordinator's handwriting.ts), held like an iPad mini
// with the book open, the reader and the voice line played, the board saying nothing: words written with the Pencil on
// HQ's page are read once the pen rests (one reading, of the ink alone): they fill the post-it and stand beside the ink
// as type, and Send puts them in the book as written; changed in the post-it first, they're the board's typed words,
// and the type goes; a note sent before its words were read takes them as they come, and the book shows them there,
// editable, unless the board typed others there first; a reading refused, before Send or after, or words read that the
// book didn't take, are told.
import assert from 'node:assert/strict';

// c: book-check's { hqOnStore, ui, reader, hush, posts, notes, pages, ceo (the CEO's name), noErrorsIn, shot }
export async function writtenStory(browser, c) {
  const { page, errors, done } = await c.hqOnStore(browser),
    before = { notes: c.notes.length, pages: c.pages.length };
  c.hush(true);
  try {
    const s = { ...c, page };
    await readAndSent(s);
    await changedFirst(s);
    await readLate(s);
    await typedLate(s);
    await refused(s);
    await notTaken(s);
    await refusedSent(s);
    c.noErrorsIn(errors);
  } finally {
    c.hush(false);
    Object.assign(c.reader, { words: '', ms: 0, refused: null });
    c.notes.splice(before.notes);
    c.pages.splice(before.pages);
    await done();
  }
}

// Written, the pen resting: one reading of the ink alone, its words in the post-it and beside the ink as type; Send
// keeps them, said 'written', and the type stays
async function readAndSent(s) {
  const { page, reader, ui } = s;
  reader.words = '+ same for the Sunday one?';
  const read = reader.inks.length; // (earlier stories' marks were read too)
  const box = await write(page, 120, 300),
    field = page.locator(ui('textarea'));
  // (at once: the stand-in reads as soon as the pen rests, and WebKit's post-it shows only once its screenshot's in)
  assert.equal(await typeBeside(page, box), 0, 'no type before the words are read');
  await page.waitForSelector(ui('.sheet:not([hidden])'));
  await until(() => field.inputValue(), reader.words, 'the words read fill the post-it');
  assert.equal(reader.inks.length, read + 1, 'one reading, once the pen rested');
  const ink = await picture(page, reader.inks.at(-1));
  assert.ok(ink.dark > 100 && ink.light > ink.dark * 4, `the ink alone, dark on white (${JSON.stringify(ink)})`);
  assert.ok(ink.width >= box.w && ink.height >= box.h, `the whole ink, at least as drawn (${JSON.stringify(ink)})`);
  assert.ok((await typeBeside(page, box)) > 50, 'the words stand beside the ink as type');
  await s.shot('book-written-read', page);
  const sent = await send(s);
  assert.deepEqual([sent.words, sent.said], [reader.words, 'written']);
  await page.waitForTimeout(300);
  assert.ok((await typeBeside(page, box)) > 50, 'in the book, the words stay beside the ink as type');
}

// Read, then changed in the post-it: the board's own words go, typed, and no type stands beside the ink
async function changedFirst(s) {
  const { page, reader, ui } = s;
  reader.words = 'Sunday too';
  const box = await write(page, 120, 470),
    field = page.locator(ui('textarea'));
  await until(() => field.inputValue(), reader.words, 'read');
  await field.fill('Sunday too, and Monday');
  await page.waitForTimeout(100);
  assert.equal(await typeBeside(page, box), 0, 'the words changed: no type beside the ink');
  const sent = await send(s);
  assert.deepEqual([sent.words, sent.said], ['Sunday too, and Monday', 'typed']);
}

// Sent before the pen rested: read at Send, the words come after the note went in, as its words, and the book shows
// them on the CEO's sheet, to be written over
async function readLate(s) {
  const { page, reader, posts } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: 2500 });
  const read = reader.inks.length;
  await write(page, 120, 640);
  const sent = await send(s);
  assert.equal(sent.words, '', 'sent with no words yet');
  assert.equal(reader.inks.length, read + 1, 'its lines read at Send');
  const id = s.notes.at(-1).id;
  await until(
    () => JSON.stringify(posts.find(p => p.path === '/api/book/note/edit' && p.body.id === id)?.body ?? null),
    JSON.stringify({ id, words: 'Lighter ink', said: 'written', was: '' }),
    'the words read go in the note',
  );
  const face = page.locator(`#book nav [title^="For ${s.ceo}"]`);
  await face.click();
  await inBook(s).waitFor({ timeout: 5000 });
  const words = inBook(s).getByRole('textbox');
  await until(() => words.inputValue(), 'Lighter ink', 'the book shows the words read');
  assert.ok(await words.isEditable(), 'the words can be written over in the book');
  await s.shot('book-written-late', page);
}

// Sent before the pen rested, and words typed on its note in the book while it's read: they're the board's, and the
// words read, coming later, don't go over them (the store refuses an edit made for the words it had)
async function typedLate(s) {
  const { page, reader, posts } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: 5000 });
  await write(page, 120, 390);
  await send(s);
  const id = s.notes.at(-1).id,
    words = inBook(s).getByRole('textbox');
  await words.fill('Darker, please');
  await until(() => s.notes.at(-1).words, 'Darker, please', 'typed in the book');
  await until(
    () => posts.some(p => p.path === '/api/book/note/edit' && p.body.id === id && p.body.said === 'written'),
    true,
    'the words read come',
  );
  await page.waitForTimeout(500);
  assert.deepEqual([s.notes.at(-1).words, s.notes.at(-1).said], ['Darker, please', 'typed'], "the board's words stay");
  assert.equal(await words.inputValue(), 'Darker, please', '...in the book too');
}

// A reading refused (the day's are used) with the post-it open: it says so, not a blank like ink with no writing; a
// line more, read, puts the words in and the message goes
async function refused(s) {
  const { page, reader, ui } = s;
  Object.assign(reader, {
    words: 'Hi',
    ms: 1000,
    refused: [429, "handwriting is read 300 times a day, and today's are used"],
  });
  await write(page, 300, 390);
  await page.waitForSelector(ui('.sheet:not([hidden])'));
  const msg = page.locator(ui('.msg'));
  await until(
    () => msg.textContent(),
    "Your handwriting wasn’t read: handwriting is read 300 times a day, and today's are used.",
    'the post-it says why the words are missing',
  );
  reader.refused = null;
  await write(page, 360, 240); // (above the post-it, open below the first line)
  await until(() => page.locator(ui('textarea')).inputValue(), 'Hi', 'read this time');
  assert.equal(await msg.textContent(), '', 'the failure no longer told beside the words read');
  await page.locator(ui('[data-cancel]')).dispatchEvent('click');
  await page.waitForSelector(ui('.sheet'), { state: 'hidden' });
  reader.refused = null;
}

// Words read after Send that the book didn't take (it failed): the board is told on the page
async function notTaken(s) {
  const { page, reader, ui } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: 1500 });
  await page.route('**/api/book/note/edit', r => r.fulfill({ status: 500, json: { error: 'the store broke' } }));
  try {
    await write(page, 300, 560);
    await send(s);
    await until(() => page.locator(ui('.tip.show')).isVisible(), true, 'the board is told the words read went nowhere');
    assert.equal(
      await page.locator(ui('.tip')).textContent(),
      `The book said no: the store broke. The words read for note ${s.notes.at(-1).n} aren’t in it.`,
    );
  } finally {
    await page.unroute('**/api/book/note/edit');
  }
}

// A reading refused that comes after Send: the page says so, or the note would look like ink with no writing
async function refusedSent(s) {
  const { page, reader, ui } = s;
  Object.assign(reader, { ms: 2500, refused: [504, 'the reader took too long'] });
  try {
    await write(page, 300, 700);
    await send(s);
    await until(
      () => page.locator(ui('.tip')).textContent(),
      'Your handwriting wasn’t read: the reader took too long. What it says isn’t in its note.',
      'the board is told its handwriting went unread',
    );
    assert.ok(await page.locator(ui('.tip.show')).isVisible());
  } finally {
    reader.refused = null;
  }
}

// ---- the Pencil and what it leaves

// The last note sent, in the book's open sheet of the CEO's
const inBook = s =>
  s.page.getByRole('region', { name: `For ${s.ceo}` }).getByRole('group', { name: `Note ${s.notes.at(-1).n}` });

// "Hi" written at x, y with the pen, three lines in a row, as Safari hands them over. Returns the ink's box.
async function write(page, x, y) {
  const line = (a, b, n = 10) =>
    Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  const lines = [
    line([x, y], [x, y + 40]),
    line([x + 22, y], [x + 22, y + 40]),
    line([x, y + 20], [x + 22, y + 20]),
    line([x + 36, y + 14], [x + 36, y + 40]),
  ];
  for (const pts of lines)
    await page.evaluate(pts => {
      const at = (kind, [x, y], pressure) =>
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(kind, {
            pointerId: 7,
            pointerType: 'pen',
            isPrimary: true,
            clientX: x,
            clientY: y,
            pressure,
            buttons: kind === 'pointerup' ? 0 : 1,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      at('pointerdown', pts[0], 0.4);
      pts.slice(1).forEach(p => at('pointermove', p, 0.5));
      at('pointerup', pts.at(-1), 0);
    }, pts);
  return { x, y, w: 36, h: 40 };
}
// Send on the post-it (headless WebKit paints and hit-tests a popping-in post-it late: the button's own click), the
// note it sent
async function send({ page, ui, posts }) {
  const noted = posts.filter(p => p.path === '/api/book/note').length;
  await page.locator(ui('.send')).dispatchEvent('click');
  await page.waitForSelector(ui('.sheet'), { state: 'hidden', timeout: 15_000 });
  await until(() => posts.filter(p => p.path === '/api/book/note').length, noted + 1, 'the note went in the book');
  return posts.filter(p => p.path === '/api/book/note')[noted].body;
}
// How many of review mode's ink pixels to the right of a box are type's dark (marks.js TYPE_INK), not the ink's red
const typeBeside = (page, b) =>
  page.evaluate(b => {
    const k = devicePixelRatio;
    let dark = 0;
    for (const c of document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > canvas')) {
      const x = Math.round((b.x + b.w + 8) * k),
        y = Math.round(b.y * k),
        w = Math.min(Math.round(240 * k), c.width - x),
        h = Math.round(24 * k);
      if (w <= 0 || h <= 0) continue;
      const d = c.getContext('2d').getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
    }
    return dark;
  }, b);
// A picture the reader got: its size, and its dark and light pixels
const picture = (page, src) =>
  page.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
      g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let dark = 0,
      light = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
      if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) light++;
    }
    return { width: img.width, height: img.height, dark, light };
  }, src);
// Waits till what() is the value wanted, failing on what it was then
async function until(what, want, why) {
  let got;
  for (let i = 0; i < 60; i++) {
    got = await what();
    if (got === want) return;
    await new Promise(res => setTimeout(res, 150));
  }
  assert.equal(got, want, why);
}
