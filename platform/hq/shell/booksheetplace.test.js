// node --test platform/hq/shell/booksheetplace.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joined,
  leftOf,
  notesOnPages,
  pageSends,
  planeSheet,
  reordered,
  sendOrder,
  sentLine,
  slotAt,
} from './booksheetplace.js';

const note = (id, page, n, status = 'open') => ({ id, page, n, status });
const pages = [
  { id: 1, kind: 'sheet', owner: 'lark' },
  { id: 2, kind: 'free', owner: null },
  { id: 3, kind: 'sheet', owner: 'juno' },
  { id: 4, kind: 'sheet', owner: 'kit' },
];

test("each sheet page shows its owner's notes, sent first, then open, each in its sheet's order", () => {
  const sent = { id: 9, owner: 'lark', status: 'sent', notes: [note(90, 1, 1, 'sent')] };
  const open = { id: 10, owner: 'lark', status: 'open', notes: [note(101, 1, 2), note(100, 1, 1)] };
  const on = notesOnPages({ open: [open], sent: [sent] }, pages, 'juno');
  assert.deepEqual(
    on.get(1).map(g => [g.sheet.id, g.notes.map(x => x.note.id)]),
    [
      [9, [90]],
      [10, [100, 101]],
    ],
  );
  assert.deepEqual(on.get(3), []);
  assert.equal(on.has(2), false, 'a free page shows no notes');
});

test("nobody's sheet is the CEO's page's; a moved note shows on its new owner's page, or stays tagged with its owner", () => {
  const nobodys = { id: 11, owner: null, status: 'open', notes: [note(110, 3, 1)] };
  const kits = { id: 12, owner: 'kit', status: 'open', notes: [note(120, 1, 1)] };
  const wrens = { id: 13, owner: 'wren', status: 'open', notes: [note(130, 1, 1)] };
  const on = notesOnPages({ open: [nobodys, kits, wrens] }, pages, 'juno');
  assert.deepEqual(
    on.get(3).map(g => g.notes.map(x => x.note.id)),
    [[110]],
  );
  assert.deepEqual(
    on.get(4).map(g => g.notes.map(x => [x.note.id, x.away])),
    [[[120, null]]],
  );
  assert.deepEqual(
    on.get(1).map(g => g.notes.map(x => [x.note.id, x.away])),
    [[[130, 'wren']]],
  );
});

test("the plane sends the page owner's open batch; a free page's sends are its own", () => {
  const oneOff = { id: 20, owner: 'lark', status: 'sending', page: 2, notes: [note(200, 2, 1)] };
  const larks = { id: 21, owner: 'lark', status: 'open', notes: [note(210, 1, 1)] };
  const shown = notesOnPages({ open: [oneOff, larks] }, pages, 'juno');
  assert.equal(planeSheet({ open: [oneOff, larks] }, pages[0], 'juno', shown.get(1)).id, 21);
  assert.equal(planeSheet({ open: [oneOff, larks] }, pages[0], 'juno', []), null, 'only on a page with its notes');
  assert.equal(planeSheet({ open: [oneOff] }, pages[0], 'juno', shown.get(1)), null);
  const gone = { id: 19, owner: 'kit', status: 'sent', page: 2, notes: [] };
  assert.deepEqual(pageSends({ open: [oneOff, larks], sent: [gone] }, 2), { sending: oneOff, sent: gone });
});

test('the seconds to undo run from 1 to 0; Sent says the time, and the day when not today', () => {
  assert.equal(leftOf(10_000, 0, 10_000), 1);
  assert.equal(leftOf(10_000, 7_500, 10_000), 0.25);
  assert.equal(leftOf(10_000, 12_000, 10_000), 0);
  const now = new Date(2026, 9, 26, 9, 0);
  assert.equal(sentLine(new Date(2026, 9, 26, 8, 16).toISOString(), now), 'Sent 08:16');
  assert.equal(sentLine(new Date(2026, 9, 25, 18, 40).toISOString(), now), 'Sent 25 Oct 18:40');
});

test('a lifted note lands between the others; the sheet keeps its notes on other pages where they are', () => {
  assert.equal(slotAt([50, 150, 250], 10), 0);
  assert.equal(slotAt([50, 150, 250], 200), 2);
  assert.equal(slotAt([50, 150, 250], 900), 3);
  // the sheet: 1 2 3 4 5, this page shows 2 3 4
  assert.deepEqual(reordered([1, 2, 3, 4, 5], [2, 3, 4], 4, 0), [1, 4, 2, 3, 5]);
  assert.deepEqual(reordered([1, 2, 3, 4, 5], [2, 3, 4], 2, 2), [1, 3, 4, 2, 5]);
  assert.deepEqual(reordered([1, 2, 3], [1, 2, 3], 1, 1), [2, 1, 3]);
});

test('a line from one number to another joins them; one that starts or ends off a number is ink', () => {
  const discs = [
    { id: 1, x: 20, y: 60 },
    { id: 2, x: 20, y: 200 },
  ];
  assert.deepEqual(
    joined(
      [
        [24, 64],
        [60, 120],
        [18, 196],
      ],
      discs,
    ),
    [1, 2],
  );
  assert.equal(
    joined(
      [
        [24, 64],
        [200, 196],
      ],
      discs,
    ),
    null,
  );
  assert.equal(
    joined(
      [
        [24, 64],
        [22, 62],
      ],
      discs,
    ),
    null,
    'a dot on one number',
  );
});

test("a free page's faces: the rail's first, then everyone by name", () => {
  const agents = [
    { id: 'wren', name: 'Wren' },
    { id: 'kit', name: 'Kit' },
    { id: 'lark', name: 'Lark' },
    { id: 'abe', name: 'Abe' },
  ];
  assert.deepEqual(
    sendOrder(agents, ['lark', 'gone']).map(a => a.id),
    ['lark', 'abe', 'kit', 'wren'],
  );
});
