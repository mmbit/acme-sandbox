// node --test src/notebooktitles.test.ts (real notebook routes and the worker's small-model queue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('notebooktitles');
const { db } = h;
const { companyDay } = await import('./company.ts');
const { TITLES_A_DAY } = await import('./notebooktitles.ts');
const mine = (await h.board('/api/notebooks')).body.shelf[0].id;
const pages = async () => (await h.board(`/api/notebooks/pages?notebook=${mine}`)).body.pages;
const pageNow = async (id: number) => (await pages()).find((p: any) => p.id === id);
const createPage = async () => (await h.board('/api/notebooks/pages/create', { notebook: mine })).body.id as number;
const stroke = (x = 100) => ({
  color: '#222222',
  size: 4,
  points: [
    [x, 100, 0.5, 0],
    [x + 100, 180, 0.5, 16],
  ],
});
const draw = async (page: number) => (await h.board('/api/notebooks/groups/create', { page, ink: [stroke()] })).body;
const title = (id: number, title: unknown) => h.board('/api/notebooks/pages/title', { id, title });
const respond = (reading: string, title: unknown) =>
  h.worker('reads/answer', { reading, result: { structured_output: { title } } });

async function claimed() {
  // The production idle timer is five seconds. Leave room for its picture and the server under load.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const reading = (await h.worker('reads/claim')).body;
    if (reading.reading) return reading;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('The untitled page did not reach the small model');
}

test('the title route keeps the date, validates titles and keeps a title through later edits', async () => {
  const page = await createPage(),
    before = await pageNow(page);
  assert.equal((await title(page, 3)).status, 400);
  assert.equal((await title(page, 'x'.repeat(81))).status, 400);
  assert.equal((await title(-1, 'Missing')).status, 404);
  const named = await title(page, '  Garden\n layout  ');
  assert.equal(named.status, 200);
  assert.equal(named.body.title, 'Garden layout');
  assert.equal(named.body.day, before.day);
  await draw(page);
  assert.equal((await pageNow(page)).title, 'Garden layout');
});

test('an untitled drawing reaches Haiku as a picture, waits for enough content, then keeps its short title', async () => {
  const page = await createPage();
  const group = await draw(page);
  const first = await claimed();
  assert.equal(first.model, 'haiku');
  assert.ok(first.content.some((part: any) => part.type === 'image' && part.source.media_type === 'image/png'));
  await respond(first.reading, null);
  assert.equal((await pageNow(page)).title, '');
  // An unchanged page is not submitted again, even when it is read on another screen.
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.deepEqual((await h.worker('reads/claim')).body, {});
  await h.board('/api/notebooks/groups/edit', { id: group.id, since: group.updated, ink: [stroke(), stroke(300)] });
  const next = await claimed();
  await respond(next.reading, '  Garden layout ');
  assert.equal((await pageNow(page)).title, 'Garden layout');
  assert.equal((await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.title, 'Garden layout');
  await title(page, 'My garden');
  assert.equal((await pageNow(page)).title, 'My garden');
});

test('a typed or deliberately cleared title wins over a model answer already in flight', async () => {
  const page = await createPage();
  await draw(page);
  const first = await claimed();
  await title(page, 'My own title');
  await respond(first.reading, 'A model title');
  assert.equal((await pageNow(page)).title, 'My own title');
  const cleared = await createPage();
  await draw(cleared);
  const next = await claimed();
  await title(cleared, '');
  await respond(next.reading, 'Another title');
  assert.equal((await pageNow(cleared)).title, '');
  await draw(cleared);
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.deepEqual((await h.worker('reads/claim')).body, {});
});

test('a title for erased content is discarded and the new content gets its own reading', async () => {
  const page = await createPage(),
    group = await draw(page);
  const old = await claimed();
  await h.board('/api/notebooks/groups/edit', { id: group.id, since: group.updated, ink: [stroke(500)] });
  await respond(old.reading, 'Old drawing');
  assert.equal((await pageNow(page)).title, '');
  const fresh = await claimed();
  assert.equal((await respond(fresh.reading, '')).body.written, 0);
  const retried = await claimed();
  await respond(retried.reading, 'New drawing');
  assert.equal((await pageNow(page)).title, 'New drawing');
});

test('TITLES_A_DAY a day: past it nothing goes to the model', async () => {
  db.prepare('insert or replace into page_titles (day, titles) values (?, ?)').run(
    companyDay(Date.now()),
    TITLES_A_DAY,
  );
  const page = await createPage();
  await draw(page);
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.deepEqual((await h.worker('reads/claim')).body, {});
  db.prepare('delete from page_titles').run();
  // (titled by hand, so a later listing doesn't send it)
  await title(page, 'Bounded');
});

test('an archived page is not titled when its notebook is listed', async () => {
  const page = await createPage();
  await draw(page);
  db.prepare('update book_pages set archived = 1 where id = ?').run(page);
  await pages();
  // (past the rest and the picture's drawing, as claimed() allows)
  await new Promise(resolve => setTimeout(resolve, 10_000));
  assert.deepEqual((await h.worker('reads/claim')).body, {});
});
