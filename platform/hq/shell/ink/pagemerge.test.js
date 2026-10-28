// node --test platform/hq/shell/ink/pagemerge.test.js   (a page's ink and pictures merged three ways; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merged, mergedScraps } from './pagemerge.js';

const line = (x, color = '#2a2352') => ({
  color,
  size: 3,
  points: [
    [x, 10, 0.5, 0],
    [x + 5, 20, 0.5, 16],
  ],
});

test("both sides' new strokes are kept, each side's own objects in place, and nothing comes twice", () => {
  const a = line(1),
    b = line(2),
    mine = line(3),
    theirs = line(4, '#d9480f');
  const base = [a, b],
    out = merged(base, [a, b, mine], [line(1), line(2), theirs]);
  assert.deepEqual(out, [a, b, theirs, mine]);
  assert.equal(out[0], a, 'the same stroke is this side’s object, so its undo still finds it');
  assert.deepEqual(merged(base, [a, b], [a, b]), [a, b]);
});

test('a stroke taken off on either side stays off; one taken off on both is gone once', () => {
  const [a, b, c] = [line(1), line(2), line(3)];
  assert.deepEqual(merged([a, b, c], [a, c], [a, b, c, line(4, '#1971c2')]), [a, c, line(4, '#1971c2')], 'my undo');
  assert.deepEqual(merged([a, b, c], [a, b, c, line(5)], [a, c]), [a, c, line(5)], 'their eraser');
  assert.deepEqual(merged([a, b], [a], [a]), [a]);
});

test('a picture moved on one side lands where it was moved; on both, where this side put it', () => {
  const at = (file, x) => ({ file, x, y: 0, w: 100, h: 80, tilt: 0 });
  const base = [at('p.png', 0), at('q.png', 0)];
  assert.deepEqual(mergedScraps(base, base, [at('p.png', 50), at('q.png', 0)]), [at('p.png', 50), at('q.png', 0)]);
  assert.deepEqual(mergedScraps(base, [at('p.png', 0), at('q.png', 9)], base), [at('p.png', 0), at('q.png', 9)]);
  assert.deepEqual(mergedScraps(base, [at('p.png', 7), at('q.png', 0)], [at('p.png', 50), at('q.png', 0)]), [
    at('q.png', 0),
    at('p.png', 7),
  ]);
});
