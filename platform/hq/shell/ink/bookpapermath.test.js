// node --test platform/hq/shell/ink/bookpapermath.test.js   (the paper effects' numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALL,
  FIBRE_PX,
  LETTER_MS,
  TEAR_PX,
  WRITTEN_MS,
  crumpleOutline,
  letterStep,
  tornOutline,
  wrapLines,
} from './bookpapermath.js';

test('words are written a letter at a time, quickly, and a long line still finishes in time', () => {
  assert.equal(letterStep(8), LETTER_MS, 'a short answer at the pen’s own pace');
  for (const count of [24, 25, 100, 2000]) {
    const step = letterStep(count);
    assert.ok(step <= LETTER_MS);
    assert.ok(step * count <= WRITTEN_MS + 1e-9, `${count} letters done in ${step * count} ms`);
  }
  assert.equal(letterStep(0), 0, 'nothing to write');
});

test('a sheet balls up from its own edge to a jagged ball about its middle, the same way each time', () => {
  const flat = crumpleOutline(0, 7);
  for (const [x, y] of flat)
    assert.ok(
      [x, y].some(v => v === 0 || v === 100),
      `(${x}, ${y}) on the sheet's edge`,
    );
  const ball = crumpleOutline(1, 7),
    radii = ball.map(([x, y]) => Math.hypot(x - 50, y - 50));
  assert.ok(Math.max(...radii) <= BALL / 2 + 1e-9, 'the ball well inside the sheet');
  assert.ok(Math.max(...radii) - Math.min(...radii) > 2, 'its edge folds in and out, never a circle');
  assert.deepEqual(crumpleOutline(1, 7), ball, 'the same seed, the same ball');
  assert.notDeepEqual(crumpleOutline(1, 8), ball, 'another seed, another ball');
  const half = crumpleOutline(0.5, 7);
  half.forEach(([x, y], i) => {
    assert.ok(Math.abs(x - (flat[i][0] + ball[i][0]) / 2) < 1e-9 && Math.abs(y - (flat[i][1] + ball[i][1]) / 2) < 1e-9);
  });
});

test('a page tears out along its spine, jagged, the tear running down as it goes, its corner kept', () => {
  const [w, h, ear] = [150, 200, 14],
    px = points => points.map(([x, y]) => [(x * w) / 100, (y * h) / 100]),
    torn = px(tornOutline(w, h, { seed: 3, ear })),
    edge = torn.slice(3, -2);
  assert.deepEqual(
    torn.slice(0, 3),
    [
      [0, 0],
      [w - ear, 0],
      [w, ear],
    ],
    'the top and its turned corner whole',
  );
  assert.ok(edge.length > 20, 'ragged a few px apart down the spine');
  for (const [x] of edge)
    assert.ok(x < w && x >= w - FIBRE_PX - TEAR_PX - 1e-9, `${x}: torn, never deeper than the tear`);
  const depths = edge.map(([x]) => w - x);
  assert.ok(Math.max(...depths) - Math.min(...depths) > TEAR_PX / 2, 'in and out: jagged, never a straight cut');
  const whole = px(tornOutline(w, h, { t: 0, seed: 3, ear }));
  assert.equal(whole.length, torn.length, 'as many points at every t, so it moves smoothly');
  for (const [x] of whole.slice(3, -2)) assert.equal(x, w, 'not yet torn: the edge straight');
  const half = px(tornOutline(w, h, { t: 0.5, seed: 3, ear })).slice(3, -2);
  assert.ok(half[0][0] < w && half.at(-1)[0] === w, 'half way: torn at the top, whole at the foot');
  const fibres = px(tornOutline(w, h, { seed: 3, ear, fibres: true })).slice(3, -2);
  fibres.forEach(([x], i) =>
    assert.ok(x >= edge[i][0] && x <= edge[i][0] + FIBRE_PX + 1e-9, 'fibres just past the paper'),
  );
  assert.notDeepEqual(tornOutline(w, h, { seed: 4, ear }), tornOutline(w, h, { seed: 3, ear }), 'never two alike');
});

test('words wrap at the box’s width, keep their line breaks, and a word too long for it breaks', () => {
  const measure = s => s.length * 10;
  assert.deepEqual(wrapLines('the price bigger please', 100, measure), ['the price', 'bigger', 'please']);
  assert.deepEqual(wrapLines('one\ntwo three', 100, measure), ['one', 'two three']);
  assert.deepEqual(wrapLines('abcdefghijklmnopqrstuvw', 100, measure), ['abcdefghij', 'klmnopqrst', 'uvw']);
  assert.deepEqual(wrapLines('', 100, measure), ['']);
});
