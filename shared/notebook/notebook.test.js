// node --test shared/notebook/notebook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HQ = 'https://hq.example.test';
const hq = {
  posted: [],
  postMessage(message, origin) {
    this.posted.push([message, origin]);
  },
};
const heard = [];
let named; // the host's answer at /__hq-origin, once it gives one
const naming = new Promise(resolve => (named = resolve));
globalThis.fetch = async path => {
  assert.equal(path, '/__hq-origin');
  await naming;
  return { ok: true, text: async () => `${HQ}\n` };
};
globalThis.window = { parent: hq, addEventListener: (type, fn) => type === 'message' && heard.push(fn) };
const notebook = await import('./notebook.js');
const arrive = (source, origin, data) => heard.forEach(fn => fn({ source, origin, data }));
const moves = [];
notebook.on('pull', detail => moves.push(['pull', detail]));

test("nothing is heard or sent before the host names HQ's origin", async () => {
  arrive(hq, HQ, { hq: 'hq', notebook: 'pull', detail: {} });
  assert.equal(notebook.send('context', { level: 3 }), false);
  named();
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual([moves, hq.posted], [[], []]);
});

test('a page that listens hears pull, then letgo, from its parent at HQ’s origin alone', () => {
  const lets = [];
  const off = notebook.on('letgo', detail => lets.push(detail));
  arrive({}, HQ, { hq: 'hq', notebook: 'pull', detail: { from: 'another frame' } });
  arrive(hq, 'https://outside.example', { hq: 'hq', notebook: 'pull', detail: { from: 'a parent elsewhere' } });
  arrive(hq, HQ, { hq: 'hq', notebook: 'pull', detail: {} });
  arrive(hq, HQ, { hq: 'hq', notebook: 'letgo', detail: { open: true } });
  off();
  arrive(hq, HQ, { hq: 'hq', notebook: 'letgo', detail: { open: false } });
  assert.deepEqual(moves, [['pull', {}]]);
  assert.deepEqual(lets, [{ open: true }]);
});

test("a parent gone to another origin after HQ spoke is not heard, and words still go to HQ's origin only", () => {
  arrive(hq, 'https://outside.example', { hq: 'hq', notebook: 'pull', detail: { from: 'after HQ' } });
  assert.equal(moves.length, 1);
  assert.equal(notebook.send('context', { level: 3 }), true);
  assert.deepEqual(hq.posted, [[{ hq: 'notebook', kind: 'context', detail: { level: 3 } }, HQ]]);
});

test('an event the notebook has no name for is refused', () => {
  assert.throws(() => notebook.on('opened', () => {}), /no event called opened/);
});
