// node --test shared/watchalong/strokes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inks, inkAt } from './strokes.js';

const stroke = color => ({
  color,
  size: 5,
  points: [
    [20, 30, 0.5, 0],
    [80, 90, 0.5, 100],
  ],
});
const ink = (timestamp, payload) => ({ type: 5, timestamp, data: { tag: 'ink', payload: { id: 1, ...payload } } });

test('a dry canvas replaces its ink with fewer lines or none, even without canvas pictures', () => {
  for (const canvas of [-1, 12]) {
    const first = stroke('#d0443a'),
      second = stroke('#2f6bdc');
    const events = [
      ink(1, { phase: 'end', n: 1, stroke: first }),
      ink(2, { phase: 'shown', canvas, strokes: [first] }),
      ink(3, { phase: 'end', n: 2, stroke: second }),
      ink(4, { phase: 'shown', canvas, strokes: [first, second] }),
      ink(5, { phase: 'shown', canvas, strokes: [second] }),
      ink(6, { phase: 'shown', canvas, strokes: [] }),
    ];
    const live = new Inks();
    events.slice(0, -1).forEach(event => live.add(event));
    assert.deepEqual(
      live.shown.map(s => s.stroke),
      [second],
    );
    live.add(events.at(-1));
    assert.deepEqual(live.shown, []);
    assert.deepEqual(
      inkAt(events, 5).map(s => s.stroke.color),
      [second.color],
    );
    assert.deepEqual(inkAt(events, 6), []);
  }
});
