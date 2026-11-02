// node --test src/viewmarks.test.ts   (the real server, the board's session and the live SSE feed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('viewmarks');
const { db } = h;
const { ORIGIN } = await import('./config.ts');
const anchor = () => ({
  v: 1,
  url: `${ORIGIN}/?open=shop`,
  el: { selector: '#basket', tag: 'button', text: 'Basket', box: { x: 10, y: 40, w: 120, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
  ink: [
    {
      color: '#2B2230',
      size: 6,
      points: [
        [20, 50, 0.5, 0],
        [100, 70, 0.6, 16],
      ],
    },
  ],
});

test('marks on viewed work reach the live board feed without being stored or replayed', async () => {
  const device = crypto.randomUUID();
  const before = db.prepare('select count(*) as n from events').get() as { n: number };
  const stop = new AbortController();
  const response = await fetch(`${h.base}/api/events`, { headers: { cookie: h.boardCookie }, signal: stop.signal });
  const reader = response.body!.getReader();
  try {
    const mark = { device, anchor: anchor() };
    assert.equal((await h.board('/api/viewer/marks', mark)).status, 200);
    const shared = await nextMarks(reader);
    assert.equal(shared.device, device);
    assert.deepEqual(shared.anchor.ink[0].points, mark.anchor.ink[0].points);
    assert.equal((await h.board('/api/viewer/marks', { ...mark, anchor: { ...mark.anchor, ink: [] } })).status, 200);
    assert.deepEqual((await nextMarks(reader)).anchor.ink, []);
    assert.deepEqual(db.prepare('select count(*) as n from events').get(), before);
    assert.ok(!(await h.feed()).some((event: any) => event.marks));
    for (const malformed of [
      {},
      { ...mark, device: 'other' },
      { ...mark, anchor: { ...mark.anchor, ink: [{ color: 'red' }] } },
    ])
      assert.equal((await h.board('/api/viewer/marks', malformed)).status, 400);
    const endpoint = `${h.base}/api/viewer/marks`;
    const headers = { origin: ORIGIN, 'content-type': 'application/json' };
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(mark) })).status, 401);
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, origin: 'https://outside.test', cookie: h.boardCookie },
          body: JSON.stringify(mark),
        })
      ).status,
      403,
    );
  } finally {
    stop.abort();
  }
});

async function nextMarks(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const text = new TextDecoder();
  let pending = '';
  for (;;) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, 'the live feed stays open');
    pending += text.decode(chunk.value, { stream: true });
    const lines = pending.split('\n\n');
    pending = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'viewmarks') return event.marks;
    }
  }
}
