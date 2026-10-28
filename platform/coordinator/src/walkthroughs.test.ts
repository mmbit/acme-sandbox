// node --test src/walkthroughs.test.ts   (the harness: the test company, the real server, the board's session, the voice line)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('walkthroughs');
const bookcalls = await import('./ink/bookcalls.ts'); // (its 5-minute sweep)

const page = (call: number) =>
  h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 }).then(r => r.body as { id: number });
const kept = async (page: { id: number }) => (await h.board(`/api/book/page?id=${page.id}`)).status === 200;

test('a card offers a walk-through only when its maker says so, and a call rung from it is one with its briefing', async () => {
  const job = await h.start({ agent: 'kit', title: 'The gift-wrap step' });
  const offered = await h.ask(job, {
    kind: 'notice',
    title: 'Done: gift wrap',
    body: 'In the basket now.',
    topic: 'shop',
    walk: true,
  });
  const plain = await h.ask(job, { kind: 'notice', title: 'Done: an icon', body: 'A new icon.', topic: 'shop' });
  const cards = (await h.board('/api/requests')).body as { id: number; walk: number }[];
  assert.deepEqual(
    [cards.find(c => c.id === offered)?.walk, cards.find(c => c.id === plain)?.walk],
    [1, 0],
    "the desk phone reads the maker's flag",
  );

  const walk = (await h.voice('call-context', { agent: 'kit', lang: 'en', request: offered, walk: true })).body;
  assert.match(walk.prompt, /## A walk-through/);
  assert.match(walk.prompt, /open_work/);
  // a restart's briefing keeps it (the call's row says so)
  const again = (await h.voice('call-context', { agent: 'kit', lang: 'en', token: walk.token })).body;
  assert.match(again.prompt, /## A walk-through/);
  // the same card rung plainly, or a card that offers none, is a call like any other
  for (const asked of [{ request: offered }, { request: plain, walk: true }]) {
    const c = (await h.voice('call-context', { agent: 'kit', lang: 'en', ...asked })).body;
    assert.doesNotMatch(c.prompt, /## A walk-through/, JSON.stringify(asked));
  }
});

test("the sweep throws away a walk-through's page nobody wrote on once its call has ended, and keeps the rest", async () => {
  const job = await h.start({ agent: 'kit', title: 'The ribbon step' });
  const card = await h.ask(job, {
    kind: 'notice',
    title: 'Done: ribbons',
    body: 'In the basket now.',
    topic: 'shop',
    walk: true,
  });
  const walkThrough = async () =>
    (await h.voice('call-context', { agent: 'kit', lang: 'en', request: card, walk: true })).body as {
      call: number;
      token: string;
    };
  const [empty, written, live] = [await walkThrough(), await walkThrough(), await walkThrough()];
  const plain = await h.liveCall('kit');
  const [p1, p2, p3, p4] = [
    await page(empty.call),
    await page(written.call),
    await page(live.call),
    await page(plain.call),
  ];
  // the board's note keeps a page (the agent's rings are never in the book)
  const anchor = {
    v: 1,
    url: 'https://hq.example.com/',
    el: null,
    view: { w: 800, h: 600, x: 0, y: 0, dpr: 2 },
    ink: [],
  };
  assert.equal((await h.board('/api/book/note', { page: p2.id, anchor, words: 'Bigger?', said: 'typed' })).status, 200);
  // the pages are old, so only the hang-up's own minute can hold one back
  h.db
    .prepare('update book_pages set created = ? where id in (?, ?, ?, ?)')
    .run(new Date(Date.now() - 3_600_000).toISOString(), p1.id, p2.id, p3.id, p4.id);
  for (const c of [empty, written, plain])
    await h.voice('call-end', { agent: 'kit', lines: ['Board: Thanks, bye.'], request: card, token: c.token });

  // just ended: HQ's own hang-up may still be filing the last mark
  bookcalls.sweep();
  assert.ok(await kept(p1), 'not within a minute of the hang-up');
  bookcalls.sweep(Date.now() + 120_000);
  assert.deepEqual(
    await Promise.all([p1, p2, p3, p4].map(kept)),
    [false, true, true, true],
    "the empty walk-through page goes; a written one, a live call's and a plain call's stay",
  );
});
