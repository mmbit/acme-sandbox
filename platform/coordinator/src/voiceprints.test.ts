// node --test src/voiceprints.test.ts   (the voices calls recognise: the voice line's routes and the board's list;
// the harness's throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { harness } from './harness.ts';

let repo = '';
const h = await harness('voiceprints', { before: r => (repo = r) });
const { board, voice } = h;
const { db } = await import('./db.ts');
const { yearly } = await import('./voiceprints.ts');

const print = (x: number) => Array.from({ length: 192 }, (_, i) => x + i / 1000);
const enrol = (name: string, x: number, more = {}) =>
  voice('voiceprint', {
    name,
    print: print(x),
    pieces: 3,
    consent: 'Yes, you can keep my voice.',
    asked: 'May I remember your voice for next time?',
    call: 248,
    ...more,
  });
const voices = async () =>
  (await voice('voiceprints')).body.voices as { id: number; name: string; print: number[]; pieces: number }[];

test('a voice enrolled on a call is matched by the voice line, listed for the board without its print or consent, and enrolled again by name', async () => {
  const saved = await enrol('Anna', 0.1);
  assert.equal(saved.status, 200);
  assert.deepEqual(await voices(), [{ id: saved.body.id, name: 'Anna', print: print(0.1), pieces: 3 }]);

  const listed = (await board('/api/voiceprints')).body;
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['call', 'enrolledAt', 'heardAt', 'id', 'name']);
  assert.deepEqual(
    { ...listed[0], enrolledAt: 0 },
    { id: saved.body.id, name: 'Anna', call: 248, enrolledAt: 0, heardAt: null },
  );

  const again = await enrol('  anna ', 0.2);
  assert.deepEqual(
    await voices(),
    [{ id: again.body.id, name: 'anna', print: print(0.2), pieces: 3 }],
    'one print per name, in any case',
  );
  await board('/api/voiceprints/delete', { id: again.body.id });
});

test('a later call refines the voices it heard, never one deleted meanwhile', async () => {
  const kept = (await enrol('Bram', 0.3)).body.id,
    gone = (await enrol('Cleo', 0.4)).body.id;
  assert.deepEqual((await board('/api/voiceprints/delete', { id: gone })).body, { ok: true });
  const heard = await voice('voiceprints-heard', {
    heard: [kept, gone].map(id => ({ id, print: print(0.5), pieces: 7 })),
  });
  assert.deepEqual(heard.body, { ok: true });
  assert.deepEqual(await voices(), [{ id: kept, name: 'Bram', print: print(0.5), pieces: 7 }]);
  assert.ok((await board('/api/voiceprints')).body[0].heardAt > 0);

  // someone new, enrolled twice since: a refinement meant for an earlier id lands on no one
  await enrol('Gus', 0.6);
  const gus = (await enrol('Gus', 0.65)).body.id;
  await voice('voiceprints-heard', { heard: [gone, gus - 1].map(id => ({ id, print: print(0.7), pieces: 8 })) });
  assert.deepEqual(await voices(), [
    { id: kept, name: 'Bram', print: print(0.5), pieces: 7 },
    { id: gus, name: 'Gus', print: print(0.65), pieces: 3 },
  ]);
  assert.equal((await board('/api/voiceprints')).body[0].heardAt, null);
});

test('"forget my voice" on a call and the board\'s tap delete it; the board deletes only what is there', async () => {
  await enrol('Dirk', 0.1);
  assert.deepEqual((await voice('voiceprint-forget', { name: 'DIRK' })).body, { forgot: true });
  assert.deepEqual((await voice('voiceprint-forget', { name: 'Dirk' })).body, { forgot: false });
  assert.ok(!(await voices()).some(v => v.name === 'Dirk'));
  assert.equal((await board('/api/voiceprints/delete', { id: 999_999 })).status, 404);
});

test("the voice line is told what to say before enrolling: the company's words, else none", async () => {
  assert.equal((await voice('voiceprints')).body.consent, null);
  appendFileSync(`${repo}/company/brand.yaml`, '\nvoiceprints:\n  consent: "Our own words on voices."\n');
  assert.equal((await voice('voiceprints')).body.consent, 'Our own words on voices.');
});

test('a print, name, pieces or consent of the wrong shape is refused', async () => {
  for (const wrong of [
    { name: ' ' },
    { name: 'x'.repeat(41) },
    { name: 'Eve\nAdams' },
    { print: print(0).slice(1) },
    { print: [...print(0).slice(1), null] },
    { print: 'numbers' },
    { pieces: 0 },
    { pieces: 1.5 },
    { consent: '' },
    { consent: 'y'.repeat(601) },
    { asked: '' },
  ])
    assert.equal((await enrol('Eve', 0.1, wrong)).status, 400, JSON.stringify(wrong).slice(0, 40));
  assert.equal((await voice('voiceprints-heard', { heard: [{ id: 1, print: [1], pieces: 1 }] })).status, 400);
  assert.equal((await voice('voiceprints-heard', {})).status, 400);
  assert.ok(!(await voices()).some(v => v.name === 'Eve'));
});

test('only the voice line reaches the prints, and only the board its list', async () => {
  const stranger = { authorization: 'Bearer nope', 'content-type': 'application/json' };
  assert.equal((await h.send('/api/voice/voiceprints', stranger)).status, 401);
  for (const path of ['/api/voice/voiceprint', '/api/voice/voiceprints-heard', '/api/voice/voiceprint-forget'])
    assert.equal((await h.send(path, stranger, {})).status, 401, path);
  assert.equal((await h.send('/api/voice/voiceprints', { cookie: 's=board-voiceprints' })).status, 401);
  const id = (await enrol('Fien', 0.1)).body.id;
  for (const [path, body] of [
    ['/api/voiceprints', undefined],
    ['/api/voiceprints/delete', { id }],
  ] as const)
    assert.ok([401, 403].includes((await h.send(path, { authorization: 'Bearer voice-secret' }, body)).status), path);
  assert.ok((await voices()).some(v => v.id === id));
});

test('a voice unheard for a year brings one card: keep resets its year, delete and 30 days unanswered delete it', async context => {
  const DAY = 24 * 3600_000,
    now = Date.now();
  for (const v of (await board('/api/voiceprints')).body as { id: number }[])
    await board('/api/voiceprints/delete', { id: v.id }); // (the earlier tests' voices)
  // saved a year and a day ago, Mona 300 days ago
  context.mock.timers.enable({ apis: ['Date'], now: now - 366 * DAY });
  const ids = {} as Record<string, number>;
  for (const name of ['Hana', 'Ivo', 'Jet', 'Kees', 'Lot']) ids[name] = (await enrol(name, 0.1)).body.id;
  context.mock.timers.setTime(now - 300 * DAY);
  ids.Mona = (await enrol('Mona', 0.6)).body.id;
  context.mock.timers.reset();

  const open = async () =>
    ((await board('/api/requests')).body as { id: number; kind: string; title: string; body: string }[]).filter(
      c => c.kind !== 'tip',
    );
  const titles = async () => (await open()).map(c => c.title).toSorted();
  const saved = async () => (await voices()).map(v => v.name);
  const keep = (...names: string[]) => names.map(n => `Keep ${n}'s saved voice?`);
  const answer = async (name: string, option: string) =>
    (await h.answer((await open()).find(c => c.title === keep(name)[0])!.id, '', { answers: [option] })).status;

  yearly(now);
  assert.deepEqual(await titles(), keep('Hana', 'Ivo', 'Jet', 'Kees', 'Lot'), "Mona's year isn't up");
  assert.match(
    (await open())[0].body,
    /no call has heard it since it was saved on \d+ \w+ 20\d\d\. .*Unanswered, it's deleted on \d+ \w+ 20\d\d\.$/,
  );
  yearly(now + DAY);
  assert.equal((await open()).length, 5, 'never twice for the same voice');

  const madeJobs = () => (db.prepare('select count(*) n from jobs').get() as { n: number }).n,
    before = madeJobs();
  assert.equal(await answer('Hana', 'Keep it another year'), 200);
  assert.equal(await answer('Ivo', 'Delete it'), 200);
  await board('/api/voiceprints/delete', { id: ids.Jet });
  await voice('voiceprints-heard', { heard: [{ id: ids.Kees, print: print(0.45), pieces: 4 }] });
  assert.deepEqual(await titles(), keep('Lot'), 'kept, deleted or heard: off the desk phone');
  assert.deepEqual(await saved(), ['Hana', 'Kees', 'Lot', 'Mona']);
  assert.equal(madeJobs(), before, 'no job is made to hear the answers');

  // Lot's card unanswered for 30 days: deleted, and the card leaves saying so
  yearly(now + 29 * DAY);
  assert.deepEqual(await saved(), ['Hana', 'Kees', 'Lot', 'Mona']);
  yearly(now + 31 * DAY);
  assert.deepEqual(await saved(), ['Hana', 'Kees', 'Mona']);
  assert.deepEqual(await open(), []);
  const archived = (await board('/api/requests/archive')).body.cards as { title: string; closing: string }[];
  assert.match(archived.find(c => c.title === keep('Lot')[0])!.closing, /unanswered for 30 days/);

  // Hana's year starts again when it's kept, Kees's when a call hears it
  yearly(now + 364 * DAY);
  assert.deepEqual(await titles(), keep('Mona'));
  yearly(now + 366 * DAY);
  assert.deepEqual(await titles(), keep('Hana', 'Kees', 'Mona'));
  for (const name of ['Hana', 'Kees', 'Mona']) await board('/api/voiceprints/delete', { id: ids[name] });
  assert.deepEqual(await open(), []);
});
