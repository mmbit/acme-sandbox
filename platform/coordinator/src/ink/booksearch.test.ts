// node --test src/ink/booksearch.test.ts   (the book's Search on the real server, the board's session)
// (the notebooks' groups)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../harness.ts';

const h = await harness('booksearch');
const { base, db } = h;
const { ORIGIN } = await import('../config.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');

// (a 1 × 1 white PNG for a snip)
const SNIP =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
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
// A scrap with its words on My journal's current page
const scrap = async (words: string, said: string, owner: string | null = null) =>
  (await h.board('/api/notebooks/groups/scrap', { anchor, words, said, snip: SNIP, owner })).body;
const find = async (q: string) => (await h.board(`/api/book/search?q=${encodeURIComponent(q)}`)).body;

test("scraps' words, said or typed, and answers under them are found with their group, page and day", async () => {
  const said = await scrap('The tear line is too dark next to the others', 'spoken', 'wren');
  const other = await scrap('Bigger price, like the café’s', 'typed');
  const yesterday = said.page;
  db.prepare("update book_pages set day = '2026-10-25' where id = ?").run(yesterday);
  // (the page sent, and wren answering the spoken scrap's note)
  await h.board('/api/notebooks/pages/send', { id: yesterday });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const { note } = db.prepare('select note from notebook_groups where id = ?').get(said.id) as { note: number };
  const { job } = db
    .prepare('select s.job from book_notes n join book_sheets s on s.id = n.sheet where n.id = ?')
    .get(note) as { job: number };
  const run = await h.claimJob(job);
  const review = (db.prepare('select id from review_notes where job = ?').get(job) as { id: number }).id;
  assert.equal(
    (await h.agent('answer', run.token, { note: review, text: 'Lighter now: half the old ink on the tear line' }))
      .status,
    200,
  );
  // (today's scrap on the fresh page the send made, and one with no words)
  const today = await scrap('Tear-off strip on the left', 'typed');
  await scrap('', 'typed');
  assert.notEqual(today.page, yesterday);

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
    [said.id, 1, yesterday, 'mine', 'wren', 'board'],
  );
  assert.equal(tear.found[1].by, 'wren', 'an answer says who answered');
  assert.equal(tear.found[1].note, said.id, 'under the group it answers');
  assert.equal(tear.found[0].owner, null, "a scrap nobody's yet: the routing check's");
  // (its notebook, which a find on the Shelf opens)
  const { notebook } = db.prepare('select notebook from book_pages where id = ?').get(yesterday) as {
    notebook: number;
  };
  assert.equal(spoken.notebook, notebook, "a find says its page's notebook");

  // every word of the query, each the start of a word, with or without its accent
  assert.deepEqual(
    (await find('tear dark')).found.map((f: any) => f.how),
    ['spoken'],
  );
  assert.deepEqual(
    (await find('cafe')).found.map((f: any) => [f.note, f.n, f.how]),
    [[other.id, 2, 'typed']],
  );
  assert.deepEqual((await find('ear')).found, []);
  assert.deepEqual(await find(''), { q: '', found: [], total: 0 });
  // a deleted group's words go with it
  await h.board('/api/notebooks/groups/delete', { id: today.id });
  assert.equal((await find('tear')).total, 2);
});

test('handwriting read into type on a page is found by its words, as written', async () => {
  const page = (await scrap('', 'typed')).page;
  const drawn = (
    await h.board('/api/notebooks/groups/create', {
      page,
      ink: anchor.ink,
    })
  ).body;
  const texts = [{ x: 10, y: 20, w: 200, color: '#2b2230', text: 'Swap the\nmugs’ order?' }];
  assert.equal(
    (await h.board('/api/notebooks/groups/edit', { id: drawn.id, since: drawn.updated, ink: [], texts })).status,
    200,
  );
  assert.deepEqual(
    (await find('mugs order')).found.map((f: any) => [f.note, f.how, f.text]),
    [[drawn.id, 'written', 'Swap the mugs’ order?']],
  );
});

test("only the board's own notebooks, and only the board searches", async () => {
  const now = new Date().toISOString();
  const nb = db
    .prepare("insert into notebooks (who, kind, name, created, updated) values ('guest:7', 'mine', '', ?, ?)")
    .run(now, now).lastInsertRowid;
  const page = db
    .prepare(
      `insert into book_pages (who, day, kind, label, created, updated, w, h, notebook, pos)
      values ('guest:7', '2026-10-27', 'free', '', ?, ?, 400, 400, ?, 0)`,
    )
    .run(now, now, nb).lastInsertRowid;
  db.prepare(
    `insert into notebook_groups (page, kind, by, words, said, created, updated)
    values (?, 'scrap', 'guest:7', 'Hidden teacups', 'typed', ?, ?)`,
  ).run(page, now, now);
  assert.deepEqual((await find('teacups')).found, [], "a guest's own notebook isn't the board's");
  const outside = await fetch(`${base}/api/book/search?q=tear`);
  assert.equal(outside.status, 401, 'no session, no search');
});
