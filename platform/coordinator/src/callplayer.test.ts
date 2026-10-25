// node --test src/callplayer.test.ts   (the harness: the test company, the real server, the board's session)
// A walk-through call watched back in HQ: the call log says which calls have a recording, and the board's route sends
// it as gzipped NDJSON, its head first (moments, notes, items) and never the transcript; the replay's page and files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { harness } from './harness.ts';

const h = await harness('callplayer');
const { base, voice } = h;
const { ORIGIN } = await import('./config.ts');
const BOARD = { cookie: h.boardCookie, origin: ORIGIN };
// A walk-through recorded with watchalong.js (moments.test.ts says what's in it)
const WALK = JSON.parse(
  gunzipSync(readFileSync(new URL('../../../shared/watchalong/walk.test.json.gz', import.meta.url))).toString('utf8'),
) as { type: number; timestamp: number; data: Record<string, unknown> }[][];
const SAID = ['Board: the secret word is marmalade', 'Wren: got it'];

type Ctx = Awaited<ReturnType<typeof h.liveCall>>;
const end = (ctx: Ctx, lines: string[]) => voice('call-end', { agent: 'wren', lines, token: ctx.token });
async function walkThrough(batches = WALK) {
  const ctx = await h.liveCall('wren');
  const started = await fetch(`${base}/api/watchalong/start`, {
    method: 'POST',
    headers: { ...BOARD, 'content-type': 'application/json' },
    body: JSON.stringify({ call: ctx.call, key: ctx.key }),
  });
  const { events } = (await started.json()) as { events: string };
  for (const batch of batches) {
    const posted = await fetch(`${base}${events}`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: JSON.stringify({ events: batch }),
    });
    assert.equal(posted.status, 200);
  }
  await end(ctx, SAID);
  return ctx.call;
}
const calls = async () =>
  (await (await fetch(`${base}/api/calls`, { headers: BOARD })).json()) as { id: number; recorded: boolean }[];
const recording = (call: number, headers: Record<string, string> = BOARD) =>
  fetch(`${base}/api/calls/recording?call=${call}`, { headers });

test('the call log marks a walk-through call as recorded, and its route sends the recording, head first, never the transcript', async () => {
  const walked = await walkThrough();
  const plain = await h.liveCall('wren');
  await end(plain, SAID);
  const listed = await calls();
  assert.equal(listed.find(c => c.id === walked)?.recorded, true);
  assert.equal(listed.find(c => c.id === plain.call)?.recorded, false);

  const res = await recording(walked);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(res.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const text = await res.text();
  assert.doesNotMatch(text, /marmalade|got it/);
  const [head, ...events] = text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const all = WALK.flat();
  assert.deepEqual(events, all);
  assert.equal(head.start, all[0].timestamp);
  assert.equal(head.end, all.at(-1)!.timestamp);
  assert.equal(typeof head.clockMs, 'number');
  assert.equal(head.agent, 'wren');
  assert.deepEqual(head.items, []);
  assert.equal(head.notes, null); // (not followed up yet)
  assert.deepEqual(head.moments.map((m: { n: number; kind: string }) => `${m.n} ${m.kind}`).slice(0, 3), [
    '1 page',
    '2 tap',
    '3 typed',
  ]);
  assert.equal(head.moments.at(-1).words, 'tapped "Pay" (button)');

  assert.equal((await recording(plain.call)).status, 404);
  assert.equal((await recording(999_999)).status, 404);
  assert.equal((await recording(walked, { origin: ORIGIN })).status, 401);
});

test("the replay's page runs only its own scripts and draws a recorded page's styles; the replayer comes from the app", async () => {
  const page = await fetch(`${base}/shared/watchalong/replay.html`, { headers: BOARD });
  assert.equal(page.status, 200);
  const policy = page.headers.get('content-security-policy') ?? '';
  assert.match(
    policy,
    new RegExp(
      `script-src ${ORIGIN}/shared/watchalong/replay\\.js ${ORIGIN}/shared/watchalong/vendor/rrweb-replay\\.js;`,
    ),
  );
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.match(policy, /object-src 'none'; base-uri 'none'/);

  for (const [path, type] of [
    ['/shared/watchalong/vendor/rrweb-replay.js', /javascript/],
    ['/shared/watchalong/vendor/rrweb-replay.css', /css/],
    ['/shared/watchalong/replay.js', /javascript/],
    ['/shared/watchalong/player.js', /javascript/],
    ['/shared/watchalong/scrubber.js', /javascript/],
  ] as const) {
    const res = await fetch(`${base}${path}`, { headers: BOARD });
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', type, path);
    // (the board's alone: the sign-in for anyone else)
    assert.equal((await fetch(`${base}${path}`, { redirect: 'manual' })).status, 302, path);
  }
  assert.match(
    await (await fetch(`${base}/shared/watchalong/vendor/rrweb-replay.js`, { headers: BOARD })).text(),
    /class Replayer/,
  );
});
