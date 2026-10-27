// book-check.mjs's handwriting story (shared/review/written.js, the coordinator's handwriting.ts), held like an iPad mini
// with the book open, the reader and the voice line played, the board saying nothing: words written with the Pencil on
// HQ's page are read once the pen rests (one reading, of the ink alone), and the note that goes into the book as the
// mark settles has them as written; a note in before its words were read takes them as they come, and the book shows
// them there, editable, unless the board typed others there first; a reading refused, or words read that the book
// didn't take, are told. (no post-it)
import assert from 'node:assert/strict';

// c: book-check's { hqOnStore, ui, reader, hush, posts, notes, pages, ceo (the CEO's name), noErrorsIn, shot }
export async function writtenStory(browser, c) {
  const { page, errors, done } = await c.hqOnStore(browser),
    before = { notes: c.notes.length, pages: c.pages.length };
  c.hush(true);
  try {
    const s = { ...c, page, seen: c.posts.filter(p => p.path === '/api/book/note').length };
    await readAndSent(s);
    await readLate(s);
    await typedLate(s);
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

// Written, the pen resting: one reading of the ink alone, before the type of its words shows; the note in the book
// has them, said 'written'
async function readAndSent(s) {
  const { page, reader } = s;
  reader.words = '+ same for the Sunday one?';
  const read = reader.inks.length; // (earlier stories' marks were read too)
  const box = await write(page, 120, 300);
  assert.equal(await typeBeside(page, box), 0, 'no type before the words are read');
  await send(s);
  const id = s.notes.at(-1).id;
  await until(
    () => JSON.stringify([s.notes.at(-1).words, s.notes.at(-1).said]),
    JSON.stringify([reader.words, 'written']),
    'the words read are the note’s, as written',
  );
  assert.equal(s.notes.at(-1).id, id);
  assert.equal(reader.inks.length, read + 1, 'one reading, once the pen rested');
  const ink = await picture(page, reader.inks.at(-1));
  assert.ok(ink.dark > 100 && ink.light > ink.dark * 4, `the ink alone, dark on white (${JSON.stringify(ink)})`);
  assert.ok(ink.width >= box.w && ink.height >= box.h, `the whole ink, at least as drawn (${JSON.stringify(ink)})`);
  await s.shot('book-written-read', page);
}

// Read slowly: the words come after the note went in, as its words, and the book shows them on the CEO's sheet, to be
// written over
async function readLate(s) {
  const { page, reader, posts } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: 2500 });
  const read = reader.inks.length;
  await write(page, 120, 640);
  const sent = await send(s);
  assert.equal(sent.words, '', 'in the book with no words yet');
  assert.equal(reader.inks.length, read + 1, 'its lines read');
  const id = s.notes.at(-1).id;
  await until(
    () => JSON.stringify(posts.find(p => p.path === '/api/book/note/edit' && p.body.id === id)?.body ?? null),
    JSON.stringify({ id, words: 'Lighter ink', said: 'written', was: '' }),
    'the words read go in the note',
  );
  // (by its name: the book has no title= since its own tooltips.)
  const face = page.locator(`#book nav [aria-label^="For ${s.ceo}"]`);
  await face.click();
  await inBook(s).waitFor({ timeout: 5000 });
  const words = inBook(s).getByRole('textbox');
  await until(() => words.inputValue(), 'Lighter ink', 'the book shows the words read');
  assert.ok(await words.isEditable(), 'the words can be written over in the book');
  await s.shot('book-written-late', page);
}

// Read slowly, and words typed on its note in the book while it's read: they're the board's, and the
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

// Words read after the note went in that the book didn't take (it failed): the board is told on the page
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

// A reading refused: the page says so, or the note would look like ink with no writing
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

// The last note sent, in the book's open sheet of the CEO's: the last on its page (numbered only beside others there:
const inBook = s =>
  s.page
    .getByRole('region', { name: `For ${s.ceo}` })
    .getByRole('group')
    .last();

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
// The pen rested: the note that went in the book as the mark settled, the one after the last one this story saw
async function send(s) {
  const notes = () => s.posts.filter(p => p.path === '/api/book/note'),
    noted = s.seen;
  await until(() => notes().length, noted + 1, 'the note went in the book');
  s.seen = noted + 1;
  return notes()[noted].body;
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
