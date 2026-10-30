// node --test platform/hq/shell/ink/notebookstack.test.js   (where a notebook's new things land: pure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, footprint, landingPage, nextScrap, scrapSize, slipsUnder, STACK } from './notebookstack.js';

const page = (id, created, more = {}) => ({ id, created, archived: 0, send_at: null, tries: null, ...more });
const sent = p => p.send_at !== null;

test('new groups land on the newest page neither sent, archived nor a try’s versions page', () => {
  const pages = [
    page(1, '2026-10-01T09:00:00.000Z'),
    page(2, '2026-10-02T09:00:00.000Z'),
    page(3, '2026-10-03T09:00:00.000Z', { tries: 40 }),
    page(4, '2026-10-04T09:00:00.000Z', { archived: 1 }),
    page(5, '2026-10-05T09:00:00.000Z', { send_at: 1_800_000_000_000 }),
  ];
  assert.equal(landingPage(pages, sent)?.id, 2);
  // (made in the same millisecond: the later id)
  assert.equal(landingPage([...pages, page(6, '2026-10-02T09:00:00.000Z')], sent)?.id, 6);
  // (a summary, as HQ reads it: sending or sent, and no tries on the play's)
  const summaries = [
    { id: 7, created: '2026-10-01T09:00:00.000Z', archived: false, sending: false, sent: null },
    { id: 8, created: '2026-10-02T09:00:00.000Z', archived: false, sending: true, sent: null },
  ];
  assert.equal(landingPage(summaries, p => p.sending || !!p.sent)?.id, 7);
  assert.equal(landingPage(pages.slice(2), sent), undefined);
});

test("a group's box holds its strokes' width, its words' lines and its pictures", () => {
  const stroke = {
    size: 4,
    points: [
      [10, 20, 0.5, 0],
      [50, 60, 0.5, 16],
    ],
  };
  const text = { x: 100, y: 0, w: 80, text: 'two\nlines' },
    picture = { file: '1-g-00000000.png', x: -20, y: 30, w: 40, h: 10, tilt: 0 };
  assert.equal(boxOf({ ink: [], texts: [], pictures: [] }), null);
  assert.deepEqual(boxOf({ ink: [stroke] }), { x: 8, y: 18, w: 44, h: 44 });
  assert.deepEqual(boxOf({ ink: [stroke], texts: [text], pictures: [picture] }), { x: -20, y: 0, w: 200, h: 62 });
});

test('the next scrap goes under the newest group, past any in its way, or at the top of an empty page', () => {
  assert.deepEqual(nextScrap([]), { x: STACK.x, y: STACK.top, w: STACK.w });
  assert.deepEqual(nextScrap([{ id: 1, box: null }]), { x: STACK.x, y: STACK.top, w: STACK.w });
  const far = { id: 1, box: { x: 40, y: 3000, w: 360, h: 200 } },
    newest = { id: 3, box: { x: 900.4, y: 100, w: 200, h: 100 } };
  assert.deepEqual(nextScrap([far, newest], 150), { x: 900, y: 248, w: STACK.w }, 'beside the newest, not the far one');
  const inWay = { id: 2, box: { x: 1000, y: 260, w: 50, h: 40 } },
    under = { id: 0, box: { x: 1100, y: 330, w: 50, h: 40 } };
  assert.equal(nextScrap([far, newest, inWay], 150).y, 348, 'past a group in its way');
  assert.equal(nextScrap([far, newest, inWay, under], 150).y, 418, 'and past the one it then meets');
  assert.equal(nextScrap([far, newest, { id: 4, box: null }], 150).y, 248, 'a group with no box is nowhere');
});

test("a scrap's post-it words are part of it: the next one goes a clear gap under them", () => {
  const box = { x: 40, y: 80, w: 360, h: 200 },
    bare = footprint({ kind: 'scrap', words: '', box });
  assert.deepEqual(bare, box, 'no words, the picture alone');
  const one = footprint({ kind: 'scrap', words: 'The basket hides', box }),
    three = footprint({ kind: 'scrap', words: 'word '.repeat(50), box });
  assert.ok(one.h > box.h + 40 && one.h < box.h + 60, `a line of words under it: ${one.h}`);
  assert.ok(three.h > one.h + 35, 'more lines, taller');
  assert.deepEqual(footprint({ kind: 'note', words: 'x', box }), box, "only a scrap's words hang under it");
  const next = nextScrap([{ id: 1, kind: 'scrap', words: 'The basket hides', box }], 100);
  assert.equal(next.y, Math.round(one.y + one.h + STACK.gap), 'under the words, a gap clear');
  // (a narrow picture's words are wider than it, as wide as the stack)
  assert.equal(footprint({ kind: 'scrap', words: 'a', box: { ...box, w: 120 } }).w, STACK.w);
});

test("a call's page lays its notes in two columns, each next under the shorter one", () => {
  const second = STACK.x + STACK.w + STACK.gap;
  const spots = [];
  const groups = [];
  for (const [i, h] of [200, 120, 80, 300, 60].entries()) {
    const spot = nextScrap(groups, h, 'call');
    spots.push(spot);
    groups.push({ id: i + 1, kind: 'scrap', words: '', box: { x: spot.x, y: spot.y, w: STACK.w, h } });
  }
  assert.deepEqual(
    spots.map(s => [s.x, s.y]),
    [
      [STACK.x, STACK.top],
      [second, STACK.top],
      [second, STACK.top + 120 + STACK.gap],
      [STACK.x, STACK.top + 200 + STACK.gap],
      [second, STACK.top + 120 + 80 + 2 * STACK.gap],
    ],
    'the leftmost of equals, then the shorter column',
  );
  for (const a of groups)
    for (const b of groups)
      if (a !== b)
        assert.ok(
          a.box.x + a.box.w <= b.box.x ||
            b.box.x + b.box.w <= a.box.x ||
            a.box.y + a.box.h <= b.box.y ||
            b.box.y + b.box.h <= a.box.y,
          `#${a.id} and #${b.id} don't overlap`,
        );
  // (what the board drew in a column counts: the next goes under it)
  const drawn = { id: 9, kind: 'drawing', box: { x: second + 100, y: 600, w: 80, h: 80 } };
  assert.deepEqual(nextScrap([drawn], 50, 'call'), { x: STACK.x, y: STACK.top, w: STACK.w });
  assert.equal(nextScrap([{ id: 1, box: { x: STACK.x, y: STACK.top, w: 360, h: 900 } }, drawn], 50, 'call').y, 728);
  // (any other page keeps one column: under the newest)
  assert.equal(nextScrap(groups, 50).x, groups.at(-1).box.x);
});

// (the board, call 162)
test("a scrap's picture as wide as it was cut, at most the stack's width; a tall crop shorter, but still readable", () => {
  assert.deepEqual(scrapSize(240, 150), { w: 240, h: 150 }, 'as cut');
  assert.deepEqual(scrapSize(720, 360), { w: STACK.w, h: 157 }, 'a wide one at the stack width');
  const tall = scrapSize(390, 900);
  assert.ok(tall.h <= 470 && tall.h < (900 * STACK.w) / 390, `shorter than its width would make it: ${tall.h}`);
  const tower = scrapSize(390, 3000),
    fit = STACK.w / 390;
  assert.ok(Math.abs(tower.w / 390 - fit * 0.6) < 0.01, `a tower scaled no less than readable: ${tower.w}`);
});

test("what's slipped under a group: a reply matched only by the answer it answers, never by its own id", () => {
  const children = [
    { id: 7, kind: 'answer' },
    { id: 8, kind: 'answer', spot: { dx: 0, dy: 0, w: 200 } },
    { id: 9, kind: 'answer', style: 'version' },
    { id: 8, kind: 'reply', answers: 7 },
    { id: 30, kind: 'reply', answers: 8 },
    { id: 31, kind: 'reply', answers: 9 },
    { id: 32, kind: 'reply', answers: null },
  ];
  assert.deepEqual(
    slipsUnder(children).map(c => `${c.kind} ${c.id}`),
    ['answer 7', 'reply 8', 'reply 32'],
    "the slipped answer, its reply (whose id is a placed answer's) and a loose reply; not what's written in",
  );
});
