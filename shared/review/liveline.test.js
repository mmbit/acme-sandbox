// node --test shared/review/liveline.test.js   (the live line: the words as they're said, its last phrase, a dropped
// line.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveLine } from './liveline.js';

// A stand-in socket: what's sent kept, opened at once, closed on asking
class Socket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static last = null;
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = Socket.OPEN;
    this.sent = [];
    Socket.last = this;
  }
  send(m) {
    this.sent.push(m);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
    this.dispatchEvent(new Event('close'));
  }
  said(m) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}
globalThis.WebSocket = Socket;
// A stand-in audio context: its tap hears one buffer of 48 kHz audio when asked
const node = () => ({ connect: n => n, disconnect() {}, gain: {} });
function audio() {
  const tap = { ...node() };
  return {
    sampleRate: 48000,
    destination: node(),
    createGain: node,
    createScriptProcessor: () => tap,
    hear: x => tap.onaudioprocess?.({ inputBuffer: { getChannelData: () => x } }),
  };
}
const ends = () => {
  const ctx = audio(),
    heard = [],
    over = [];
  const line = liveLine(new URL('https://hq.test/__review/'), ctx, node(), {
    heard: t => heard.push(t),
    over: () => over.push(true),
  });
  return { line, ctx, heard, over, ws: Socket.last };
};

test('the audio goes as 16 kHz PCM, the words so far come back, and its last phrase brings them all', async () => {
  const { line, ctx, heard, ws } = ends();
  assert.equal(ws.url, 'wss://hq.test/__review/dictate');
  ctx.hear(new Float32Array(4800).fill(0.5));
  assert.ok(ws.sent[0] instanceof Int16Array && Math.abs(ws.sent[0].length - 1600) <= 1, 'a third as many samples');
  ws.said({ type: 'heard', text: 'Make this' });
  const ended = line.end();
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { type: 'end' }, 'its last phrase asked for');
  ws.said({ type: 'heard', text: 'Make this headline shorter' });
  ws.said({ type: 'done' });
  assert.equal(await ended, true, 'the line brought the words');
  assert.deepEqual(heard, ['Make this', 'Make this headline shorter']);
});

test('a line that drops before its words are in leaves them to the clip', async () => {
  const { line, ws } = ends();
  ws.close();
  assert.equal(await line.end(), false);
});

test('done unasked (its five minutes) is the end: over() hears it, and the words are in', async () => {
  const { line, over, ws } = ends();
  ws.said({ type: 'done' });
  assert.deepEqual(over, [true]);
  assert.equal(await line.end(), true);
});

test('dropped while its last phrase is awaited: no wait, no words', async () => {
  const { line } = ends();
  const ended = line.end();
  line.close();
  assert.equal(await ended, false);
});
