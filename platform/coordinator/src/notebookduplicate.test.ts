// node --test src/notebookduplicate.test.ts   (the harness: the test company, the real server, the board's session)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('notebookduplicate');

const stroke = (y: number) => ({
  color: '#2B2230',
  size: 6,
  points: [
    [20, y, 0.5, 0],
    [100, y + 20, 0.6, 16],
  ],
});
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
const pages = async (notebook: number) => (await h.board(`/api/notebooks/pages?notebook=${notebook}`)).body.pages;
const units = async (page: number) =>
  (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups.map((g: any) => ({
    kind: g.kind,
    ink: g.ink,
    texts: g.texts,
    h: g.h,
  }));

test('a sent sketch page duplicated: a new open page at the end with everything on it, the page sent as it was', async () => {
  const nb = await myNotebook(),
    page = (await h.board('/api/notebooks/pages/create', { notebook: nb })).body.id as number;
  for (const y of [50, 400]) await h.board('/api/notebooks/groups/create', { page, ink: [stroke(y)] });
  assert.equal((await h.board('/api/notebooks/pages/send', { id: page })).status, 200);
  const was = await units(page);
  const copy = (await h.board('/api/notebooks/pages/duplicate', { id: page })).body;
  assert.equal(copy.chapter, 'sketch');
  assert.ok(!copy.sent && !copy.sending, 'the copy is open');
  assert.equal((await pages(nb)).at(-1).id, copy.id, "at the notebook's end");
  assert.deepEqual(await units(copy.id), was, 'everything on it, in its order');
  // (drawn on, the page sent untouched)
  assert.equal((await h.board('/api/notebooks/groups/create', { page: copy.id, ink: [stroke(700)] })).status, 200);
  assert.deepEqual(await units(page), was);
  const sent = (await pages(nb)).find((p: any) => p.id === page);
  assert.ok(sent.sent || sent.sending, 'the page sent stays locked');
  assert.equal((await h.board('/api/notebooks/pages/duplicate', { id: 99999 })).status, 404);
});
