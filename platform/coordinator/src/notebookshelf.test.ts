// node --test src/notebookshelf.test.ts   (the harness: the test company, the real server, the board's session)
// What the shelf reads of a notebook besides its name: My journal, its cover the board uploads, its new answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { harness } from './harness.ts';

const h = await harness('notebookshelf');
const { db } = h;
const DIR = `${h.dataDir}/book`;

const shelf = async () => (await h.board('/api/notebooks')).body;
const journal = async () => (await shelf()).shelf[0];
const png = async (w: number, h_: number, background = '#2b6cb0') =>
  `data:image/png;base64,${(
    await sharp({ create: { width: w, height: h_, channels: 3, background } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
const covers = () => readdirSync(DIR).filter(f => /^nb\d+-c-/.test(f));

test("the board's own notebook is My journal: first on the shelf, never archived", async () => {
  const mine = await journal();
  assert.deepEqual([mine.name, mine.kind, mine.cover, mine.news], ['My journal', 'mine', null, 0]);
  const refused = await h.board('/api/notebooks/archive', { id: mine.id, archived: true });
  assert.deepEqual([refused.status, refused.body.error], [409, 'My journal stays on the shelf']);
});

test("a cover uploaded is kept, carried on the shelf's read and served; a new one replaces it", async () => {
  const { id } = await journal();
  const set = await h.board('/api/notebooks/cover', { id, picture: await png(640, 800) });
  assert.equal(set.status, 200);
  assert.match(set.body.cover, new RegExp(`^/api/notebooks/cover\\?id=${id}&v=`));
  assert.equal((await journal()).cover, set.body.cover, "the shelf's read carries it");
  const served = await fetch(h.base + set.body.cover, { headers: { cookie: h.boardCookie } });
  assert.deepEqual([served.status, served.headers.get('content-type')], [200, 'image/png']);
  assert.ok((await served.arrayBuffer()).byteLength > 0);
  assert.equal(covers().length, 1);
  const again = await h.board('/api/notebooks/cover', { id, picture: await png(400, 400, '#c2402e') });
  assert.notEqual(again.body.cover, set.body.cover);
  assert.equal(covers().length, 1, 'the cover before thrown away');
});

test('a cover is a picture: anything else refused, the cover kept', async () => {
  const { id, cover } = await journal();
  const words = await h.board('/api/notebooks/cover', { id, picture: 'data:text/plain;base64,aGVsbG8=' });
  assert.deepEqual([words.status, words.body.error], [400, 'the picture is a PNG or JPEG data URL']);
  const broken = await h.board('/api/notebooks/cover', { id, picture: 'data:image/png;base64,aGVsbG8=' });
  assert.deepEqual([broken.status, broken.body.error], [400, 'not a picture we can read']);
  const huge = await h.board('/api/notebooks/cover', { id, picture: await png(2400, 600) });
  assert.equal(huge.status, 413);
  assert.equal((await h.board('/api/notebooks/cover', { id: 999, picture: await png(10, 10) })).status, 404);
  assert.equal((await journal()).cover, cover, 'the cover as it was');
  assert.equal((await h.board('/api/notebooks/cover?id=999')).status, 404);
});

test("an agent's answer in a notebook is news on the shelf until the board reads the notebook", async () => {
  const { id } = await journal();
  const page = (await h.board(`/api/notebooks/pages?notebook=${id}`)).body.pages.at(-1).id;
  const ink = [
    {
      color: '#2B2230',
      size: 6,
      points: [
        [20, 50, 0.5, 0],
        [100, 70, 0.6, 16],
      ],
    },
  ];
  assert.equal((await h.board('/api/notebooks/groups/create', { page, ink })).status, 200);
  const group = db.prepare('select max(id) id from notebook_groups where page = ?').get(page) as { id: number };
  db.prepare("insert into book_slips (grp, by, text, created) values (?, 'wren', 'Here it is', ?)").run(
    group.id,
    new Date(Date.now() + 1000).toISOString(),
  );
  assert.equal((await journal()).news, 1, 'one new answer');
  await new Promise(res => setTimeout(res, 1100));
  await h.board(`/api/notebooks/pages/groups?page=${page}`);
  assert.equal((await journal()).news, 0, 'read: none new');
});
