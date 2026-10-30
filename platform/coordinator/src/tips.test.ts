// node --test src/tips.test.ts   (uses a throwaway DATA_DIR)
// The feature tips the board's events bring: the pin's with its first picture, a seat's past 80% of its week, the
// desk phone's and calls' when a card shows, filed or let go by later.ts, and those only HQ's page sees. A tip on the
// desk phone: after the cards that need an answer, never in their place, and off to Later and back like a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

// (a company with its own names for the desk phone and the intercom)
const h = await harness('tips', {
  before: repo => {
    const file = `${repo}/company/brand.yaml`;
    writeFileSync(file, readFileSync(file, 'utf8').replace('names: {', 'names: { intercom: speaking tube,'));
  },
});
const { db, board, worker } = h;
const { ORIGIN } = await import('./config.ts');
const jobs = await import('./jobs.ts');
const later = await import('./later.ts');
const tips = await import('./tips.ts');

const offered = () =>
  (db.prepare('select key, details from tips order by key').all() as { key: string; details: string }[]).map(t => ({
    key: t.key,
    details: JSON.parse(t.details),
  }));
const keys = () => offered().map(t => t.key);
const dayFrom = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now() + n * 864e5);
const card = (title: string, extra: Record<string, unknown> = {}) =>
  (jobs.createRequest({ kind: 'decision', title, body: 'Yes or no?', ...extra }) as { id: number }).id;
// Time passes (no route moves the clock): the card's day has come
const arrive = (id: number) =>
  db.prepare('update requests set hidden_until = ? where id = ?').run(new Date().toISOString(), id);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=',
  'base64',
);

test("an agent's card for later brings the desk phone's tip only when its day comes and it shows", () => {
  const id = card('A bench for the garden?', { agent: 'kit', visibleFrom: dayFrom(3) });
  assert.deepEqual(keys(), [], 'off the phone: no tip');
  arrive(id);
  later.sweep();
  assert.deepEqual(keys(), ['deskphone']);
});

test('the third card waiting, brought back from Later, brings the calls tip', async () => {
  card('Which colour?');
  const third = card('Which day?', { visibleFrom: dayFrom(2) });
  assert.deepEqual(keys(), ['deskphone'], 'two waiting');
  assert.equal((await board('/api/requests/later', { id: third, day: null })).status, 200);
  assert.deepEqual(keys(), ['calls', 'deskphone']);
});

test("the board's first line with a picture brings the pin's tip; a line without one doesn't", async () => {
  assert.equal((await board('/api/chat', { text: 'Hello' })).status, 200);
  assert.equal(keys().includes('pin'), false);
  const uploaded = await fetch(`${h.base}/api/pictures`, {
    method: 'POST',
    headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/png' },
    body: PNG,
  });
  const { id } = (await uploaded.json()) as { id: number };
  assert.equal((await board('/api/chat', { text: 'This one', pictures: [id] })).status, 200);
  assert.equal(keys().includes('pin'), true);
});

test("a seat's reading past 80% of its week brings the seats' tip with the seat's name, the seat warning off", async () => {
  const reading = (week: number) => worker('seat', { seat: 'claude-2', engine: 'claude', state: 'ready', week });
  assert.equal((await reading(0.79)).status, 200);
  assert.equal(keys().includes('seats'), false);
  assert.equal((await reading(0.81)).status, 200);
  assert.deepEqual(
    offered().find(t => t.key === 'seats'),
    { key: 'seats', details: { seat: 'claude-2' } },
  );
});

test("a tip's card names the intercom as the company's brand does", () => {
  const id = tips.offer('deadlines', { thread: 'The garden' });
  const { body } = db.prepare('select body from requests where id = ?').get(id) as { body: string };
  assert.match(body, /a deadline on the speaking tube:/);
  db.prepare("delete from tips where key = 'deadlines'").run(); // (the rename's test below files its own)
});

test("HQ's page brings a tip once; an event that isn't one is refused", async () => {
  const first = await board('/api/tips/events', { key: 'look' });
  assert.equal(first.status, 200);
  assert.equal(typeof first.body.id, 'number');
  assert.deepEqual((await board('/api/tips/events', { key: 'look' })).body, { id: null }, 'already offered');
  for (const key of ['nope', '__proto__', 'constructor', 'toString'])
    assert.equal((await board('/api/tips/events', { key })).status, 400, key);
});

test('an urgent card on a device without notifications brings their tip, though another device has them', async () => {
  const key = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
  const device = {
    endpoint: 'https://push.example.com/one-device',
    keys: { p256dh: key([4, ...Array(64).fill(1)]), auth: key(Array(16).fill(2)) },
  };
  assert.equal((await board('/api/push/subscribe', device)).body.devices, 1);
  assert.equal(typeof (await board('/api/tips/events', { key: 'notifications' })).body.id, 'number');
  assert.equal(keys().includes('notifications'), true);
});

const laterTitles = async () => ((await board('/api/requests/later')).body as { title: string }[]).map(r => r.title);
const phoneCards = async () => (await board('/api/requests')).body as { id: number; kind: string; title: string }[];

test('a tip put off with Later is on the Later list and comes back early; one waiting its day is not', async () => {
  const deskphone = db.prepare("select request from tips where key = 'deskphone'").get() as { request: number };
  const waiting = db
    .prepare("select title from requests where id = (select request from tips where key = 'calls')")
    .get() as {
    title: string;
  };
  assert.equal((await board('/api/requests/later', { id: deskphone.request, day: dayFrom(2) })).status, 200);
  const listed = await laterTitles();
  assert.equal(listed.includes(tipTitle(deskphone.request)), true, 'put off');
  assert.equal(listed.includes(waiting.title), false, 'waiting its day');
  assert.equal((await board('/api/requests/later', { id: deskphone.request, day: null })).status, 200);
  assert.equal(
    (await phoneCards()).some(c => c.id === deskphone.request),
    true,
    'back on the phone',
  );
});
const tipTitle = (id: number) =>
  (db.prepare('select title from requests where id = ?').get(id) as { title: string }).title;

test('the tips come after the cards that need an answer, and never take one of their places in the 100', async () => {
  const before = await phoneCards();
  assert.equal(before.at(-1)!.kind, 'tip', 'the tip last, though newer');
  const oldest = before.filter(c => c.kind !== 'tip').at(-1)!;
  const real = before.filter(c => c.kind !== 'tip').length;
  for (let n = real; n < 100; n++) card(`Card ${n}`);
  const full = await phoneCards();
  assert.equal(full.length, 100);
  assert.equal(
    full.some(c => c.kind === 'tip'),
    false,
  );
  assert.equal(full.at(-1)!.id, oldest.id, 'the oldest card keeps its place');
});

// The pausing tip became the deadlines tip: a card filed under it is moved once, at the start (run here again, the
// module loaded afresh).
test("a pausing tip's card filed before the deadlines tip gives the deadline advice, and is the deadlines tip's", async () => {
  const { lastInsertRowid } = db
    .prepare("insert into requests (created, kind, title, body, urgency, topic) values (?, 'tip', ?, ?, 'tip', 'Tips')")
    .run(
      new Date().toISOString(),
      'Some work ran past its time',
      'Deploys without buildx ran past the time it was due. You can have work paused to make room for what matters more, and started again when you like: ask on the intercom. Projects shows what’s running.',
    );
  const id = Number(lastInsertRowid);
  db.prepare("insert into tips (key, request, at) values ('pausing', ?, ?)").run(id, new Date().toISOString());
  db.prepare("delete from migrations where id = '2026-10-29-pausing-tip-is-deadlines'").run();
  // @ts-expect-error the query makes a fresh copy of the module (a restart), a path TypeScript can't resolve
  await import('./tips.ts?restart');
  const { body } = db.prepare('select body from requests where id = ?').get(id) as { body: string };
  assert.equal(
    body,
    'Deploys without buildx ran past the time it was due. Give what matters a deadline on the intercom: that work goes first, and the rest waits its turn. Projects shows when each piece lands.',
  );
  assert.equal((db.prepare('select key from tips where request = ?').get(id) as { key: string }).key, 'deadlines');
  const tips = await import('./tips.ts');
  assert.equal(tips.offer('deadlines', { thread: 'Another thread' }), null, 'no second card for the same tip');
});
