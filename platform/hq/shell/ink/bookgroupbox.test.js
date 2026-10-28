// node --test platform/hq/shell/ink/bookgroupbox.test.js   (the next scrap's place)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STACK, nextScrap } from './bookgroupbox.js';

test('the next scrap goes under the foot of the groups, or under the heading of an empty page', () => {
  assert.deepEqual(nextScrap([]), { x: STACK.x, y: STACK.top, w: STACK.w });
  const groups = [
    { box: { x: 40, y: 32, w: 360, h: 200 } },
    { box: { x: 600, y: 10, w: 10, h: 400.4 } },
    { box: null },
  ];
  assert.equal(nextScrap(groups).y, 442);
});
