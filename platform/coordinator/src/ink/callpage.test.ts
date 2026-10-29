// node --test src/ink/callpage.test.ts   (the harness: the test company, the real server, the board's session, the voice
// line). A call's agent working its notes page as the board does (callpage.ts), and its plain note (callnotes.ts scrap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../harness.ts';

const h = await harness('callpage');
const { db } = h;
const ledger = await import('../ledger.ts');

const GOAL = 'The call writes on the page like the board';
const groups = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const said = (r: { status: number; body: any }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const groupRow = (id: number) =>
  db.prepare('select kind, by, status, note, deleted, words from notebook_groups where id = ?').get(id) as any;
// (every change the agent makes is counted on the page as its hand's: each screen's read takes it as a step its Undo
// takes back)
const handed = async (page: number) =>
  (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.handed as number;
async function callPage() {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  return { call, token, page };
}

test('a plain note is words on a post-it, no picture, an ask on the call’s list, in the agent’s hand', async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Give the agent a plain note', goal: GOAL, owner: 'wren' }));
  assert.match(note.ok, /^Note 1 is on the call's page \(#\d+\)/);
  const [g] = await groups(page);
  assert.equal(g.id, note.id);
  assert.deepEqual(
    [g.kind, g.by, g.pictures.length, g.texts.map((t: any) => t.text).join('')],
    ['note', 'juno', 0, 'Give the agent a plain note'],
  );
  assert.deepEqual(
    ledger.items(call).map(i => [i.kind, i.owner, i.what]),
    [['task', 'wren', 'Give the agent a plain note']],
  );
  assert.ok((await handed(page)) > 0, "the agent's hand counted on the page");
  // (a crop is from and region both)
  const half = await h.voice('scrap', { call, from: 'now', words: 'x', goal: GOAL });
  assert.equal(half.status, 400);
});

test('the agent reads the page, draws a rectangle round a note and a highlight, each its own mark in its hand', async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Two notes side by side', goal: GOAL })).id as number;
  await h.board('/api/notebooks/groups/create', {
    page,
    ink: [
      {
        color: '#d63c3c',
        size: 4,
        points: [
          [500, 40, 0.5, 0],
          [700, 90, 0.5, 16],
        ],
      },
    ],
  });
  const counted = await handed(page);
  await h.board('/api/notebooks/groups/create', {
    page,
    ink: [
      {
        color: '#d63c3c',
        size: 4,
        points: [
          [900, 40, 0.5, 0],
          [960, 90, 0.5, 16],
        ],
      },
    ],
  });
  assert.equal(await handed(page), counted, "the board's own change isn't counted");
  const read = said(await h.voice('page', { call })).ok as string;
  assert.match(read, new RegExp(`#${note} yours note \\(an ask\\): “Two notes side by side” at `));
  assert.match(read, /the board's drawing, 1 line of ink at /);
  const before = await handed(page);
  const rect = said(await h.voice('mark', { call, mark: 'rect', around: note })).id as number;
  const highlight = said(
    await h.voice('mark', { call, mark: 'highlight', box: { x: 500, y: 30, width: 220, height: 60 } }),
  ).id as number;
  const pen = said(
    await h.voice('mark', {
      call,
      mark: 'pen',
      points: [
        [10, 10],
        [40, 30],
        [80, 20],
      ],
    }),
  ).id as number;
  assert.ok((await handed(page)) >= before + 3, "each mark counted as the agent's hand's");
  const on = await groups(page);
  const of = (id: number) => on.find(g => g.id === id);
  const noteBox = of(note).box;
  // (round the note with room; the highlight the highlighter's yellow, see-through, filled)
  const ring = of(rect);
  assert.deepEqual([ring.kind, ring.by, ring.ink.length], ['drawing', 'juno', 1]);
  assert.ok(ring.box.x < noteBox.x && ring.box.x + ring.box.w > noteBox.x + noteBox.w, 'the ring goes round the note');
  assert.deepEqual(
    [of(highlight).ink[0].color, of(highlight).ink[0].alpha, of(highlight).ink[0].fill],
    ['#ffd23f', 0.42, true],
  );
  assert.equal(of(pen).ink[0].points.length, 3);
  // (nothing a mark draws is an ask)
  assert.equal(ledger.items(call).length, 1);
  for (const wrong of [
    { mark: 'rect' },
    { mark: 'star', around: note },
    { mark: 'line', points: [[0, 0]] },
    { mark: 'rect', around: 999_999 },
  ])
    assert.notEqual((await h.voice('mark', { call, ...wrong })).status, 200, JSON.stringify(wrong));
});

test('the agent changes its own scrap’s words and its item’s, moves and deletes, but not the board’s words', async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
  const changed = said(await h.voice('change', { call, id: note, words: 'Make the price much smaller' }));
  assert.match(changed.ok, /the board can undo it/);
  const [g] = await groups(page);
  assert.equal(g.texts.map((t: any) => t.text).join(''), 'Make the price much smaller');
  assert.equal(ledger.items(call)[0].what, 'Make the price much smaller', 'its item takes the new words');
  said(await h.voice('change', { call, id: note, to: { x: 600, y: 400 } }));
  assert.deepEqual([(await groups(page))[0].box.x, (await groups(page))[0].box.y], [600, 400]);
  // (one the board joined another note into keeps both)
  const other = said(await h.voice('scrap', { call, words: 'Move Send elsewhere', goal: GOAL })).id as number;
  said(await h.board('/api/notebooks/groups/join', { ids: [note, other] }));
  assert.equal((await h.voice('change', { call, id: note, words: 'Make it small' })).status, 409);
  assert.deepEqual(
    ledger.items(call).map(i => i.what),
    ['Make the price much smaller', 'Move Send elsewhere'],
  );
  const mine = 'Mine, and long enough to need more than a short line of words. '.repeat(4).trim();
  const board = said(
    await h.board('/api/notebooks/groups/create', {
      page,
      texts: [{ x: 40, y: 40, w: 300, text: mine, color: '#2b2230' }],
    }),
  ).id as number;
  assert.ok(said(await h.voice('page', { call })).ok.includes(`“${mine}”`), 'read whole');
  assert.equal((await h.voice('change', { call, id: board, words: 'Theirs' })).status, 409);
  said(await h.voice('change', { call, id: board, delete: true }));
  said(await h.voice('change', { call, id: note, delete: true }));
  assert.deepEqual(await groups(page), []);
  // (the board's Undo of a delete is the store's restore, the agent's deletes too)
  said(await h.board('/api/notebooks/groups/restore', { id: note }));
  assert.equal(groupRow(note).deleted, null);
  assert.equal((await h.voice('change', { call, id: note, words: 'x', delete: true })).status, 400);
});

test("at hang-up the agent's marks stay on the page as drawn, one the board drew on goes as its note", async () => {
  const { call, token, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Use the page’s width', goal: GOAL })).id as number;
  const kept = said(await h.voice('mark', { call, mark: 'ellipse', around: note })).id as number;
  const drawnOn = said(await h.voice('mark', { call, mark: 'rect', box: { x: 600, y: 600, width: 200, height: 100 } }))
    .id as number;
  const moved = said(
    await h.voice('mark', {
      call,
      mark: 'arrow',
      points: [
        [600, 800],
        [700, 900],
      ],
    }),
  ).id as number;
  // (the board writes inside the rectangle, and moves the arrow)
  const rect = (await groups(page)).find(g => g.id === drawnOn);
  const ink = [
    ...rect.ink,
    {
      color: '#d63c3c',
      size: 4,
      points: [
        [650, 640, 0.5, 0],
        [700, 650, 0.5, 16],
      ],
    },
  ];
  said(await h.board('/api/notebooks/groups/edit', { id: drawnOn, since: rect.updated, ink }));
  said(await h.board('/api/notebooks/groups/move', { id: moved, page, dx: 30, dy: 0 }));
  // (and draws its own line for the agent's in another: as many strokes, not the same)
  const swapped = said(await h.voice('mark', { call, mark: 'rect', box: { x: 900, y: 600, width: 200, height: 100 } }))
    .id as number;
  said(
    await h.board('/api/notebooks/groups/edit', {
      id: swapped,
      since: (await groups(page)).find(g => g.id === swapped).updated,
      ink: [{ ...ink[1], points: (ink[1].points as number[][]).map(([x, y, ...r]) => [x + 300, y, ...r]) }],
    }),
  );
  // (a promise for the board the agent words again stays as it wrote it)
  ledger.add(call, { kind: 'promise', owner: 'board', what: 'Try it on the iPad', goal: GOAL, quote: 'you try' }, null);
  const promise = (await groups(page)).find(g => g.texts.some((t: any) => /^Promise for you/.test(t.text))).id;
  said(await h.voice('change', { call, id: promise, words: 'Promise for you: try it on the iPad and the phone' }));
  await h.voice('call-end', { agent: 'juno', lines: ['Board: use the width.'], token });
  for (let i = 0; i < 100 && groupRow(note).note === null; i++) await new Promise(r => setTimeout(r, 50));
  assert.notEqual(groupRow(note).note, null, 'the note went as an ask');
  assert.deepEqual([groupRow(kept).status, groupRow(kept).note], ['sent', null], 'the ellipse stays as drawn');
  assert.deepEqual([groupRow(moved).status, groupRow(moved).note], ['sent', null], 'moved is unchanged');
  assert.deepEqual([groupRow(promise).status, groupRow(promise).note], ['sent', null], 'its own change is as written');
  assert.notEqual(groupRow(drawnOn).note, null, "the rectangle the board wrote in goes as the board's note");
  assert.notEqual(groupRow(swapped).note, null, "the board's stroke for the agent's goes as its note");
});
