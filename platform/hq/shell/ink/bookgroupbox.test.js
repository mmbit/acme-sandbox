// node --test platform/hq/shell/ink/bookgroupbox.test.js   (the next scrap's place)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STACK, nextScrap } from './bookgroupbox.js';

test('the next scrap goes under the newest group, past any in its way, or at the top of an empty page', () => {
  assert.deepEqual(nextScrap([]), { x: STACK.x, y: STACK.top, w: STACK.w });
  assert.deepEqual(nextScrap([{ id: 1, box: null }]), { x: STACK.x, y: STACK.top, w: STACK.w });
  const far = { id: 1, box: { x: 40, y: 3000, w: 360, h: 200 } },
    newest = { id: 3, box: { x: 900.4, y: 100, w: 200, h: 100 } };
  assert.deepEqual(nextScrap([far, newest], 150), { x: 900, y: 232, w: STACK.w }, 'beside the newest, not the far one');
  const inWay = { id: 2, box: { x: 1000, y: 260, w: 50, h: 40 } },
    under = { id: 0, box: { x: 1100, y: 330, w: 50, h: 40 } };
  assert.equal(nextScrap([far, newest, inWay], 150).y, 332, 'past a group in its way');
  assert.equal(nextScrap([far, newest, inWay, under], 150).y, 402, 'and past the one it then meets');
  assert.equal(nextScrap([far, newest, { id: 4, box: null }], 150).y, 232, 'a group with no box is nowhere');
});
