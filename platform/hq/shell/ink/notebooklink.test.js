// node --test platform/hq/shell/ink/notebooklink.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as link from './notebooklink.js';

const heard = [];
const hqWindow = { addEventListener: (type, fn) => type === 'message' && heard.push(fn) };
const framed = name => ({
  name,
  posted: [],
  postMessage(message, origin) {
    this.posted.push([message, origin]);
  },
});
const game = framed('game'),
  elsewhere = framed('elsewhere');
const PREVIEW = 'https://game.preview.example.test';
link.mountFrames(hqWindow, { frames: () => [game], trusts: origin => origin === PREVIEW });
const arrive = (source, origin, data) => heard.forEach(fn => fn({ source, origin, data }));

test("HQ's listeners hear the pull and the let-go, until they unsubscribe", () => {
  const moves = [];
  const off = link.on('pull', () => moves.push('pull'));
  link.on('letgo', detail => moves.push(['letgo', detail]));
  link.emit('pull');
  link.emit('letgo', { open: true });
  off();
  link.emit('pull');
  assert.deepEqual(moves, ['pull', ['letgo', { open: true }]]);
});

test('an artifact HQ shows hears pull, then letgo with where the notebook ends up', () => {
  game.posted.length = 0;
  link.emit('pull');
  link.emit('letgo', { open: false });
  assert.deepEqual(
    game.posted.map(([message]) => message),
    [
      { hq: 'hq', notebook: 'pull', detail: {} },
      { hq: 'hq', notebook: 'letgo', detail: { open: false } },
    ],
  );
  assert.equal(elsewhere.posted.length, 0);
});

test("the notebook hears HQ's word and its artifacts', never another frame's or another site's", () => {
  const words = [];
  link.on('message', word => words.push(word));
  link.send('debug', { fps: 60 });
  arrive(game, PREVIEW, { hq: 'notebook', kind: 'context', detail: { level: 3 } });
  arrive(elsewhere, PREVIEW, { hq: 'notebook', kind: 'context', detail: 'from a frame HQ never showed' });
  arrive(game, 'https://outside.example', { hq: 'notebook', kind: 'context', detail: 'the frame gone elsewhere' });
  arrive(game, PREVIEW, { hq: 'notebook', kind: 7 });
  arrive(game, PREVIEW, null);
  assert.deepEqual(words, [
    { kind: 'debug', detail: { fps: 60 }, from: 'hq' },
    { kind: 'context', detail: { level: 3 }, from: 'artifact' },
  ]);
});
