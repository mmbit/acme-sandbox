// node --test src/ink/callpointers.test.ts   (who reacts to the board's ink on a live call's notes page, on the real
// server: the book's judge never, the call's agent alone; the board's ink on the agent's own scraps and versions points,
// reaches the agent as a mark, and goes once the agent's turn on it is done)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('callpointers');
const { db } = h;
const judge = await import('./bookjudge.ts');
const { addSlip } = await import('./bookslips.ts');
const { addWords } = await import('../notebookscraps.ts');
const { pageRow } = await import('../notebook.ts');

const stroke = (x: number) => ({
  color: '#292722',
  size: 4,
  points: [
    [x, 10, 0.5, 0],
    [x + 50, 40, 0.5, 10],
  ],
});
const said = (r: { status: number; body: any }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const unit = async (page: number, id: number) =>
  (said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups as any[]).find(g => g.id === id);
const claimed = async () => (await h.worker('reads/claim')).body.reading;
const verdicts = () => db.prepare('select * from ink_verdicts').all();

test('on a call’s page the judge reads nothing of the board’s; in the Journal it does', async () => {
  const { call } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const texts = [{ x: 10, y: 10, w: 200, text: 'werk hier drie varianten van uit', color: '#292722' }];
  const mine = said(await h.board('/api/notebooks/groups/create', { page, ink: [stroke(10)], texts }));
  assert.equal(await judge.judge({ grp: mine.id }), null);
  await new Promise(res => setTimeout(res, 100));
  assert.equal(await claimed(), undefined, 'no model asked');
  assert.deepEqual(verdicts(), []);
  assert.equal((await unit(page, mine.id)).seen, null, 'no tick');
  assert.equal(
    (db.prepare('select count(*) n from jobs where kind in (?, ?)').get('try', 'ink-answer') as { n: number }).n,
    0,
  );
  // (the same words on a page of the Journal go to the judge)
  const journal = said(await h.board('/api/notebooks/pages/create', { notebook: pageRow(page, 'board')!.notebook }));
  said(await h.board('/api/notebooks/groups/create', { page: journal.id, ink: [stroke(10)], texts }));
  let reading;
  for (let i = 0; i < 40 && !reading; i++) {
    reading = await claimed();
    if (!reading) await new Promise(res => setTimeout(res, 20));
  }
  assert.ok(reading, 'the Journal’s note is judged');
  await h.worker('reads/answer', {
    reading,
    result: { is_error: false, structured_output: { reply: 'none', why: 'a test' } },
  });
});

test('the board’s ink on the agent’s scrap points: the agent hears it, its ink alone goes once the turn is done', async () => {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  // (the agent's own scrap, with its own ring, and its own change later is no pointer)
  const own = said(await h.voice('mark', { call, mark: 'rect', box: { x: 10, y: 10, width: 50, height: 50 } }));
  const before = await unit(page, own.id);
  assert.equal(before.pointed, false);
  assert.equal((await h.voice(`drawn?id=${own.id}&call=${call}`)).status, 404, 'its own: no mark');

  // The board circles on it
  const circled = said(
    await h.board('/api/notebooks/groups/edit', {
      id: own.id,
      since: before.updated,
      ink: [...before.ink, stroke(80)],
    }),
  );
  const shown = await unit(page, own.id);
  assert.equal(shown.pointed, true);
  assert.equal(shown.seen, null);
  const heard = said(await h.voice(`drawn?id=${own.id}&call=${call}`));
  assert.deepEqual([heard.n, heard.who, heard.words, heard.updated], [own.id, 'Board', '', circled.updated]);
  assert.deepEqual(heard.pointer, { on: own.id, version: null });
  assert.equal(heard.picture.type, 'image/png');

  // Drawn on again before the turn was done: it stays, and comes again
  const more = said(
    await h.board('/api/notebooks/groups/edit', {
      id: own.id,
      since: circled.updated,
      ink: [...circled.ink, stroke(140)],
    }),
  );
  assert.deepEqual(said(await h.voice('pointed', { id: own.id, call, updated: circled.updated })), { cleared: false });
  assert.equal((await unit(page, own.id)).ink.length, 3);
  // (another call's word is no one's)
  assert.equal((await h.voice('pointed', { id: own.id, call: call + 1, updated: more.updated })).status, 404);

  // The turn on it done: the board's strokes go, the agent's ring stays
  assert.deepEqual(said(await h.voice('pointed', { id: own.id, call, updated: more.updated })), { cleared: true });
  const after = await unit(page, own.id);
  assert.deepEqual(after.ink, before.ink);
  assert.equal(after.pointed, false);
  assert.equal((await h.voice(`drawn?id=${own.id}&call=${call}`)).status, 404, 'nothing left to point');
  said(await h.voice('call-end', { agent: 'juno', lines: ['Board: Zo.'], token }));
});

test('a circle on the agent’s version on a call’s page goes to the agent alone, and goes once its turn is done', async () => {
  const { call, token } = await h.liveCall('juno');
  const at = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const g = addWords(pageRow(at, 'board')!, 'juno', 'Twee knoppen', { room: 0 }) as { id: number };
  const red = { r: 176, g: 65, b: 47 },
    picture = {
      type: 'image/png',
      clean: await sharp({ create: { width: 160, height: 120, channels: 3, background: red } })
        .png()
        .toBuffer(),
    };
  const slips = ['A', 'B', 'C'].map(v =>
    addSlip(null, 'juno', null, `Button ${v}`, { grp: g.id, style: 'version', version: v, picture }),
  );
  const sheets = () => (db.prepare('select count(*) n from book_sheets').get() as { n: number }).n;
  const had = sheets();
  // (circled where HQ showed version C)
  const frame = { x: 0, y: 0, w: 300, h: 225 };
  const reply = said(await h.board('/api/notebooks/groups/reply', { answer: slips[2].id, ink: [stroke(10)], frame }));
  await new Promise(res => setTimeout(res, 100));
  assert.equal(sheets(), had, 'no note goes to anyone');
  assert.equal(await claimed(), undefined, 'no judge');
  assert.equal(db.prepare('select picked from book_slips where id = ?').get(slips[2].id)!.picked, null, 'no pick');
  const kids = (await unit(at, g.id)).children.filter((c: any) => c.kind === 'reply');
  assert.deepEqual(
    kids.map((c: any) => [c.id, c.by]),
    [[reply.id, 'board']],
  );
  const heard = said(await h.voice(`drawn?id=${reply.id}&call=${call}`));
  assert.deepEqual([heard.who, heard.pointer], ['Board', { on: g.id, version: 'C' }]);
  // (its picture is version C with the ink over it, not the strokes on blank paper: the frame's middle is C's)
  const shot = sharp(Buffer.from(heard.picture.data, 'base64'));
  const { width, height } = await shot.metadata();
  const { data } = await shot
    .extract({ left: Math.round(width! / 2), top: Math.round(height! / 2), width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [red.r, red.g, red.b]);
  assert.deepEqual(said(await h.voice('pointed', { id: reply.id, call, updated: heard.updated })), { cleared: true });
  assert.deepEqual(
    (await unit(at, g.id)).children.filter((c: any) => c.kind === 'reply'),
    [],
  );
  said(await h.voice('call-end', { agent: 'juno', lines: ['Board: Zo.'], token }));
  // (the call over, a reply there goes to its agent as ever)
  said(await h.board('/api/notebooks/groups/reply', { answer: slips[1].id, ink: [stroke(10)] }));
  assert.equal(sheets(), had + 1);
});
