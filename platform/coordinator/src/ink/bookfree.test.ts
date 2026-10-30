// node --test src/ink/bookfree.test.ts   (the harness: the test company, the real server, the board's session)
// A free page at the book's own routes: its saves, its scraps, the pictures waiting on it, an invited person's pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { harness } from '../harness.ts';

const h = await harness('bookfree');
const { base, agent } = h;
const { ORIGIN } = await import('../config.ts');
const { MAX_POINTS } = await import('../pagechecks.ts');
const pictures = await import('../pictures.ts');
const people = await import('./sketchpeople.ts');
const book = await import('./book.ts');
const DIR = `${h.dataDir}/book`;

// convert -size 4x4 gradient:red-blue -strip png24:base.png
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=',
  'base64',
);
const DRAWN = `data:image/png;base64,${PNG.toString('base64')}`;
const STROKE = {
  color: '#2B2230',
  size: 5,
  points: [
    [10, 20, 0.5, 0],
    [12.5, 21.25, 0.62, 16],
  ],
};
const LIGHT = { color: '#ffd23f', size: 20, alpha: 0.45, points: [[40, 40, 0.5, 0]] };

const create = async () => (await h.board('/api/book/page/new', { kind: 'free', w: 800, h: 600 })).body;
const save = (id: number, ink: unknown, scraps: unknown = []) => h.board('/api/book/page/save', { id, ink, scraps });
const read = async (id: number) => (await h.board(`/api/book/page?id=${id}`)).body;
const listed = async () => (await h.board('/api/book')).body.pages as any[];
const files = () => readdirSync(DIR).filter(f => !f.startsWith('.'));
const shown = (url: string, cookie = h.boardCookie) => fetch(base + url, { headers: { cookie } });

test('a save is kept whole or refused: the caps, a bad stroke', async () => {
  const { id } = await create();
  const dot = { color: '#000000', size: 1, points: [[1, 1, 0.5, 0]] };
  const long = { ...dot, points: Array.from({ length: MAX_POINTS / 2 + 1 }, () => [1, 1, 0.5, 0]) };
  for (const bad of [[long, long], [{ ...dot, color: 'red' }], [{ ...dot, points: [] }], 'lines'])
    assert.ok((await save(id, bad)).status >= 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await read(id)).strokes, 0);
  assert.equal((await save(9999, [])).status, 404);
  assert.equal((await save(id, [long])).status, 200, 'up to the cap, it saves');
});

test("only the board, from HQ's own page, on the book's routes", async () => {
  const { id } = await create();
  await save(id, [STROKE]);
  const elsewhere = {
    cookie: h.boardCookie,
    origin: 'https://hello.preview.example.com',
    'content-type': 'application/json',
  };
  const posts = [
    ...['page/new', 'page/save', 'page/label', 'page/archive', 'page/delete', 'page/send', 'scrap', 'note'],
    ...['note/edit', 'note/move', 'note/delete', 'note/restore', 'note/link', 'sheet/order', 'send', 'undo'],
    ...['slip/tick', 'slip/reply'],
  ].map(p => `/api/book/${p}`);
  for (const path of posts) {
    const body = JSON.stringify({ id, kind: 'free', w: 800, h: 600 });
    assert.equal((await fetch(base + path, { method: 'POST', headers: elsewhere, body })).status, 403, path);
  }
  const gets = ['', `/page?id=${id}`, `/picture?id=${id}`, `/scrap?id=${id}&file=x`, `/notes?page=${id}`]
    .concat(['/sheets', '/search?q=x', '/snip?id=1'])
    .map(p => `/api/book${p}`);
  for (const path of gets) assert.equal((await fetch(base + path)).status, 401, path);
  // another book's pages are not the board's own
  h.db.prepare("update book_pages set who = 'guest:999' where id = ?").run(id);
  assert.equal((await h.board(`/api/book/page?id=${id}`)).status, 404);
  assert.ok(!(await listed()).some(p => p.id === id));
});

// ---------------------------------------------------------------- scraps.
// (pictures.test.ts's JPEG)
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAQDBv/EABUQAQEAAAAAAAAAAAAAAAAAAAAS/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYB/8QAFhEBAQEAAAAAAAAAAAAAAAAAABRh/9oADAMBAAIRAxEAPwDnLLT2WyHFpYostPZZDhYostPZZDhYwstPZayhxKWKLLT2WQ4WKLLT2WQ4WP/Z',
  'base64',
);
const BOARD = { cookie: h.boardCookie, origin: ORIGIN };
const upload = async (id: number, body: Buffer = PNG, type = 'image/png') => {
  const res = await fetch(`${base}/api/book/scrap?id=${id}`, {
    method: 'POST',
    headers: { ...BOARD, 'content-type': type },
    body: new Uint8Array(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const at = (file: string, x = 10) => ({ file, x, y: 20, w: 120, h: 90, tilt: -4 });
const scrapsOf = (id: number) => files().filter(f => f.startsWith(`${id}-s-`));
const scrapUrl = (id: number, file: string) => `/api/book/scrap?id=${id}&file=${file}`;
// A picture waiting on a free page (fromReview), which no route sends: the test calls it as one would
const toBook = (body: { picture: string; to: 'new' | 'last' }) => {
  const r = book.fromReview(Buffer.from(body.picture.split(',')[1], 'base64'), body.to);
  return Array.isArray(r)
    ? { status: r[0], json: { error: r[1] } as any, text: r[1] }
    : { status: 200, json: r as any, text: '' };
};
// Every picture waiting from review mode placed, as HQ's page does when it opens: each test starts with none
async function placeWaiting() {
  for (const { id } of await listed()) {
    const page = await read(id);
    if (!page.waiting.length) continue;
    const kept = page.scraps.map(({ url: _url, ...c }: any) => c);
    await save(id, [STROKE], [...kept, ...page.waiting.map((c: any) => at(c.file))]);
  }
}
// As many as the route takes before it refuses: the refusal's status and the count let in
async function untilRefused(send: () => { status: number } | Promise<{ status: number }>) {
  for (let n = 0; n < 500; n++) {
    const { status } = await send();
    if (status !== 200) return { status, n };
  }
  return { status: 200, n: 500 };
}
const DAY_AGO = new Date(Date.now() - 25 * 3600_000);

test("a picture for a free page is uploaded, stripped and kept, shown only for its own page, at HQ's size", async () => {
  const { id } = await create();
  const other = await create();
  const up = await upload(id);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.file, new RegExp(`^${id}-s-[0-9a-f]{8}\\.png$`));
  assert.equal(up.body.url, scrapUrl(id, up.body.file));
  assert.equal(statSync(`${DIR}/${up.body.file}`).mode & 0o777, 0o600);
  assert.match((await upload(id, JPEG, 'image/png')).body.file, /\.jpg$/, 'the type from the bytes');
  const picture = await shown(up.body.url);
  assert.deepEqual([picture.status, picture.headers.get('content-type')], [200, 'image/png']);
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), PNG);
  for (const url of [
    scrapUrl(other.id, up.body.file),
    `/api/book/scrap?id=${id}&file=..%2F${up.body.file}`,
    scrapUrl(id, `${id}-s-00000000.png`),
  ])
    assert.equal((await shown(url)).status, 404, url);
  assert.equal((await fetch(base + up.body.url)).status, 401);

  assert.equal((await upload(9999)).status, 404);
  assert.equal((await upload(id, Buffer.concat([PNG, Buffer.alloc(pictures.MAX_BYTES)]))).status, 413);
  const capped = await untilRefused(() => upload(id));
  assert.equal(capped.status, 429);
  assert.ok(capped.n > 10, `room for a page's worth first (${capped.n})`);
  assert.equal((await upload(other.id)).status, 200, 'another page has its own');
});

test('a save places the scraps, kept whole or refused, and HQ reads them back with their addresses', async () => {
  const { id } = await create();
  const other = await create();
  const a = (await upload(id)).body.file,
    b = (await upload(id)).body.file,
    foreign = (await upload(other.id)).body.file;
  const saved = await save(id, [STROKE], [{ ...at(a), x: 10.123456, tilt: 3.14159 }, at(b, 200)]);
  assert.equal(saved.body.pictures, 2);
  assert.deepEqual((await read(id)).scraps, [
    { file: a, x: 10.12, y: 20, w: 120, h: 90, tilt: 3.14, url: scrapUrl(id, a) },
    { ...at(b, 200), url: scrapUrl(id, b) },
  ]);
  for (const bad of [
    [at(foreign)],
    [at(`${id}-s-00000000.png`)],
    [at('../pictures/1.png')],
    [at(a), at(a, 50)],
    [{ ...at(a), x: 24001 }],
    [{ ...at(a), h: 12001 }],
    [{ ...at(a), tilt: 181 }],
    [{ ...at(a), w: null }],
    { file: a },
    null,
  ])
    assert.equal((await save(id, [STROKE], bad)).status, 400, JSON.stringify(bad));
  assert.equal((await read(id)).scraps.length, 2, 'nothing refused was kept');
  assert.equal((await save(id, [], [])).body.pictures, 0);
  assert.ok(existsSync(`${DIR}/${a}`) && existsSync(`${DIR}/${b}`), 'none placed: the files kept a while');
});

test("a save sweeps the page's scrap files nothing names once they're a day old; delete takes them all", async () => {
  const { id } = await create();
  const placed = (await upload(id)).body.file,
    removed = (await upload(id)).body.file,
    old = (await upload(id)).body.file;
  utimesSync(`${DIR}/${old}`, DAY_AGO, DAY_AGO);
  utimesSync(`${DIR}/${placed}`, DAY_AGO, DAY_AGO);
  await save(id, [STROKE], [at(placed)]);
  assert.deepEqual(scrapsOf(id).sort(), [placed, removed].sort());
  utimesSync(`${DIR}/${removed}`, DAY_AGO, DAY_AGO);
  await save(id, [STROKE], [at(placed)]);
  assert.deepEqual(scrapsOf(id), [placed]);
  // one placed long ago and taken off now is kept a day from now: undo can place it again
  utimesSync(`${DIR}/${placed}`, DAY_AGO, DAY_AGO);
  await save(id, [STROKE], []);
  assert.equal((await save(id, [STROKE], [at(placed)])).status, 200);
  await h.board('/api/book/page/delete', { id });
  assert.deepEqual(scrapsOf(id), []);
});

test('pictures sent to the book wait on a new page or the free page last opened, out of its picture, until placed', async () => {
  await placeWaiting();
  const fresh = toBook({ picture: DRAWN, to: 'new' });
  assert.deepEqual([fresh.status, fresh.json.fresh], [200, true], fresh.text);
  const page = await read(fresh.json.id);
  assert.deepEqual([page.kind, page.w, page.h, page.pictures, page.waiting.length], ['free', 1200, 800, 0, 1]);
  assert.equal(page.waiting[0].url, scrapUrl(fresh.json.id, page.waiting[0].file));
  const job = await h.start({ agent: 'wren' });
  assert.equal((await agent(`sketch?id=${fresh.json.id}`, job.token)).body.pictures, 0, 'no agent sees it yet');
  await h.finish(job);

  const sent = (to: 'new' | 'last') => toBook({ picture: DRAWN, to }).json;
  const a = await create(),
    b = await create();
  const open = async (id: number) => {
    await new Promise(r => setTimeout(r, 5)); // (each read a later moment)
    await read(id);
  };
  await open(b.id);
  await open(a.id);
  assert.deepEqual(sent('last'), { id: a.id, fresh: false });
  await open(b.id);
  assert.deepEqual(sent('last'), { id: b.id, fresh: false });
  await h.board('/api/book/page/archive', { id: b.id, archived: true });
  assert.deepEqual(sent('last'), { id: a.id, fresh: false });

  // a save that places one takes it off the waiting list; the rest wait on, never swept
  const waiting = (await read(a.id)).waiting as { file: string }[];
  await save(a.id, [STROKE], [at(waiting[0].file)]);
  const after = await read(a.id);
  assert.deepEqual([after.waiting.map((c: any) => c.file), after.pictures], [[waiting[1].file], 1]);
  utimesSync(`${DIR}/${waiting[1].file}`, DAY_AGO, DAY_AGO);
  await save(a.id, [STROKE], [at(waiting[0].file)]);
  assert.ok(existsSync(`${DIR}/${waiting[1].file}`));

  // a cap across the book, kept in it: 'new' can't get round it
  const capped = await untilRefused(() => toBook({ picture: DRAWN, to: 'new' }));
  assert.equal(capped.status, 429);
  await placeWaiting();
  assert.equal(toBook({ picture: DRAWN, to: 'new' }).status, 200, 'placed, they make room again');
  assert.equal(toBook({ picture: 'data:image/svg+xml;base64,PHN2Zz4=', to: 'new' }).status, 400, 'not a picture');
  await placeWaiting();
});

// ---------------------------------------------------------------- invited people's own.
const guests = await import('../guests.ts');

test("the board still opens an invited person's legacy pages and saves without overwriting another writer", async () => {
  guests.invite('Pia', 'pia@example.org');
  const listedPia = ((await h.board('/api/book/people')).body as any[]).find(p => p.name === 'Pia');
  assert.match(listedPia.colour, /^#[0-9a-f]{6}$/);
  const { who } = listedPia;
  const hers = book.createPage({ kind: 'free', w: 800, h: 600 }, who) as { id: number };
  const theirs = book.savePage({ id: hers.id, ink: [STROKE], scraps: [] }, who) as { updated: string };
  const day = (await h.board(`/api/book?who=${encodeURIComponent(who)}`)).body;
  assert.ok(day.pages.some((p: any) => p.id === hers.id));
  assert.ok(!(await listed()).some(p => p.id === hers.id));
  const page = (await h.board(`/api/book/page?id=${hers.id}&who=${encodeURIComponent(who)}`)).body;
  const saveAs = (ink: unknown, since: string, id = hers.id) =>
    h.board('/api/book/page/save', { who, id, ink, scraps: [], since });
  assert.equal((await saveAs([...page.ink, LIGHT], page.updated)).status, 200);
  assert.equal((await saveAs([STROKE], theirs.updated)).status, 409, 'saved since: read it again');
  const own = await create();
  assert.equal((await h.board('/api/book/page/save', { who, id: own.id, ink: [], scraps: [] })).status, 404);
  for (const nobody of ['guest:999999', 'someone'])
    assert.equal((await h.board(`/api/book?who=${nobody}`)).status, 404);
});

test("an invited person's legacy pages keep to their storage", async () => {
  guests.invite('Uma', 'uma@example.org');
  const who = people.whoOf(people.grantOf('Uma')!);
  const first = book.createPage({ kind: 'free', w: 800, h: 600 }, who) as { id: number };
  book.savePage({ id: first.id, ink: [STROKE], scraps: [] }, who);
  const filler = `${DIR}/${first.id}-s-00000000.png`;
  writeFileSync(filler, '');
  truncateSync(filler, people.GUEST_SPACE);
  assert.equal((book.savePage({ id: first.id, ink: [STROKE, STROKE], scraps: [] }, who) as any)[0], 413);
  assert.equal((book.createPage({ kind: 'free', w: 800, h: 600 }, who) as any)[0], 413);
  rmSync(filler);
  assert.ok(!Array.isArray(book.savePage({ id: first.id, ink: [STROKE, STROKE], scraps: [] }, who)), 'room again');
  assert.ok(!Array.isArray(book.createPage({ kind: 'free', w: 800, h: 600 }, who)));
});

test("a person's book keeps their name at their address once a page is in it; an empty one keeps nothing", async () => {
  // invited at one address, with nothing else of theirs open: the board may name someone else so at another
  assert.ok(!Array.isArray(guests.invite('Rafa', 'rafa@example.org')));
  assert.ok(people.hasBook('Rafa'), 'a book from the invite');
  assert.ok(!Array.isArray(guests.invite('Rafa', 'rafa.other@example.org')), 'an empty book keeps no name');
  // a page in the new book, and the name stays with the person who has it
  const rafas = people.whoOf(people.grantOf('Rafa')!),
    page = book.createPage({ w: 800, h: 600, kind: 'free' }, rafas) as { id: number };
  const refused = guests.invite('Rafa', 'rafa@example.org');
  assert.ok(Array.isArray(refused) && refused[0] === 409, 'a book with a page in it keeps the name');
  assert.equal(guests.emailOf('Rafa'), 'rafa.other@example.org');
  // its page gone, the book is empty again and keeps nothing
  book.deletePage(page.id, rafas);
  assert.ok(!Array.isArray(guests.invite('Rafa', 'rafa@example.org')));
});
