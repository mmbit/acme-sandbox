// node --test src/pictures.test.ts   (the harness: the test company, the real server, the board's session, the voice line)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { harness, type Running } from './harness.ts';

const h = await harness('pictures');
const { base, voice, agent } = h;
const { ORIGIN } = await import('./config.ts');
const jobs = await import('./jobs.ts');
const pictures = await import('./pictures.ts');
const ledger = await import('./ledger.ts');
const BOARD = { cookie: h.boardCookie, origin: ORIGIN }, DIR = `${h.dataDir}/pictures`;

// convert -size 4x4 gradient:red-blue -strip png24:base.png, and a JPEG with an Exif segment that says where it was taken
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAQDBv/EABUQAQEAAAAAAAAAAAAAAAAAAAAS/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYB/8QAFhEBAQEAAAAAAAAAAAAAAAAAABRh/9oADAMBAAIRAxEAPwDnLLT2WyHFpYostPZZDhYostPZZDhYwstPZayhxKWKLLT2WQ4WKLLT2WQ4WP/Z', 'base64');
const exif = Buffer.from('Exif\0\0MM GPSLatitude 52.3676 N', 'latin1'), len = Buffer.alloc(2);
len.writeUInt16BE(exif.length + 2);
const PHONE = Buffer.concat([JPEG.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, exif, JPEG.subarray(2)]);

const upload = async (body: Buffer, type = 'image/jpeg', q = '') => {
  const res = await fetch(`${base}/api/pictures${q}`, { method: 'POST', headers: { ...BOARD, 'content-type': type }, body });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
// an upload sent in pieces, without a content-length: its status
const chunked = (body: Buffer) => new Promise<number>((done, failed) => {
  const req = request(`${base}/api/pictures`, { method: 'POST', headers: { ...BOARD, 'content-type': 'image/png', 'transfer-encoding': 'chunked' } });
  req.on('response', res => { res.resume(); done(res.statusCode!); });
  req.on('error', failed);
  let i = 0;
  const next = () => { if (i >= body.length) return req.end(); req.write(body.subarray(i, i += 256 * 1024), next); };
  next();
});
const say = (body: unknown) => fetch(`${base}/api/chat`, { method: 'POST', headers: { ...BOARD, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const lastLine = async () => ((await h.board('/api/chat')).body.messages as { id: number }[]).at(-1)!.id;
const tray = async () => ((await h.board('/api/pictures/waiting')).body.pictures as { id: number }[]).map(p => p.id);
const jobFor = (agent: string, extra: Record<string, unknown> = {}) => h.start({ agent, ...extra });
const fetchAs = (token: string, id: number) => agent(`picture?id=${id}`, token);
// The intercom's turn, as the worker takes it (its note: what the board said), ended done or failed
const turn = async (status = 'done') => { const t = (await h.claim('claude', { kind: 'chat' }))!; await h.finish(t, { status }); return t; };
// Whether a job holds a customer's details, as the worker asks before it lets anything of it out
const holds = async (job: Running) => (await h.worker('customers', { job: job.id })).body.customers;
// a call as the voice line starts and ends it, and the query HQ's call screen uploads its pictures with. The agent's
// earlier calls not followed up yet ended a day ago: a new call doesn't carry on from them (call.ts carriedOn; no route
// moves the clock).
type Ctx = { call: number; token: string; key: string };
const startCall = async (who: string, again?: string) => {
  if (!again) h.db.prepare("update calls set ts = ? where agent = ? and status = 'ended' and processed_at is null").run(new Date(Date.now() - 25 * 3600_000).toISOString(), who);
  return (await voice('call-context', { agent: who, lang: 'en', token: again })).body as Ctx;
};
const endCall = (who: string, c: Ctx, lines: string[] = []) => voice('call-end', { agent: who, lines, token: c.token });
const onVoice = async (id: number, c: number) => (await voice(`picture?id=${id}&call=${c}`)).status;
const onCall = (c: Ctx) => `?call=${c.call}&key=${c.key}`;

test('an upload is read by its bytes, cut down to the picture (no Exif), stored 0600; anything else is refused', async () => {
  const jpeg = await upload(PHONE);
  assert.equal(jpeg.status, 200);
  const kept = await fetch(`${base}/api/pictures/file?id=${jpeg.body.id}`, { headers: BOARD });
  assert.ok(!Buffer.from(await kept.arrayBuffer()).includes(Buffer.from('GPSLatitude')));
  assert.equal(statSync(`${DIR}/${jpeg.body.id}.jpg`).mode & 0o777, 0o600);
  assert.equal(statSync(DIR).mode & 0o777, 0o700);
  // a PNG sent as a JPEG is still a PNG, and HQ gets it back as one, as an image and nothing else
  const png = await upload(PNG, 'image/jpeg');
  assert.equal(png.body.type, 'image/png');
  const shown = await fetch(`${base}/api/pictures/file?id=${png.body.id}`, { headers: BOARD });
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.equal(shown.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(shown.headers.get('cache-control'), 'private, no-store');  // (a browser asks again, and hears no once it's gone)
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), PNG);
  assert.equal((await upload(Buffer.from('<svg onload=alert(1)>'), 'image/png')).status, 400);
  assert.equal((await upload(PNG, 'image/svg+xml')).status, 415);
  assert.equal((await upload(Buffer.concat([PNG, Buffer.alloc(pictures.MAX_BYTES)]), 'image/png')).status, 413);
  // one that turns out too big as it comes in, with no length to go by, hears so too
  const files = readdirSync(DIR).length;
  assert.equal(await chunked(Buffer.concat([PNG, Buffer.alloc(pictures.MAX_BYTES)])), 413);
  assert.equal(readdirSync(DIR).length, files);
  // only from HQ's own page, with the board's session
  assert.equal((await fetch(`${base}/api/pictures`, { method: 'POST', headers: { ...BOARD, origin: 'https://hello.preview.example.com', 'content-type': 'image/png' }, body: PNG })).status, 403);
  assert.equal((await fetch(`${base}/api/pictures/file?id=${png.body.id}`)).status, 401);
});

test('pictures go with the board\'s line: the CEO\'s turn is told how to look at them, and HQ shows them on the line', async () => {
  const a = (await upload(JPEG)).body.id, b = (await upload(PNG, 'image/png')).body.id;
  assert.equal((await say({ text: 'This is how the menu looks on my phone', pictures: [a, b] })).status, 200);
  const heard = await turn();
  assert.match(heard.note, /how the menu looks/);
  assert.ok(heard.note.includes(`hq picture ${a} ${b}`));
  const history = await (await fetch(`${base}/api/chat`, { headers: BOARD })).json() as any;
  assert.deepEqual(history.messages.find((m: any) => m.text.startsWith('This is how')).pictures, [a, b]);
  // a picture goes with one line only; an unknown one, or too many, and the line isn't sent. A picture no longer
  // waiting is named, so HQ can take it out of its tray.
  const before = await lastLine();
  const again = await say({ text: 'again', pictures: [a] });
  assert.equal(again.status, 409);
  assert.deepEqual((await again.json() as any).missing, [a]);
  const unknown = await say({ text: 'nope', pictures: [99999] });
  assert.deepEqual((await unknown.json() as any).missing, [99999]);
  assert.equal((await say({ text: 'nope', pictures: ['x'] })).status, 400);
  const many = await Promise.all(Array.from({ length: pictures.PER_LINE + 1 }, () => upload(PNG, 'image/png')));
  assert.equal((await say({ text: 'lots', pictures: many.map(u => u.body.id) })).status, 400);
  assert.equal(await lastLine(), before);
  // a picture on its own is a line
  assert.equal((await say({ text: '', pictures: [many[0].body.id] })).status, 200);
  assert.equal((await say({ text: '  ' })).status, 400);
});

test('who may save an intercom picture: any job, once its line is sent', async () => {
  const plain = (await upload(PNG, 'image/png')).body.id;
  await say({ text: 'the logo, for Wren', pictures: [plain] });
  const wren = await jobFor('wren');
  const got = await fetchAs(wren.token, plain);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(got.body.data, 'base64'), PNG);
  assert.equal(got.body.from, 'the intercom');
  // one still waiting for its line isn't anyone's
  const unsent = (await upload(PNG, 'image/png')).body.id;
  assert.equal((await fetchAs((await jobFor('juno')).token, unsent)).status, 404);
});

test('a card\'s answer takes pictures: they wait for that card apart from the intercom\'s tray, and its answer names them for hq picture', async () => {
  const wren = await jobFor('wren');
  const card = (await agent('request', wren.token, { kind: 'action', title: 'The invoices', body: 'File them.' })).body.id as number;
  const mine = (await upload(PNG, 'image/png', `?request=${card}`)).body.id, chat = (await upload(PNG, 'image/png')).body.id;
  assert.ok(!(await tray()).includes(mine));
  assert.deepEqual(((await h.board(`/api/pictures/waiting?request=${card}`)).body.pictures as { id: number }[]).map(p => p.id), [mine]);
  assert.equal((await fetchAs(wren.token, mine)).status, 404);   // (not sent yet)
  // the intercom's picture isn't this card's, nor this card's the intercom's
  const wrong = await h.answer(card, 'here', { pictures: [chat] });
  assert.equal(wrong.status, 409);
  assert.deepEqual(wrong.body.missing, [chat]);
  assert.equal((await say({ text: 'x', pictures: [mine] })).status, 409);
  // a picture alone is an answer
  assert.equal((await h.answer(card, '', { pictures: [mine] })).status, 200);
  const heard = (await agent('request-answer', wren.token, { id: card })).body.answer as string;
  assert.ok(heard.includes(`hq picture ${mine}`), heard);
  // the agent who asked saves them, not an unrelated job
  const got = await fetchAs(wren.token, mine);
  assert.equal(got.status, 200);
  assert.equal(got.body.from, `card #${card}`);
  assert.equal((await fetchAs((await jobFor('juno')).token, mine)).status, 404);
  assert.equal((await h.answer(card, '', { pictures: [mine] })).status, 404);
  // no picture waits for a card that's answered, nor goes with keys
  assert.equal((await upload(PNG, 'image/png', `?request=${card}`)).status, 409);
  const keys = (await agent('request', wren.token, { kind: 'credential', title: 'Print API', body: 'b', secrets: 'PRINTAPI_TEST_KEY' })).body.id as number;
  assert.ok(keys);
  assert.equal((await upload(PNG, 'image/png', `?request=${keys}`)).status, 409);
});

test('a customer card\'s answer pictures: only whoever reads the card, refused with why to anyone else, and its reader holds their details', async () => {
  const asker = await jobFor('kit');
  const card = (jobs.createRequest({ kind: 'decision', title: 'Refund the kea mug?', body: 'Their photo.', agent: 'kit', job: asker.id, customers: true }) as { id: number }).id;
  const id = (await upload(PNG, 'image/png', `?request=${card}`)).body.id;
  assert.equal((await h.answer(card, 'refund', { pictures: [id] })).status, 200);
  for (const job of [await jobFor('juno'), await jobFor('kit')]) {   // an unrelated job, and the same agent's other job
    const r = await fetchAs(job.token, id);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, jobs.CARD_REFUSED);
    assert.equal(await holds(job), false);
  }
  for (const job of [asker, await jobFor('vera')]) {   // the job that filed it, and org.yaml's roles.customerData
    assert.equal((await fetchAs(job.token, id)).status, 200);
    assert.equal(await holds(job), true);
  }
});

test('a call\'s pictures: the voice line gets them only for that live call; afterwards whoever hq call shows it to, and a customer call\'s only to the jobs working on it', async () => {
  const ctx = await startCall('wren');
  const id = (await upload(PNG, 'image/png', onCall(ctx))).body.id;
  assert.equal(await onVoice(id, ctx.call), 200);
  assert.equal(await onVoice(id, ctx.call + 1), 404);
  assert.equal((await h.call(`/api/voice/picture?id=${id}&call=${ctx.call}`, ctx.token)).status, 401);
  // not to a colleague while the call is live, nor through the call's own token
  assert.equal((await fetchAs((await jobFor('kit')).token, id)).status, 404);
  assert.equal((await fetchAs(ctx.token, id)).status, 403);
  await endCall('wren', ctx, ['Board: (shared picture #' + id + ' on screen)', 'Wren: I see it.']);
  assert.equal(await onVoice(id, ctx.call), 404);
  assert.equal((await upload(PNG, 'image/png', onCall(ctx))).status, 409);   // the call has ended
  const followUp = (await h.claim())!;   // (the harness's own jobs run on engines of their own: this is the call's)
  assert.equal(followUp.call, ctx.call);
  assert.ok(followUp.prompt.includes(`hq picture ${id}`));
  assert.match(followUp.prompt, /one they don't name was never sent to it/);
  const kit = await jobFor('kit');
  assert.equal((await fetchAs(kit.token, id)).status, 200);
  assert.equal(await holds(kit), false, 'an ordinary call\'s picture');
  // once the call is about a customer (here: its follow-up was handed their details, as reading them does), a job not
  // working on it is refused with why, and the one that saves its picture holds them
  jobs.handedCustomerData(followUp.id);
  for (const job of [await jobFor('juno'), await jobFor('wren')]) {
    assert.equal((await fetchAs(job.token, id)).status, 403);
    assert.equal(await holds(job), false);
  }
  for (const job of [await jobFor('dex', { call: ctx.call }), await jobFor('vera')]) {   // a job handed out for the call, and org.yaml's roles.customerData
    assert.equal((await fetchAs(job.token, id)).status, 200);
    assert.equal(await holds(job), true);
  }
});

test('a call whose line dropped before the hand-over: its follow-up lists its pictures, and doesn\'t say which reached the call agent', async () => {
  const ctx = await startCall('wren');
  const id = (await upload(PNG, 'image/png', onCall(ctx))).body.id;
  assert.equal((await agent('item', ctx.token, { kind: 'promise', owner: 'wren', what: 'Look at the sketch', quote: 'I will look at it' })).status, 200);
  ledger.sweep(Date.now() + 3 * 3600_000 + 60_000);   // (three hours on, with no hand-over: no route moves the clock)
  const followUp = (await h.claim())!;
  assert.equal(followUp.call, ctx.call);
  assert.ok(followUp.prompt.includes(`hq picture ${id}`));
  assert.match(followUp.prompt, /which of them reached the call agent is unknown/);
  assert.doesNotMatch(followUp.prompt, /never sent to it/);
});

// An upload whose body is still coming in when `meanwhile` runs: the half sent, then the rest
function slowUpload(q: string, meanwhile: () => Promise<void>) {
  return new Promise<number>((done, failed) => {
    const req = request(`${base}/api/pictures${q}`, { method: 'POST', headers: { ...BOARD, 'content-type': 'image/png', 'content-length': PNG.length } },
      res => { res.resume(); done(res.statusCode!); });
    req.on('error', failed);
    req.write(PNG.subarray(0, 20));
    setTimeout(() => { meanwhile().then(() => req.end(PNG.subarray(20)), failed); }, 200);
  });
}

test('a call that hangs up while its picture comes in gets none, nor does the next call that takes its number', async () => {
  const files = readdirSync(DIR).length;
  const gone = await startCall('wren');
  assert.equal(await slowUpload(onCall(gone), async () => { await endCall('wren', gone); }), 409);
  // a silent call's number comes back: the picture meant for it must not show on the new one
  const silent = await startCall('wren');
  let next = 0;
  assert.equal(await slowUpload(onCall(silent), async () => {
    await endCall('wren', silent);
    next = (await startCall('wren')).call;
  }), 409);
  assert.equal(next, silent.call);
  assert.equal(readdirSync(DIR).length, files);
});

test('a picture picked on a call that ends before it\'s sent never lands on the next call that takes its number', async () => {
  // HQ redraws the picture while the board's call with Customer Care ends with nothing said, and a call with Wren starts
  const care = await startCall('poppy');
  await endCall('poppy', care);
  const next = await startCall('wren');
  assert.equal(next.call, care.call);
  assert.equal((await upload(PNG, 'image/png', onCall(care))).status, 409);
  // nor does a picture with no key, or another call's, get on a live call: only its own
  assert.equal((await upload(PNG, 'image/png', `?call=${next.call}`)).status, 409);
  assert.equal((await upload(PNG, 'image/png', `?call=${next.call}&key=${(await startCall('kit')).key}`)).status, 409);
  assert.equal((await upload(PNG, 'image/png', onCall(next))).status, 200);
  // a restarted call agent goes on with the same call, and the same key
  assert.equal((await startCall('wren', next.token)).key, next.key);
});

test('a call where nobody spoke leaves nothing behind, its pictures included: the next call with its number finds none', async () => {
  const ctx = await startCall('wren');
  const id = (await upload(PNG, 'image/png', onCall(ctx))).body.id;
  await endCall('wren', ctx);
  assert.ok(!((await h.board('/api/calls')).body as { id: number }[]).some(c => c.id === ctx.call));
  assert.equal(await onVoice(id, ctx.call), 404);
  assert.ok(!existsSync(`${DIR}/${id}.png`));
});

// (a day passing: no route moves the clock, so the picture is made a day old in the table)
const dayOld = (id: number) => h.db.prepare('update pictures set created = ? where id = ?').run(new Date(Date.now() - 25 * 3600_000).toISOString(), id);

test('a picture the board picked but never sent goes after a day, at the next upload, and its number is never used again', async () => {
  const old = (await upload(PNG, 'image/png')).body.id;
  dayOld(old);
  const next = (await upload(PNG, 'image/png')).body.id;
  assert.ok(!(await tray()).includes(old));
  assert.equal((await fetch(`${base}/api/pictures/file?id=${old}`, { headers: BOARD })).status, 404);
  assert.ok(next > old);   // its number never comes back
  assert.ok(!existsSync(`${DIR}/${old}.png`));
});

test('a line with a picture that went after a day is refused and names it; the tray\'s others are untouched', async () => {
  const kept = (await upload(PNG, 'image/png')).body.id, old = (await upload(PNG, 'image/png')).body.id;
  dayOld(old);
  await upload(PNG, 'image/png');   // (collects the old one)
  const before = await lastLine();
  const refused = await say({ text: 'these two', pictures: [kept, old] });
  assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json() as any).missing, [old]);
  assert.equal(await lastLine(), before);
  assert.ok((await tray()).includes(kept));
  assert.equal((await say({ text: 'this one', pictures: [kept] })).status, 200);
});

test('a line with a picture already sent on an earlier line is refused and names it; the tray\'s others are untouched', async () => {
  const sent = (await upload(PNG, 'image/png')).body.id, kept = (await upload(PNG, 'image/png')).body.id;
  assert.equal((await say({ text: 'the first one', pictures: [sent] })).status, 200);
  const before = await lastLine();
  const refused = await say({ text: 'both again', pictures: [sent, kept] });
  assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json() as any).missing, [sent]);
  assert.equal(await lastLine(), before);
  const line = ((await h.board('/api/chat')).body.messages as any[]).find(m => m.text === 'the first one');
  assert.deepEqual(line.pictures, [sent], 'the sent one stays with its line');
  assert.ok((await tray()).includes(kept));
  assert.equal((await say({ text: 'this one', pictures: [kept] })).status, 200);
});

test('a fresh session\'s recap names a long line\'s pictures after cutting its words', async () => {
  const pic = (await upload(PNG, 'image/png')).body.id;
  await say({ text: 'word '.repeat(400), pictures: [pic] });
  await turn();   // heard
  await say({ text: 'about that picture' });
  // a turn failed three times: the CEO starts over in a fresh session. (A failed turn is tried again two minutes on: no
  // route moves the clock, so the table says they're up.)
  for (let i = 0; i < 3; i++) h.db.prepare('update jobs set not_before = 0 where id = ?').run((await turn('failed')).id);
  const fresh = (await h.claim('claude', { kind: 'chat' }))!;
  assert.ok(fresh.prompt.includes(`(with picture #${pic})`));
  await h.finish(fresh);
});

test('pictures the board removes from its tray free their place; HQ finds the rest again, and a sent one stays', async () => {
  const forget = async (id: number) => (await h.board('/api/pictures/forget', { id })).status;
  const already = await tray();
  const fresh = await Promise.all(Array.from({ length: pictures.WAITING - already.length }, () => upload(PNG, 'image/png')));
  assert.equal((await upload(PNG, 'image/png')).status, 429);
  // after a reload HQ finds every one still waiting, and removing them makes room again
  assert.deepEqual(await tray(), [...already, ...fresh.map(u => u.body.id)].sort((a, b) => a - b));
  for (const id of await tray()) assert.equal(await forget(id), 200);
  assert.deepEqual(await tray(), []);
  assert.ok(!existsSync(`${DIR}/${fresh[0].body.id}.png`));
  assert.equal((await upload(PNG, 'image/png')).status, 200);
  // a sent picture is part of its line, a call's is part of its call: neither goes
  const sent = (await upload(PNG, 'image/png')).body.id;
  await say({ text: 'keep this one', pictures: [sent] });
  assert.equal(await forget(sent), 404);
  const ctx = await startCall('wren');
  const shown = (await upload(PNG, 'image/png', onCall(ctx))).body.id;
  assert.equal(await forget(shown), 404);
  assert.equal(await onVoice(shown, ctx.call), 200);
  // only from HQ's own page
  assert.equal((await fetch(`${base}/api/pictures/forget`, { method: 'POST', headers: { ...BOARD, origin: 'https://hello.preview.example.com',
    'content-type': 'application/json' }, body: JSON.stringify({ id: sent }) })).status, 403);
});

test('uploads that arrive together never fill the tray past WAITING: one gets the last place, the rest hear 429 and leave nothing', async () => {
  while ((await tray()).length < pictures.WAITING - 1) assert.equal((await upload(PNG, 'image/png')).status, 200);
  const files = readdirSync(DIR).length;
  assert.deepEqual((await together('')).sort(), [200, 429, 429, 429, 429, 429]);
  assert.equal((await tray()).length, pictures.WAITING);
  assert.equal(readdirSync(DIR).length, files + 1);
});

test('uploads that arrive together on a call never take it past PER_CALL', async () => {
  const ctx = await startCall('wren');
  for (let i = 0; i < pictures.PER_CALL - 1; i++) assert.equal((await upload(PNG, 'image/png', onCall(ctx))).status, 200);
  const files = readdirSync(DIR).length;
  assert.deepEqual((await together(onCall(ctx))).sort(), [200, 429, 429, 429, 429, 429]);
  assert.equal(readdirSync(DIR).length, files + 1);
  assert.equal((await upload(PNG, 'image/png', onCall(ctx))).status, 429);
});

// Six uploads send their PNG's first bytes, all pass the count while there's one place left, then finish: their statuses
async function together(q: string) {
  const started = Array.from({ length: 6 }, () => {
    const req = request(`${base}/api/pictures${q}`, { method: 'POST', headers: { ...BOARD, 'content-type': 'image/png' } });
    const status = new Promise<number>((done, failed) => {
      req.on('response', res => { res.resume(); done(res.statusCode!); });
      req.on('error', failed);
    });
    req.write(PNG.subarray(0, 8));
    return { req, status };
  });
  await new Promise(r => setTimeout(r, 200));
  for (const { req } of started) req.end(PNG.subarray(8));
  return Promise.all(started.map(s => s.status));
}
