// node --test src/callviews.test.ts   (hq call <id> moments and screen <time>: an ended walk-through call stepped back
// through, its transcript lined up by when each line was said; the screen's pictures need CHROMIUM_PATH)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { harness } from './harness.ts';

const h = await harness('callviews');
const { base, voice, agent } = h;
const { ORIGIN } = await import('./config.ts');
const ledger = await import('./ledger.ts');
const watchalong = await import('./watchalong.ts');
after(() => watchalong.closeMirrors());
const BOARD = { cookie: h.boardCookie, origin: ORIGIN };
const noChromium =
  process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH) ? false : 'no Chromium here (CHROMIUM_PATH)';
// A walk-through recorded with watchalong.js (moments.test.ts says what's in it): #1 on /, #2 tapped "Name on the mug",
// #3 typed, #4 and #5 tapped "Add to basket", #6 a dwell, ... #11 on /basket.html, #12 tapped "Pay"
const WALK = JSON.parse(
  gunzipSync(readFileSync(new URL('../../../shared/watchalong/walk.test.json.gz', import.meta.url))).toString('utf8'),
) as { type: number; timestamp: number; data: Record<string, unknown> }[][];
const T0 = WALK[0][0].timestamp;

type Ctx = Awaited<ReturnType<typeof h.liveCall>>;
// A live call that shows the walk-through, then ends with these lines, each said this long after the recording's start
// (its page's clock made the server's, as the voice line's clock is), or with no times (a call from before they were kept)
async function walkThrough(who: string, said: [string, number][], timed = true) {
  const ctx = await h.liveCall(who);
  const started = await fetch(`${base}/api/watchalong/start`, {
    method: 'POST',
    headers: { ...BOARD, 'content-type': 'application/json' },
    body: JSON.stringify({ call: ctx.call, key: ctx.key }),
  });
  const { events } = (await started.json()) as { events: string };
  for (const batch of WALK) {
    const posted = await fetch(`${base}${events}`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: JSON.stringify({ events: batch }),
    });
    assert.equal(posted.status, 200);
  }
  const { clockMs } = watchalong.callPlayback(ctx.call)!;
  await end(
    who,
    ctx,
    said.map(([line]) => line),
    timed ? said.map(([, after]) => T0 + clockMs + after) : undefined,
  );
  return ctx.call;
}
const end = (who: string, ctx: Ctx, lines: string[], times?: number[], request = 0) =>
  voice('call-end', { agent: who, lines, token: ctx.token, request, ...(times ? { times } : {}) });
const NOT_FOUND = { status: 404, body: { error: 'not found' } };
const timesOf = (call: number) =>
  (h.db.prepare('select line_times from calls where id = ?').get(call) as { line_times: string | null }).line_times;
const view = (call: number, token: string, more: string) => agent(`call?id=${call}&${more}`, token);

test("each line keeps when it was said, through the hand-over and a late one; a list that isn't one a line is dropped", async () => {
  const kept = await h.liveCall('wren');
  await end('wren', kept, ['Board: one', 'Wren: two'], [1_900_000_000_000, 1_900_000_004_000.4]);
  assert.equal(timesOf(kept.call), '[1900000000000,1900000004000]');
  const short = await h.liveCall('wren');
  await end('wren', short, ['Board: one', 'Wren: two'], [1_900_000_000_000]);
  assert.equal(timesOf(short.call), null);
  // the sweep ends a lost line's call (an item recorded keeps it); its transcript comes later, with its times
  const lost = await h.liveCall('kit');
  await agent('item', lost.token, { kind: 'promise', owner: 'kit', what: 'Send the note', quote: 'I will send it' });
  ledger.sweep(Date.now() + 3 * 3_600_000 + 60_000);
  await end('kit', lost, ['Board: late'], [1_900_000_009_000]);
  assert.equal(timesOf(lost.call), '[1900000009000]');
});

test("hq call <id> moments: the moments and the transcript in one timeline by the server's clock, on hq call's access", async () => {
  const call = await walkThrough('wren', [
    ['Board: let me show you the mug', 1000],
    ['Wren: the basket button is right there', 7000],
    ['Board: and then I pay', 16000],
  ]);
  const juno = await h.start({ agent: 'juno', title: 'Watching a call back' });
  const got = (await view(call, juno.token, 'view=moments')).body;
  assert.equal(typeof got.timeZone, 'string');
  assert.equal(got.untimed, undefined);
  assert.ok(
    got.lines.every((l: string) => /^\d\d:\d\d:\d\d {2}\S/.test(l)),
    got.lines.join('\n'),
  );
  assert.deepEqual(
    got.lines.map((l: string) => l.slice(10)),
    [
      '#1 on /',
      '[1] Board: let me show you the mug',
      '#2 tapped "Name on the mug" (input text)',
      '#3 typed 10 characters in "Name on the mug"',
      '#4–5 tapped "Add to basket" (button) (×2)',
      '[2] Wren: the basket button is right there',
      '#6 still for 4 s on a changed screen',
      '#7 scrolled the page down 900 px',
      '#8 paused showing the screen',
      '#9 showed the screen again',
      '#10 scrolled the page up 900 px',
      '#11 on /basket.html',
      '[3] Board: and then I pay',
      '#12 tapped "Pay" (button)',
    ],
  );
  // the CLI prints them under the clock's zone
  const printed = await h.hq(juno, 'call', String(call), 'moments');
  assert.equal(printed.code, 0, printed.out);
  assert.match(printed.out, /^\(Times in [\w/]+\.\)\n\n\d\d:\d\d:\d\d {2}#1 on \/\n/);
  // a call from before the lines had times: the moments alone, and why
  h.db.prepare('update calls set line_times = null where id = ?').run(call);
  const untimed = (await view(call, juno.token, 'view=moments')).body;
  assert.equal(untimed.lines.length, 11);
  assert.match(untimed.untimed, /have no times/);
  assert.match(
    (await h.hq(juno, 'call', String(call), 'moments')).out,
    /Only the moments: the transcript's lines have no times/,
  );
  // a call with no recording says so; a bad view is refused
  const plain = await h.liveCall('wren');
  await end('wren', plain, ['Board: no screen today']);
  assert.match((await view(plain.call, juno.token, 'view=moments')).body.error, /has no recording/);
  assert.equal((await view(plain.call, juno.token, 'view=film')).status, 400);
});

test('the views go only where hq call goes: not a live call, nor a call about keys to another agent', async () => {
  const juno = await h.start({ agent: 'juno', title: 'Watching calls back' });
  const live = await h.liveCall('wren');
  for (const more of ['view=moments', 'view=screen&at=%2312'])
    assert.deepEqual(await view(live.call, juno.token, more), NOT_FOUND, more);
  assert.match((await h.hq(juno, 'call', String(live.call), 'moments')).out, /No call #\d+ you can read/);
  await end('wren', live, ['Board: done']);
  // a call about a card for keys: its own agent's alone, who is marked as holding keys
  const keys = h.jobs.createRequest({
    kind: 'credential',
    title: 'Keys',
    body: 'Enter them.',
    agent: 'penny',
    secrets: 'SOME_KEY',
  }) as { id: number };
  const ctx = await h.liveCall('penny', keys.id);
  await end('penny', ctx, ['Board: here they are'], [Date.now()], keys.id);
  assert.deepEqual(await view(ctx.call, juno.token, 'view=moments'), NOT_FOUND);
  const penny = await h.start({ agent: 'penny', title: 'Her own call' });
  assert.match((await view(ctx.call, penny.token, 'view=moments')).body.error, /has no recording/);
  assert.equal(
    (h.db.prepare('select about_keys from jobs where id = ?').get(penny.id) as { about_keys: number }).about_keys,
    1,
  );
});

test(
  'hq call <id> screen <time>: a PNG of the screen at a moment, a time of day or a time from the start',
  { skip: noChromium },
  async () => {
    const call = await walkThrough('wren', [['Board: here we go', 0]]);
    const juno = await h.start({ agent: 'juno', title: 'Stepping back' });
    const PNG = (data: string) => Buffer.from(data, 'base64').subarray(1, 4).toString() === 'PNG';
    const tapped = (await view(call, juno.token, 'view=screen&at=%234')).body;
    assert.ok(PNG(tapped.picture.data));
    assert.equal(Math.max(tapped.width, tapped.height), 1568);
    assert.match(tapped.line, /^The screen at \d\d:\d\d:\d\d \(#4\), 5s into the call$/);
    const at = tapped.line.slice(14, 22);
    const same = (await view(call, juno.token, `view=screen&at=${at}`)).body;
    assert.match(same.line, new RegExp(`^The screen at ${at}, [45]s into the call$`));
    assert.match((await view(call, juno.token, 'view=screen&at=%2B15s')).body.line, /, 15s into the call$/);
    assert.match(
      (await view(call, juno.token, 'view=screen&at=%2B5m')).body.line,
      /\(the recording ended at \d\d:\d\d:\d\d\)$/,
    );
    for (const bad of ['now', '+', 'soon', '25:00'])
      assert.equal((await view(call, juno.token, `view=screen&at=${encodeURIComponent(bad)}`)).status, 400, bad);
    // the CLI saves it: to --out, or a new private file in the job's TMPDIR
    const tmp = mkdtempSync(`${tmpdir()}/callviews-`);
    const out = await h.hq({ ...juno, tmp }, 'call', String(call), 'screen', '#12', '--out', `${tmp}/pay.png`);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^The screen at \d\d:\d\d:\d\d \(#12\), 17s into the call \(\d+×1568 px\) → .*\/pay\.png\n$/);
    assert.equal(readFileSync(`${tmp}/pay.png`).subarray(1, 4).toString(), 'PNG');
    const saved = await h.hq({ ...juno, tmp }, 'call', String(call), 'screen', '+2s');
    assert.equal(saved.code, 0, saved.out);
    assert.ok(
      readdirSync(tmp).some(f => /^call-\d+-screen\.\w{6}\.png$/.test(f)),
      readdirSync(tmp).join(' '),
    );
  },
);
