// node --test src/voice.test.ts   (a stand-in for the speech-to-text server): the board's words come back as said, only whisper's
// sound tags go. Silence and noise are kept out by the STT server's voice activity detection (platform/stt), never here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness } from './harness.ts';

let said = '';
const stt = createServer((q, s) => { q.resume(); q.on('end', () => s.end(JSON.stringify({ text: said }))); }).listen(0);
await new Promise(r => stt.once('listening', r));
after(() => stt.close());
const h = await harness('voice', { env: { STT_URL: `http://localhost:${(stt.address() as AddressInfo).port}` } });
const { ORIGIN } = await import('./config.ts');
// the board dictates in HQ: its recording goes to /api/voice, the words come back
const hear = async (text: string) => {
  said = text;
  const r = await fetch(`${h.base}/api/voice?lang=en`, { method: 'POST', body: Buffer.alloc(400), headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'audio/mp4' } });
  return (await r.json()).text;
};

test('a board that says just "Thank you." (or "You.") is heard', async () => {
  for (const words of ['Thank you.', 'You.', 'Thanks for watching!', 'Ondertiteld door de redactie, zeg dat maar tegen Kit.'])
    assert.equal(await hear(` ${words}\n`), words);
});

test("whisper's sound tags are formatting, not words", async () => {
  assert.equal(await hear('[BLANK_AUDIO]'), '');
  assert.equal(await hear(' (music) Send it to Kit. *laughs*'), 'Send it to Kit.');
});
