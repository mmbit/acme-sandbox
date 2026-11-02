// node --test src/notebooktidy.test.ts   (the harness: the test company, the real server, the board's session)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('notebooktidy');

const stroke = {
  color: '#2B2230',
  size: 6,
  points: [
    [20, 50, 0.5, 0],
    [100, 70, 0.6, 16],
  ],
};
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
const open = async (notebook: number) =>
  (await h.board(`/api/notebooks/pages?notebook=${notebook}`)).body.pages.map((p: any) => p.id) as number[];
const made = async (notebook: number) => (await h.board('/api/notebooks/pages/create', { notebook })).body.id as number;
const tidy = (notebook: number, keep: unknown) => h.board('/api/notebooks/pages/tidy', { notebook, keep });

test("a blank page left goes: New page twice leaves one; what's drawn, titled, archived or shown stays", async () => {
  const nb = await myNotebook();
  const drawn = await made(nb);
  await h.board('/api/notebooks/groups/create', { page: drawn, ink: [stroke] });
  await tidy(nb, drawn); // (any blank page the notebook started with, gone first)
  const titled = await made(nb),
    archived = await made(nb),
    erased = await made(nb);
  await h.board('/api/notebooks/pages/title', { id: titled, title: 'Shop ideas' });
  await h.board('/api/notebooks/pages/archive', { id: archived, archived: true });
  // (a stroke drawn and taken away: its group kept for Undo, and the page with it)
  const g = (await h.board('/api/notebooks/groups/create', { page: erased, ink: [stroke] })).body;
  await h.board('/api/notebooks/groups/delete', { id: g.id });
  // New page tapped twice: the first is left once the second shows
  const first = await made(nb),
    second = await made(nb);
  assert.deepEqual((await tidy(nb, second)).body, { gone: 1 });
  const after = await open(nb);
  assert.ok(!after.includes(first), 'the first new page went');
  for (const id of [drawn, titled, erased, second]) assert.ok(after.includes(id), `page ${id} stays`);
  const listed = (await h.board(`/api/notebooks/pages?notebook=${nb}`)).body;
  assert.ok(
    listed.archived.some((p: any) => p.id === archived),
    'an archived page is left as it is',
  );
  // the page shown left for another: it goes too, and nothing more
  assert.deepEqual((await tidy(nb, drawn)).body, { gone: 1 });
  assert.ok(!(await open(nb)).includes(second));
  assert.deepEqual((await tidy(nb, drawn)).body, { gone: 0 });
  assert.equal((await tidy(nb, 'x')).status, 400);
  assert.equal((await tidy(999, drawn)).status, 404);
});
