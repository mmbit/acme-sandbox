// node --test src/notebookgive.test.ts   (the harness: the board's session, a guest signed in by their shelf's link)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { fakeLettermint } from './fixture.ts';

const lettermint = await fakeLettermint();
const h = await harness('notebookgive', { env: { CADDY_HOST: '127.0.0.1', PUBLIC_HOST: 'hq.company.test' } });
lettermint.on();
const { ORIGIN } = await import('./config.ts');
const { addSlip } = await import('./ink/bookslips.ts');
const api = '/guest/notebooks/api';

const typed = (text: string) => [{ x: 40, y: 40, w: 500, text, color: '#292722' }];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=',
  'base64',
);
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
// A page of the board's with a scrap of words and a photo on it and a version under it, as a call's prototype clip has
async function boardPage(title: string) {
  const page = (await h.board('/api/notebooks/pages/create', { notebook: await myNotebook() })).body.id as number;
  await h.board('/api/notebooks/pages/title', { id: page, title });
  const uploaded = await fetch(`${h.base}/api/notebooks/pictures?page=${page}`, {
    method: 'POST',
    headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/png' },
    body: PNG,
  });
  assert.equal(uploaded.status, 200);
  const photo = { file: (await uploaded.json()).file, x: 10, y: 10, w: 100, h: 100, tilt: 0 };
  const unit = (await h.board('/api/notebooks/groups/create', { page, texts: typed('Reis A'), pictures: [photo] }))
    .body;
  addSlip(null, 'juno', null, 'the whole trip at once', { grp: unit.id, style: 'version', version: 'v1', link: null });
  addSlip(null, 'juno', null, 'an answer about a note', { grp: unit.id, style: 'text' });
  return page;
}
async function signIn(link: string) {
  const { g: cookie } = await h.guestIn(link, lettermint.code);
  const send = async (path: string, body?: unknown) => {
    const response = await fetch(h.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return Object.assign(send, { cookie });
}

test('a page given to someone new and then to them again: two pages of their own notebook, every unit, photo and version on them, theirs to change', async () => {
  const first = await boardPage('Fotoboek met Esmee'),
    second = await boardPage('Fotoboek, sessie 2');
  const given = await h.board('/api/notebooks/pages/give', {
    id: first,
    person: { name: 'Esmee', email: 'esmee@example.org' },
  });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  assert.equal(given.body.name, 'Esmee');
  assert.equal(given.body.page.title, 'Fotoboek met Esmee');
  assert.match(given.body.link, /\/guest\/[A-Za-z0-9_-]{43}$/, "their shelf's link");
  const to = (await h.board('/api/notebooks/people')).body.everyone.find((p: any) => p.name === 'Esmee').to;
  const again = await h.board('/api/notebooks/pages/give', { id: second, to });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.link, given.body.link, 'the same link');

  const guest = await signIn(given.body.link);
  const shelf = (await guest(`${api}/shelf`)).body;
  const pages = (await guest(`${api}/pages?notebook=${shelf.journal.notebook}`)).body.pages;
  const titles = pages.map((p: any) => p.title);
  assert.deepEqual(titles.slice(-2), ['Fotoboek met Esmee', 'Fotoboek, sessie 2'], 'both in their journal, in order');
  const copy = pages.at(-2);
  assert.equal(copy.readonly, false, 'theirs to write on');
  const groups = (await guest(`${api}/pages/groups?page=${copy.id}`)).body.groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].texts[0].text, 'Reis A');
  assert.deepEqual(
    groups[0].children.map((c: any) => c.text),
    ['the whole trip at once'],
    'the version comes, the answer stays with the page',
  );
  const [photo] = groups[0].pictures;
  const seen = await fetch(`${h.base}${api}/pictures?file=${encodeURIComponent(photo.file)}`, {
    headers: { cookie: guest.cookie },
  });
  assert.equal(seen.status, 200, 'the photo opens for them');
  assert.deepEqual(Buffer.from(await seen.arrayBuffer()), PNG);
  const edited = await guest(`${api}/groups/edit`, {
    id: groups[0].id,
    since: groups[0].updated,
    ink: [],
    texts: typed('Reis A, met kaart'),
    pictures: [{ ...photo, x: 60 }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.pictures[0].x, 60, 'and saves with their change');
  const board = (await h.board(`/api/notebooks/pages/groups?page=${first}`)).body.groups;
  assert.equal(board[0].texts[0].text, 'Reis A', "the board's page stays as it was");
  assert.equal(board[0].pictures[0].x, 10);
});

test("a page given to nobody known, or a guest's own page, is refused", async () => {
  const page = await boardPage('Los');
  assert.equal((await h.board('/api/notebooks/pages/give', { id: page, to: 'guest:9999' })).status, 404);
  assert.equal((await h.board('/api/notebooks/pages/give', { id: 99999, to: 'guest:1' })).status, 404);
  const bad = await h.board('/api/notebooks/pages/give', { id: page, person: { name: 'Esmee', email: 'nope' } });
  assert.equal(bad.status, 400);
  const theirs = (await h.board('/api/notebooks/guests')).body.notebooks[0].pages[0].id;
  assert.equal((await h.board('/api/notebooks/pages/give', { id: theirs, to: 'guest:1' })).status, 404);
});
