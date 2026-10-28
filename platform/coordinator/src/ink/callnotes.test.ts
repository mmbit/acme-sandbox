// node --test src/ink/callnotes.test.ts   (the harness: the test company, the real server, the board's session, the voice
// line). A call's notes page (callnotes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('callnotes');
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { onPublish } = await import('../events.ts');
const ledger = await import('../ledger.ts');
const jobs = await import('../jobs.ts');
const callnotes = await import('./callnotes.ts');
const { handOver } = await import('../call.ts');
const { moveGroup, deleteGroup } = await import('../notebookgroups.ts');
const DIR = `${h.dataDir}/book`;

// The board's note on the call: a picture of three changes side by side, red, green and blue thirds
const third = (background: string) => ({
  input: { create: { width: 100, height: 120, channels: 3 as const, background } },
});
const THREE = await sharp({ create: { width: 300, height: 120, channels: 3, background: '#ffffff' } })
  .composite([
    { ...third('#ff0000'), left: 0, top: 0 },
    { ...third('#00ff00'), left: 100, top: 0 },
    { ...third('#0000ff'), left: 200, top: 0 },
  ])
  .png()
  .toBuffer();
const anchor = {
  v: 1,
  url: `${ORIGIN}/?open=shop`,
  el: null,
  view: { w: 1024, h: 768, x: 0, y: 0, dpr: 2 },
  ink: [
    {
      color: '#ff5a5f',
      size: 4,
      points: [
        [10, 20, 0.5, 0],
        [190, 120, 0.6, 16],
      ],
    },
  ],
};
const groups = async (page: number) => (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const fileOf = (g: any) => /file=([^&]+)/.exec(g.pictures[0].url)![1];
// The colour in the middle of a group's picture
async function colourOf(g: any) {
  const { data } = await sharp(readFileSync(`${DIR}/${decodeURIComponent(fileOf(g))}`))
    .resize(1, 1)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)].map(v => (v > 200 ? 'f' : v < 50 ? '0' : '?')).join('');
}
const pageNow = (id: number) =>
  db.prepare('select label, archived, send_at, fresh, notebook, kind from book_pages where id = ?').get(id) as any;
async function until(what: () => unknown, why: string) {
  for (let i = 0; i < 100; i++) {
    if (what()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail(why);
}

test("a call's notes page: open as the call starts, the agent's scraps landing one by one, each its own crop", async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = await h.board('/api/notebooks/call', { call });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const page = opened.body.page.id as number;
  // (an ordinary page of My Notebook, titled for the call)
  const shelf = (await h.board('/api/notebooks')).body.shelf as any[];
  const notebook = shelf.find(n => n.id === opened.body.notebook);
  assert.equal(notebook.kind, 'mine');
  assert.match(pageNow(page).label, /^Call with Juno, /);
  assert.equal((await h.board('/api/notebooks/call', { call })).body.page.id, page, 'the same page, asked again');
  const listed = (await h.board(`/api/notebooks/pages?notebook=${notebook.id}`)).body.pages as any[];
  assert.equal(listed.at(-1).id, page, 'the newest page of My Notebook');

  // The board draws three changes in one mark, saying them: the note goes on the call's page, for the line
  const drawn = await h.board('/api/book/note', {
    page,
    anchor,
    words: 'smaller, move it here, and drop this',
    said: 'spoken',
    snip: `data:image/png;base64,${THREE.toString('base64')}`,
  });
  assert.equal(drawn.status, 200, JSON.stringify(drawn.body));
  assert.equal(drawn.body.note.n, 1);

  // On its turn the agent makes one scrap per change, each with its own crop, each a 'book' event for the page
  const heard: number[] = [];
  onPublish(e => void (e.type === 'book' && e.text === 'notebook' && e.page === page && heard.push(Date.now())));
  const changes = [
    { x: 0, words: 'Make the price smaller' },
    { x: 1 / 3, words: 'Move the basket up here' },
    { x: 2 / 3, words: "Drop the banner: it's not needed" },
  ];
  for (const [i, c] of changes.entries()) {
    const made = await h.voice('scrap', {
      call,
      from: 'note 1',
      region: { x: c.x, y: 0, width: 1 / 3, height: 1 },
      words: c.words,
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.match(made.body.ok, new RegExp(`^Scrap ${i + 1} is on the call's page`));
    assert.equal((await groups(page)).length, i + 1, 'each lands as it is made');
  }
  assert.ok(heard.length >= 3, `each scrap told the screens (${heard.length})`);
  const scraps = await groups(page);
  assert.deepEqual(
    scraps.map(g => [g.kind, g.by, g.words, g.status]),
    changes.map(c => ['scrap', 'juno', c.words, 'open']),
  );
  assert.deepEqual(await Promise.all(scraps.map(colourOf)), ['f00', '0f0', '00f'], 'each its own focused crop');
  assert.deepEqual(
    scraps.map(g => [g.pictures[0].w, g.pictures[0].h]),
    [
      [100, 120],
      [100, 120],
      [100, 120],
    ],
  );
  assert.ok(scraps[0].box.y + scraps[0].box.h < scraps[1].box.y, 'stacked under each other, never over');

  // What the line can't cut is refused in words
  const refused = async (body: Record<string, unknown>) => {
    const r = await h.voice('scrap', {
      call,
      from: 'note 1',
      region: { x: 0, y: 0, width: 0.5, height: 1 },
      words: 'x',
      ...body,
    });
    return [r.status, r.body.error];
  };
  assert.equal((await refused({ from: 'note 9' }))[0], 404);
  assert.equal((await refused({ region: { x: 0.8, y: 0, width: 0.5, height: 1 } }))[0], 400);
  assert.equal((await refused({ words: '' }))[0], 400);
  assert.equal((await refused({ owner: 'nobody' }))[0], 400);
  assert.deepEqual(await refused({ from: '-20s' }), [404, 'No screen is being shown on this call.']);

  // Its title, a few words; what the agent records on the call, written on the page
  assert.equal(
    (await h.voice('title', { call, title: 'A summary of everything we said on this long call' })).status,
    400,
  );
  assert.equal((await h.voice('title', { call, title: 'Shop page: price, basket, banner' })).status, 200);
  assert.equal(pageNow(page).label, 'Shop page: price, basket, banner');
  ledger.add(
    call,
    { kind: 'promise', owner: 'juno', what: 'Send the board the new shop page', goal: 'See it live', quote: 'send it' },
    null,
  );
  const typed = (await groups(page)).at(-1);
  assert.deepEqual(
    [typed.kind, typed.by, typed.texts[0].text],
    ['drawing', 'juno', 'Promise for Juno: Send the board the new shop page'],
  );

  // The board scribbles on the page: a line that starts on the first scrap, and one beside the scraps
  const line = (x: number, y: number) => ({
    color: '#2b2230',
    size: 4,
    points: [
      [x, y, 0.5, 0],
      [x + 30, y + 10, 0.5, 16],
    ],
  });
  const on = scraps[0].box;
  db.prepare('update book_pages set ink = ?, strokes = 2 where id = ?').run(
    JSON.stringify([line(on.x + 10, on.y + 10), line(900, 40)]),
    page,
  );

  // The call ends: the page goes in, each scrap a note on its way to an agent, and it goes to My Notebook's archive
  await h.voice('call-end', { agent: 'juno', lines: ['Board: smaller, move it here, and drop this.'], token });
  await until(() => pageNow(page).send_at !== null && pageNow(page).archived === 1, 'the page was sent and archived');
  const after = await groups(page);
  assert.deepEqual(
    after.map(g => [g.kind, g.by, g.status, !!g.note]),
    [
      ['scrap', 'juno', 'sent', true],
      ['scrap', 'juno', 'sent', true],
      ['scrap', 'juno', 'sent', true],
      ['drawing', 'juno', 'sent', false],
      ['drawing', 'board', 'sent', true],
      ['drawing', 'board', 'sent', true],
    ],
    "the agent's own typed note goes back to nobody; the board's lines go",
  );
  const { shelf: afterShelf } = (await h.board('/api/notebooks')).body;
  assert.ok(
    afterShelf.some((n: any) => n.id === notebook.id),
    'My Notebook stays on the shelf',
  );
  assert.equal(
    (await h.voice('scrap', { call, from: 'note 1', region: { x: 0, y: 0, width: 1, height: 1 }, words: 'late' }))
      .status,
    404,
  );
});

test('a call with nothing on its page leaves no page', async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  await h.voice('call-end', { agent: 'juno', lines: ['Board: Just checking in.'], token });
  await until(() => !pageNow(opened.page.id), 'the blank page went');
  assert.ok(db.prepare('select 1 from notebooks where id = ?').get(opened.notebook), 'My Notebook stays');
});

test('what the agent records on a call with no notes page (a phone call) makes none', async () => {
  const { call, token } = await h.liveCall('juno');
  const item = ledger.add(
    call,
    { kind: 'task', owner: 'juno', what: 'Make the price smaller', goal: 'A calmer shop', quote: 'make it smaller' },
    null,
  );
  assert.equal(typeof item, 'object', JSON.stringify(item));
  assert.equal(db.prepare("select 1 from book_pages where kind = 'call' and call = ?").get(call), undefined);
  await h.voice('call-end', { agent: 'juno', lines: ['Board: Make the price smaller.'], token });
  assert.equal(db.prepare("select 1 from book_pages where kind = 'call' and call = ?").get(call), undefined);
});

// A live call whose page has the agent's first scrap, cut from the board's note 1
async function scrapped() {
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  await h.board('/api/book/note', {
    page,
    anchor,
    words: 'smaller, and move it here',
    said: 'spoken',
    snip: `data:image/png;base64,${THREE.toString('base64')}`,
  });
  const made = await h.voice('scrap', { call, from: 'note 1', region: THIRD, words: 'Make the price smaller' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return { call, token, page, scrap: made.body.id as number };
}
const THIRD = { x: 0, y: 0, width: 1 / 3, height: 1 };

test('a scrap still being cut as the call ends is refused: the page goes in as it was, then to the archive', async () => {
  const { call, token, page } = await scrapped();
  const late = callnotes.scrap({ call, from: 'note 1', region: { ...THIRD, x: 1 / 3 }, words: 'Move the basket up' });
  handOver('juno', ['Board: smaller, and move it here.'], 0, token);
  assert.deepEqual(await late, [404, 'This call has ended: its page has gone in.']);
  await until(() => pageNow(page).archived === 1, 'the page was archived');
  assert.deepEqual(
    (await groups(page)).map(g => [g.words, g.status]),
    [['Make the price smaller', 'sent']],
  );
});

test("a call's page the board changes as it's sent is sent again, and archived once it's sent", async () => {
  const { call, page, scrap } = await scrapped();
  const ending = callnotes.ended(call);
  assert.equal((moveGroup({ id: scrap, page, dx: 40 }) as any).id, scrap);
  await ending;
  assert.notEqual(pageNow(page).send_at, null);
  assert.equal(pageNow(page).archived, 1);
  const [sent] = await groups(page);
  assert.equal(sent.status, 'sent', 'sent as the board left it');
});

test("a call's page that can't be sent stays open on the shelf, and says so", async () => {
  const { call, page, scrap } = await scrapped();
  const ending = callnotes.ended(call);
  deleteGroup({ id: scrap });
  await assert.rejects(
    ending,
    /its notes page #\d+ wasn't sent .*nothing on this page to send.*stays open on the shelf/,
  );
  const { notebook, archived, send_at } = pageNow(page);
  assert.deepEqual([archived, send_at], [0, null]);
  assert.equal((db.prepare('select archived from notebooks where id = ?').get(notebook) as any).archived, 0);
});

test("the board's mark no scrap was cut from goes in as its own scrap: nothing it drew is lost", async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  // (the book's first mark on a call finds the notes page as the call's page, never a second one)
  const made = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  assert.equal(made.id, opened.page.id);
  await h.board('/api/book/note', {
    page: made.id,
    anchor,
    words: 'this is too loud',
    said: 'spoken',
    snip: `data:image/png;base64,${THREE.toString('base64')}`,
  });
  await h.voice('call-end', { agent: 'juno', lines: ['Board: this is too loud.'], token });
  await until(() => pageNow(made.id)?.archived === 1, 'the page was archived');
  const [kept] = await groups(made.id);
  assert.deepEqual(
    [kept.kind, kept.by, kept.words, kept.status, !!kept.note],
    ['scrap', 'board', 'this is too loud', 'sent', true],
  );
  // (sent with the page, on a sheet that goes: not the call's own sheet, which never does)
  const sheet = db
    .prepare('select s.status, s.owner from book_notes n join book_sheets s on s.id = n.sheet where n.id = ?')
    .get(kept.note) as { status: string; owner: string | null };
  assert.ok(['sending', 'sent'].includes(sheet.status) && sheet.owner === null, JSON.stringify(sheet));
});

test("at hang-up every note no scrap was cut from, and the board's typed words and pictures, go in", async () => {
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  const snip = `data:image/png;base64,${THREE.toString('base64')}`;
  // Two pictured notes on the same place (the same anchor), and one with no picture
  await h.board('/api/book/note', { page, anchor, words: 'make it smaller', said: 'spoken', snip });
  await h.board('/api/book/note', { page, anchor, words: 'and teal', said: 'spoken', snip });
  await h.board('/api/book/note', { page, anchor, words: 'the whole page is too busy', said: 'typed', snip: null });
  const cut = await h.voice('scrap', {
    call,
    from: 'note 1',
    region: { x: 0, y: 0, width: 1 / 3, height: 1 },
    words: 'Make the price smaller',
  });
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
  // The board types on the page and tapes a picture on it
  const { file } = (await fetch(`${h.base}/api/book/scrap?id=${page}`, {
    method: 'POST',
    body: new Uint8Array(THREE),
    headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/png' },
  }).then(r => r.json())) as { file: string };
  const typed = { x: 600, y: 60, w: 300, text: 'Teal everywhere', color: '#2F6BDC' };
  const saved = await h.board('/api/book/page/save', {
    id: page,
    ink: [],
    scraps: [{ file, x: 600, y: 200, w: 150, h: 60, tilt: 0 }],
    texts: [typed],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  await h.voice('call-end', { agent: 'juno', lines: ['Board: smaller, teal, too busy.'], token });
  await until(() => pageNow(page)?.archived === 1, 'the page was sent and archived');
  const after = await groups(page);
  assert.deepEqual(
    after.map(g => [g.kind, g.by, g.words, g.said, g.texts.map((t: any) => t.text), g.pictures.length, g.status]),
    [
      ['scrap', 'juno', 'Make the price smaller', 'typed', [], 1, 'sent'],
      ['drawing', 'board', '', null, ['Teal everywhere'], 0, 'sent'],
      ['drawing', 'board', '', null, [], 1, 'sent'],
      ['scrap', 'board', 'and teal', 'spoken', [], 1, 'sent'],
      ['scrap', 'board', 'the whole page is too busy', 'typed', [], 0, 'sent'],
    ],
    "the note cut from is the agent's scrap; the other on its place, the one with no picture, the words and picture go",
  );
  assert.deepEqual(
    { ...(db.prepare('select ink, texts, scraps from book_pages where id = ?').get(page) as object) },
    { ink: '[]', texts: '[]', scraps: '[]' },
    'nothing left in the book page itself',
  );
});

test("a call page with only the board's typed words keeps them", async () => {
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  const typed = { x: 40, y: 60, w: 300, text: 'Ring the printer', color: '#2F6BDC' };
  await h.board('/api/book/page/save', { id: page, ink: [], scraps: [], texts: [typed] });
  await h.voice('call-end', { agent: 'juno', lines: ['Board: ring the printer.'], token });
  await until(() => pageNow(page)?.archived === 1, 'the page was sent and archived, not deleted');
  assert.deepEqual(
    (await groups(page)).map(g => [g.kind, g.by, g.texts[0]?.text]),
    [['drawing', 'board', 'Ring the printer']],
  );
});

test("a page brought to the call by its folded corner is the call page's first scrap, in front of both", async () => {
  const { call } = await h.liveCall('juno');
  const mine = (await h.board('/api/notebooks')).body.shelf[0].id;
  const page = (await h.board('/api/notebooks/pages/create', { notebook: mine })).body.id;
  await h.board('/api/notebooks/groups/create', {
    page,
    ink: [
      {
        color: '#2b2230',
        size: 6,
        points: [
          [20, 20, 0.5, 0],
          [300, 200, 0.5, 16],
        ],
      },
    ],
  });
  const opened = (await h.board('/api/notebooks/call', { call, page })).body;
  const [first] = await groups(opened.page.id);
  assert.deepEqual([first.kind, first.by, first.pictures.length], ['scrap', 'board', 1]);
  assert.equal((await groups(opened.page.id)).length, 1);
  await h.board('/api/notebooks/call', { call, page });
  assert.equal((await groups(opened.page.id)).length, 1, 'brought once');
  assert.equal((await h.board('/api/notebooks/call', { call: call + 99 })).status, 404, 'no such live call');
});

test("a call page the shelf carried into My Notebook is the call's notes page there", async () => {
  const myNotebook = () => (db.prepare("select id, archived from notebooks where kind = 'mine'").get() as any) ?? {};
  // The board's first mark comes before the notes page is made, and the shelf carries that page into My Notebook
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  const line = {
    color: '#2b2230',
    size: 6,
    points: [
      [20, 20, 0.5, 0],
      [300, 200, 0.5, 16],
    ],
  };
  await h.board('/api/book/page/save', { id: page.id, ink: [line], scraps: [] });
  await h.board('/api/notebooks');
  assert.equal(pageNow(page.id).notebook, myNotebook().id);
  const drawn = (await groups(page.id)).length;
  assert.ok(drawn > 0, 'carried as groups');
  // (the book lists which notebook has a call's page, so HQ asks nothing of one at hang-up: calldraw.js)
  assert.equal((await h.board('/api/book')).body.pages.find((p: any) => p.id === page.id).notebook, myNotebook().id);
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  assert.deepEqual([opened.page.id, opened.notebook], [page.id, myNotebook().id]);
  assert.equal((await groups(page.id)).length, drawn, 'its groups as they were');
  await h.voice('call-end', { agent: 'juno', lines: ['Board: that line.'], token });
  await until(() => pageNow(page.id)?.archived === 1, 'the page was archived');
  assert.equal((await groups(page.id)).length, drawn, 'carried once');
  assert.equal(myNotebook().archived, 0, 'My Notebook stays on the shelf');
});

test("a call's notes page reads like any page, a customer call's too; a call about a card for keys keeps its own", async () => {
  const sketches = async (token: string, archived = '') =>
    ((await h.agent(`sketches${archived}`, token)).body.sketches as { id: number }[]).map(p => p.id);
  const holds = async (job: number) => (await h.worker('customers', { job })).body.customers as boolean;
  const kit = await h.start({ agent: 'kit' });
  const { call, token } = await h.liveCall('juno');
  db.prepare('update calls set customers = 1 where id = ?').run(call);
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  await h.board('/api/book/note', { page, anchor, words: 'the colours here', said: 'spoken' });
  await h.voice('call-end', { agent: 'juno', lines: ['Board: that line.'], token });
  await until(() => pageNow(page).archived === 1, 'the page was sent and archived');
  assert.ok((await sketches(kit.token, '?archived=1')).includes(page));
  assert.equal((await h.agent(`sketch?id=${page}`, kit.token)).status, 200);
  assert.equal(await holds(kit.id), false, 'and nothing marked');

  const card = jobs.createRequest({
    kind: 'credential',
    title: 'A key',
    body: 'b',
    agent: 'wren',
    secrets: 'CALLNOTES_TEST_KEY',
  }) as {
    id: number;
  };
  const keys = await h.liveCall('wren');
  const kept = (await h.board('/api/notebooks/call', { call: keys.call })).body.page.id as number;
  await h.board('/api/book/note', { page: kept, anchor, words: 'where it goes', said: 'spoken' });
  await h.voice('call-end', { agent: 'wren', lines: ['Board: done.'], token: keys.token });
  await until(() => pageNow(kept).archived === 1, 'the page was sent and archived');
  db.prepare('update calls set request = ? where id = ?').run(card.id, keys.call); // (the call the card was rung about)
  assert.ok(!(await sketches(kit.token, '?archived=1')).includes(kept));
  assert.equal((await h.agent(`sketch?id=${kept}`, kit.token)).status, 404);
  const wren = await h.start({ agent: 'wren' });
  assert.equal((await h.agent(`sketch?id=${kept}`, wren.token)).status, 200, "its own agent's");
});

test("the call engine's split: the watch-along, the screen and the line's drawing and driving read nothing of Ink", () => {
  const root = new URL('../../../../', import.meta.url).pathname;
  const engine = [
    'platform/coordinator/src/watchalong.ts',
    ...readdirSync(`${root}shared/watchalong`)
      .filter(f => /\.(ts|js)$/.test(f) && !f.includes('.test.'))
      .map(f => `shared/watchalong/${f}`),
    'platform/hq/shell/callscreen.js',
    'platform/hq/shell/calldrive.js',
  ];
  for (const file of engine) {
    const imports = readFileSync(`${root}${file}`, 'utf8').match(/^import .*$/gm) ?? [];
    assert.deepEqual(
      imports.filter(i => /ink\/|notebook|callnotes|book/.test(i)),
      [],
      `${file} imports Ink`,
    );
  }
  // (Ink reads the engine: the call's page cuts its scraps through the watch-along's screen)
  assert.match(readFileSync(`${root}platform/coordinator/src/ink/callnotes.ts`, 'utf8'), /watchalong\.screen\(/);
});
