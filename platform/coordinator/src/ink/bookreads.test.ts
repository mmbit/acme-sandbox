// node --test src/ink/bookreads.test.ts   (the harness: the test company, the real server, the board's session, the
// voice line). The book's pages as a call's agent reads them (bookreads.ts): a Notebook page as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('bookreads');
const { db } = h;

const said = (r: { status: number; body: any }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
async function until(what: () => unknown, why: string) {
  for (let i = 0; i < 100; i++) {
    if (what()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`never: ${why}`);
}

// Call #262: the board's new call had a new page, and it asked about the practice session's page before it, full on
// its screen; the agent's sketch tool said that page had nothing on it (it read the old book's columns, empty on a
// Notebook page, whose notes are its units).
test("an earlier call's full notes page reads as it is on the next call, never as empty", async () => {
  const first = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call: first.call })).page.id as number;
  said(await h.voice('title', { call: first.call, title: 'Practice session' }));
  said(
    await h.voice('write-down', {
      call: first.call,
      words: 'What rubs: the handle under each scrap',
      goal: 'A calmer shop',
    }),
  );
  await h.voice('call-end', { agent: 'juno', lines: ['Board: Good, the list is on the page.'], token: first.token });
  const row = () => db.prepare('select send_at, strokes, scraps from book_pages where id = ?').get(page) as any;
  await until(() => row()?.send_at != null, 'the page went in');
  assert.deepEqual(
    [row().strokes, row().scraps],
    [0, '[]'],
    "a Notebook page's notes aren't in the old book's columns",
  );

  const next = await h.liveCall('juno');
  said(await h.board('/api/notebooks/call', { call: next.call }));
  for (const asked of [String(page), 'practice session']) {
    const shown = said(await h.voice('sketch', { call: next.call, sketch: asked }));
    assert.match(shown.line, new RegExp(`^Page #${page} “[^”]*Practice session” of the board's book`), asked);
    const { width = 0 } = await sharp(Buffer.from(shown.pictures[0].data, 'base64')).metadata();
    assert.ok(width > 0, 'its picture');
  }
  await h.voice('call-end', { agent: 'juno', lines: [], token: next.token });
});
