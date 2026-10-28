// node --test src/ink/bookwriting.test.ts   (the board's writing on a sheet page going with the sheet's notes, on the real
// server: the send's spots, the page's ink read by the worker's claim and answer, each line under the nearest note in
// its owner's task, ink that went never going again, a failed reading pointing at the page)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('bookwriting');
const { ORIGIN } = await import('../config.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');

const anchor = {
  v: 1,
  url: `${ORIGIN}/?open=projects`,
  el: null,
  view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
  ink: [],
};
// a line of handwriting across the page from x at y, n px long
const line = (x: number, y: number, n: number) => ({
  color: '#1d9a5b',
  size: 4,
  points: Array.from({ length: Math.ceil(n / 10) + 1 }, (_, i) => [x + i * 10, y + 4 * Math.sin(i), 0.5, i * 16]),
});
const page = (
  await h.board('/api/book/page/new', { kind: 'sheet', owner: 'moss', url: '/?open=gazette', w: 600, h: 2000 })
).body;
const note = async (words: string) =>
  (await h.board('/api/book/note', { page: page.id, anchor, words, said: 'typed' })).body.note;
// the page's ink so far, saved as the book saves it
const ink: ReturnType<typeof line>[] = [];
const write = (...lines: ReturnType<typeof line>[]) => {
  ink.push(...lines);
  return h.board('/api/book/page/save', { id: page.id, ink, scraps: [] });
};
// a note where the book lays it out: down the page's left at y, or at x
const spot = (n: { id: number }, y: number, x = 20) => ({ note: n.id, page: page.id, x, y, w: 260, h: 120 });
const due = () => booksheets.deliverDue(Date.now() + booknotes.SEND_MS);

// The next reading the worker claims, with its picture's width
async function claimed() {
  for (let i = 0; i < 100; i++) {
    const c = (await h.worker('reads/claim')).body;
    // (the book's judge's calls for the notes, answered none: bookjudge.ts)
    if (c.reading && JSON.parse(c.schema).properties.reply) {
      await h.worker('reads/answer', {
        reading: c.reading,
        result: { is_error: false, structured_output: { reply: 'none', why: 'test' } },
      });
      continue;
    }
    if (c.reading) {
      const png = Buffer.from(c.content[0].source.data, 'base64');
      return { reading: c.reading as string, width: (await sharp(png).metadata()).width! };
    }
    await new Promise(res => setTimeout(res, 20));
  }
  return null;
}
const answer = (reading: string, words: string) =>
  h.worker('reads/answer', { reading, result: { is_error: false, structured_output: { writing: !!words, words } } });
// The sheet as HQ reads it
const sheetOf = (id: number) => {
  const { open, sent } = booksheets.sheets();
  return [...open, ...sent].find(s => s.id === id)!;
};
async function sentJob(id: number) {
  for (let i = 0; i < 100 && sheetOf(id).status !== 'sent'; i++) await new Promise(res => setTimeout(res, 20));
  return h.db.prepare('select * from jobs where id = ?').get(sheetOf(id).job) as any;
}

test("the board's writing on the sheet goes with its notes, each line under the note nearest it", async () => {
  // the morning's writing: a long line right of the top note, a short word under the lower one
  const morning = [line(340, 60, 200), line(40, 420, 40), line(90, 422, 30)];
  const early = await note('The date line');
  await write(...morning);
  for (const spots of [
    [{ note: 99_999, page: page.id, x: 0, y: 0, w: 1, h: 1 }],
    'here',
    [{ ...spot(early, 20), x: 'a' }],
  ])
    assert.equal((await h.board('/api/book/send', { id: early.sheet, spots })).status, 400, JSON.stringify(spots));
  // undone, then sent from a book that says where nothing lies: nothing is read
  await h.board('/api/book/send', { id: early.sheet, spots: [spot(early, 20)] });
  await h.board('/api/book/undo', { id: early.sheet });
  await h.board('/api/book/send', { id: early.sheet });
  due();
  assert.equal(await claimed(), null, 'the undo took its spots back');
  assert.doesNotMatch((await sentJob(early.sheet)).prompt, /beside this note/);

  const top = await note('The headline wraps'),
    low = await note('And the byline');
  const sheet = top.sheet;
  await h.board('/api/book/send', { id: sheet, spots: [spot(top, 20), spot(low, 260)] });
  due();
  assert.equal(sheetOf(sheet).status, 'sending', 'it waits for its writing to be read');
  const readings = [await claimed(), await claimed()];
  assert.ok(readings.every(Boolean), 'one reading a note with writing beside it');
  due();
  assert.equal(await claimed(), null, 'a sheet being read is read once');
  const [wide, small] = [...readings].sort((a, b) => b!.width - a!.width);
  await answer(small!.reading, 'smaller please');
  await answer(wide!.reading, 'same on Sunday');
  const job = await sentJob(sheet);
  assert.equal(job.agent, 'moss');
  const [, first, second] = job.prompt.split(/^## Note /m);
  assert.match(first, /The headline wraps\n[^]*beside this note on the sheet, in its own hand: “same on Sunday”/);
  assert.match(second, /And the byline\n[^]*beside this note on the sheet, in its own hand: “smaller please”/);
  assert.doesNotMatch(first, /smaller please/);
});

test("writing nearest another sheet's note on the page stays there, and goes with that sheet", async () => {
  // Kit's note and Moss's side by side on Moss's page, a line under each
  const kits = await note('The footer'),
    kitSheet = (await h.board('/api/book/note/move', { id: kits.id, to: 'kit' })).body.sheet.id;
  const moss = await note('The masthead'),
    spots = [spot(kits, 960), spot(moss, 960, 320)];
  await write(line(40, 1100, 100), line(340, 1100, 60));
  await h.board('/api/book/send', { id: moss.sheet, spots });
  due();
  const masthead = await claimed();
  assert.ok(masthead);
  assert.equal(await claimed(), null, "the line under Kit's note isn't read with Moss's sheet");
  await answer(masthead!.reading, 'in red');
  assert.match((await sentJob(moss.sheet)).prompt, /The masthead\n[^]*“in red”/);

  await h.board('/api/book/send', { id: kitSheet, spots });
  due();
  const footer = await claimed();
  assert.ok(footer, "the line under Kit's note goes with Kit's sheet");
  await answer(footer!.reading, 'smaller');
  const job = await sentJob(kitSheet);
  assert.equal(job.agent, 'kit');
  assert.match(job.prompt, /The footer\n[^]*“smaller”/);
  assert.doesNotMatch(job.prompt, /in red/);
});

test('writing beside a note wiped while it was read stays on the page for the note brought back', async () => {
  const price = await note('The price'),
    photo = await note('The photo');
  await write(line(340, 1340, 120), line(340, 1600, 60));
  await h.board('/api/book/send', { id: price.sheet, spots: [spot(price, 1300), spot(photo, 1560)] });
  due();
  const readings = [await claimed(), await claimed()];
  assert.ok(readings.every(Boolean));
  await h.board('/api/book/note/delete', { id: photo.id });
  const [wide, small] = [...readings].sort((a, b) => b!.width - a!.width);
  await answer(wide!.reading, 'twelve euros');
  await answer(small!.reading, 'a brighter one');
  const job = await sentJob(price.sheet);
  assert.match(job.prompt, /The price\n[^]*“twelve euros”/);
  assert.doesNotMatch(job.prompt, /The photo|a brighter one/);

  const back = (await h.board('/api/book/note/restore', { id: photo.id })).body.note;
  await h.board('/api/book/send', { id: back.sheet, spots: [spot(back, 1560)] });
  due();
  const again = await claimed();
  assert.ok(again, 'its writing never went');
  await answer(again!.reading, 'a brighter one');
  assert.match((await sentJob(back.sheet)).prompt, /The photo\n[^]*“a brighter one”/);
});

test('ink that went once never goes again; a doodle goes as nothing; writing that fails to read points at the page', async () => {
  const third = await note('The byline again'),
    sheet = third.sheet;
  // a mark drawn near the new note, the writing above it gone already
  await write(line(40, 1800, 60));
  await h.board('/api/book/send', { id: sheet, spots: [spot(third, 1740)] });
  due();
  const ring = await claimed();
  assert.ok(ring, 'only the new ink is read');
  assert.equal(await claimed(), null, 'the writing that went with earlier sheets stays gone');
  await answer(ring!.reading, '');
  const job = await sentJob(sheet);
  assert.doesNotMatch(job.prompt, /beside this note/, 'marks only: nothing quoted');

  // writing the reader fails on: the owner is told to look at the page
  const fourth = await note('The lede');
  await write(line(40, 1950, 120));
  await h.board('/api/book/send', { id: fourth.sheet, spots: [spot(fourth, 1890)] });
  due();
  for (let i = 0; i < 2; i++) {
    const c = await claimed();
    await h.worker('reads/answer', { reading: c!.reading, error: 'exit 1' });
  }
  const failed = await sentJob(fourth.sheet);
  assert.match(failed.prompt, new RegExp(`couldn't be read: \`hq sketch ${page.id}\` shows the page`));
});
