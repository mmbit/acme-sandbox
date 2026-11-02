// node --test src/ink/callpage.test.ts   (the harness: the test company, the real server, the board's session, the voice
// line). A call's agent working its notes page as the board does (callpage.ts), and its plain note (callnotes.ts scrap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { harness } from '../harness.ts';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';
import { UNIT_W, WORDS_IN } from '../../../hq/shell/ink/scrapunit.js';

const h = await harness('callpage');
const { db } = h;
const ledger = await import('../ledger.ts');
const { READS_A_DAY, counted } = await import('./inkread.ts');
const { companyDay } = await import('../company.ts');

const GOAL = 'The call writes on the page like the board';
const groups = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const said = (r: { status: number; body: any }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
// The worker's next small-model call, once the agent's read has put one up
async function claimed() {
  for (let i = 0; i < 100; i++) {
    const c = (await h.worker('reads/claim')).body;
    if (c.reading) return c;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error('nothing to claim');
}
const groupRow = (id: number) =>
  db.prepare('select kind, by, status, note, deleted, words from notebook_groups where id = ?').get(id) as any;
// The call's page gone in at its end, its group with it
async function sent(id: number) {
  for (let i = 0; i < 100 && groupRow(id).status !== 'sent'; i++) await new Promise(r => setTimeout(r, 50));
}
async function callPage() {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  return { call, token, page };
}

test('a plain note is words on a post-it, no picture, an ask on the call’s list, in the agent’s hand', async () => {
  const { call, page } = await callPage();
  const note = said(
    await h.voice('write-down', { call, words: 'Give the agent a plain note', goal: GOAL, owner: 'wren' }),
  );
  assert.match(note.ok, /^Written down \(#\d+; item #\d+ on the call's list\), your words alone/);
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
  // (a crop is from and region both)
  const half = await h.voice('write-down', { call, from: 'now', words: 'x', goal: GOAL });
  assert.equal(half.status, 400);
});

// The board's drawing on the call's page, its ink a line from (x, 40)
const drawing = (page: number, x: number) =>
  h.board('/api/notebooks/groups/create', {
    page,
    ink: [
      {
        color: '#d63c3c',
        size: 4,
        points: [
          [x, 40, 0.5, 0],
          [x + 60, 90, 0.5, 16],
        ],
      },
    ],
  });
const readsToday = () =>
  (db.prepare('select reads from handwriting_reads where day = ?').get(companyDay(Date.now())) as any)?.reads ?? 0;
// The worker's claim answered with readings of the asked pictures, each as given
const answered = (asked: any, reading: (id: number) => object) =>
  h.worker('reads/answer', {
    reading: asked.reading,
    result: {
      is_error: false,
      structured_output: {
        readings: asked.content
          .filter((c: any) => c.type === 'text' && /^Picture #/.test(c.text))
          .map((c: any) => Number(/#(\d+)/.exec(c.text)![1]))
          .map((id: number) => ({ id, ...reading(id) })),
      },
    },
  });

test("a reading missing a field or over its length is no reading, kept for none, and '' stays a reading", async () => {
  const { call, page } = await callPage();
  await drawing(page, 500);
  const reading = h.voice('page', { call });
  // (a failed answer is tried once more: both wrong, the call fails)
  await answered(await claimed(), () => ({ words: 'yes' }));
  await answered(await claimed(), () => ({ words: 'x'.repeat(601), marks: '', unsure: '' }));
  assert.match(said(await reading).ok, /its ink couldn't be read just now/);
  const again = h.voice('page', { call });
  await answered(await claimed(), () => ({ words: '', marks: '', unsure: '' }));
  assert.match(said(await again).ok, /its ink, read: nothing anyone could read$/m);
});

test('the agent reads the page, draws a rectangle round a note and a highlight, each its own mark in its hand', async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('write-down', { call, words: 'Two notes side by side', goal: GOAL })).id as number;
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
  // (the board's drawing read from its strokes by Haiku 5.5, the page's words beside it: the worker's claim answered)
  const reading = h.voice('page', { call });
  const asked = await claimed();
  assert.equal(asked.model, 'claude-haiku-5-5');
  assert.deepEqual(
    asked.content.map((c: any) => c.type),
    ['text', 'image', 'text', 'image', 'text'],
    "each of the board's drawings a picture",
  );
  assert.match(asked.content.at(-1).text, /Two notes side by side/, 'the page beside the ink');
  const drawn = asked.content
    .filter((c: any) => c.type === 'text' && /^Picture #/.test(c.text))
    .map((c: any) => Number(/#(\d+)/.exec(c.text)![1]));
  await h.worker('reads/answer', {
    reading: asked.reading,
    result: {
      is_error: false,
      structured_output: {
        readings: drawn.map((id: number) => ({ id, words: '', marks: 'a line under the title', unsure: '' })),
      },
    },
  });
  const read = said(await reading).ok as string;
  assert.match(read, new RegExp(`#${note} yours note \\(an ask\\): “Two notes side by side” at `));
  assert.match(read, /the board's drawing, 1 line of ink at [\d, ]+; its ink, read: drawn: a line under the title$/m);
  // (read again: the reading kept, nothing asked of the model)
  assert.match(said(await h.voice('page', { call })).ok, /its ink, read: drawn: a line under the title/);
  assert.deepEqual((await h.worker('reads/claim')).body, {}, 'nothing more to read');
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
  const note = said(await h.voice('write-down', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
  const changed = said(await h.voice('change', { call, id: note, words: 'Make the price much smaller' }));
  assert.match(changed.ok, /says it now\.$/);
  const [g] = await groups(page);
  assert.equal(g.texts.map((t: any) => t.text).join(''), 'Make the price much smaller');
  assert.equal(ledger.items(call)[0].what, 'Make the price much smaller', 'its item takes the new words');
  const other = said(await h.voice('write-down', { call, words: 'Move Send elsewhere', goal: GOAL })).id as number;
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
  said(await h.voice('change', { call, id: note, words: 'Make it small' }));
  const typedOver = (await groups(page)).find(g => g.id === note);
  assert.deepEqual(
    typedOver.texts.map((t: any) => t.text),
    ['Make it small', 'and the font'],
  );
  assert.deepEqual(
    ledger.items(call).map(i => i.what),
    ['Make it small', 'Move Send elsewhere'],
  );
  // (one the board took the agent's words out of stays as the board left it)
  const typedOut = (await groups(page)).find(g => g.id === note);
  said(
    await h.board('/api/notebooks/groups/edit', {
      id: note,
      since: typedOut.updated,
      texts: typedOut.texts.filter((t: any) => t.id === 'b0a2d0000000'),
    }),
  );
  assert.equal((await h.voice('change', { call, id: note, words: 'Make it tiny' })).status, 409);
  assert.deepEqual(
    (await groups(page)).find(g => g.id === note).texts.map((t: any) => t.text),
    ['and the font'],
  );
  assert.deepEqual(
    ledger.items(call).map(i => i.what),
    ['Make it small', 'Move Send elsewhere'],
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

test('a screen deletes only the note it has read: one the agent reworded since stays, as it says now', async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('write-down', { call, words: 'Projects hold milestones', goal: GOAL })).id as number;
  const read = (await groups(page)).find(g => g.id === note);
  // (typed where HQ's page lays words, so the board's screen has nothing of its own to save over it.)
  assert.deepEqual([read.texts[0].x, read.texts[0].w], [WORDS_IN, UNIT_W - 2 * WORDS_IN]);
  said(await h.voice('change', { call, id: note, words: 'Projects hold milestones, which replace deliverables' }));
  const reworded = (await groups(page)).find(g => g.id === note);
  assert.equal(reworded.texts[0].x, WORDS_IN, 'typed again where it stood');
  const gone = await h.board('/api/notebooks/groups/delete', { id: note, since: read.updated });
  assert.equal(gone.status, 409);
  assert.equal(
    (await groups(page))
      .find(g => g.id === note)
      ?.texts.map((t: any) => t.text)
      .join(''),
    'Projects hold milestones, which replace deliverables',
  );
  said(await h.board('/api/notebooks/groups/delete', { id: note, since: reworded.updated }));
});

test('a note the board moved in its unit is typed again where the board put it when the agent rewords it', async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('write-down', { call, words: 'Projects hold milestones', goal: GOAL })).id as number;
  const read = (await groups(page)).find(g => g.id === note);
  const moved = read.texts.map((t: any) => ({ ...t, x: 60, y: t.y + 30, w: UNIT_W - WORDS_IN - 60 }));
  said(await h.board('/api/notebooks/groups/edit', { id: note, since: read.updated, texts: moved }));
  said(await h.voice('change', { call, id: note, words: 'Projects hold milestones, which replace deliverables' }));
  const [line] = (await groups(page)).find(g => g.id === note).texts;
  // (as wide as the unit leaves it there, so HQ's page has nothing to lay anew.)
  assert.deepEqual([line.x, line.y, line.w], [60, moved[0].y, UNIT_W - WORDS_IN - 60]);
});

test("the agent's note joined with another keeps its words and both items'", async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('write-down', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
  const other = said(await h.voice('write-down', { call, words: 'Move Send elsewhere', goal: GOAL })).id as number;
  // (the board's join: one note holding both asks)
  db.prepare('update call_asks set grp = ? where grp = ?').run(note, other);
  const before = (await groups(page)).find(g => g.id === note);
  assert.equal((await h.voice('change', { call, id: note, words: 'Make it smaller still' })).status, 409);
  assert.deepEqual((await groups(page)).find(g => g.id === note).texts, before.texts);
  assert.deepEqual(
    ledger.items(call).map(i => i.what),
    ['Make the price smaller', 'Move Send elsewhere'],
  );
});

test("after the board's Undo of the agent's new words, each of its notes is still its own", async () => {
  const { call, page } = await callPage();
  const note = said(await h.voice('write-down', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
  // (and one the call records otherwise: a job it queues there, ledger.ts noteOnPage)
  ledger.add(
    call,
    { kind: 'task', owner: 'moss', what: 'Try the shop on the phone', goal: GOAL, quote: 'try it' },
    null,
  );
  const other = (await groups(page)).find(g => g.id !== note).id as number;
  for (const id of [note, other]) {
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
  const note = said(await h.voice('write-down', { call, words: 'Make the price smaller', goal: GOAL })).id as number;
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
  const note = said(await h.voice('write-down', { call, words: 'Use the page’s width', goal: GOAL })).id as number;
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
  const note = said(await h.voice('write-down', { call, words: 'Make the basket bigger', goal: GOAL, owner: 'wren' }))
    .id as number;
  const why = 'Show me a few versions of a bigger basket';
  const started = said(await h.voice('try', { call, id: note, why }));
  assert.match(started.ok, /^Started: .+ makes a few versions of it, .+ appear under it one by one/);
  const run = db.prepare('select agent, kind, expedite, prompt from jobs where id = ?').get(started.job) as any;
  assert.deepEqual([run.agent, run.kind, run.expedite], ['wren', 'try', 1]);
  assert.ok(run.prompt.includes(why), "the board's words in the run's brief");
  assert.equal((db.prepare('select tried from notebook_groups where id = ?').get(note) as any).tried, started.job);
  const again = said(await h.voice('try', { call, id: note, why: 'And one in red' }));
  assert.equal(again.job, started.job, 'one try at a time: the ask goes to the one going');
  assert.match(again.ok, /still going/);
  // (another call's page, and no words for why)
  const other = await callPage();
  const theirs = said(await h.voice('write-down', { call: other.call, words: 'Not this call’s', goal: GOAL }))
    .id as number;
  assert.equal((await h.voice('try', { call, id: theirs, why })).status, 404);
  assert.equal((await h.voice('try', { call, id: note, why: ' ' })).status, 400);
  h.cancelQueued();
});

test(
  "the agent's drawing goes in the call's notes as a picture in the company's look, and it sees what went in",
  {
    skip: !process.env.CHROMIUM_PATH && 'needs CHROMIUM_PATH',
  },
  async () => {
    const { call, page } = await callPage();
    mkdirSync(`${h.repo}/kits/look`, { recursive: true });
    writeFileSync(`${h.repo}/kits/look/drawing.css`, 'main { background: #00ff00; }');
    appendFileSync(`${h.repo}/theme/hq.yaml`, 'drawing: kits/look/drawing.css\n');
    // (a script in it never runs)
    const svg = `<svg viewBox="0 0 640 320"><rect x="40" y="40" width="200" height="120" class="accent"/>
    <text x="300" y="100">Milestones</text><script>document.querySelector('main').style.background = '#ff0000'</script></svg>`;
    const drawn = said(await h.voice('drawing', { call, svg }));
    assert.match(drawn.ok, new RegExp(`^Your drawing is in the call's notes \\(#${drawn.id}\\)`));
    const seen = await sharp(Buffer.from(drawn.picture.data, 'base64')).metadata();
    assert.deepEqual([drawn.picture.type, seen.width], ['image/jpeg', 640], 'the agent sees it at half its size');
    const g = (await groups(page)).at(-1);
    assert.deepEqual([g.id, g.kind, g.by, g.words ?? ''], [drawn.id, 'scrap', 'juno', ''], 'a picture of its own');
    const file = decodeURIComponent(/file=([^&]+)/.exec(g.pictures[0].url)![1]);
    const corner = await sharp(readFileSync(`${h.dataDir}/book/${file}`))
      .extract({ left: 2, top: 2, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.deepEqual([...corner.subarray(0, 3)], [0, 255, 0], "the company's ground, untouched by the script");
    for (const notOne of ['a box and an arrow', '<svg viewBox="0 0 640 320"></svg>'])
      assert.equal((await h.voice('drawing', { call, svg: notOne })).status, 400, notOne);
  },
);

// (last in the file: it uses up the day's readings, and nothing after it may need one.)
test("the board's ink read on a call is one of the day's handwriting readings, none past them", async () => {
  // (the readings earlier tests left unanswered, claimed and let go: the next claim is this test's)
  while ((await h.worker('reads/claim')).body.reading);
  const { call, page } = await callPage();
  await drawing(page, 500);
  const was = readsToday(),
    reading = h.voice('page', { call });
  await answered(await claimed(), () => ({ words: 'yes', marks: '', unsure: '' }));
  assert.match(said(await reading).ok, /its ink, read: written “yes”$/m);
  assert.equal(readsToday(), was + 1, 'counted');
  for (let used = readsToday(); used < READS_A_DAY; used++) counted();
  // (read again: the kept reading needs none)
  assert.match(said(await h.voice('page', { call })).ok, /its ink, read: written “yes”$/m);
  await drawing(page, 900);
  const past = await h.voice('page', { call });
  assert.equal(past.status, 429);
  assert.match(past.body.error, new RegExp(`${READS_A_DAY} times a day`));
  assert.deepEqual((await h.worker('reads/claim')).body, {}, 'nothing sent to the model past the bound');
});
