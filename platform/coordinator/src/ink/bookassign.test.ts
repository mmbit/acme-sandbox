// node --test src/ink/bookassign.test.ts   (a scrap of the board's, on any page, handed to a guest invited to its book
// or its project: the guest's copy on their Asks page kept in step both ways, answered only by their Answer; never to
// an agent.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../harness.ts';

const h = await harness('bookassign', { env: { CADDY_HOST: '127.0.0.1' } });
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { currentPage, mine } = await import('../notebook.ts');
const { asksPage } = await import('./askpages.ts');
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
  return (await guest(`${api}/pages/groups?page=${asks.id}`)).body.groups.at(-1);
}
// A note of the board's on its own notebook's Asks page, as the board's screen writes it
async function boardNote(text: string, page = asksPage(mine().id).id) {
  const made = await h.board('/api/notebooks/groups/create', { page, texts: typed(text) });
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
  assert.deepEqual(
    femke,
    { to: book.who, name: GUEST, kind: 'guest', initial: 'F', colour: book.colour },
    'the guest as their own book knows them',
  );
  assert.ok(
    people.everyone.every((p: any) => p.kind === 'guest'),
    'guests only, never an agent',
  );
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
  const [copy] = (await guest(`${api}/pages/groups?page=${asks.id}`)).body.groups;
  assert.equal(textOf(copy), 'Tagline OK?');
  assert.ok((await groupsOn(original.page)).some((g: any) => g.id === original.id));

  assert.deepEqual(copy.question, { answered: false }, 'a question on their side');
  assert.equal((await groupsOn(original.page)).find((g: any) => g.id === original.id).question, null);

  // what they write on the copy shows on the board's scrap, still out with them until they press Answer
  const written = await guest(`${api}/groups/edit`, { id: copy.id, since: copy.updated, ink: [stroke] });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const out = (await groupsOn(original.page)).find((g: any) => g.id === original.id);
  assert.equal(out.ink.length, 1);
  assert.equal(out.ink[0].color, stroke.color);
  assert.deepEqual(out.assigned, [{ ...femke, answered: false }], 'writing answers nothing');
  const answered = await guest(`${api}/groups/answer`, { id: copy.id });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(answered.body.group.question, { answered: true });
  const mirrored = (await groupsOn(original.page)).find((g: any) => g.id === original.id);
  assert.deepEqual(mirrored.assigned, [{ ...femke, answered: true }]);
  // (only a copy handed to them is answered)
  assert.equal((await h.board('/api/notebooks/groups/answer', { id: original.id })).status, 409);

  // and the board's words, written again, show on theirs
  const edited = await h.board('/api/notebooks/groups/edit', {
    id: original.id,
    since: mirrored.updated,
    texts: typed('Tagline OK? Shorter?'),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const [kept] = (await guest(`${api}/pages/groups?page=${asks.id}`)).body.groups;
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
  assert.equal((await a.guest(`${api}/groups/edit`, { id: copyA.id, since: copyA.updated, ink: [red] })).status, 200);
  // B wrote on the copy as it read it before A's answer reached it: read it again
  const stale = await b.guest(`${api}/groups/edit`, { id: copyB.id, since: copyB.updated, ink: [blue] });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const fresh = await copyFor(b.guest, b.notebook);
  assert.deepEqual(
    fresh.ink.map((s: any) => s.color),
    [red.color],
  );
  const answered = await b.guest(`${api}/groups/edit`, {
    id: copyB.id,
    since: fresh.updated,
    ink: [...fresh.ink, blue],
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal((await a.guest(`${api}/groups/answer`, { id: copyA.id })).status, 200);
  assert.equal((await b.guest(`${api}/groups/answer`, { id: copyB.id })).status, 200);

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
    const edited = await guest(`${api}/groups/edit`, { id: copy.id, since: copy.updated, pictures });
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

test('a scrap goes to no agent, and from any page, a sketch page too', async () => {
  await invited(GUEST);
  const original = await boardNote('Which colour for the button?');
  const agent = await h.board('/api/notebooks/groups/assign', { id: original.id, to: 'agent:lark' });
  assert.equal(agent.status, 400, JSON.stringify(agent.body));
  assert.equal(db.prepare('select owner from notebook_groups where id = ?').get(original.id)!.owner, null);
  const sketch = await boardNote('Hi Lyra', currentPage(mine().id));
  const fromSketch = await h.board('/api/notebooks/groups/assign', { id: sketch.id, to: await toOf(GUEST) });
  assert.equal(fromSketch.status, 200, JSON.stringify(fromSketch.body));
  assert.deepEqual(
    (await groupsOn(sketch.page)).find((g: any) => g.id === sketch.id).assigned.map((p: any) => [p.name, p.answered]),
    [[GUEST, false]],
  );
});

test("a page's people are the guests invited to its book; the board's own book offers every guest", async () => {
  const a = await invited('Dirk Meijer'),
    b = await invited('Esther Pool');
  const page = asksPage(a.notebook).id;
  const own = (await h.board(`/api/notebooks/people?page=${page}`)).body;
  assert.deepEqual(
    own.everyone.map((p: any) => p.name),
    ['Dirk Meijer'],
  );
  const mine_ = (await h.board(`/api/notebooks/people?page=${asksPage(mine().id).id}`)).body.everyone;
  for (const name of ['Dirk Meijer', 'Esther Pool'])
    assert.ok(
      mine_.some((p: any) => p.name === name),
      name,
    );
  assert.ok(
    mine_.every((p: any) => p.kind === 'guest'),
    'never an agent',
  );
  void b;
});

test("a guest's own book's Asks page gathers the open questions handed to them in their other books, each where it is", async () => {
  const own = await invited('Gina Smit');
  const other = await h.board('/api/notebooks/guests', {
    kind: 'invited',
    name: 'Gina, second book',
    people: [{ name: 'Gina Smit', email: 'gina@example.org' }],
  });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const book = other.body.notebook.id as number;
  const original = await boardNote('Which photo?', asksPage(book).id);
  assert.equal(
    (await h.board('/api/notebooks/groups/assign', { id: original.id, to: await toOf('Gina Smit') })).status,
    200,
  );
  const copy = await copyFor(own.guest, book);
  const pages = (await own.guest(`${api}/pages?notebook=${own.notebook}`)).body.pages;
  const asks = pages.find((p: any) => p.kind === 'asks');
  assert.ok(asks, 'an Asks page in their own book, made with it');
  const read = async () => (await own.guest(`${api}/pages/groups?page=${asks.id}`)).body.groups;
  const [gathered] = await read();
  assert.equal(gathered.id, copy.id, 'the copy itself, not another');
  assert.deepEqual(gathered.elsewhere, { page: copy.page, label: 'Asks' });
  assert.equal(gathered.page, copy.page, 'it stays on its own page');

  // past the other book's ends (not swept yet: not revoked), its copy is no longer gathered
  db.prepare("update notebook_guests set ends = '2000-01-01T00:00:00.000Z' where notebook = ?").run(book);
  assert.deepEqual(await read(), [], 'the guest room refuses that book, and so does the gather');
  db.prepare('update notebook_guests set ends = null where notebook = ?').run(book);

  // a new scrap after it is at the Asks page's own end; answered, it's gathered no more
  const made = await own.guest(`${api}/groups/create`, { page: asks.id, after: copy.id, empty: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.page, asks.id);
  assert.equal((await own.guest(`${api}/groups/answer`, { id: copy.id })).status, 200);
  assert.deepEqual(
    (await read()).map((g: any) => g.id),
    [made.body.id],
  );
});

test('a new empty scrap goes in a gap between two, or first, on any page', async () => {
  const page = asksPage(mine().id).id;
  const one = await boardNote('one', page),
    two = await boardNote('two', page);
  const refused = await h.board('/api/notebooks/groups/create', { page, after: one.id });
  assert.equal(refused.status, 400, 'empty only when asked for');
  const between = await h.board('/api/notebooks/groups/create', { page, after: one.id, empty: true });
  assert.equal(between.status, 200, JSON.stringify(between.body));
  const first = await h.board('/api/notebooks/groups/create', { page, after: 'start', empty: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const order = (await groupsOn(page)).map((g: any) => g.id);
  assert.deepEqual(
    order.filter((id: number) => [one.id, two.id, between.body.id, first.body.id].includes(id)),
    [first.body.id, one.id, between.body.id, two.id],
  );
  const sketch = currentPage(mine().id);
  const onSketch = await h.board('/api/notebooks/groups/create', { page: sketch, empty: true });
  assert.equal(onSketch.status, 200, JSON.stringify(onSketch.body));
  assert.deepEqual([onSketch.body.ink, onSketch.body.texts, onSketch.body.pictures], [[], [], []]);
});

test('a scrap goes only to someone on the list, from an open page', async () => {
  const original = await boardNote('Who takes this?');
  const nobody = await h.board('/api/notebooks/groups/assign', { id: original.id, to: 'guest:Nobody' });
  assert.equal(nobody.status, 400);
  assert.equal((await h.board('/api/notebooks/groups/assign', { id: 999999, to: 'guest:Nobody' })).status, 404);
});
