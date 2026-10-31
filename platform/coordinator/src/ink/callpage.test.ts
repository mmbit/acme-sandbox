// node --test src/ink/callpage.test.ts   (the harness: the test company, the real server, the board's session, the voice
// line). A call's agent working its notes page as the board does (callpage.ts), and its plain note (callnotes.ts scrap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../harness.ts';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';

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
// The call's page gone in at its end, its group with it
async function sent(id: number) {
  for (let i = 0; i < 100 && groupRow(id).status !== 'sent'; i++) await new Promise(r => setTimeout(r, 50));
}
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
  // (on the note itself, round its words; the highlight and the pen line drawings of their own; the highlight the
  // highlighter's yellow, see-through, filled)
  assert.equal(rect, note, 'the rectangle is on the note');
  const words = boxOf({ texts: of(note).texts })!,
    ring = boxOf({ ink: of(note).ink })!;
  assert.equal(of(note).ink.length, 1);
  assert.ok(ring.x <= words.x && ring.x + ring.w >= words.x + words.w, 'the rectangle goes round its words');
  assert.ok(of(note).h >= ring.y + ring.h, 'the note is as tall as the rectangle');
  assert.deepEqual([of(highlight).kind, of(highlight).by], ['drawing', 'juno']);
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
  const other = said(await h.voice('scrap', { call, words: 'Move Send elsewhere', goal: GOAL })).id as number;
  said(await h.voice('change', { call, id: note, after: other }));
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [other, note],
    'moved after the other',
  );
  // (one the board typed in keeps both its words and the board's)
  const typedIn = (await groups(page)).find(g => g.id === note);
  said(
    await h.board('/api/notebooks/groups/edit', {
      id: note,
      since: typedIn.updated,
      texts: [...typedIn.texts, { id: 'b0a2d0000000', x: 0, y: 200, w: 200, text: 'and the font', color: '#2b2230' }],
    }),
  );
  // (the agent's mark on it after leaves the board's line the board's)
  said(await h.voice('mark', { call, mark: 'ellipse', around: note }));
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
  assert.deepEqual(
    (await groups(page)).map(g => g.id),
    [other],
  );
  // (the board's Undo of a delete is the store's restore, the agent's deletes too)
  said(await h.board('/api/notebooks/groups/restore', { id: note }));
  assert.equal(groupRow(note).deleted, null);
  assert.equal((await h.voice('change', { call, id: note, words: 'x', delete: true })).status, 400);
});

test("after the board's Undo of the agent's new words, its note and its promise for the board are still its own", async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
  ledger.add(
    call,
    { kind: 'promise', owner: 'board', what: 'Try the shop on the phone', goal: GOAL, quote: 'try it' },
    null,
  );
  const promise = (await groups(page)).find(g => g.id !== note).id as number;
  for (const id of [note, promise]) {
    const before = (await groups(page)).find(g => g.id === id);
    said(await h.voice('change', { call, id, words: 'Make it smaller still' }));
    // (Undo: the board's screen puts the group's lines back as they were, their own ids)
    const after = (await groups(page)).find(g => g.id === id);
    said(await h.board('/api/notebooks/groups/edit', { id, since: after.updated, texts: before.texts }));
    said(await h.voice('change', { call, id, words: 'Make it a little smaller' }));
  }
  assert.equal(ledger.items(call)[0].what, 'Make it a little smaller');
});

test("the board's Undo of the agent's new words takes its item's line back too, by the call's end", async () => {
  const { call, token, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
  const before = (await groups(page)).find(g => g.id === note);
  said(await h.voice('change', { call, id: note, words: 'Make it smaller still' }));
  const after = (await groups(page)).find(g => g.id === note);
  said(await h.board('/api/notebooks/groups/edit', { id: note, since: after.updated, texts: before.texts }));
  await h.voice('call-end', { agent: 'juno', lines: ['Board: smaller.'], token });
  await sent(note);
  assert.equal(ledger.items(call)[0].what, 'Make the price smaller');
});

test("at hang-up the agent's notes and marks stay on the page, the board's ink on them too, and none is sent", async () => {
  const { call, token, page } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Use the page’s width', goal: GOAL })).id as number;
  const kept = said(await h.voice('mark', { call, mark: 'ellipse', around: note })).id as number;
  const drawnOn = said(await h.voice('mark', { call, mark: 'rect', box: { x: 600, y: 600, width: 200, height: 100 } }))
    .id as number;
  // (the board writes inside the rectangle)
  const rect = (await groups(page)).find(g => g.id === drawnOn);
  const stroke = {
    color: '#d63c3c',
    size: 4,
    points: [
      [650, 640, 0.5, 0],
      [700, 650, 0.5, 16],
    ],
  };
  said(await h.board('/api/notebooks/groups/edit', { id: drawnOn, since: rect.updated, ink: [...rect.ink, stroke] }));
  await h.voice('call-end', { agent: 'juno', lines: ['Board: use the width.'], token });
  await sent(note);
  for (const id of [note, kept, drawnOn])
    assert.deepEqual(
      [groupRow(id).status, groupRow(id).note],
      ['sent', null],
      'on the page as it went in, sent nowhere',
    );
  assert.equal(
    (await groups(page)).find(g => g.id === drawnOn).ink.length,
    rect.ink.length + 1,
    "the board's ink stays on the rectangle",
  );
});

test("the agent starts a try on a scrap: its owner's try run, once; a scrap on another call's page is refused", async () => {
  const { call } = await callPage();
  const note = said(await h.voice('scrap', { call, words: 'Make the basket bigger', goal: GOAL, owner: 'wren' }))
    .id as number;
  const why = 'Show me a few versions of a bigger basket';
  const started = said(await h.voice('try', { call, id: note, why }));
  assert.match(started.ok, /^Started: .+ makes a few versions of it, .+ land under it one by one/);
  const run = db.prepare('select agent, kind, expedite, prompt from jobs where id = ?').get(started.job) as any;
  assert.deepEqual([run.agent, run.kind, run.expedite], ['wren', 'try', 1]);
  assert.ok(run.prompt.includes(why), "the board's words in the run's brief");
  assert.equal((db.prepare('select tried from notebook_groups where id = ?').get(note) as any).tried, started.job);
  const again = said(await h.voice('try', { call, id: note, why: 'And one in red' }));
  assert.equal(again.job, started.job, 'one try at a time: the ask goes to the one going');
  assert.match(again.ok, /still going/);
  // (another call's page, and no words for why)
  const other = await callPage();
  const theirs = said(await h.voice('scrap', { call: other.call, words: 'Not this call’s', goal: GOAL })).id as number;
  assert.equal((await h.voice('try', { call, id: theirs, why })).status, 404);
  assert.equal((await h.voice('try', { call, id: note, why: ' ' })).status, 400);
  h.cancelQueued();
});
