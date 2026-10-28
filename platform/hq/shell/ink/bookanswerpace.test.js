// node --test platform/hq/shell/ink/bookanswerpace.test.js   (an answer's letters and a versions page's frames)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LETTER_MS, WHOLE_MS, frameUnder, framesLaid, lettersAt, writingMs } from './bookanswerpace.js';

test('a short answer comes a letter every LETTER_MS', () => {
  assert.equal(writingMs(20), 20 * LETTER_MS);
  assert.equal(lettersAt(0, 20), 0);
  assert.equal(lettersAt(LETTER_MS * 5, 20), 5);
  assert.equal(lettersAt(LETTER_MS * 20, 20), 20);
});

test('a long answer speeds up and is whole within WHOLE_MS', () => {
  assert.equal(writingMs(400), WHOLE_MS);
  assert.equal(lettersAt(WHOLE_MS / 2, 400), 200);
  assert.equal(lettersAt(WHOLE_MS, 400), 400);
  assert.equal(lettersAt(WHOLE_MS * 9, 400), 400);
});

test('frames sit side by side and wrap down within the width', () => {
  const { frames, height } = framesLaid(4, 700, { frame: 200, gap: 20, ratio: 0.5, caption: 40 });
  assert.deepEqual(
    frames.map(f => [f.x, f.y]),
    [
      [0, 0],
      [220, 0],
      [440, 0],
      [0, 160],
    ],
  );
  assert.equal(height, 160 * 2 - 20);
});

test('on narrow paper two frames across while each can be least wide, else one as wide as the paper', () => {
  const two = framesLaid(3, 407, { frame: 210, least: 140, gap: 22, ratio: 0.5, caption: 40 });
  assert.deepEqual(
    two.frames.map(f => [f.x, f.y, f.w]),
    [
      [0, 0, 192],
      [214, 0, 192],
      [0, 96 + 40 + 22, 192],
    ],
  );
  const { frames } = framesLaid(2, 150, { frame: 200, ratio: 0.5 });
  assert.deepEqual(
    frames.map(f => [f.x, f.y, f.w, f.h]),
    [
      [0, 0, 150, 75],
      [0, 75 + 46 + 22, 150, 75],
    ],
  );
  assert.equal(framesLaid(0, 500).height, 0);
});

test('a mark is on the frame it covers most, else the nearest', () => {
  const frames = [
    { x: 0, y: 0, w: 200, h: 150 },
    { x: 222, y: 0, w: 200, h: 150 },
    { x: 0, y: 218, w: 200, h: 150 },
  ];
  // a ring a little outside the second frame, reaching into the gaps round it
  assert.equal(frameUnder({ x0: 208, y0: -14, x1: 436, y1: 164 }, frames), 1);
  // a tick on the third's lower half
  assert.equal(frameUnder({ x0: 60, y0: 300, x1: 120, y1: 340 }, frames), 2);
  // a ring round the first that reaches over the second's edge: the first it covers most
  assert.equal(frameUnder({ x0: -10, y0: -10, x1: 240, y1: 160 }, frames), 0);
  // in the paper below them all, touching none: the nearest
  assert.equal(frameUnder({ x0: 250, y0: 400, x1: 300, y1: 420 }, frames), 2);
  assert.equal(frameUnder({ x0: 0, y0: 0, x1: 1, y1: 1 }, []), -1);
});
