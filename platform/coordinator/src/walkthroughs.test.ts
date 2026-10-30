// node --test src/walkthroughs.test.ts   (the harness: the test company, the real server, the board's session, the voice line)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('walkthroughs');

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

test("a walk-through keeps one page: the Pencil's and the notes page are one, in My journal, whoever asks first", async () => {
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
  const pages = (call: number) =>
    h.db.prepare('select id, notebook from book_pages where call = ?').all(call) as { id: number; notebook: number }[];
  const notes = async (call: number) => (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  // (HQ asks for both as the call is picked up: the Pencil's page, and the call's notes page)
  for (const pencilFirst of [true, false]) {
    const c = await walkThrough();
    const first = pencilFirst ? (await page(c.call)).id : await notes(c.call);
    // (the first ask, whichever it is, makes the call's notes page: never a page outside My journal beside it)
    assert.deepEqual(
      pages(c.call).map(p => [p.id, !!p.notebook]),
      [[first, true]],
    );
    const second = pencilFirst ? await notes(c.call) : (await page(c.call)).id;
    assert.equal(first, second, 'the same page');
    const [only] = pages(c.call);
    assert.deepEqual([pages(c.call).length, only.id, !!only.notebook], [1, first, true], 'one page, in My journal');
    // hung up with nothing on it, it goes; nothing of the call is left
    await h.voice('call-end', { agent: 'kit', lines: ['Board: Thanks, bye.'], request: card, token: c.token });
    assert.equal(await kept({ id: first }), false);
    assert.deepEqual(pages(c.call), []);
  }
});
