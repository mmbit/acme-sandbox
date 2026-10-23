// node --test src/pins.test.ts: a call about the board's pins (review notes it ticked in HQ's Reviews and rang the maker
// about): the call's prompt carries them, the voice line gets their screenshots, nothing is sent by starting it, and on it
// the agent rewords a pin or marks it sent (feedback.ts, call.ts, hq pin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { harness } from './harness.ts';

const h = await harness('pins', { env: { PUBLIC_HOST: 'hq.company.test' }, before: repo => {
  mkdirSync(`${repo}/products/other`); writeFileSync(`${repo}/products/other/product.yaml`, 'name: Other\nstatus: preview\nowner: bolt\n');
} });
const { voice, board } = h;
(await import('./storage.ts')).FLOOR.bytes = 0;   // (screenshots are kept whatever this machine's disk has free)
const pinRoute = (token: string, body: unknown) => h.agent('pin', token, body);
const note = async (id: number) => ((await board('/api/review/notes')).body as any[]).find(n => n.id === id);

// A preview host's page, as the board's browser asks for it (its Host; the preview key's cookie once it has one)
const onHost = (host: string, path: string, headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; headers: any; body: any }>(done => {
  const req = request(h.base + path, { method: body ? 'POST' : 'GET', headers: { host, ...headers, ...body ? { 'content-type': 'application/json' } : {} } }, res => {
    let text = ''; res.on('data', c => { text += c; }); res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body: text && JSON.parse(text) }));
  });
  req.end(body ? JSON.stringify(body) : undefined);
});
// the board opens a preview from HQ: the signed link, then the key its cookie keeps
const keyFor = async (host: string) => {
  const link = new URL((await board('/api/preview/link', { url: `https://${host}/` })).body.url);
  return String((await onHost(host, link.pathname + link.search)).headers['set-cookie']).split(';')[0];
};
// a 1×1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HOST = 'hello.preview.company.test', KEY = await keyFor(HOST);
// a note the board pins on a preview page in review mode
const pinned = async (words: string, page = '/shop', shot = true, host = HOST) => {
  const r = await onHost(host, '/__review/notes', { cookie: KEY, origin: `https://${host}` },
    { note: words, page: `https://${host}${page}`, shot: shot ? PNG : undefined, element: { tag: 'button', selector: 'main > button', text: 'Order now' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
// The board rings bolt (hello's owner) about these pins, as the voice line asks for the call.
const ring = async (pins: unknown, token = '') => {
  const r = await voice('call-context', { agent: 'bolt', lang: 'en', pins, ...(token ? { token } : {}) });
  assert.equal(r.status, 200);
  return r.body as { prompt: string; token: string; call: number; pins: { id: number; kind: string; type: string; data: string }[] };   // (kind)
};

test("a call about pins carries them and their screenshots, and sends none of them", async () => {
  const a = await pinned('The button is too pale', '/2026/presentation/#7'), b = await pinned('Why two prices?', '/shop', false);
  const c = await ring([a, b]);
  assert.match(c.prompt, /the board's pins on Hello/);
  assert.match(c.prompt, new RegExp(`### Pin #${a} on https://${HOST}/2026/presentation/#7\\n.*The button is too pale[^]*Slide: 7`));
  assert.match(c.prompt, new RegExp(`### Pin #${b} on .*/shop\\n.*Why two prices`));
  assert.match(c.prompt, /pin_sent/);
  // the screenshots, in order, for the voice line (b has none)
  assert.deepEqual(c.pins.map(p => [p.id, p.type]), [[a, 'image/png']]);
  assert.equal(c.pins[0].data, PNG.split(',')[1]);
  assert.deepEqual([(await note(a)).status, (await note(b)).status], ['pending', 'pending']);
  // the call ends: the pins stay waiting
  assert.equal((await voice('call-end', { agent: 'bolt', lines: ['Board: the pale button.'], token: c.token })).status, 200);
  assert.deepEqual([(await note(a)).status, (await note(b)).status], ['pending', 'pending']);
});

test("a call's images: every pin's screenshot first, the pictures in what room is left, and what had none named under its pin", async () => {
  // four pictures as big as a note takes (1.5 MB, 2 MB in base64): with two screenshots, room for two of them
  const big = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1536 * 1024 - 4)]).toString('base64');
  const r = await onHost(HOST, '/__review/notes', { cookie: KEY, origin: `https://${HOST}` },
    { note: 'Warmer, like these', page: `https://${HOST}/shop`, shot: PNG, pictures: [big, big, big, big], element: { tag: 'button', selector: 'main > button', text: 'Order now' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.id as number, b = await pinned('And this one');
  const c = await ring([a, b]);
  assert.deepEqual(c.pins.map(p => [p.id, p.kind]), [[a, 'screenshot'], [a, 'picture'], [a, 'picture'], [b, 'screenshot']]);
  assert.match(c.prompt, new RegExp(`### Pin #${a} [^#]*No room on this call for 2 of the pictures added to it: you don't see them\\. Tell the board`));
  assert.doesNotMatch(c.prompt.slice(c.prompt.indexOf(`### Pin #${b}`)), /No room/, 'the second pin has all of its');
  assert.equal((await voice('call-end', { agent: 'bolt', lines: ['Board: these.'], token: c.token })).status, 200);
  await board('/api/review/discard', { ids: [a, b] });
});

test('a call is about the ticked notes still waiting, about one thing; anything else rings without pins', async () => {
  const a = await pinned('one'), gone = await pinned('discarded');
  assert.equal((await board('/api/review/discard', { slug: 'hello', ids: [gone] })).status, 200);
  // a ticked pin sent or discarded since drops out; the others still come
  for (const pins of [[a, gone], [a, 99999]]) {
    const c = await ring(pins);
    assert.match(c.prompt, new RegExp(`### Pin #${a} `));
    assert.doesNotMatch(c.prompt, new RegExp(`### Pin #${gone} `));
  }
  for (const pins of [[gone], 'x', []])
    assert.doesNotMatch((await ring(pins)).prompt, /the board's pins/, JSON.stringify(pins).slice(0, 40));
  // two products' notes in one call: refused as a set
  const elsewhere = await pinned('on another product', '/', true, 'other.preview.company.test');
  assert.doesNotMatch((await ring([a, elsewhere])).prompt, /the board's pins/);
  assert.match((await ring([a])).prompt, /the board's pins/);
});

test("a call that leaves nothing behind takes its pins with it: a later call with its number isn't about them", async () => {
  const a = await pinned('the old call\'s pin');
  const first = await ring([a]);
  assert.equal((await voice('call-end', { agent: 'bolt', lines: [], token: first.token })).status, 200);
  const next = await ring([]);
  assert.equal(next.call, first.call);   // (the number came back)
  assert.doesNotMatch(next.prompt, /the board's pins/);
  assert.deepEqual(next.pins, []);
  assert.equal((await pinRoute(next.token, { id: a, words: 'x' })).status, 409);
  assert.equal((await ring([], next.token)).pins.length, 0);   // nor does a restart of it
  assert.deepEqual([(await note(a)).note, (await note(a)).status], ["the old call's pin", 'pending']);
});

test('on the call the agent rewords a pin, and marks one sent with its job or as answered; nothing else', async () => {
  const a = await pinned('make it red'), b = await pinned('is this the final price?'), c = await pinned('add a FAQ'), other = await pinned('not on this call');
  const call = await ring([a, b, c]), t = call.token;
  // reword: the board and the agent landed on better words
  assert.equal((await pinRoute(t, { id: a, words: '  Make the button the brand green, not red  ' })).status, 200);
  assert.equal((await note(a)).note, 'Make the button the brand green, not red');
  assert.equal((await note(a)).status, 'pending');
  assert.equal((await pinRoute(t, { id: a, words: '   ' })).status, 409);
  // sent with the job the agent queued on the call
  const queued = await h.agent('job', t, { agent: 'moss', title: 'A FAQ on hello', prompt: 'Add a FAQ.' });
  assert.equal(queued.status, 200);
  const r = await pinRoute(t, { id: c, sent: true, job: queued.body.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: c, job: queued.body.id, agent: 'moss' });
  assert.deepEqual([(await note(c)).status, (await note(c)).job, (await note(c)).call], ['sent', queued.body.id, call.call]);
  // answered on the call: no job
  assert.equal((await pinRoute(t, { id: b, sent: true, answered: true })).status, 200);
  assert.deepEqual([(await note(b)).status, (await note(b)).job, (await note(b)).call], ['sent', null, call.call]);
  // refused: not this call's pin, not waiting any more, a job that isn't one, neither or both, and any token but a call's
  assert.equal((await pinRoute(t, { id: other, words: 'x' })).status, 409);
  assert.equal((await pinRoute(t, { id: other, sent: true, answered: true })).status, 409);
  assert.equal((await pinRoute(t, { id: b, words: 'again' })).status, 409);
  assert.equal((await pinRoute(t, { id: a, sent: true, job: 99999 })).status, 409);
  assert.equal((await pinRoute(t, { id: a, sent: true })).status, 400);
  assert.equal((await pinRoute(t, { id: a, sent: true, job: queued.body.id, answered: true })).status, 400);
  assert.equal((await pinRoute((await h.start({ agent: 'bolt' })).token, { id: a, words: 'x' })).status, 403);
  assert.equal((await note(a)).note, 'Make the button the brand green, not red');
  // HQ shows them as it stands: one waiting, the answered one and the sent one done
  const list = ((await board('/api/review/notes?slug=hello')).body as any[]).filter(n => [a, b, c].includes(n.id));
  assert.deepEqual(list.map(n => [n.id, n.status]), [[a, 'pending'], [c, 'sent'], [b, 'sent']]);
});

test('several calls about the same pins: what one did, the next (and a restart) sees', async () => {
  const a = await pinned('think about the cover'), b = await pinned('which paper?');
  const first = await ring([a, b]);
  assert.equal((await pinRoute(first.token, { id: b, sent: true, answered: true })).status, 200);
  // a restart mid-call reads its pins from the call, whatever the line sends
  const again = await ring([], first.token);
  assert.equal(again.call, first.call);
  assert.match(again.prompt, new RegExp(`### Pin #${b} [^]*Now: marked sent: answered on call #${first.call}`));
  assert.deepEqual(again.pins.map(p => p.id), [a]);   // (only a waiting pin's screenshot)
  await voice('call-end', { agent: 'bolt', lines: ['Board: let me think about the cover.'], token: first.token });
  // a later call about the pin left waiting
  const second = await ring([a]);
  assert.notEqual(second.call, first.call);
  assert.equal((await pinRoute(second.token, { id: a, words: 'A linen cover' })).status, 200);
  assert.equal((await pinRoute(first.token, { id: a, words: 'x' })).status, 401);   // the ended call's token is gone
  assert.equal((await note(a)).note, 'A linen cover');
});

// hq pin, as the call's tools run it (hq_tools.py): the words on stdin; a refusal changes nothing (exit 1)
test('hq pin words and sent, from a call', async () => {
  const a = await pinned('bigger'), b = await pinned('why?');
  const call = await ring([a, b]);
  const hq = (args: string[], stdin = '') => new Promise<{ code: number; out: string; err: string }>(resolve => {
    const p = execFile(new URL('../../worker/bin/hq', import.meta.url).pathname, args,
      { env: { PATH: process.env.PATH, HQ_URL: h.base, HQ_TOKEN: call.token, HQ_AGENT: 'bolt', HQ_CALL: '1' } },
      (err, out, errOut) => resolve({ code: err ? Number((err as any).code) : 0, out: out.trim(), err: errOut.trim() }));
    p.stdin!.end(stdin);
  });
  let r = await hq(['pin', 'words', String(a), '-'], 'Make it bigger, twice the size');
  assert.equal(r.code, 0, r.err);
  assert.equal((await note(a)).note, 'Make it bigger, twice the size');
  r = await hq(['pin', 'sent', String(b), 'answered']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([(await note(b)).status, (await note(b)).job, (await note(b)).call], ['sent', null, call.call]);
  r = await hq(['pin', 'sent', String(b), 'answered']);
  assert.equal(r.code, 1);
  r = await hq(['pin', 'sent', String(a), 'job:99999']);
  assert.equal(r.code, 1);
  r = await hq(['pin', 'words', String(a), 'file.txt']);
  assert.equal(r.code, 1);
  r = await hq(['pin', 'words', String(a), '-'], 'x'.repeat(4001)); // past the note box's length: refused, never cut
  assert.equal(r.code, 1);
  assert.equal((await note(a)).note, 'Make it bigger, twice the size');
  assert.equal((await note(a)).status, 'pending');
});
