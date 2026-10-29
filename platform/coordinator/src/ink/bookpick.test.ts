// node --test src/ink/bookpick.test.ts   (the board rings a version to pick it: the ring goes as a reply on that
// version, drawn over its frame in the picture the judge reads; the judge's 'pick' picks it and unpicks the rest of its
// set; the try run hears which; the note the tried group goes as carries the frame and the patch)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('bookpick');
const { agent, db } = h;
const judge = await import('./bookjudge.ts');
const { withPicks, pickedOn } = await import('./bookpick.ts');
afterEach(() => h.cancelQueued());

const png = async (background: string) =>
  `data:image/png;base64,${(
    await sharp({ create: { width: 160, height: 120, channels: 3, background } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
const stroke = (points: number[][]) => ({
  color: '#2B2230',
  size: 4,
  points: points.map(([x, y], i) => [x, y, 0.5, i * 16]),
});
// A ring round a box, as a pen draws one: a loop a little outside it
const ring = (b: { x: number; y: number; w: number; h: number }) =>
  stroke(
    Array.from({ length: 25 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return [b.x + b.w / 2 + Math.cos(a) * (b.w / 2 + 14), b.y + b.h / 2 + Math.sin(a) * (b.h / 2 + 14)];
    }),
  );
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
const currentPage = async () =>
  (await h.board(`/api/notebooks/pages?notebook=${await myNotebook()}`)).body.pages.at(-1).id as number;
const childrenOf = async (page: number, id: number) =>
  ((await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[]).find(g => g.id === id).children;

// The judge's next call (null: none came), answered with a verdict
async function judged(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const c = (await h.worker('reads/claim')).body;
    if (c.reading) return c;
    await new Promise(res => setTimeout(res, 20));
  }
  return null;
}
const say = (c: { reading: string }, reply: string, why: string) =>
  h.worker('reads/answer', { reading: c.reading, result: { is_error: false, structured_output: { reply, why } } });
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise(res => setTimeout(res, 10));
  assert.ok(ok());
}
const pickedIds = (ids: number[]) =>
  ids.filter(id => (db.prepare('select picked from book_slips where id = ?').get(id) as any).picked);

// The board's note tried in two versions by a running try run
async function tried() {
  const page = await currentPage();
  const g = (
    await h.board('/api/notebooks/groups/create', {
      page,
      ink: [
        stroke([
          [40, 40],
          [200, 60],
        ]),
      ],
      texts: [{ x: 40, y: 80, w: 200, text: 'warmer?', color: '#2a2352' }],
    })
  ).body;
  await say((await judged())!, 'try', 'wonders about a colour');
  // (the judge's try queued the real run; this test's own run, claimed alone, stands in for it)
  await until(() => !!(db.prepare('select tried from notebook_groups where id = ?').get(g.id) as any).tried);
  h.cancelQueued();
  const run = await h.start({ agent: 'juno' });
  db.prepare('update notebook_groups set tried = ? where id = ?').run(run.id, g.id);
  const version = async (name: string, colour: string) =>
    (
      await agent('answer', run.token, {
        grp: g.id,
        version: name,
        text: `${name}, as it would look`,
        picture: await png(colour),
        patch: `diff --git a/${name} b/${name}\n+${colour}`,
      })
    ).body.slip;
  const v1 = await version('Warm sand', '#e8c88a');
  const v2 = await version('Brick red', '#b0412f');
  return { page, g, run, v1, v2 };
}

test('a ring round a version goes as a reply over its frame; the judge’s pick picks it, the run hears which', async () => {
  const { page, g, run, v1, v2 } = await tried();
  const frame = { x: 360, y: 72, w: 300, h: 225 };
  const sent = await h.board('/api/notebooks/groups/reply', { answer: v2.id, ink: [ring(frame)], frame });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const c = (await judged())!;
  const [image, text] = c.content;
  assert.equal(image.type, 'image', 'the judge sees the frame with the ring over it');
  const seen = await sharp(Buffer.from(image.source.data, 'base64')).metadata();
  assert.ok(seen.width! > seen.height!, 'the frame’s shape, not the ring’s alone');
  assert.match(text.text, /version 2 of 2, “Brick red”/);
  assert.match(text.text, /pick: only for a note on one of an agent's versions/);
  assert.deepEqual(JSON.parse(c.schema), judge.schemaOf(true), 'pick offered on a version');
  await say(c, 'pick', 'rings one version to choose it');
  await until(() => pickedIds([v1.id, v2.id]).length === 1);
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v2.id]);
  const shown = (await childrenOf(page, g.id)).filter((x: any) => x.style === 'version');
  assert.deepEqual(
    shown.map((x: any) => !!x.picked),
    [false, true],
    'the page shows it',
  );
  const heard = db.prepare('select text from messages where job = ?').all(run.id) as { text: string }[];
  assert.match(heard.at(-1)!.text, /The board picked your version “Brick red”/);
  // a tick on the other moves the pick: one per try
  await h.board('/api/notebooks/groups/reply', {
    answer: v1.id,
    ink: [
      stroke([
        [380, 300],
        [390, 312],
        [420, 280],
      ]),
    ],
    frame,
  });
  await say((await judged())!, 'pick', 'ticks the version it likes');
  await until(() => pickedIds([v1.id, v2.id])[0] === v1.id);
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v1.id]);
  // a cross is none: the pick stays
  await h.board('/api/notebooks/groups/reply', {
    answer: v2.id,
    ink: [
      stroke([
        [360, 72],
        [660, 297],
      ]),
    ],
    frame,
  });
  await say((await judged())!, 'none', 'rules that one out');
  await new Promise(res => setTimeout(res, 50));
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v1.id]);
  await h.finish(run);
});

test('the pick goes with the page: the note’s picture has the frame beside it, its job the version and its patch', async () => {
  const { page, g, run, v1, v2 } = await tried();
  await h.board('/api/notebooks/groups/reply', { answer: v2.id, ink: [ring({ x: 0, y: 0, w: 200, h: 150 })] });
  await say((await judged())!, 'pick', 'rings one version');
  await until(() => pickedOn(g.id)?.id === v2.id);
  const sent = await h.board('/api/notebooks/pages/send', { id: page });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const n = db
    .prepare('select n.* from book_notes n join notebook_groups g on g.note = n.id where g.id = ?')
    .get(g.id) as any;
  const { readFileSync } = await import('node:fs');
  const { DIR } = await import('../pagescraps.ts');
  const snip = await sharp(readFileSync(`${DIR}/${n.snip}`)).metadata();
  assert.ok(snip.width! > 2 * snip.height!, 'the group, and the frame beside it');
  const [text] = withPicks([n], ['The board’s note: warmer?']);
  assert.match(text, /The board picked the version “Brick red” \(Brick red, as it would look\): build that one/);
  assert.match(text, /```diff\ndiff --git a\/Brick red b\/Brick red\n\+#b0412f\n```/);
  assert.equal(withPicks([{ ...n, id: -1 }], ['x'])[0], 'x', 'a note with no pick is as it was');
  // (its kept patch gone: the job isn't told to build it without it.)
  const { renameSync } = await import('node:fs');
  const patch = `${DIR}/${pickedOn(g.id)!.patch}`;
  renameSync(patch, `${patch}.away`);
  assert.throws(() => withPicks([n], ['x']), /ENOENT/);
  renameSync(`${patch}.away`, patch);
  void v1;
  await h.finish(run);
});

test('a pick on what isn’t a version picks nothing', async () => {
  const { pickNow } = await import('./bookpick.ts');
  const { g, run, v1 } = await tried();
  assert.equal(pickNow({ grp: g.id }), null, 'the note itself');
  assert.equal(pickNow({ grp: 999_999 }), null, 'nothing');
  assert.deepEqual(pickedIds([v1.id]), []);
  await h.finish(run);
});

test("a try on a call's note: its versions on their page, and a ring on one, a note there, picks it", async () => {
  const { tryNow } = await import('./booktry.ts');
  const { pageFor } = await import('./callnotes.ts');
  const { call } = await h.liveCall('juno');
  const page = pageFor(call)!;
  const anchor = { v: 1, url: '/?open=shop', el: null, view: { w: 1180, h: 820, x: 0, y: 0, dpr: 2 }, ink: [] };
  const { note } = (await h.board('/api/book/note', { page: page.id, anchor, words: 'warmer?', said: 'typed' })).body;
  await say((await judged())!, 'none', 'judged by hand below');
  const run = await h.claimJob(tryNow({ note: note.id }, { id: 1, why: 'wonders about a colour' })!);
  const { review } = db.prepare('select review from book_notes where id = ?').get(note.id) as any;
  const version = async (name: string, colour: string) =>
    (
      await agent('answer', run.token, {
        note: review,
        version: name,
        text: `${name}, as it would look`,
        picture: await png(colour),
      })
    ).body.slip;
  const v1 = await version('Warm sand', '#e8c88a');
  const v2 = await version('Brick red', '#b0412f');
  const { id: tries } = db.prepare('select id from book_pages where tries_note = ?').get(note.id) as any;
  const read = async () => (await h.board(`/api/notebooks/pages/groups?page=${tries}`)).body;
  const before = await read();
  assert.equal(before.tries_note, note.id);
  assert.equal(before.tried.words, 'warmer?');
  assert.deepEqual(
    before.tried.children.map((c: any) => [c.kind, c.version]),
    [
      ['answer', 'Warm sand'],
      ['answer', 'Brick red'],
    ],
    'its versions on their page',
  );
  // a ring round version 2: a note on the versions page, replying to it, the judge's pick picks it
  const frame = { x: 360, y: 72, w: 300, h: 225 };
  const sent = await h.board('/api/notebooks/groups/reply', { answer: v2.id, ink: [ring(frame)], frame });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const reply = db.prepare('select page, answers from book_notes where id = ?').get(sent.body.note) as any;
  assert.deepEqual([reply.page, reply.answers], [tries, v2.id]);
  const c = (await judged())!;
  assert.match(c.content.at(-1).text, /version 2 of 2, “Brick red”/);
  await say(c, 'pick', 'rings one version to choose it');
  await until(() => pickedIds([v1.id, v2.id]).length === 1);
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v2.id]);
  const after = (await read()).tried.children;
  assert.deepEqual(
    after.map((c: any) => [c.kind, !!c.picked]),
    [
      ['answer', false],
      ['answer', true],
      ['reply', false],
    ],
    'the page shows the pick and the reply',
  );
  const heard = db.prepare('select text from messages where job = ?').all(run.id) as { text: string }[];
  assert.match(heard.at(-1)!.text, /The board picked your version “Brick red”/);
  await h.finish(run);
});
