// book-check.mjs's call story's small call under the pen (bookcall.mjs, shell/callbubble.js, shared/review/pencil.js).
// The minimised call is no page to write on: the pen drags it to another corner and taps it open, never inking, and in
// a corner it keeps clear of HQ's zoom buttons. The pen tells the line it's down and lifted only while the screen is
// shown, and never for the bubble.
import assert from 'node:assert/strict';

const notes = s => s.posts.filter(p => p.path === '/api/book/note').length;
const pens = s => s.line.said.filter(e => e.type === 'pen').map(e => e.down);

// s: bookcall.mjs's story state, its screen shown (askToSee)
export async function penOnTheBubble(s) {
  const { page } = s,
    before = notes(s);
  assert.deepEqual(pens(s), [], 'before Show the pen told the line nothing');
  assert.equal(await clear(page), true, "the bubble's corner is clear of the zoom buttons");
  const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
  assert.equal(await dragTo(s, [60, 60]), 'top-left', 'the pen drags the bubble');
  await page.waitForTimeout(2000); // (a mark would have gone in by now: callnotes.js)
  assert.equal(notes(s), before, 'no ink on the bubble');
  assert.deepEqual(pens(s), [], 'a pen on the bubble is no drawing');
  const b = await page.locator('.callbubble .cb-face').boundingBox();
  await s.pen([[b.x + b.width / 2, b.y + b.height / 2]]);
  await page.waitForSelector('#call-layer', { state: 'visible', timeout: 3000 });
  await page.click('#call-min');
  await page.waitForSelector('#call-layer', { state: 'hidden', timeout: 3000 });
  assert.equal(await dragTo(s, [w - 60, h - 60]), 'bottom-right');
  assert.equal(await clear(page), true, 'back in its corner, clear of the zoom buttons');
  await penHeard(s, w, before);
}

// Shown now: a line on the page goes to the line as the pen's down and lift, and makes its note
async function penHeard(s, w, before) {
  await s.pen(
    Array.from({ length: 10 }, (_, i) => [w / 2 + i * 6, 120]),
    { lift: false },
  );
  await s.page.evaluate(() => window.__lift());
  assert.deepEqual(pens(s), [true, false], "the pen's down and lift on the page went to the line");
  for (let i = 0; i < 40 && notes(s) === before; i++) await s.page.waitForTimeout(100);
  assert.equal(notes(s), before + 1, 'that line made its note');
}

const clear = page =>
  page.evaluate(() => {
    const a = document.querySelector('.callbubble').getBoundingClientRect(),
      z = document.querySelector('#zoom').getBoundingClientRect();
    return !(a.left < z.right && z.left < a.right && a.top < z.bottom && z.top < a.bottom);
  });
// The pen from the bubble's face to there, then its spring: the corner it settled in
async function dragTo(s, [x, y]) {
  const b = await s.page.locator('.callbubble .cb-face').boundingBox(),
    [x0, y0] = [b.x + b.width / 2, b.y + b.height / 2];
  await s.pen(Array.from({ length: 16 }, (_, i) => [x0 + ((x - x0) * i) / 15, y0 + ((y - y0) * i) / 15]));
  await s.page.waitForTimeout(1000);
  return s.page.evaluate(() => localStorage.getItem('callCorner'));
}
