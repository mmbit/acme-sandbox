// node --test src/booksearch.test.ts   (the book's Search on the real server, the board's session)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('booksearch');
const { base, db } = h;
const { ORIGIN } = await import('./config.ts');
const book = await import('./book.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');

const anchor = {
  v: 1,
  url: `${ORIGIN}/?open=projects`,
  el: { selector: '#projects > li:nth-child(2)', tag: 'li', text: 'Teacups', box: { x: 10, y: 400, w: 300, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 300, dpr: 2 },
  ink: [
    {
      color: '#2B2230',
      size: 8,
      points: [
        [10, 20, 0.5, 0],
        [190, 120, 0.6, 16],
      ],
    },
  ],
};
const newPage = async (body: Record<string, unknown>) =>
  (await h.board('/api/book/page/new', { w: 800, h: 600, ...body })).body;
const note = async (page: number, words: string, said: string) =>
  (await h.board('/api/book/note', { page, anchor, words, said })).body.note;
const find = async (q: string) => (await h.board(`/api/book/search?q=${encodeURIComponent(q)}`)).body;

test("notes' words, written, said or typed, and answers on them are found with their note, page and day", async () => {
  const yesterday = await newPage({ kind: 'sheet', owner: 'wren', url: '/?open=studio' }),
    today = await newPage({ kind: 'free' });
  db.prepare("update book_pages set day = '2026-10-25' where id = ?").run(yesterday.id);
  const said = await note(yesterday.id, 'The tear line is too dark next to the others', 'spoken');
  const written = await note(yesterday.id, 'Bigger price, like the café’s', 'written');
  await note(today.id, 'Tear-off strip on the left', 'typed');
  await note(today.id, '', 'typed');
  // (wren answers the spoken note, after the notes)
  const sheet = (db.prepare('select sheet from book_notes where id = ?').get(said.id) as { sheet: number }).sheet;
  await h.board('/api/book/send', { id: sheet });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const job = await h.claimJob(
    (db.prepare('select job from book_sheets where id = ?').get(sheet) as { job: number }).job,
  );
  const review = (db.prepare('select review from book_notes where id = ?').get(said.id) as { review: number }).review;
  assert.equal(
    (await h.agent('answer', job.token, { note: review, text: 'Lighter now: half the old ink on the tear line' }))
      .status,
    200,
  );

  const tear = await find('tear');
  assert.equal(tear.total, 3);
  assert.deepEqual(
    tear.found.map((f: any) => [f.how, f.day, f.text]),
    [
      ['typed', tear.found[0].day, 'Tear-off strip on the left'],
      ['answer', '2026-10-25', 'Lighter now: half the old ink on the tear line'],
      ['spoken', '2026-10-25', 'The tear line is too dark next to the others'],
    ],
  );
  const spoken = tear.found[2];
  assert.deepEqual(
    [spoken.note, spoken.n, spoken.page, spoken.kind, spoken.owner, spoken.by],
    [said.id, 1, yesterday.id, 'sheet', 'wren', 'board'],
  );
  assert.equal(tear.found[1].by, 'wren', 'an answer says who answered');
  assert.equal(tear.found[1].note, said.id, 'on the note it answers');
  // (a free page's note is on nobody's sheet)
  assert.equal(tear.found[0].owner, null);

  // every word of the query, each the start of a word, with or without its accent
  assert.deepEqual(
    (await find('tear dark')).found.map((f: any) => f.how),
    ['spoken'],
  );
  assert.deepEqual(
    (await find('cafe')).found.map((f: any) => [f.note, f.how]),
    [[written.id, 'written']],
  );
  assert.deepEqual((await find('ear')).found, []);
  assert.deepEqual(await find(''), { q: '', found: [], total: 0 });
});

test('handwriting read into type after its note went is found by its words, as written', async () => {
  // (a 1 × 1 white PNG stands in for the board's ink; the worker's model reads it)
  const ink =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
  const asked = h.board('/api/book/read', { ink });
  let reading = '';
  for (let i = 0; i < 50 && !reading; i++) {
    reading = (await h.worker('reads/claim')).body.reading ?? '';
    if (!reading) await new Promise(res => setTimeout(res, 20));
  }
  const structured_output = { writing: true, words: 'Swap the\n mugs’ order?' };
  await h.worker('reads/answer', { reading, result: { is_error: false, structured_output } });
  const { words } = (await asked).body;
  // (Send went before the reading came: the note with no words, then the words read in as an edit, written.js settle)
  const page = await newPage({ kind: 'free' });
  const sent = await note(page.id, '', 'typed');
  assert.equal(
    (await h.board('/api/book/note/edit', { id: sent.id, words, said: 'written', was: sent.words })).status,
    200,
  );

  assert.deepEqual(
    (await find('mugs order')).found.map((f: any) => [f.note, f.how, f.text]),
    [[sent.id, 'written', 'Swap the mugs’ order?']],
  );
});

test("only the board's own book, and only the board searches", async () => {
  const page = book.createPage({ kind: 'free', w: 400, h: 400 }, 'guest:7') as { id: number };
  const guests = booknotes.addNote({ page: page.id, anchor, words: 'Hidden teacups', said: 'typed' }, 'guest:7') as any;
  assert.equal(guests.note.words, 'Hidden teacups');
  assert.deepEqual((await find('teacups')).found, [], "a guest's own book isn't the board's");
  const outside = await fetch(`${base}/api/book/search?q=tear`);
  assert.equal(outside.status, 401, 'no session, no search');
});
