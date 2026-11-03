// node --test src/notebookplaces.test.ts   (the harness: the test company, the real server, the board's session)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { unitsPage } from './ink/bookpicture.ts';

const h = await harness('notebookplaces');
const { db } = h;

const stroke = (x: number, y: number) => ({
  color: '#2B2230',
  size: 6,
  points: [
    [x, y, 0.5, 0],
    [x + 80, y + 20, 0.6, 16],
  ],
});
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
const newPage = async (notebook: number) => (await h.board('/api/notebooks/pages/create', { notebook })).body.id;
const groups = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const create = (body: Record<string, unknown>) => h.board('/api/notebooks/groups/create', body);
const place = (page: number, places: unknown) => h.board('/api/notebooks/groups/place', { page, places });

test("a sketch page's units keep their places: made where drawn, the first place given stands, split beside", async () => {
  const page = await newPage(await myNotebook()),
    drawn = (await create({ page, ink: [stroke(0, 0), stroke(200, 0)], place: { x: 400, y: 300 } })).body,
    loose = (await create({ page, ink: [stroke(0, 0)] })).body;
  assert.deepEqual(drawn.place, { x: 400, y: 300 }, 'made at its place');
  assert.equal(loose.place, null, 'none given, none kept: the page lays it');
  const first = (await place(page, [{ id: loose.id, x: 30, y: 90 }])).body.groups,
    second = (await place(page, [{ id: loose.id, x: 600, y: 900 }])).body.groups;
  assert.deepEqual(
    [first[0].place, second[0].place],
    [
      { x: 30, y: 90 },
      { x: 30, y: 90 },
    ],
    "the first screen's stands",
  );
  assert.equal((await place(page, [{ id: loose.id, x: '1', y: 2 }])).status, 400, 'a place is two numbers');
  assert.equal((await place(page, [{ id: 999999, x: 1, y: 2 }])).status, 400, 'a unit on this page');
  const { split } = (await h.board('/api/notebooks/groups/split', { id: drawn.id, ink: [1] })).body;
  assert.deepEqual(
    [split.place.x + split.ink[0].points[0][0], split.place.y + split.ink[0].points[0][1]],
    [400 + 200, 300],
    'a stroke split out stays where it was on the page',
  );
  assert.equal(split.ink[0].size, 6, 'never scaled');
  const other = await newPage(await myNotebook());
  await h.board('/api/notebooks/groups/move', { id: drawn.id, page: other });
  assert.equal((await groups(other))[0].place, null, 'moved to another page, laid there afresh');
});

test("a sketch page's picture holds what's drawn far out every way, each where it was drawn", async () => {
  const page = await newPage(await myNotebook());
  await create({ page, ink: [stroke(0, 0)], place: { x: -2000, y: -1500 } });
  await create({ page, ink: [stroke(0, 0)], place: { x: 3000, y: 4000 } });
  const drawn = await unitsPage(page),
    [a, b] = drawn.ink.map(s => s.points[0]);
  assert.deepEqual([b[0] - a[0], b[1] - a[1]], [5000, 5500], 'as far apart as drawn');
  assert.ok(a[0] >= 0 && a[1] >= 0 && b[0] < drawn.w && b[1] < drawn.h, 'both on the picture');
});

test('a page of scraps places nothing: its masonry lays it', async () => {
  const page = await newPage(await myNotebook());
  db.prepare("update book_pages set kind = 'call' where id = ?").run(page);
  const g = (await create({ page, ink: [stroke(0, 0)], place: { x: 5, y: 5 } })).body;
  assert.equal(g.place, null, 'a place given is not kept');
  assert.equal((await place(page, [{ id: g.id, x: 1, y: 2 }])).status, 400, 'only a sketch page places its units');
});
