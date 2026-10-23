import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bars, lineGraph, compact, BAR_MIN_PX } from './stats.js';

test('a bar per value: the last now, one not counted yet a stub, the highest the top', () => {
  const svg = bars([null, 2, 4], { width: 30, height: 20 });
  const rects = [...svg.matchAll(/<rect ([^>]*)>/g)].map(match => match[1]);
  assert.equal(rects.length, 3);
  assert.match(rects[0], /class="none"/);
  assert.match(rects[0], new RegExp(`height="${BAR_MIN_PX}.0"`));
  assert.match(rects[1], /height="10.0"/);
  assert.match(rects[2], /height="20.0" .*class="now"/);
  assert.equal([...bars([null, 1], { stubs: false }).matchAll(/<rect/g)].length, 1);
  assert.equal(bars([]), '');
});

test('tips name each bar, escaped, and a bar row without them is hidden from screen readers', () => {
  assert.match(bars([1, 2], { tips: ['Mon: <1>', 'Today'] }), /<title>Mon: &lt;1&gt;<\/title>/);
  assert.match(bars([1, 2]), /aria-hidden="true"/);
  assert.match(bars([50], { scale: 100, height: 20 }), /height="10.0"/);
});

test('a line per series in the graph’s own percentages, ending on a dot, clamped to its scale', () => {
  const svg = lineGraph([
    { name: 'cpu', values: [0, 50, 150] },
    { name: 'gpu', values: [7] },
  ]);
  assert.doesNotMatch(svg, /viewBox/);
  assert.doesNotMatch(svg, /gpu/);
  assert.match(svg, /<g class="cpu"><line x1="0.00%" y1="100.00%" x2="50.00%" y2="50.00%"\/>/);
  assert.match(svg, /<circle cx="100.00%" cy="0.00%" r="4"\/>/);
  assert.equal(lineGraph([{ name: 'cpu', values: [3] }]), '');
});

test('a count made short', () => {
  assert.deepEqual([940, 1234, 12_900].map(compact), ['940', '1.2k', '13k']);
});
