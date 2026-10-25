// node --test src/dictation.test.ts   (uses a throwaway DATA_DIR; products/hello from the repo is the product)
// Review mode's live dictation (feedback.ts dictate, dictation.ts) through to a stand-in voice line that echoes each
// frame.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import type { Duplex } from 'node:stream';
import { fixtureRepo } from './fixture.ts';

fixtureRepo();
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/dictation-test-`);
process.env.PUBLIC_HOST = 'hq.company.test';
process.env.VOICE_TOKEN = 'voice-secret';

// The voice line's stand-in: what each dictation asked with, and every frame echoed back as it came
const asked: { url?: string; authorization?: string }[] = [];
const line = createServer();
line.on('upgrade', (req, socket) => {
  asked.push({ url: req.url, authorization: req.headers.authorization });
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
  );
  socket.on('data', (chunk: Buffer) => echo(socket, chunk));
  socket.on('end', () => socket.end()); // (an HTTP server's sockets stay half open, as the voice line's don't)
});
await new Promise<void>(r => line.listen(0, r));
after(() => line.close());
process.env.VOICE_URL = `http://localhost:${(line.address() as any).port}`;

const feedback = await import('./feedback.ts');
const { db } = await import('./db.ts');
const shares = await import('./shares.ts');
const HOST = 'hello.preview.company.test',
  ORIGIN = `https://${HOST}`,
  KEY = 'board-key';
db.prepare('insert into preview_keys (key, expires) values (?, ?)').run(KEY, Date.now() + 864e5);

// The coordinator's upgrade, with the Host Caddy passes on (a browser's WebSocket can't set it)
const coordinator = createServer();
coordinator.on('upgrade', (req, socket, head) => {
  req.headers.host = HOST;
  feedback.dictate(req, socket, head);
});
await new Promise<void>(r => coordinator.listen(0, r));
after(() => coordinator.close());
const port = (coordinator.address() as any).port;

// An upgrade's answer: its status (101 once carried through), the connection closed after
// (cookie: another reviewer's, an outsider's ps)
const upgrade = (
  path: string,
  {
    key = KEY,
    origin = ORIGIN,
    cookie = key ? `pv=${key}` : null,
  }: { key?: string | null; origin?: string; cookie?: string | null } = {},
) =>
  new Promise<number>((resolve, reject) => {
    const q = request(`http://localhost:${port}${path}`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        origin,
        ...(cookie ? { cookie } : {}),
      },
    });
    q.on('upgrade', (answer, socket) => {
      socket.destroy();
      resolve(answer.statusCode!);
    });
    q.on('response', answer => {
      answer.resume();
      resolve(answer.statusCode!);
    });
    q.on('error', reject);
    q.end();
  });

// A real browser's WebSocket to /__review/dictate, open, with the messages it gets
const open = async () => {
  const ws = new WebSocket(`ws://localhost:${port}/__review/dictate`, {
    headers: { origin: ORIGIN, cookie: `pv=${KEY}` },
  } as any);
  ws.binaryType = 'arraybuffer';
  const got: (string | number[])[] = [];
  ws.onmessage = e => got.push(typeof e.data === 'string' ? e.data : [...new Uint8Array(e.data)]);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ws, got };
};
const until = async (done: () => boolean) => {
  while (!done()) await new Promise(r => setTimeout(r, 10));
};

test('a dictation is refused without the board’s key, from another origin, or on another path', async () => {
  assert.equal(await upgrade('/__review/dictate', { key: null }), 403);
  assert.equal(await upgrade('/__review/dictate', { key: 'guess' }), 403);
  assert.equal(await upgrade('/__review/dictate', { origin: 'https://other.preview.company.test' }), 403);
  assert.equal(await upgrade('/__review/dictation'), 404);
  assert.equal(await upgrade('/voice/dictate'), 404);
  assert.equal(asked.length, 0);
});

test('a dictation carries audio and text both ways, to the voice line with its token', async () => {
  const { ws, got } = await open();
  ws.send(new Uint8Array([1, 2, 3, 250]));
  ws.send('{"type":"end"}');
  await until(() => got.length === 2);
  assert.deepEqual(got, [[1, 2, 3, 250], '{"type":"end"}']);
  assert.deepEqual(asked.at(-1), { url: '/voice/dictate?lang=en', authorization: 'Bearer voice-secret' });
  ws.close();
  await new Promise(r => {
    ws.onclose = r;
  });
});

test('one dictation at a time on a product: another waits until it ends', async () => {
  const first = await open();
  assert.equal(await upgrade('/__review/dictate'), 429);
  first.ws.close();
  await new Promise(r => {
    first.ws.onclose = r;
  });
  let status = 0;
  for (let i = 0; i < 50 && status !== 101; i++) status = await upgrade('/__review/dictate'); // (once the close has reached here)
  assert.equal(status, 101);
});

// An invited reviewer dictates as the board does, in no language of ours: their words are written down as heard.
test("an outside reviewer's dictation is let in, without the board's language; a view-only share's is not", async () => {
  const invite = (name: string, view = false) =>
    feedback.inviteToShare({ page: `${ORIGIN}/`, name, email: `${name.toLowerCase()}@example.org`, days: 3, view });
  // their session on the preview host, as the guest desk's hand-off leaves it (shares.ts onward, accept)
  const sessionOf = (guest: string) => {
    const code = new URL(shares.onward(guest, `${ORIGIN}/`)!).searchParams.get('s')!;
    return `ps=${shares.accept(code, HOST)!.session}`;
  };
  invite('Noor');
  invite('Wim', true);
  const noor = sessionOf('Noor'),
    wim = sessionOf('Wim');
  assert.equal(await upgrade('/__review/dictate', { cookie: wim }), 403, 'a view-only share takes no notes');
  assert.equal(await upgrade('/__review/dictate', { cookie: noor, origin: 'https://other.preview.company.test' }), 403);
  let status = 429;
  for (let i = 0; i < 50 && status === 429; i++) status = await upgrade('/__review/dictate', { cookie: noor }); // (once the last test's close has reached here)
  assert.equal(status, 101);
  assert.deepEqual(asked.at(-1), { url: '/voice/dictate?lang=', authorization: 'Bearer voice-secret' });
});

// Each whole frame in a chunk sent back unmasked, as a server sends it (the test's frames are small: one chunk holds them)
function echo(socket: Duplex, chunk: Buffer) {
  for (let at = 0; at < chunk.length;) {
    const opcode = chunk[at] & 0x0f,
      length = chunk[at + 1] & 0x7f,
      mask = chunk.subarray(at + 2, at + 6);
    const payload = Buffer.from(chunk.subarray(at + 6, at + 6 + length).map((byte, i) => byte ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
    if (opcode === 8) socket.end();
    at += 6 + length;
  }
}
