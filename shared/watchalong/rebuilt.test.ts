// node --test shared/watchalong/rebuilt.test.ts
// What rrweb's replayer rebuilds unlike the page, put right in its events (rebuilt.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rebuilt } from './rebuilt.js';
import type { RecordedEvent } from './store.ts';

const el = (id: number, tagName: string, childNodes: unknown[] = []) => ({
  type: 2,
  id,
  tagName,
  attributes: {},
  childNodes,
});
// HQ as rrweb snapshots it: <html> with its head, its body, then the book and review mode's controls after the body
const snapshot = (at: number): RecordedEvent => ({
  type: 2,
  timestamp: at,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [
        el(2, 'html', [
          el(3, 'head'),
          el(4, 'body', [el(5, 'main')]),
          el(6, 'div', [el(7, 'canvas')]),
          el(8, 'review-mode'),
        ]),
      ],
    },
  },
});
const mutation = (at: number, adds: unknown[], removes: unknown[] = []): RecordedEvent => ({
  type: 3,
  timestamp: at,
  data: { source: 0, texts: [], attributes: [], removes, adds },
});
const adopted = (at: number, id: number, styleIds: number[]): RecordedEvent => ({
  type: 3,
  timestamp: at,
  data: { source: 15, id, styleIds, styles: [{ styleId: styleIds[0], rules: [{ rule: '.fab svg { width: 24px }' }] }] },
});

test("what follows <body> in a snapshot goes in after it, node by node, as rrweb's rebuild puts <body> last", () => {
  const [full, after, ...rest] = new Rebuilt().take([snapshot(10)]);
  assert.equal(rest.length, 0);
  const html = (full.data as any).node.childNodes[0];
  assert.deepEqual(
    html.childNodes.map((n: any) => n.tagName),
    ['head', 'body'],
  );
  assert.equal(html.childNodes[1].childNodes[0].tagName, 'main', "the body's own content stays in it");
  assert.equal(after.timestamp, 10);
  assert.deepEqual(after.data, {
    source: 0,
    texts: [],
    attributes: [],
    removes: [],
    adds: [
      { parentId: 2, nextId: null, node: el(6, 'div', [el(7, 'canvas')]) },
      { parentId: 6, nextId: null, node: el(7, 'canvas') },
      { parentId: 2, nextId: null, node: el(8, 'review-mode') },
    ],
  });
  const plain = {
    ...snapshot(10),
    data: { node: { type: 0, id: 1, childNodes: [el(2, 'html', [el(3, 'head'), el(4, 'body')])] } },
  };
  assert.deepEqual(new Rebuilt().take([plain]), [plain], 'a page with nothing after its body is left as it is');
});

test('a shadow host moved on the page adopts its stylesheets again, once moved', () => {
  const rebuilt = new Rebuilt();
  const moved = mutation(30, [{ parentId: 9, nextId: null, node: el(8, 'review-mode') }], [{ parentId: 2, id: 8 }]);
  const elsewhere = mutation(40, [{ parentId: 9, nextId: null, node: el(20, 'div', [el(8, 'review-mode')]) }]);
  const events = rebuilt.take([
    adopted(11, 8, [2]),
    mutation(20, [{ parentId: 4, nextId: null, node: el(12, 'p') }]),
    moved,
    elsewhere,
  ]);
  const again = (at: number) => ({ type: 3, timestamp: at, data: { source: 15, id: 8, styleIds: [2] } });
  assert.deepEqual(events.slice(2), [moved, again(30), elsewhere, again(40)], 'moved itself, or inside what moved');
  assert.equal(events.length, 6, 'nothing after a mutation that moved no host');
  // a new snapshot starts afresh: its hosts adopt anew, with new style ids
  assert.deepEqual(rebuilt.take([snapshot(50), moved]).slice(2), [moved]);
});
