// node --test src/ink/bookcalls.test.ts   (the harness: the test company, the real server, the board's session, the voice line)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('bookcalls');
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const DIR = `${h.dataDir}/book`;
// No judge's call on these words comes for a while (any other's answered with none): a note on a call is its agent's
// to act on
async function unjudged(words: string) {
  for (let i = 0; i < 15; i++) {
    const c = (await h.worker('reads/claim')).body;
    if (c.reading && JSON.parse(c.schema).properties.reply) {
      assert.ok(!(c.content.at(-1).text as string).includes(JSON.stringify(words)), `${words}: judged`);
      const structured_output = { reply: 'none', why: 'test' };
      await h.worker('reads/answer', { reading: c.reading, result: { is_error: false, structured_output } });
    }
    await new Promise(res => setTimeout(res, 20));
  }
}

const ring = (color: string) => ({
  color,
  size: 4,
  points: [
    [10, 20, 0.5, 0],
    [190, 120, 0.6, 16],
    [12, 24, 0.5, 40],
  ],
});
const SNIP = `data:image/png;base64,${(
  await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer()
).toString('base64')}`;
const anchor = (color = '#ff5a5f') => ({
  v: 1,
  url: `${ORIGIN}/?open=projects#t=secret`,
  el: { selector: '#projects > li:nth-child(2)', tag: 'li', text: 'Teacups', box: { x: 10, y: 400, w: 300, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 300, dpr: 2 },
  ink: [ring(color)],
});
const note = (body: Record<string, unknown>) =>
  h.board('/api/book/note', { anchor: anchor(), words: '', said: 'spoken', ...body });

test("a call's page: the board's notes numbered on it, never on a sheet to send, never the agent's ink; the line reads them", async () => {
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  assert.deepEqual([page.kind, page.call, page.summary, page.agent], ['call', call, null, 'juno']);
  // (when the call started, for the page's name in the book)
  assert.ok(Math.abs(Date.parse(page.started) - Date.now()) < 60_000, `the call started ${page.started}`);

  const one = (await note({ page: page.id, words: 'This feels high?', snip: SNIP })).body;
  assert.equal(one.note.n, 1);
  assert.equal(one.note.by, 'board');
  // (a note on a call isn't judged: it's for the call's agent, who decides what becomes of it. The board, call 161)
  await unjudged('This feels high?');
  // (the agent's rings are never kept)
  for (const by of ['juno', 'lark']) {
    const theirs = await note({ page: page.id, anchor: anchor('#7b5ea7'), words: 'this one', by });
    assert.deepEqual([theirs.status, theirs.body.error], [400, "a note is the book's own: by isn't given"]);
  }
  const two = (await note({ page: page.id, words: 'or with shipping in?', said: 'typed' })).body;
  assert.deepEqual([two.note.n, two.note.by, two.sheet.id], [2, 'board', one.sheet.id]);
  const sheetPage = (
    await h.board('/api/book/page/new', { kind: 'sheet', owner: 'juno', url: '/?open=desk', w: 800, h: 600 })
  ).body;
  assert.equal((await note({ page: sheetPage.id, by: 'juno' })).status, 400);

  // the agent's own open sheet goes on beside the call's, which is never listed to send, nor sent
  const own = (await note({ page: sheetPage.id, said: 'typed' })).body;
  assert.notEqual(own.sheet.id, one.sheet.id);
  const sheets = (await h.board('/api/book/sheets')).body;
  assert.deepEqual(
    sheets.open.map((s: any) => s.id),
    [own.sheet.id],
  );
  // ...and read with its page, however old the call, for the book to show the call's notes there; each note says it's
  // a call's, and whose, so HQ's page never takes it for a sheet's
  const { calls } = (await h.board(`/api/book/calls?pages=${page.id},${sheetPage.id}`)).body;
  assert.deepEqual(
    calls.map((s: any) => [s.id, s.notes.map((n: any) => n.id)]),
    [[one.sheet.id, [one.note.id, two.note.id]]],
  );
  assert.equal((await h.board('/api/book/calls?pages=')).status, 400);
  assert.match((await h.board('/api/book/send', { id: one.sheet.id })).body.error, /stay on its page/);
  // ...nor moved to a sheet that is, and words written over again aren't judged either
  const moved = await h.board('/api/book/note/move', { id: one.note.id, to: 'juno' });
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, /stays on its call's page/);
  const edited = (
    await h.board('/api/book/note/edit', { id: two.note.id, words: 'Or with shipping in?', said: 'typed' })
  ).body;
  assert.equal(edited.note.words, 'Or with shipping in?');
  await unjudged('Or with shipping in?');
  // ...nor the board's handwriting, read after the note went in
  const written = (await note({ page: page.id })).body.note;
  const late = (
    await h.board('/api/book/note/edit', { id: written.id, words: 'What time is it?', said: 'written', was: '' })
  ).body;
  assert.equal(late.note.words, 'What time is it?');
  await unjudged('What time is it?');

  // the voice line reads the board's note, on this live call only
  const read = await h.voice(`note?id=${one.note.id}&call=${call}`);
  assert.equal(read.status, 200);
  assert.deepEqual([read.body.n, read.body.words, read.body.url], [1, 'This feels high?', '/?open=projects']);
  assert.equal(read.body.picture.type, 'image/png');
  assert.equal((await sharp(Buffer.from(read.body.picture.data, 'base64')).metadata()).width, 20);
  assert.equal((await h.voice(`note?id=${own.note.id}&call=${call}`)).status, 404, "a sheet's note");
  assert.equal((await h.voice(`note?id=${one.note.id}&call=${call + 1}`)).status, 404, 'another call');

  // the call ends: the line reads no more, the page stays with the call's summary on top once it's written
  await h.voice('call-end', { agent: 'juno', lines: ['Board: This feels high.'], token });
  assert.equal((await h.voice(`note?id=${one.note.id}&call=${call}`)).status, 404, 'the call has ended');
  db.prepare('update calls set reply = ? where id = ?').run('Prices: shipping shown in, from Monday.', call);
  const listed = (await h.board('/api/book')).body.pages.find((p: any) => p.id === page.id);
  assert.equal(listed.summary, 'Prices: shipping shown in, from Monday.');

  // thrown away in one tap: its notes, their snips and its sheet go with it
  const snip = readdirSync(DIR).find(f => f.startsWith(`n${one.note.id}-`));
  assert.ok(snip, 'the snip was kept');
  assert.equal((await h.board('/api/book/page/delete', { id: page.id })).status, 200);
  assert.ok(!existsSync(`${DIR}/${snip}`));
  assert.equal((db.prepare('select count(*) n from book_notes where page = ?').get(page.id) as { n: number }).n, 0);
  assert.ok(!db.prepare('select 1 from book_sheets where id = ?').get(one.sheet.id));
  assert.equal(
    (await h.board('/api/book/page/delete', { id: sheetPage.id })).status,
    409,
    "a sheet's page still waits",
  );
});

test("a call's page is given to an agent on its own, as a free page is: its seconds to undo, undone", async () => {
  const { call } = await h.liveCall('juno');
  const page = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  const sending = (await h.board('/api/book/page/send', { id: page.id, to: 'kit' })).body;
  assert.deepEqual([sending.owner, sending.status, sending.page], ['kit', 'sending', page.id]);
  assert.deepEqual((await h.board('/api/book/undo', { id: sending.id })).body, { id: sending.id, status: 'undone' });
});

// The agent's rings that older calls kept as notes on their pages: gone once, the board's
// notes and ink untouched, and a page left with nothing of the board's goes with them.
test("the agent's rings kept on calls' pages go, and the board's notes and ink stay", async () => {
  const { insertNote } = await import('./booknotes.ts');
  const { dropAgentInk } = await import('./bookcalls.ts');
  const ringed = async (strokes = 0) => {
    const { call } = await h.liveCall('juno');
    const page = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
    db.prepare('update book_pages set strokes = ? where id = ?').run(strokes, page.id);
    const sheet = Number(
      db
        .prepare("insert into book_sheets (who, owner, status, created) values ('board', 'juno', 'call', ?)")
        .run(new Date().toISOString()).lastInsertRowid,
    );
    const ring = insertNote(
      sheet,
      page.id,
      'juno',
      anchor('#7b5ea7') as any,
      { words: 'this', said: 'written' },
      null,
      null,
    );
    return { page: page.id, sheet, ring };
  };
  const theirsAlone = await ringed(),
    besideTheBoards = await ringed(),
    onItsInk = await ringed(3);
  const boards = (await note({ page: besideTheBoards.page, words: 'Too dark' })).body.note;
  assert.equal(dropAgentInk(), 3);
  const pageOf = (id: number) => db.prepare('select 1 from book_pages where id = ?').get(id);
  const notesOn = (id: number) =>
    (db.prepare('select id from book_notes where page = ?').all(id) as { id: number }[]).map(n => n.id);
  assert.ok(!pageOf(theirsAlone.page), 'a page with only its rings goes');
  assert.ok(!db.prepare('select 1 from book_sheets where id = ?').get(theirsAlone.sheet));
  assert.deepEqual(notesOn(besideTheBoards.page), [boards.id], "the board's note stays, the ring goes");
  assert.ok(pageOf(onItsInk.page), "a page with the board's ink stays");
  assert.deepEqual(notesOn(onItsInk.page), []);
  assert.equal(dropAgentInk(), 0, 'nothing left');
});
