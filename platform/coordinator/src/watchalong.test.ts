// node --test src/watchalong.test.ts   (the harness: the test company, the real server, the board's session, the voice line)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { harness } from './harness.ts';

const h = await harness('watchalong');
const { base, voice, agent } = h;
const { ORIGIN } = await import('./config.ts');
const store = await import('../../../shared/watchalong/store.ts');
const ledger = await import('./ledger.ts');
const watchalong = await import('./watchalong.ts');
const BOARD = { cookie: h.boardCookie, origin: ORIGIN },
  DIR = `${h.dataDir}/watchalong`;
// the coordinator's store, read as the agent's side will read it
const kept = store.open(h.db, DIR);
const HOUR_MS = 3_600_000;

type Ctx = Awaited<ReturnType<typeof h.liveCall>>;
const endCall = (who: string, c: Ctx, lines: string[] = []) => voice('call-end', { agent: who, lines, token: c.token });
const startWatching = async (c: Ctx, key = c.key) => {
  const res = await fetch(`${base}/api/watchalong/start`, {
    method: 'POST',
    headers: { ...BOARD, 'content-type': 'application/json' },
    body: JSON.stringify({ call: c.call, key }),
  });
  return { status: res.status, body: (await res.json()) as { id: number; events: string } };
};
const post = async (events: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  (await fetch(`${base}${events}`, { method: 'POST', headers, body: JSON.stringify(body) })).status;
const batch = (...types: number[]) => ({ events: types.map(type => ({ type, timestamp: Date.now(), data: {} })) });

test("a watch-along starts on the board's live call by the call's key, and takes batches from HQ's origin alone", async () => {
  const ctx = await h.liveCall('wren');
  assert.equal((await startWatching(ctx, 'guess')).status, 409);
  const watching = await startWatching(ctx);
  assert.equal(watching.status, 200);
  // no board session needed: the session's key is enough (a guest's page), but only from HQ's origin
  assert.equal(await post(watching.body.events, batch(4, 2)), 200);
  assert.equal(await post(watching.body.events, batch(3), { origin: 'https://hello.preview.example.com' }), 403);
  assert.equal(await post(watching.body.events.replace(/key=[^&]+/, 'key=guess'), batch(3)), 404);
  assert.equal(await post(watching.body.events, { events: [{ type: 2 }] }), 400);
  assert.ok(existsSync(`${DIR}/${watching.body.id}.ndjson.gz`));
  await endCall('wren', ctx, ['Board: look at this page']);
  // the call is over, so is its watch-along; its recording stays with the call
  assert.equal(await post(watching.body.events, batch(3)), 409);
  assert.equal(store.read(kept, watching.body.id)!.events.length, 2);
});

test('a call that leaves nothing behind takes its watch-along with it', async () => {
  const ctx = await h.liveCall('wren');
  const watching = await startWatching(ctx);
  assert.equal(await post(watching.body.events, batch(4, 2)), 200);
  await endCall('wren', ctx);
  assert.equal(existsSync(`${DIR}/${watching.body.id}.ndjson.gz`), false);
  assert.equal(await post(watching.body.events, batch(3)), 404);
});

test("the sweep ends a lost line's watch-along with its call, and takes it with a silent one", async () => {
  const noted = await h.liveCall('kit'),
    silent = await h.liveCall('dex');
  await agent('item', noted.token, {
    kind: 'promise',
    owner: 'kit',
    goal: 'g',
    what: 'Send the note',
    quote: 'I will send it',
  });
  const keeps = await startWatching(noted),
    goes = await startWatching(silent);
  for (const watching of [keeps, goes]) assert.equal(await post(watching.body.events, batch(4, 2)), 200);
  ledger.sweep(Date.now() + 3 * HOUR_MS + 60_000);
  assert.equal(await post(keeps.body.events, batch(3)), 409);
  assert.ok(store.find(kept, keeps.body.id)!.ended);
  assert.equal(store.find(kept, goes.body.id), undefined);
  assert.equal(existsSync(`${DIR}/${goes.body.id}.ndjson.gz`), false);
  // the silent call's number can come back: a new call there has no recording of the old one's
  assert.deepEqual(store.sessionsOf(kept, 'call', String(silent.call)), []);
});

test("the recorder is served to HQ's pages and a join link's without a session", async () => {
  const own = readFileSync(new URL('../../../shared/watchalong/watchalong.js', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../../../shared/watchalong/canvas.js', import.meta.url), 'utf8');
  const recorder = readFileSync(new URL('../node_modules/@rrweb/record/dist/record.js', import.meta.url), 'utf8');
  for (const [path, text] of [
    ['/shared/watchalong/watchalong.js', own],
    ['/shared/watchalong/canvas.js', canvas],
    ['/shared/watchalong/vendor/rrweb-record.js', recorder],
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await res.text(), text);
  }
});

// ---- what the call's agent sees (job #17928): the voice line's screen-turn and screen, on a recorded walk-through
// (shared/watchalong/walk.test.json.gz: moments.test.ts says what's in it). Pictures need Chromium (CHROMIUM_PATH).
const WALK = JSON.parse(
  gunzipSync(readFileSync(new URL('../../../shared/watchalong/walk.test.json.gz', import.meta.url))).toString('utf8'),
) as { type: number; timestamp: number; data: Record<string, unknown> }[][];
after(() => watchalong.closeMirrors());
const { SCROLL_MS } = await import('../../../shared/watchalong/moments.ts');
const noChromium =
  process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH) ? false : 'no Chromium here (CHROMIUM_PATH)';
const JPEG = (data: string) => Buffer.from(data, 'base64').subarray(0, 2).toString('hex') === 'ffd8';
const turn = (c: Ctx, body: Record<string, unknown> = {}) =>
  voice('screen-turn', { purpose: 'call', ref: String(c.call), after: 0, seen: 0, briefed: false, ...body });
const screenTool = (c: Ctx, body: Record<string, unknown>) =>
  voice('screen', { purpose: 'call', ref: String(c.call), ...body });
const walkedThrough = async (c: Ctx, batches = WALK) => {
  const watching = await startWatching(c);
  for (const events of batches) assert.equal(await post(watching.body.events, { events }), 200);
  return watching;
};
// the walk's batches up to its pause, and from there
const PAUSE = WALK.findIndex(events => events.some(e => e.type === 5 && e.data.tag === 'paused'));

test("a caller's turn brings the moments since the agent's last, a picture when the screen changed, and the briefing once (without Chromium, the picture's failure fails the turn)", async () => {
  const ctx = await h.liveCall('wren');
  assert.deepEqual((await turn(ctx)).body, { on: false });
  const watching = await walkedThrough(ctx, WALK.slice(0, PAUSE));
  await new Promise(resolve => setTimeout(resolve, SCROLL_MS + 100)); // (the last scroll settles)
  const answered = await turn(ctx);
  if (noChromium) return assert.equal(answered.status, 500); // (the line tells the agent, and asks again next turn)
  const first = answered.body;
  assert.equal(first.on, true);
  assert.equal(first.paused, false);
  assert.match(first.brief, /trust the screen/);
  assert.match(first.lines[0], /^#1 \d\d:\d\d:\d\d on \/$/);
  assert.ok(
    first.lines.some((l: string) => /typed 10 characters in "Name on the mug"/.test(l)),
    first.lines.join('\n'),
  );
  assert.ok(!first.lines.join(' ').includes('Grandma'));
  assert.ok(first.picture.type === 'image/jpeg' && JPEG(first.picture.data));
  // nothing new: no lines, no picture, no briefing again
  const again = (await turn(ctx, { after: first.last, seen: first.version, briefed: true })).body;
  assert.deepEqual([again.lines, again.picture, again.brief], [[], undefined, undefined]);
  // paused: the lines up to the pause, no picture, and the tool refuses
  assert.equal(await post(watching.body.events, { events: WALK[PAUSE] }), 200);
  const paused = (await turn(ctx, { after: first.last, seen: first.version, briefed: true })).body;
  assert.equal(paused.paused, true);
  assert.match(paused.lines.at(-1), /paused showing the screen$/);
  assert.equal(paused.picture, undefined);
  assert.equal((await screenTool(ctx, {})).status, 409);
  await endCall('wren', ctx, ['Board: look at this page']);
  assert.deepEqual((await turn(ctx)).body, { on: false });
  assert.equal((await screenTool(ctx, {})).status, 404);
});

// (and the empty batch a quiet page asks with)
test("each batch's answer says whether the screen reaches the agent, the first's once its mirror has opened (without Chromium, it doesn't)", async () => {
  const ctx = await h.liveCall('wren');
  const watching = await startWatching(ctx);
  const answers = [];
  for (const events of [...WALK, []]) {
    const res = await fetch(`${base}${watching.body.events}`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: JSON.stringify({ events }),
    });
    answers.push(((await res.json()) as { seen?: boolean }).seen);
  }
  assert.deepEqual(
    answers,
    answers.map(() => !noChromium),
  );
  await endCall('wren', ctx, ['Board: look']);
});

test(
  'the screen tool: the screen now or at a moment, a part zoomed in, and the moments since a time',
  { skip: noChromium },
  async () => {
    const ctx = await h.liveCall('wren');
    await walkedThrough(ctx);
    const now = (await screenTool(ctx, {})).body;
    assert.ok(JPEG(now.picture.data));
    assert.match(now.line, /^The screen now \(\d\d:\d\d:\d\d\)$/);
    const tapped = (await screenTool(ctx, { at: '#4' })).body;
    assert.ok(JPEG(tapped.picture.data));
    assert.match(tapped.line, /^The screen at \d\d:\d\d:\d\d \(#4\)$/);
    const zoomed = await screenTool(ctx, { region: { x: 0, y: 0, width: 0.5, height: 0.25 } });
    assert.equal(zoomed.status, 200);
    const list = (await screenTool(ctx, { since: '#10' })).body.lines;
    assert.deepEqual(
      list.map((l: string) => l.replace(/ \d\d:\d\d:\d\d/, '')),
      ['#10 scrolled the page up 900 px', '#11 on /basket.html', '#12 tapped "Pay" (button)'],
    );
    for (const asked of [{ at: 'yesterday' }, { since: 'soon' }, { region: { x: 0.8, y: 0, width: 0.5, height: 1 } }])
      assert.equal((await screenTool(ctx, asked)).status, 400, JSON.stringify(asked));
    await endCall('wren', ctx, ['Board: look']);
  },
);

test("a session of a purpose without its own briefing is never watched for an agent (never told it's the board's screen)", async () => {
  const session = store.start(kept, 'customer', '7', 'hidden', ['https://shop.example']);
  assert.equal(store.add(kept, session.id, session.key, Buffer.from(JSON.stringify({ events: WALK[0] }))), 200);
  assert.deepEqual((await voice('screen-turn', { purpose: 'customer', ref: '7', after: 0, seen: 0 })).body, {
    on: false,
  });
  const tool = await voice('screen', { purpose: 'customer', ref: '7' });
  assert.equal(tool.status, 404);
  // (the purpose gate's 404, not the one for nothing recorded yet)
  assert.notEqual(tool.body.error, watchalong.NOTHING);
  store.forget(kept, 'customer', '7');
});

test('the screen routes take the voice line alone', async () => {
  const res = await fetch(`${base}/api/voice/screen-turn`, { method: 'POST', body: '{}', headers: BOARD });
  assert.equal(res.status, 401);
});
