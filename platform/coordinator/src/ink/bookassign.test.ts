// node --test src/ink/bookassign.test.ts   (a scrap handed to a guest or an agent from the short list: the guest's copy
// on their Asks page kept in step both ways, the agent's answer asked for at once.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../harness.ts';

const h = await harness('bookassign', { env: { CADDY_HOST: '127.0.0.1' } });
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { currentPage, mine } = await import('../notebook.ts');
afterEach(() => h.cancelQueued());

const api = '/guest/notebooks/api';
const GUEST = 'Femke Jansen-Okafor';
const stroke = {
  color: '#c0392b',
  size: 4,
  points: [
    [10, 10, 0.5, 0],
    [40, 40, 0.5, 10],
  ],
};
const typed = (text: string) => [{ x: 40, y: 40, w: 500, text, color: '#292722' }];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=',
  'base64',
);
const placed = (file: string, x = 10) => ({ file, x, y: 10, w: 100, h: 100, tilt: 0 });

// A guest in a book of the board's, signed in: their requests to the guest room
async function invited(name: string) {
  const made = await h.board('/api/notebooks/guests', {
    kind: 'invited',
    name: `${name}'s book`,
    people: [{ name, email: `${name.split(' ')[0].toLowerCase()}@example.org` }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const door = new URL(made.body.notebook.people[0].link).pathname;
  const form = (path: string, fields: Record<string, string>) =>
    fetch(h.base + path, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(fields),
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '192.0.2.9' },
    });
  const code = /: (\d{6})/.exec(await (await form(`${door}/send`, {})).text())![1];
  const cookie = (await form(`${door}/verify`, { code })).headers.get('set-cookie')!.split(';')[0];
  const guest = async (path: string, body?: unknown) => {
    const response = await fetch(h.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  // a picture onto a page of theirs, for a group there to place
  const upload = async (page: number) => {
    const response = await fetch(`${h.base}${api}/pictures?page=${page}`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'image/png' },
      body: PNG,
    });
    assert.equal(response.status, 200);
    return (await response.json()).file as string;
  };
  return { guest, upload, notebook: made.body.notebook.id as number };
}
// A guest's copy of a scrap handed to them, on their Asks page
async function copyFor(guest: Awaited<ReturnType<typeof invited>>['guest'], notebook: number) {
  const pages = (await guest(`${api}/pages?notebook=${notebook}`)).body.pages;
  const asks = pages.find((p: any) => p.kind === 'asks');
  return (await guest(`${api}/groups?page=${asks.id}`)).body.groups.at(-1);
}
// A note of the board's on its own notebook's current page, as the board's screen writes it
async function boardNote(text: string) {
  const made = await h.board('/api/notebooks/groups/create', { page: currentPage(mine().id), texts: typed(text) });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body;
}
// Who a person on the list is, as assigning names them
const toOf = async (name: string) =>
  (await h.board('/api/notebooks/people')).body.everyone.find((p: any) => p.name === name).to as string;
const groupsOn = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups;
const textOf = (g: any) => g.texts.map((t: any) => t.text).join(' ');

test('a scrap handed to a guest lands on their Asks page, and what either side writes shows on the other', async () => {
  const { guest, notebook } = await invited(GUEST);
  const people = (await h.board('/api/notebooks/people')).body;
  const femke = people.everyone.find((p: any) => p.name === GUEST);
  const book = ((await h.board('/api/book/people')).body as any[]).find(p => p.name === GUEST);
  assert.deepEqual(femke, { to: book.who, name: GUEST, kind: 'guest' }, 'the guest as their own book knows them');
  assert.ok(people.everyone.some((p: any) => p.to === 'agent:lark' && p.kind === 'agent'));
  assert.ok(people.recent.length > 0 && people.recent.length <= 4, 'a short list, topped up');

  const original = await boardNote('Tagline OK?');
  const given = await h.board('/api/notebooks/groups/assign', { id: original.id, to: femke.to });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  assert.deepEqual(given.body.group.assigned, [{ ...femke, answered: false }]);
  assert.equal((await h.board('/api/notebooks/people')).body.recent[0].to, femke.to, 'picked last, first on the list');

  // their Asks page in the book they're in, the copy on it; the board's scrap stays where it was
  const pages = (await guest(`${api}/pages?notebook=${notebook}`)).body.pages;
  const asks = pages.find((p: any) => p.kind === 'asks');
  assert.ok(asks, `an Asks page among ${JSON.stringify(pages.map((p: any) => p.kind))}`);
  const [copy] = (await guest(`${api}/groups?page=${asks.id}`)).body.groups;
  assert.equal(textOf(copy), 'Tagline OK?');
  assert.ok((await groupsOn(original.page)).some((g: any) => g.id === original.id));

  // their answer, written on the copy, shows on the board's scrap, with a tick on their tag
  const answered = await guest(`${api}/edit`, { id: copy.id, since: copy.updated, ink: [stroke] });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const mirrored = (await groupsOn(original.page)).find((g: any) => g.id === original.id);
  assert.equal(mirrored.ink.length, 1);
  assert.equal(mirrored.ink[0].color, stroke.color);
  assert.deepEqual(mirrored.assigned, [{ ...femke, answered: true }]);

  // and the board's words, written again, show on theirs
  const edited = await h.board('/api/notebooks/groups/edit', {
    id: original.id,
    since: mirrored.updated,
    texts: typed('Tagline OK? Shorter?'),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const [kept] = (await guest(`${api}/groups?page=${asks.id}`)).body.groups;
  assert.equal(textOf(kept), 'Tagline OK? Shorter?');
  assert.equal(kept.ink.length, 1, 'their own ink stays on theirs');
});

test('two guests handed one scrap, writing one after the other, both keep their answers on every side', async () => {
  const a = await invited('Annemieke Bos'),
    b = await invited('Bart de Vries');
  const original = await boardNote('Which headline?');
  for (const name of ['Annemieke Bos', 'Bart de Vries']) {
    const given = await h.board('/api/notebooks/groups/assign', { id: original.id, to: await toOf(name) });
    assert.equal(given.status, 200);
  }
  const copyA = await copyFor(a.guest, a.notebook),
    copyB = await copyFor(b.guest, b.notebook);

  const red = { ...stroke, color: '#c0392b' },
    blue = { ...stroke, color: '#2457a6' };
  assert.equal((await a.guest(`${api}/edit`, { id: copyA.id, since: copyA.updated, ink: [red] })).status, 200);
  // B wrote on the copy as it read it before A's answer reached it: read it again
  const stale = await b.guest(`${api}/edit`, { id: copyB.id, since: copyB.updated, ink: [blue] });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const fresh = await copyFor(b.guest, b.notebook);
  assert.deepEqual(
    fresh.ink.map((s: any) => s.color),
    [red.color],
  );
  const answered = await b.guest(`${api}/edit`, { id: copyB.id, since: fresh.updated, ink: [...fresh.ink, blue] });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));

  const board = (await groupsOn(original.page)).find((g: any) => g.id === original.id);
  for (const side of [board, await copyFor(a.guest, a.notebook), await copyFor(b.guest, b.notebook)])
    assert.deepEqual(
      side.ink.map((s: any) => s.color),
      [red.color, blue.color],
    );
  assert.ok(board.assigned.every((p: any) => p.answered));

  // and the board's edit of the original keeps both answers on both copies
  const edited = await h.board('/api/notebooks/groups/edit', {
    id: board.id,
    since: board.updated,
    texts: typed('Which?'),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  for (const side of [await copyFor(a.guest, a.notebook), await copyFor(b.guest, b.notebook)]) {
    assert.equal(textOf(side), 'Which?');
    assert.equal(side.ink.length, 2);
  }
});

test("a picture added, moved, replaced or removed on a guest's copy is on the board's scrap, each in its own file", async () => {
  const { guest, upload, notebook } = await invited('Carla Mendes');
  const original = await boardNote('A better photo?');
  assert.equal(
    (await h.board('/api/notebooks/groups/assign', { id: original.id, to: await toOf('Carla Mendes') })).status,
    200,
  );
  const boardSide = async () => (await groupsOn(original.page)).find((g: any) => g.id === original.id);
  const edit = async (pictures: unknown[]) => {
    const copy = await copyFor(guest, notebook);
    const edited = await guest(`${api}/edit`, { id: copy.id, since: copy.updated, pictures });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
  };

  const first = await upload((await copyFor(guest, notebook)).page);
  await edit([placed(first)]);
  const [added] = (await boardSide()).pictures;
  assert.ok(added.file.startsWith(`${original.page}-g-`), `the board's own file, not ${added.file}`);
  assert.equal((await fetch(h.base + added.url, { headers: { cookie: h.boardCookie } })).status, 200);

  // the board moves it: the guest's copy keeps its own file, at the new place
  const moved = await h.board('/api/notebooks/groups/edit', {
    id: original.id,
    since: (await boardSide()).updated,
    pictures: [placed(added.file, 60)],
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(
    (await copyFor(guest, notebook)).pictures.map((c: any) => [c.file, c.x]),
    [[first, 60]],
  );

  const second = await upload((await copyFor(guest, notebook)).page);
  await edit([placed(second)]);
  const [replaced] = (await boardSide()).pictures;
  assert.notEqual(replaced.file, added.file, 'the new picture, not the old one');
  await edit([]);
  assert.deepEqual((await boardSide()).pictures, []);
});

test('a scrap handed to an agent becomes theirs to answer, at once', async () => {
  const original = await boardNote('Which colour for the button?');
  const given = await h.board('/api/notebooks/groups/assign', { id: original.id, to: 'agent:lark' });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  assert.equal(given.body.group.owner, 'lark');
  assert.deepEqual(given.body.group.assigned, [{ to: 'agent:lark', name: 'Lark', kind: 'agent', answered: false }]);
  const run = db.prepare("select agent, kind from jobs where kind = 'chat' order by id desc limit 1").get() as any;
  assert.deepEqual({ ...run }, { agent: 'lark', kind: 'chat' }, "the agent's quick run, asked for its answer");
});

test('a scrap goes only to someone on the list, from an open page', async () => {
  const original = await boardNote('Who takes this?');
  const nobody = await h.board('/api/notebooks/groups/assign', { id: original.id, to: 'guest:Nobody' });
  assert.equal(nobody.status, 400);
  assert.equal((await h.board('/api/notebooks/groups/assign', { id: 999999, to: 'agent:lark' })).status, 404);
});
