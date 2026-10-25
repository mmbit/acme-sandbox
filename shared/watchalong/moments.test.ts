// node --test shared/watchalong/moments.test.ts  .
// A walk-through recorded with watchalong.js in Chromium (walk.test.json.gz: a guest on a shop page types a name, taps
// Add twice, reads, scrolls, pauses and resumes, goes to the basket and taps Pay), and streams made up for one rule each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Moments, lines, DWELL_MS } from './moments.ts';
import type { RecordedEvent } from './store.ts';

const BATCHES = JSON.parse(
  gunzipSync(readFileSync(new URL('walk.test.json.gz', import.meta.url))).toString('utf8'),
) as RecordedEvent[][];
const START = BATCHES[0][0].timestamp;
const since = (at: number) => `+${((at - START) / 1000).toFixed(1)}s`;
const folded = (batches: RecordedEvent[][], until = Infinity) => {
  const moments = new Moments();
  for (const batch of batches) moments.add(batch);
  moments.settle(until);
  return moments;
};

test('a recorded walk-through folds into its moments, in order, with what was typed never in them', () => {
  const moments = folded(BATCHES);
  assert.deepEqual(lines(moments.list, since), [
    '#1 +0.0s on /',
    '#2 +1.6s tapped "Name on the mug" (input text)',
    '#3 +4.7s typed 10 characters in "Name on the mug"',
    '#4–5 +4.7s tapped "Add to basket" (button) (×2)',
    '#6 +9.4s still for 4 s on a changed screen',
    '#7 +10.4s scrolled the page down 900 px',
    '#8 +11.6s paused showing the screen',
    '#9 +12.8s showed the screen again',
    '#10 +13.6s scrolled the page up 900 px',
    '#11 +14.9s on /basket.html',
    '#12 +16.7s tapped "Pay" (button)',
  ]);
  assert.equal(moments.list[3].x !== undefined && moments.list[3].y !== undefined, true, 'a tap keeps its place');
  assert.equal(moments.paused, false);
});

test('folded a batch at a time, a live stream says only what has settled, and numbers never move', () => {
  const moments = new Moments();
  const seen: string[] = [];
  for (const batch of BATCHES) {
    moments.add(batch);
    moments.settle(batch.at(-1)!.timestamp);
    for (const moment of moments.after(seen.length)) seen.push(`#${moment.n} ${moment.words}`);
  }
  moments.settle(Infinity);
  const whole = folded(BATCHES).list.map(moment => `#${moment.n} ${moment.words}`);
  assert.deepEqual(seen, whole.slice(0, seen.length));
  assert.deepEqual(
    moments.list.map(moment => `#${moment.n} ${moment.words}`),
    whole,
  );
});

test('paused until resumed', () => {
  const upToPause = BATCHES.flat().findIndex(event => event.type === 5 && event.data.tag === 'paused');
  const moments = folded([BATCHES.flat().slice(0, upToPause + 1)]);
  assert.equal(moments.paused, true);
  assert.equal(moments.list.at(-1)!.words, 'paused showing the screen');
});

// A page of a field with a label, made up: a snapshot, then whatever comes
const at = (ms: number) => START + ms;
const page = (ms = 0): RecordedEvent[] => [
  { type: 4, timestamp: at(ms), data: { href: 'https://hq.test/', width: 800, height: 600 } },
  {
    type: 2,
    timestamp: at(ms),
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        id: 1,
        type: 0,
        childNodes: [
          {
            id: 2,
            type: 2,
            tagName: 'label',
            attributes: { for: 'email' },
            childNodes: [{ id: 3, type: 3, textContent: 'Your email' }],
          },
          { id: 4, type: 2, tagName: 'input', attributes: { id: 'email', type: 'email' }, childNodes: [] },
          {
            id: 5,
            type: 2,
            tagName: 'input',
            attributes: { type: 'checkbox', 'aria-label': 'Gift wrap' },
            childNodes: [],
          },
        ],
      },
    },
  },
];
const typing = (ms: number, text: string): RecordedEvent => ({
  type: 3,
  timestamp: at(ms),
  data: { source: 5, id: 4, text },
});
const tap = (ms: number, label: string): RecordedEvent => ({
  type: 5,
  timestamp: at(ms),
  data: { tag: 'tap', payload: { x: 10, y: 20, role: 'button', label } },
});

test('typing settles once it stops, says how much and where, and never what', () => {
  const live = new Moments();
  live.add([...page(), typing(100, '*'), typing(400, '****'), typing(700, '*******')]);
  live.settle(at(1000));
  assert.equal(live.list.length, 0, 'still typing');
  live.settle(at(700 + 1500));
  assert.deepEqual(
    live.list.map(moment => moment.words),
    ['typed 7 characters in "Your email"'],
  );
  const shown = folded([
    [
      ...page(),
      typing(100, 'jo@x.test'),
      { ...typing(200, ''), data: { source: 5, id: 5, text: '', isChecked: true } },
    ],
  ]);
  assert.deepEqual(
    shown.list.map(moment => moment.words),
    ['typed 9 characters in "Your email"', 'ticked "Gift wrap"'],
  );
  assert.ok(!JSON.stringify(shown.list).includes('jo@x'), 'a value typed never goes in a moment');
});

test('the same tap again is one line, counted; a dwell comes only after the screen changed and stayed still', () => {
  const change = (ms: number): RecordedEvent => ({
    type: 3,
    timestamp: at(ms),
    data: { source: 0, adds: [], removes: [], texts: [{ id: 3, value: 'Saved' }], attributes: [] },
  });
  const moments = folded([
    [...page(), tap(100, 'Save'), tap(300, 'Save'), tap(500, 'Save'), change(600), tap(600 + DWELL_MS + 100, 'Done')],
  ]);
  assert.deepEqual(lines(moments.list, since), [
    '#1–3 +0.1s tapped "Save" (button) (×3)',
    '#4 +4.6s still for 4 s on a changed screen',
    '#5 +4.7s tapped "Done" (button)',
  ]);
  const restless = folded([[...page(), tap(100, 'Save'), change(200), tap(1000, 'Save again')]]);
  assert.ok(!restless.list.some(moment => moment.kind === 'dwell'), 'a tap before the 4 s: no dwell');
});

test('a tap again in the next batch is a moment of its own, so the agent that had the first still hears of it', () => {
  const moments = new Moments();
  moments.add([...page(), tap(100, 'Save')]);
  const seen = moments.list.at(-1)!.n;
  moments.add([tap(300, 'Save')]);
  assert.deepEqual(lines(moments.after(seen), since), ['#2 +0.3s tapped "Save" (button)']);
  assert.deepEqual(lines(moments.list, since), ['#1–2 +0.1s tapped "Save" (button) (×2)']);
});

// rrweb's mutation: removes, then adds (a node moved is removed and added again), then texts
const mutation = (ms: number, change: { removes?: object[]; adds?: object[]; texts?: object[] }): RecordedEvent => ({
  type: 3,
  timestamp: at(ms),
  data: { source: 0, removes: [], adds: [], texts: [], attributes: [], ...change },
});
const fieldNamed = (events: RecordedEvent[]) => {
  const moments = folded([[...page(), ...events, typing(5000, '**')]]);
  return moments.list.at(-1)!.words;
};

test("a field's name follows its label as the page re-renders and moves things", () => {
  const label = (id: number, words: string, inside = 1) => ({
    parentId: inside,
    nextId: null,
    node: {
      id,
      type: 2,
      tagName: 'label',
      attributes: { for: 'email' },
      childNodes: [{ id: id + 1, type: 3, textContent: words }],
    },
  });
  // the label re-rendered inside a box, then the box replaced by a new label: the old one goes with its box
  const boxed = mutation(50, {
    removes: [{ parentId: 1, id: 2 }],
    adds: [
      { parentId: 1, nextId: null, node: { id: 30, type: 2, tagName: 'div', attributes: {}, childNodes: [] } },
      label(31, 'Old words', 30),
    ],
  });
  const replaced = mutation(100, { removes: [{ parentId: 1, id: 30 }], adds: [label(40, 'Email for the receipt')] });
  assert.equal(fieldNamed([boxed, replaced]), 'typed 2 characters in "Email for the receipt"');
  // the label's words moved within it (removed and added again, the same node): said once
  const moved = mutation(100, {
    removes: [{ parentId: 2, id: 3 }],
    adds: [{ parentId: 2, nextId: null, node: { id: 3, type: 3, textContent: 'Your email' } }],
  });
  assert.equal(fieldNamed([moved]), 'typed 2 characters in "Your email"');
});

test('typing still going on when the next page comes is told with its field named', () => {
  const next: RecordedEvent = { type: 2, timestamp: at(400), data: { node: { id: 50, type: 0, childNodes: [] } } };
  const moments = folded([[...page(), typing(100, '***'), next]]);
  assert.deepEqual(
    moments.list.map(moment => moment.words),
    ['typed 3 characters in "Your email"'],
  );
});

test("a pen stroke says its shape and what's under it, by the names the page gave", () => {
  const ink = (at: number, payload: Record<string, unknown>): RecordedEvent => ({
    type: 5,
    timestamp: at,
    data: { tag: 'ink', payload: { phase: 'end', n: at, id: 1, left: 0, top: 0, ...payload } },
  });
  const loop = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 23) * 2 * Math.PI;
    return [200 + 80 * Math.cos(a), 100 + 30 * Math.sin(a), 0.5, i * 16];
  });
  const stroke = (points: number[][]) => ({ color: '#ff5a5f', size: 5, points });
  const button = [{ role: 'button', label: 'Add to basket' }];
  const moments = folded([
    [
      ink(1000, { stroke: stroke(loop), under: button }),
      ink(2000, {
        stroke: stroke([
          [10, 50, 0.5, 0],
          [180, 54, 0.5, 300],
        ]),
        under: [{ role: 'p', label: '€24' }],
      }),
      ink(3000, {
        stroke: stroke([
          [0, 0, 0.5, 0],
          [90, 0, 0.5, 9],
          [90, 40, 0.5, 9],
          [0, 40, 0.5, 9],
          [0, 0, 0.5, 9],
        ]),
        under: [],
      }),
      ink(4000, {
        stroke: stroke([
          [0, 0, 0.5, 0],
          [60, 70, 0.5, 90],
        ]),
        under: [...button, { role: 'a', label: 'Basket' }],
      }),
      ink(5000, { stroke: stroke(loop), under: [{ role: 'input text', label: '' }] }),
    ],
  ]);
  assert.deepEqual(
    moments.list.map(moment => moment.words),
    [
      'circled "Add to basket" (button)',
      'drew a line under "€24" (p)',
      'drew a box',
      'drew on "Add to basket" (button) and "Basket" (a)',
      'drew a circle',
    ],
  );
});
