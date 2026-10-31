// book-check.mjs's handwriting story (shared/review/written.js, the coordinator's handwriting.ts), held like an iPad mini
// with the book open, the reader and the voice line played, the board saying nothing: words written with the Pencil on
// HQ's page are read once the pen rests (one reading, of the ink alone) into its post-it's field, and Save puts them in
// the Notebook's scrap as written; a scrap saved before its words were read takes them as they come (groups/edit), and
// the book shows them there, editable, unless the board typed others there first; a reading refused, or words read that
// the Notebook didn't take, are told. (the post-it and Save)
import assert from 'node:assert/strict';
import { groupsOf } from './bookplayed.mjs';
import { savedScrap } from './bookscrap.mjs';
import { pressAlong, until } from './bookkit.mjs';

// A reading that comes after Save: longer than the post-it's photo takes to develop on a loaded worker
const LATE_MS = 9000;

// c: book-check's { hqOnStore, ui, reader, hush, posts, play (the Notebook's, played), pages, noErrorsIn, shot }
export async function writtenStory(browser, c) {
  const { page, errors, done } = await c.hqOnStore(browser),
    before = { pages: c.pages.length };
  c.hush(true);
  try {
    const s = { ...c, page };
    await readAndSaved(s);
    await readLate(s);
    await typedLate(s);
    await notTaken(s);
    await refusedSaved(s);
    c.noErrorsIn(errors);
  } finally {
    c.hush(false);
    Object.assign(c.reader, { words: '', ms: 0, refused: null });
    c.pages.splice(before.pages);
    await done();
  }
}

// Written, the pen resting: one reading of the ink alone, before the type of its words shows; its post-it's field has
// them, and the scrap Save puts in the Notebook, said 'written'
async function readAndSaved(s) {
  const { page, reader, ui } = s;
  reader.words = '+ same for the Sunday one?';
  const read = reader.inks.length, // (earlier stories' marks were read too)
    from = s.posts.length;
  const box = await write(page, 120, 300);
  assert.equal(await typeBeside(page, box), 0, 'no type before the words are read');
  await until(
    async () => (await page.locator(ui('.sheet textarea')).inputValue()) === reader.words,
    'the words read in its post-it',
  );
  assert.equal(reader.inks.length, read + 1, 'one reading, once the pen rested');
  const ink = await picture(page, reader.inks.at(-1));
  assert.ok(ink.dark > 100 && ink.light > ink.dark * 4, `the ink alone, dark on white (${JSON.stringify(ink)})`);
  assert.ok(ink.width >= box.w && ink.height >= box.h, `the whole ink, at least as drawn (${JSON.stringify(ink)})`);
  await s.shot('book-written-read', page);
  const sent = await savedScrap(s, from, 'written');
  assert.deepEqual([sent.words, sent.said], [reader.words, 'written'], 'the words read are the scrap’s, as written');
  assert.equal(reader.inks.length, read + 1, '...read once');
}

// Read slowly: the words come after the scrap was saved, as its words, and the book shows them on it, to be written
// over
async function readLate(s) {
  const { page, reader, posts } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: LATE_MS });
  const read = reader.inks.length,
    from = posts.length;
  await write(page, 120, 640);
  const sent = await savedScrap(s, from, 'read late');
  assert.equal(sent.words, '', 'in the Notebook with no words yet');
  assert.equal(reader.inks.length, read + 1, 'its lines read');
  const scrap = groupsOf(s.play).at(-1);
  await until(() => {
    const first = edits(s, from, scrap.id)[0];
    return first?.words === 'Lighter ink' && first.said === 'written';
  }, 'the words read go in the scrap');
  await changed(s, scrap);
  const words = inBook(s, scrap);
  await until(async () => (await words.inputValue()) === 'Lighter ink', 'the book shows the words read');
  // (a finger's tap first: on a touch screen a field's words are the pen's to strike until one, penwords.js)
  await words.tap();
  assert.ok(await words.isEditable(), 'the words can be written over in the book');
  await words.blur();
  await s.shot('book-written-late', page);
}

// Read slowly, and words typed on its scrap while it's read (on another screen: a scrap with no words has no field in
// the book, bookgroups.js): they're the board's, and the words read, coming later, don't go over them (the store
// refuses an edit made for the words it had)
async function typedLate(s) {
  const { page, reader, posts } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: LATE_MS + 4000 });
  const from = posts.length;
  await write(page, 120, 390);
  await savedScrap(s, from, 'typed late');
  const scrap = groupsOf(s.play).at(-1),
    words = inBook(s, scrap);
  s.play.route(
    '/api/notebooks/groups/edit',
    {},
    { id: scrap.id, since: scrap.updated, words: 'Darker, please', said: 'typed' },
  );
  await until(async () => (await words.inputValue()) === 'Darker, please', 'the book shows the words typed');
  await until(() => edits(s, from, scrap.id).some(e => e.said === 'written'), 'the words read come');
  await page.waitForTimeout(500);
  assert.deepEqual([now(s, scrap).words, now(s, scrap).said], ['Darker, please', 'typed'], "the board's words stay");
  assert.equal(await words.inputValue(), 'Darker, please', '...in the book too');
}

// Words read after the scrap was saved that the Notebook didn't take (it failed): the board is told on the page
async function notTaken(s) {
  const { page, reader, ui } = s;
  Object.assign(reader, { words: 'Lighter ink', ms: LATE_MS });
  await page.route('**/api/notebooks/groups/edit', r => r.fulfill({ status: 500, json: { error: 'the store broke' } }));
  try {
    const from = s.posts.length;
    await write(page, 300, 560);
    await savedScrap(s, from, 'not taken');
    await until(() => page.locator(ui('.tip.show')).isVisible(), 'the board is told the words read went nowhere');
    assert.equal(
      await page.locator(ui('.tip')).textContent(),
      'The book said no: the store broke. The words read for the scrap aren’t in it.',
    );
  } finally {
    await page.unroute('**/api/notebooks/groups/edit');
  }
}

// A reading refused after Save: the page says so, or the scrap would look like ink with no writing
async function refusedSaved(s) {
  const { page, reader, ui } = s;
  Object.assign(reader, { ms: LATE_MS, refused: [504, 'the reader took too long'] });
  try {
    const from = s.posts.length;
    await write(page, 300, 700);
    await savedScrap(s, from, 'refused');
    // (shown for a while: its words read while it shows)
    const tip = () =>
      page
        .locator(ui('.tip.show'))
        .textContent({ timeout: 500 })
        .catch(() => null);
    await until(
      async () =>
        (await tip()) === 'Your handwriting wasn’t read: the reader took too long. What it says isn’t in its note.',
      'the board is told its handwriting went unread',
    );
  } finally {
    reader.refused = null;
  }
}

// ---- the Pencil and what it leaves

const inBook = (s, scrap) => s.page.locator(`#book .bk-words[data-g="${scrap.id}"] textarea.bk-scrap-words`);
const now = (s, scrap) => groupsOf(s.play).find(g => g.id === scrap.id);
const edits = (s, from, id) =>
  s.posts
    .slice(from)
    .filter(p => p.path === '/api/notebooks/groups/edit' && p.body.id === id)
    .map(p => p.body);
// The store's 'book' event for the scrap's page, as the coordinator publishes on every change (notebook.ts): the book
// reads its groups again
const changed = (s, scrap) =>
  s.page.evaluate(page => document.dispatchEvent(new CustomEvent('book:changed', { detail: { page } })), scrap.page);

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
  for (const pts of lines) await pressAlong(page, pts);
  return { x, y, w: 36, h: 40 };
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
