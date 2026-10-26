// node --test src/artifacts.test.ts   (HQ-OS › Artifacts: the test company's made-up products and cycles, HQ's real server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

// a business may share its id with a project
const PROJECTS = `businesses:
  - { id: game, name: Tide }
  - { id: works, name: The works }
projects:
  - { id: game, name: The game, owner: wren, business: game }
  - { id: shop, name: The shop, owner: moss }
`;
const h = await harness('artifacts', {
  env: { PUBLIC_HOST: 'hq.example.test' },
  before: repo => {
    rmSync(`${repo}/products/hello`, { recursive: true });
    writeFileSync(`${repo}/company/projects.yaml`, PROJECTS);
    writeFileSync(
      `${repo}/company/artifacts.yaml`,
      'artifacts:\n  - { name: The office, kind: app, open: "https://hq.example.test/", project: shop, shown: 2026-10-01 }\n',
    );
  },
});
const { repo, board, base, db } = h;
const projects = await import('./projects.ts');
projects.createThread({ project: 'game', name: 'The trailer', goal: 'It plays', slug: 'trailer' });

const file = (path: string, text: string) => {
  mkdirSync(`${repo}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
  writeFileSync(`${repo}/${path}`, text);
};
file('products/pebblepost/product.yaml', 'name: Pebble Post\nstatus: preview\nowner: wren\nproject: shop\n');
file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\n');
file(
  'products/tide/product.yaml',
  'name: Tide\nstatus: preview\nowner: moss\nkind: prototype\nproject: game\nshown: 2026-10-02\n',
);
file(
  'products/tide/films/trailer/artifact.yaml',
  'name: Tide trailer\nkind: film\nopen: /films/trailer/\nproject: game\nshown: 2026-10-05\npicture: films/trailer/still.png\n',
);
file('products/tide/films/trailer/still.png', 'a still');
file('products/_cycles/2026-10-01-pitch/presentation/cover.jpg', 'a cover');
file('products/tide/films/odd/artifact.yaml', 'name: Odd still\nkind: art\nopen: /odd/\npicture: still.svg\n');
file(
  'products/_cycles/2026-10-01-pitch/presentation/artifact.yaml',
  'name: The pitches\nkind: deck\nabout: Five apps, one each.\nproject: shop\npicture: cover.jpg\n',
);
file(
  'products/_cycles/2026-10-01-pitch/artifact.yaml',
  'name: Directions\nkind: art\nopen: index.html\ncards: [999]\n',
);
file('products/_cycles/2026-10-01-pitch/demo/demo.yaml', 'name: Pitch demo\nabout: Try it.\n');

const list = async () => {
  const r = await board('/api/artifacts');
  assert.equal(r.status, 200);
  return r.body as any[];
};
const one = async (name: string) => (await list()).find(a => a.name === name);
const lead = await h.start({ agent: 'juno' });
const pitchCard = await h.ask(lead, { title: 'The pitches', products: ['cycles/2026-10-01-pitch'] });
const tideCard = await h.ask(lead, { title: 'An earlier Tide presentation', products: ['tide'] });
db.prepare("update requests set created = '2026-10-01T09:00:00.000Z' where id = ?").run(tideCard);
appendFileSync(
  `${repo}/products/_cycles/2026-10-01-pitch/presentation/artifact.yaml`,
  `shown: 2026-10-03\ncards: [${pitchCard}]\n`,
);
const pebbleCard = await h.ask(lead, { title: 'Pebble Post to try', products: ['pebblepost'] });
db.prepare("update requests set created = '2026-10-03T09:00:00.000Z' where id = ?").run(pitchCard);
db.prepare("update requests set created = '2026-10-04T09:00:00.000Z' where id = ?").run(pebbleCard);

test("the list is behind the board's login", async () => {
  assert.equal((await fetch(`${base}/api/artifacts`)).status, 401);
});

test("every product, demo and artifact.yaml, newest first; one the board's day isn't known for last", async () => {
  assert.deepEqual(
    (await list()).map(a => [a.name, a.kind, a.shown]),
    [
      ['Tide trailer', 'film', '2026-10-05'],
      ['Pebble Post', 'app', '2026-10-04'],
      ['Directions', 'art', '2026-10-03'],
      ['The pitches', 'deck', '2026-10-03'],
      ['Tide', 'prototype', '2026-10-02'],
      ['The office', 'app', '2026-10-01'],
      ['Odd still', 'art', null],
      ['Pitch demo', 'prototype', null],
      ['Quiet', 'app', null],
    ],
  );
});

test("an artifact sits in its project's line of business, then its project, by their names", async () => {
  assert.deepEqual((await one('Tide trailer')).place, [
    { id: 'game', name: 'Tide', level: 'business' },
    { id: 'game', name: 'The game', level: 'project' },
  ]);
  assert.deepEqual(
    (await one('The pitches')).place,
    [{ id: 'shop', name: 'The shop', level: 'project' }],
    'a project with no business keeps its project alone',
  );
  assert.deepEqual((await one('Directions')).place, []);
});

test('`business:` places it under the line of business alone, and `project:` never names a business', async () => {
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\nbusiness: game\n');
  assert.deepEqual((await one('Quiet')).place, [{ id: 'game', name: 'Tide', level: 'business' }]);
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\nproject: works\n');
  assert.equal((await board('/api/artifacts')).status, 500, '`project:` names a project, never a business');
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\n');
});

test("the company's heroes come first, in their order", async () => {
  const office =
    'artifacts:\n  - { name: The office, kind: app, open: "https://hq.example.test/", project: shop, shown: 2026-10-01 }\n';
  file('company/artifacts.yaml', `heroes: [quiet, "https://hq.example.test/"]\n${office}`);
  const all = await list();
  assert.deepEqual(
    all.slice(0, 3).map(a => [a.name, a.hero]),
    [
      ['Quiet', true],
      ['The office', true],
      ['Tide trailer', false],
    ],
  );
  file('company/artifacts.yaml', office);
});

test('an artifact its file archives says so, and the rest are not archived', async () => {
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\narchived: true\n');
  file('products/tide/films/odd/artifact.yaml', 'name: Odd still\nkind: art\nopen: /odd/\narchived: true\n');
  const archived = (await list()).filter(a => a.archived).map(a => a.name);
  assert.deepEqual(archived, ['Odd still', 'Quiet']);
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\n');
  file('products/tide/films/odd/artifact.yaml', 'name: Odd still\nkind: art\nopen: /odd/\npicture: still.svg\n');
});

test('folder cards belong to roots, child artifacts keep their own cards and explicit day', async () => {
  assert.equal((await one('Tide')).shown, '2026-10-02');
  assert.equal((await one('Tide trailer')).shown, '2026-10-05');
  assert.deepEqual((await one('Tide trailer')).cards, []);
  assert.deepEqual((await one('Pitch demo')).cards, []);
  assert.deepEqual((await one('Pebble Post')).cards, [
    { id: pebbleCard, title: 'Pebble Post to try', day: '2026-10-04' },
  ]);
  assert.deepEqual(
    (await one('The pitches')).cards.map((c: any) => c.id),
    [pitchCard],
    'the child artifact explicitly names this card',
  );
  assert.deepEqual(
    (await one('Directions')).cards.map((c: any) => c.id),
    [pitchCard],
    "a card that isn't there adds nothing",
  );
});

test('each opens where its host serves it, with its cover from HQ', async () => {
  const pitches = await one('The pitches');
  assert.equal(pitches.open, 'https://cycles.preview.example.test/2026-10-01-pitch/presentation/');
  assert.match(pitches.picture, /^\/cycles\/2026-10-01-pitch\/presentation\/cover\.jpg\?v=[0-9a-z]+$/);
  assert.equal(pitches.about, 'Five apps, one each.');
  assert.equal((await one('Directions')).open, 'https://cycles.preview.example.test/2026-10-01-pitch/index.html');
  assert.equal((await one('Tide trailer')).open, 'https://tide.preview.example.test/films/trailer/');
  assert.equal((await one('Pitch demo')).open, 'https://cycles.preview.example.test/2026-10-01-pitch/demo/');
  assert.deepEqual(
    [(await one('The office')).open, (await one('The office')).place],
    ['https://hq.example.test/', [{ id: 'shop', name: 'The shop', level: 'project' }]],
    "company/artifacts.yaml's, at its own address",
  );
  const pebble = await one('Pebble Post');
  assert.deepEqual(
    [pebble.open, pebble.status, pebble.owner],
    ['https://pebblepost.preview.example.test', 'preview', 'wren'],
  );
});

test("a cover in a product's folder comes from HQ, behind the board's login, never an SVG", async () => {
  const trailer = await one('Tide trailer');
  assert.match(trailer.picture, /^\/api\/artifacts\/picture\?id=tide%2Ffilms%2Ftrailer&v=[0-9a-z]+$/);
  const got = await fetch(`${base}${trailer.picture}`, { headers: { cookie: h.boardCookie } });
  assert.deepEqual([got.status, await got.text()], [200, 'a still']);
  assert.equal((await fetch(`${base}${trailer.picture}`)).status, 401);
  for (const id of ['tide/films/odd', 'tide/../tide/films/trailer', 'tide'])
    assert.equal(
      (
        await fetch(`${base}/api/artifacts/picture?id=${encodeURIComponent(id)}`, {
          headers: { cookie: h.boardCookie },
        })
      ).status,
      404,
      id,
    );
});

test('a product and company/artifacts.yaml name covers too, kept by the browser until the file changes', async () => {
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\npicture: cover.jpg\n');
  file('products/quiet/cover.jpg', 'quiet');
  file(
    'company/artifacts.yaml',
    'artifacts:\n  - { name: The office, kind: app, open: "https://hq.example.test/", project: shop, picture: covers/office.jpg }\n',
  );
  file('company/covers/office.jpg', 'the office');
  for (const [name, id, body] of [
    ['Quiet', 'quiet', 'quiet'],
    ['The office', 'https://hq.example.test/', 'the office'],
  ]) {
    const { picture } = await one(name);
    assert.equal(new URL(picture, base).searchParams.get('id'), id);
    const got = await fetch(`${base}${picture}`, { headers: { cookie: h.boardCookie } });
    assert.deepEqual([got.status, await got.text()], [200, body], name);
    assert.match(String(got.headers.get('cache-control')), /immutable/, name);
  }
  // the same file keeps its address; a new shot gets a new one, which serves it
  const kept = (await one('Quiet')).picture;
  assert.equal((await one('Quiet')).picture, kept);
  file('products/quiet/cover.jpg', 'quiet again');
  const later = new Date(statSync(`${repo}/products/quiet/cover.jpg`).mtimeMs + 60_000);
  utimesSync(`${repo}/products/quiet/cover.jpg`, later, later);
  const shot = (await one('Quiet')).picture;
  assert.notEqual(shot, kept);
  const fresh = await fetch(`${base}${shot}`, { headers: { cookie: h.boardCookie } });
  assert.deepEqual([fresh.status, await fresh.text()], [200, 'quiet again']);
  // a picture named but not there fails the list
  rmSync(`${repo}/products/quiet/cover.jpg`);
  assert.equal((await board('/api/artifacts')).status, 500);
  file('products/quiet/product.yaml', 'name: Quiet\nstatus: preview\nowner: moss\n');
  file(
    'company/artifacts.yaml',
    'artifacts:\n  - { name: The office, kind: app, open: "https://hq.example.test/", project: shop, shown: 2026-10-01 }\n',
  );
});

test("a file that doesn't parse, a project HQ doesn't have, or a thread, even a real one, fails the list", async () => {
  for (const [path, text] of [
    [
      'products/_cycles/2026-10-01-pitch/lost/artifact.yaml',
      'name: Lost\nkind: deck\nopen: index.html\nproject: nowhere\n',
    ],
    [
      'products/_cycles/2026-10-01-pitch/thread/artifact.yaml',
      'name: Made by a thread\nkind: deck\nopen: index.html\nproject: game/trailer\n',
    ],
    ['products/_cycles/2026-10-01-pitch/broken/artifact.yaml', 'name: [Broken\n'],
  ]) {
    file(path, text);
    assert.equal((await board('/api/artifacts')).status, 500, path);
    rmSync(`${repo}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
  }
  assert.equal((await board('/api/artifacts')).status, 200);
});
