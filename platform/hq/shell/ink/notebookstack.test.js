// node --test platform/hq/shell/ink/notebookstack.test.js   (where a notebook's new things land: pure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, landingPage, scrapSize, slipsUnder, STACK, TALL } from './notebookstack.js';

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

test("a scrap's picture as wide as it was cut, at most the stack's width; a tall crop at most TALL.h, however narrow", () => {
  assert.deepEqual(scrapSize(240, 150), { w: 240, h: 150 }, 'as cut');
  assert.deepEqual(scrapSize(720, 360), { w: STACK.w, h: 157 }, 'a wide one at the stack width');
  assert.deepEqual(scrapSize(390, 900), { w: 139, h: TALL.h }, 'a tall one at the cap');
  assert.deepEqual(scrapSize(80, 1133), { w: 23, h: TALL.h }, "a strip of HQ's keys, top to bottom, at the cap too");
});

test("what's slipped under a group: a reply matched only by the answer it answers, never by its own id", () => {
  const children = [
    { id: 7, kind: 'answer' },
    { id: 8, kind: 'answer', style: 'version' },
    { id: 9, kind: 'answer' },
    { id: 8, kind: 'reply', answers: 7 },
    { id: 30, kind: 'reply', answers: 8 },
    { id: 31, kind: 'reply', answers: 9 },
    { id: 32, kind: 'reply', answers: null },
  ];
  assert.deepEqual(
    slipsUnder(children).map(c => `${c.kind} ${c.id}`),
    ['answer 7', 'answer 9', 'reply 8', 'reply 31', 'reply 32'],
    "every answer but a version, their replies (one's id a version's) and a loose reply",
  );
});
