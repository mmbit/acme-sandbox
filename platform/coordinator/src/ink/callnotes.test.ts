// node --test src/ink/callnotes.test.ts   (the harness: the test company, the real server, the board's session, the voice
// line). A call's notes page (callnotes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import sharp from 'sharp';
import { harness } from '../harness.ts';
import { ROOM } from '../../../hq/shell/ink/scrapunit.js';

const h = await harness('callnotes');
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { onPublish } = await import('../events.ts');
const ledger = await import('../ledger.ts');
const jobs = await import('../jobs.ts');
const callnotes = await import('./callnotes.ts');
const { handOver } = await import('../call.ts');
const { tryNow } = await import('./booktry.ts');
const { companyTime } = await import('../company.ts');
const { currentPage } = await import('../notebook.ts');
const { deliverDue } = await import('./booksheets.ts');
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
// The board's why, which every ask on the call carries
const GOAL = 'A calmer shop';
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
test("a call agent's title never replaces one the board typed", async () => {
  const { call } = await h.liveCall('juno');
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id;
  assert.equal((await h.voice('title', { call, title: 'Garden plans' })).status, 200);
  assert.match(pageNow(page).label, /, Garden plans$/);
  await h.board('/api/notebooks/pages/title', { id: page, title: 'My garden' });
  assert.equal((await h.voice('title', { call, title: 'New subject' })).status, 200);
  assert.equal(pageNow(page).label, 'My garden');
});
async function until(what: () => unknown, why: string) {
  for (let i = 0; i < 100; i++) {
    if (what()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail(why);
}
const wentIn = (page: number) => until(() => pageNow(page)?.send_at != null, 'the page went in');

test("a call's notes page: open as the call starts, the agent's scraps landing one by one, each its own crop", async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = await h.board('/api/notebooks/call', { call });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const page = opened.body.page.id as number;
  // (an ordinary page of My journal, titled for the call)
  const shelf = (await h.board('/api/notebooks')).body.shelf as any[];
  const notebook = shelf.find(n => n.id === opened.body.notebook);
  assert.equal(notebook.kind, 'mine');
  // (the call's date and time first, then who it's with till the agent names its topic.)
  const when = companyTime(Date.parse(callnotes.liveCall(call)!.ts));
  assert.equal(pageNow(page).label, `${when}, Call with Juno`);
  assert.equal((await h.board('/api/notebooks/call', { call })).body.page.id, page, 'the same page, asked again');
  const listed = (await h.board(`/api/notebooks/pages?notebook=${notebook.id}`)).body.pages as any[];
  assert.equal(listed.at(-1).id, page, 'the newest page of My journal');

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
      goal: GOAL,
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    // (with its box on the page, for the agent's ring on it)
    assert.match(
      made.body.ok,
      new RegExp(`^Scrap ${i + 1} is on the call's page \\(#\\d+\\) at \\d+, \\d+, \\d+, \\d+,`),
    );
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
  // (each the page's last unit as it lands, its picture at the unit's top-left, room to write under it)
  assert.deepEqual(
    scraps.map(g => [g.pictures[0].x, g.pictures[0].y, g.h]),
    scraps.map(g => [0, 0, g.pictures[0].h + ROOM]),
  );

  // What the line can't cut is refused in words
  const refused = async (body: Record<string, unknown>) => {
    const r = await h.voice('scrap', {
      call,
      from: 'note 1',
      region: { x: 0, y: 0, width: 0.5, height: 1 },
      words: 'x',
      goal: GOAL,
      ...body,
    });
    return [r.status, r.body.error];
  };
  assert.equal((await refused({ from: 'note 9' }))[0], 404);
  assert.equal((await refused({ region: { x: 0.8, y: 0, width: 0.5, height: 1 } }))[0], 400);
  assert.equal((await refused({ words: '' }))[0], 400);
  assert.equal((await refused({ owner: 'nobody' }))[0], 400);
  assert.equal((await refused({ goal: '' }))[0], 400, 'an ask on the call has the board’s why');
  assert.deepEqual(await refused({ from: '-20s' }), [404, 'No screen is being shown on this call.']);

  // Its title, a short topic after the call's date and time; what the agent records on the call, written on the page
  assert.equal((await h.voice('title', { call, title: 'Shop page: price, basket, banner' })).status, 400);
  assert.equal((await h.voice('title', { call, title: 'Shop page: price' })).status, 200);
  assert.equal(pageNow(page).label, `${when}, Shop page: price`);
  ledger.add(
    call,
    { kind: 'promise', owner: 'juno', what: 'Send the board the new shop page', goal: 'See it live', quote: 'send it' },
    null,
  );
  const typed = (await groups(page)).at(-1);
  assert.deepEqual(
    [typed.kind, typed.by, typed.texts[0].text],
    ['note', 'juno', 'Promise for Juno: Send the board the new shop page'],
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

  // The call ends: the page goes in as it is, nothing on it sent anywhere, and it stays among My journal's pages
  await h.voice('call-end', { agent: 'juno', lines: ['Board: smaller, move it here, and drop this.'], token });
  await wentIn(page);
  const pagesNow = (await h.board(`/api/notebooks/pages?notebook=${notebook.id}`)).body.pages as any[];
  assert.ok(
    pagesNow.some(p => p.id === page),
    "left among My journal's pages, not its archive",
  );
  const after = await groups(page);
  assert.deepEqual(
    after.map(g => [g.kind, g.by, g.status, !!g.note]),
    [
      ['scrap', 'juno', 'sent', false],
      ['scrap', 'juno', 'sent', false],
      ['scrap', 'juno', 'sent', false],
      ['note', 'juno', 'sent', false],
      ['drawing', 'board', 'sent', false],
      ['drawing', 'board', 'sent', false],
    ],
    "the agent's promise stays on the page, as the board's lines do: none goes to anyone",
  );
  const { shelf: afterShelf } = (await h.board('/api/notebooks')).body;
  assert.ok(
    afterShelf.some((n: any) => n.id === notebook.id),
    'My journal stays on the shelf',
  );
  assert.equal(
    (
      await h.voice('scrap', {
        call,
        from: 'note 1',
        region: { x: 0, y: 0, width: 1, height: 1 },
        words: 'late',
        goal: GOAL,
      })
    ).status,
    404,
  );
});

test('a call with nothing on its page leaves no page', async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  await h.voice('call-end', { agent: 'juno', lines: ['Board: Just checking in.'], token });
  await until(() => !pageNow(opened.page.id), 'the blank page went');
  assert.ok(db.prepare('select 1 from notebooks where id = ?').get(opened.notebook), 'My journal stays');
});

test("a call page with only what the agent recorded goes in, and isn't left as My journal's open page", async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  ledger.add(
    call,
    { kind: 'task', owner: 'juno', what: 'Make the price smaller', goal: 'A calmer shop', quote: 'make it smaller' },
    null,
  );
  await h.voice('call-end', { agent: 'juno', lines: ['Board: Make the price smaller.'], token });
  await wentIn(opened.page.id);
  assert.notEqual(currentPage(opened.notebook), opened.page.id, "not My journal's open page");
});

test("nothing on the call's page goes to anyone: its asks are items for the follow-up, whose brief names the page", async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  ledger.add(
    call,
    { kind: 'promise', owner: 'moss', what: 'Draw the new basket icon', goal: GOAL, quote: 'Moss draws it' },
    null,
  );
  const forBoard = ledger.add(
    call,
    { kind: 'promise', owner: 'board', what: 'Try the shop on the phone', goal: GOAL, quote: 'you try it' },
    null,
  ) as { id: number };
  const asks = () => ledger.items(call).filter(i => i.id !== forBoard.id);
  assert.deepEqual(
    asks().map(i => [i.kind, i.owner, i.what]),
    [
      ['task', 'wren', 'Make the price smaller'],
      ['promise', 'moss', 'Draw the new basket icon'],
    ],
    'the scrap is on the call’s list too',
  );
  assert.equal((await groups(page)).length, 3, 'the scrap and the two promises');

  const before = lastJob();
  await ends(page, token);
  deliverDue(Date.now() + 60_000);
  assert.deepEqual(queuedFor(before, ['wren', 'moss']), [], 'no job for an owner but what the follow-up hands out');
  assert.deepEqual(
    (await groups(page)).map(g => [g.kind, g.status, !!g.note]),
    [
      ['scrap', 'sent', false],
      ['note', 'sent', false],
      ['note', 'sent', false],
    ],
    'each stays on the page as it went in',
  );
  assert.ok(
    asks().every(i => i.status === 'open' && i.job == null),
    'nothing handed out by the page',
  );
  const followUp = (db.prepare('select job from calls where id = ?').get(call) as { job: number }).job;
  const brief = (db.prepare('select prompt from jobs where id = ?').get(followUp) as { prompt: string }).prompt;
  assert.ok(brief.includes(`hq sketch ${page}`), 'the brief names the page');
});

test("a call's notes page can't be sent: its follow-up hands each ask out once with a size the CEO can revise", async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  promise(call, 'moss', 'Draw the new basket icon');
  const sent = await h.board('/api/notebooks/pages/send', { id: page });
  assert.deepEqual([sent.status, pageNow(page).send_at], [409, null], 'Send refused while the call is on');

  const before = lastJob();
  await ends(page, token);
  deliverDue(Date.now() + 60_000);
  const followUp = await h.claimJob(
    (db.prepare('select job from calls where id = ?').get(call) as { job: number }).job,
  );
  const asks = ledger.items(call);
  assert.equal(asks.length, 2, 'the scrap and the promise');
  for (const i of asks) {
    const ask = {
      agent: i.owner,
      title: i.what,
      prompt: `${i.what}.`,
      item: i.id,
      by: 'none',
      size: '40m',
      refs: [],
      why: 'No comparable past job in this fixture, a whole visual check',
    };
    const handed = await h.agent('job', followUp.token, ask);
    assert.equal(handed.status, 200, JSON.stringify(handed.body));
    const job = handed.body.id;
    assert.equal(h.jobs.openJobs({}).find(j => j.id === job)!.queued_by, 'juno');
    assert.equal((await estimate(job, followUp.token)).estimate.agent_minutes, 40);
    const revised = await h.agent('sizes', followUp.token, { job, time: '55m', why: 'The check includes more flows' });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal((await estimate(job, followUp.token)).estimate.agent_minutes, 55);
    assert.equal((await h.agent('job', followUp.token, ask)).status, 409, 'never handed out twice');
  }
  assert.deepEqual(queuedFor(before, ['wren', 'moss']), ['moss', 'wren'], 'one job for each owner');
});

test("a call's notes page is under Calls, and stamped Sent by its follow-up handing it out, not by the call's end", async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const listed = async () => {
    const { pages } = (await h.board(`/api/notebooks/pages?notebook=${pageNow(page).notebook}`)).body;
    return (pages as any[]).find(p => p.id === page);
  };
  assert.equal((await listed()).chapter, 'calls');
  await ends(page, token);
  const ended = await listed();
  assert.deepEqual(
    [ended.sending, ended.sent, ended.readonly],
    [false, null, true],
    'with its follow-up: shut, unstamped',
  );
  const followUp = await h.claimJob(
    (db.prepare('select job from calls where id = ?').get(call) as { job: number }).job,
  );
  for (const i of ledger.items(call)) {
    const ask = { agent: i.owner, title: i.what, prompt: `${i.what}.`, item: i.id, by: 'none' };
    assert.equal((await h.agent('job', followUp.token, ask)).status, 200);
  }
  assert.equal((await h.agent('reply', followUp.token, { text: 'Handed out.' })).status, 200);
  const before = Date.now();
  assert.equal((await h.finish(followUp)).status, 200);
  const sent = (await listed()).sent;
  assert.ok(sent && Date.parse(sent) >= before - 1000, `stamped Sent as the follow-up handed it out: ${sent}`);
});
const estimate = async (job: number, token: string) => (await h.agent(`estimate?q=%23${job}`, token)).body;

// The last job's number, and the agents of the jobs queued after it for any of owners
const lastJob = () => (db.prepare('select max(id) n from jobs').get() as { n: number | null }).n ?? 0;
const queuedFor = (after: number, owners: string[]) =>
  (
    db
      .prepare(`select agent from jobs where id > ? and agent in (${owners.map(() => '?').join(', ')}) order by agent`)
      .all(after, ...owners) as { agent: string }[]
  ).map(j => j.agent);
const promise = (call: number, owner: string, what: string) =>
  (ledger.add(call, { kind: 'promise', owner, what, goal: GOAL, quote: what }, null) as { id: number }).id;
const groupOf = (item: number) =>
  (db.prepare('select grp from call_asks where item = ?').get(item) as { grp: number }).grp;
const itemOf = (call: number, id: number) => ledger.items(call).find(i => i.id === id)!;
const ownerOf = (grp: number) =>
  (db.prepare('select owner from notebook_groups where id = ?').get(grp) as { owner: string | null }).owner;
// The call ended, its page gone in
const ends = async (page: number, token: string) => {
  await h.voice('call-end', { agent: 'juno', lines: ['Board: smaller, and move it here.'], token });
  await wentIn(page);
};
// A job given asks of the call without carrying any (ledger.ts given)
function givenJob(owner: string, items: number[]) {
  const { id } = jobs.createJob({ agent: owner, title: "The board's notes", prompt: 'x' });
  ledger.given(items, id, false);
  return id;
}

test('each ask goes with its own group, and one the board deletes is dropped at the end', async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const other = await h.voice('scrap', {
    call,
    from: 'note 1',
    region: { ...THIRD, x: 1 / 3 },
    words: 'Move the basket up',
    goal: GOAL,
    owner: 'wren',
  });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const [scrapItem, otherItem] = ledger.items(call).map(i => i.id);
  const icon = promise(call, 'moss', 'Draw the new basket icon'),
    green = promise(call, 'moss', 'Colour it green'),
    players = promise(call, 'kit', 'Tell the players');
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: other.body.id })).status, 200);
  // (one with work queued on the call: deleted, its job is cancelled)
  const sign = await queuedOnCall(token, 'moss', 'Draw the shop sign', 'SIGN');
  const signItem = h.job(sign).item as number;
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: groupOf(signItem) })).status, 200);
  // (one about work under way from before the call: deleted, it stays linked to that work, which goes on)
  const { id: under } = jobs.createJob({ agent: 'moss', title: 'Paint the shop door', prompt: 'x', queuedBy: 'lyra' });
  const door = promise(call, 'moss', 'Paint the door');
  assert.equal(
    typeof ledger.link(door, { job: under }, 'juno', 0),
    'object',
    'linked on the call, as the item tool does',
  );
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: groupOf(door) })).status, 200);
  // (and one about work the call's own agent queued off the call during it, say from its follow-up of an earlier call:
  const { id: aside } = jobs.createJob({
    agent: 'moss',
    title: 'Paint the shop window',
    prompt: 'x',
    queuedBy: 'juno',
  });
  const pane = promise(call, 'moss', 'Paint the window');
  assert.equal(typeof ledger.link(pane, { job: aside }, 'juno', 0), 'object');
  assert.equal(h.job(aside).item, pane, 'it carries the promise');
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: groupOf(pane) })).status, 200);
  assert.deepEqual(
    [scrapItem, icon, green, players].map(i => ownerOf(groupOf(i))),
    ['wren', 'moss', 'moss', 'kit'],
    'each ask is its own group, its owner its own',
  );

  await ends(page, token);
  for (const off of [otherItem, signItem])
    assert.deepEqual([itemOf(call, off).status, itemOf(call, off).why], ['dropped', "taken off the call's page"]);
  assert.equal(h.job(sign).status, 'cancelled');
  assert.deepEqual([itemOf(call, door).status, itemOf(call, door).job, h.job(under).status], ['open', under, 'queued']);
  assert.deepEqual([itemOf(call, pane).status, itemOf(call, pane).job, h.job(aside).status], ['open', aside, 'queued']);
  for (const i of [scrapItem, icon, green, players])
    assert.equal(typeof ledger.handOut(i, () => true), 'object', 'the follow-up hands it out');
});

test('an ask the board deletes on a page it archives is dropped all the same', async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const [item] = ledger.items(call);
  const deleted = promise(call, 'kit', 'Tell the players');
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: groupOf(deleted) })).status, 200);
  assert.equal((await h.board('/api/notebooks/pages/archive', { id: page, archived: true })).status, 200);
  await h.voice('call-end', { agent: 'juno', lines: ['Board: smaller.'], token });
  await until(() => itemOf(call, deleted).status === 'dropped', 'one it deleted is dropped all the same');
  assert.equal(pageNow(page).send_at, null, 'an archived page stays as the board put it');
  assert.equal(typeof ledger.handOut(item.id, () => true), 'object');
  assert.match(String(ledger.handOut(deleted, () => true)), /is dropped/);
});

test('a job given asks is their work: cancelled once none is current, else told to change course', async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const icon = promise(call, 'moss', 'Draw the new basket icon'),
    green = promise(call, 'moss', 'Colour it green'),
    players = promise(call, 'kit', 'Tell the players');
  await ends(page, token);
  const kit = { job: givenJob('kit', [players]) },
    moss = { job: givenJob('moss', [icon, green]) };
  const followUp = (db.prepare('select job from calls where id = ?').get(call) as { job: number }).job;
  const toldTo = (job: number) =>
    (db.prepare('select text from messages where job = ?').all(job) as { text: string }[]).map(m => m.text).join('\n');

  assert.equal(typeof ledger.drop(players, 'The board took it back', followUp), 'object');
  assert.equal(h.job(kit.job).status, 'cancelled', 'its one ask withdrawn, before it started');
  const round = ledger.add(
    call,
    { kind: 'promise', owner: 'moss', what: 'Draw it round', goal: GOAL, quote: 'round', replaces: icon },
    followUp,
  );
  assert.equal(typeof round, 'object', JSON.stringify(round));
  assert.equal(h.job(moss.job).status, 'queued', 'Colour it green is still its work');
  assert.match(toldTo(moss.job), new RegExp(`item #${icon} .* was replaced .*Stop or change course`));
  assert.doesNotMatch(toldTo(moss.job), /goes on as before/);
});

test('work a job given asks hands on is their work too: it hears a correction, and a drop cancels it', async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const players = promise(call, 'kit', 'Tell the players'),
    news = promise(call, 'kit', 'Write the news post');
  await ends(page, token);
  const kit = { job: givenJob('kit', [players, news]) };
  const run = await h.claimJob(kit.job);
  const handed = await h.agent('job', run!.token, {
    agent: 'moss',
    title: 'Post the news',
    prompt: 'Post it.',
    code: 'NEWS',
  });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  const moss = handed.body.id as number;
  const brief = (db.prepare('select prompt from jobs where id = ?').get(moss) as { prompt: string }).prompt;
  assert.match(brief, new RegExp(`Why the board wants this \\(item #${players}, call #${call}\\): ${GOAL}`));
  const followUp = (db.prepare('select job from calls where id = ?').get(call) as { job: number }).job;
  const toldTo = (job: number) =>
    (db.prepare('select text from messages where job = ?').all(job) as { text: string }[]).map(m => m.text).join('\n');

  const later = {
    kind: 'promise',
    owner: 'kit',
    what: 'Tell the testers',
    goal: GOAL,
    quote: 'testers',
    replaces: players,
  };
  assert.equal(typeof ledger.add(call, later, followUp), 'object');
  assert.equal(h.job(moss).status, 'queued', 'the news post is still its work');
  assert.match(toldTo(moss), new RegExp(`item #${players} .* was replaced .*Stop or change course`));
  assert.equal(typeof ledger.drop(news, 'The board took it back', followUp), 'object');
  assert.equal(h.job(moss).status, 'cancelled', 'none of its asks is current');
  // (and the given job hands nothing more on)
  const again = await h.agent('job', run!.token, {
    agent: 'moss',
    title: 'Post it after all',
    prompt: 'Post it.',
    code: 'POST',
  });
  assert.equal(again.status, 409, JSON.stringify(again.body));
});

// A job the live call queues for owner (the job tool), and its number
async function queuedOnCall(token: string, owner: string, title: string, code: string, more = {}) {
  const queued = await h.agent('job', token, { agent: owner, title, prompt: `${title}.`, goal: GOAL, code, ...more });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return queued.body.id as number;
}

test("a job the call queues carries its promise on the call's page, which stays there with it", async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const icon = await queuedOnCall(token, 'moss', 'Draw the new basket icon', 'ICON');
  const promised = ledger.items(call).find(i => i.what === 'Draw the new basket icon')!;
  assert.deepEqual(
    [promised.kind, promised.owner, promised.job, h.job(icon).item],
    ['promise', 'moss', icon, promised.id],
  );
  assert.equal(
    (await groups(page)).find(g => g.id === groupOf(promised.id)).texts[0].text,
    'Promise for Moss: Draw the new basket icon',
  );
  // (a promise noted first goes as the job's item)
  const players = promise(call, 'kit', 'Tell the players');
  const told = await queuedOnCall(token, 'kit', 'Tell the players', 'PLAYERS', { item: players });
  assert.equal(itemOf(call, players).job, told);
  assert.equal(ledger.items(call).length, 3, 'the scrap and the two promises, none twice');

  await ends(page, token);
  const after = await groups(page);
  assert.deepEqual(
    [promised.id, players].map(i => after.find(g => g.id === groupOf(i))).map(g => [g.status, !!g.note]),
    [
      ['sent', false],
      ['sent', false],
    ],
    'each stays on the page with its job',
  );
  assert.deepEqual([itemOf(call, promised.id).job, itemOf(call, players).job], [icon, told]);
});

test("an ask follows its own lines however the board retypes them; the board's own lines lifted out stay on the page", async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const icon = promise(call, 'moss', 'Draw the new basket icon');
  const into = groupOf(icon);
  const now = async () => (await groups(page)).find(g => g.id === into);
  // (Moss's icon line retyped, and a line of the board's own typed into the note)
  const note = await now();
  const iconLine = (t: any) => t.text.startsWith('Promise for Moss: Draw the new basket');
  const texts = note.texts.map((t: any) => (iconLine(t) ? { ...t, text: `${t.text}, in green` } : t));
  const own = { ...note.texts[0], id: undefined, y: note.box.y + note.box.h + 20, text: 'And the cart too' };
  const edit = { id: into, since: note.updated, texts: [...texts, own] };
  assert.equal((await h.board('/api/notebooks/groups/edit', edit)).status, 200);
  const split = await h.board('/api/notebooks/groups/split', {
    id: into,
    texts: [(await now()).texts.findIndex((t: any) => t.text === 'And the cart too')],
  });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const added = split.body.split.id as number;
  assert.equal(groupOf(icon), into, 'the retyped line keeps its ask');
  // (a post-it is the agent's words: the board's own line lifted out is plain typed words; a promise for the board
  // lifted out of the board's line stays a post-it, and the board's line left behind is plain.)
  promise(call, 'board', 'Try the shop on the phone');
  const yours = (await groups(page)).find(g => g.texts[0]?.text.startsWith('Promise for you'));
  const mine = { ...yours.texts[0], id: undefined, y: yours.box.y + yours.box.h + 20, text: 'Mine too' };
  const typed = { id: yours.id, since: yours.updated, texts: [mine, ...yours.texts] };
  assert.equal((await h.board('/api/notebooks/groups/edit', typed)).status, 200);
  const out = await h.board('/api/notebooks/groups/split', { id: yours.id, texts: [1] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const lifted = out.body.split.id as number;
  const kinds = new Map((await groups(page)).map(g => [g.id, g.kind]));
  assert.deepEqual(
    [into, added, lifted, yours.id].map(id => kinds.get(id)),
    ['note', 'drawing', 'note', 'drawing'],
  );
  assert.equal(
    (await h.voice('change', { call, id: lifted, words: 'Try the shop on the tablet' })).status,
    200,
    'the promise lifted out is still its one note',
  );

  await ends(page, token);
  const after = await groups(page);
  assert.deepEqual(
    [into, added].map(id => after.find(g => g.id === id)).map(g => [g.texts[0].text, g.status]),
    [
      ['Promise for Moss: Draw the new basket icon, in green', 'sent'],
      ['And the cart too', 'sent'],
    ],
    'the retyped ask and the board’s own line stay on the page as it left them',
  );
});

test("the board's word passed on to running work is on the call's page as passed on", async () => {
  const { call, token, page } = await scrapped({ owner: 'wren' });
  const { id: running } = jobs.createJob({ agent: 'moss', title: 'Draw the icon', prompt: 'x' });
  const item = ledger.reached(call, {
    owner: 'moss',
    what: 'Keep the icon round',
    goal: GOAL,
    words: 'Keep it round',
    job: running,
    ref: 'sent on the call',
  });
  const passed = (await groups(page)).find(g => g.id === groupOf(item));
  assert.deepEqual(passed.texts.map((t: any) => t.text).join(' '), 'Message for Moss: Keep the icon round');
  await ends(page, token);
  const left = (await groups(page)).find(g => g.id === passed.id);
  assert.deepEqual([left.status, !!left.note], ['sent', false], 'it reached its work already');
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
async function scrapped(more: { owner?: string } = {}) {
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  await h.board('/api/book/note', {
    page,
    anchor,
    words: 'smaller, and move it here',
    said: 'spoken',
    snip: `data:image/png;base64,${THREE.toString('base64')}`,
  });
  const made = await h.voice('scrap', {
    call,
    from: 'note 1',
    region: THIRD,
    words: 'Make the price smaller',
    goal: GOAL,
    ...more,
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return { call, token, page, scrap: made.body.id as number };
}
const THIRD = { x: 0, y: 0, width: 1 / 3, height: 1 };

test("a scrap's item keeps the agent's line through the board's Undo of its new words, and the board's own words stay its", async () => {
  const { call, token, page, scrap } = await scrapped();
  const other = await h.voice('scrap', {
    call,
    from: 'note 1',
    region: { ...THIRD, x: 1 / 3 },
    words: 'Move the basket up',
    goal: GOAL,
  });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  // (the board's Undo puts the scrap's post-it back as it was; on the other it writes its own words)
  for (const [id, words] of [
    [scrap, 'Make the price smaller'],
    [other.body.id, 'Move the basket up\nand make it green'],
  ]) {
    assert.equal((await h.voice('change', { call, id, words: 'Make it smaller still' })).status, 200);
    const g = (await groups(page)).find(g => g.id === id);
    const edited = await h.board('/api/notebooks/groups/edit', { id, since: g.updated, words, said: 'typed' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
  }
  await ends(page, token);
  assert.deepEqual(
    ledger.items(call).map(i => i.what),
    ['Make the price smaller', 'Make it smaller still'],
    "the Undo takes the line back; the board's words on the post-it are its own, not the item's line",
  );
});

test('a scrap still being cut as the call ends is refused: the page goes in as it was', async () => {
  const { call, token, page } = await scrapped();
  const late = callnotes.scrap({
    call,
    from: 'note 1',
    region: { ...THIRD, x: 1 / 3 },
    words: 'Move the basket up',
    goal: GOAL,
  });
  handOver('juno', ['Board: smaller, and move it here.'], 0, token);
  assert.deepEqual(await late, [404, 'This call has ended: its page has gone in.']);
  await wentIn(page);
  assert.deepEqual(
    (await groups(page)).map(g => [g.words, g.status]),
    [['Make the price smaller', 'sent']],
  );
});

test("the board's scribble on a call is for its agent: not judged, never a scrap by itself, gone with an empty page", async () => {
  const { call, token } = await h.liveCall('juno');
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  // (the book's first mark on a call finds the notes page as the call's page, never a second one)
  const made = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  assert.equal(made.id, opened.page.id);
  const { note } = (
    await h.board('/api/book/note', {
      page: made.id,
      anchor,
      words: 'move this here',
      said: 'spoken',
      snip: `data:image/png;base64,${THREE.toString('base64')}`,
    })
  ).body;
  await new Promise(res => setTimeout(res, 50));
  assert.deepEqual((await h.worker('reads/claim')).body, {}, 'no judge read: no reply or try starts by itself');
  assert.equal((await groups(made.id)).length, 0, 'nothing on the page while the call is on');
  const routings = () => db.prepare('select count(*) n from note_routes').get();
  const before = routings();
  await h.voice('call-end', { agent: 'juno', lines: ['Board: move this here.'], token });
  await until(() => !pageNow(made.id), 'the empty page went');
  assert.equal(db.prepare('select 1 from book_notes where id = ?').get(note.id), undefined, 'its scribble with it');
  // (no routing check guesses at it without the call)
  assert.deepEqual(routings(), before);
});

test("at hang-up the agent's scraps and the board's typed words and pictures go in, its scribbles not", async () => {
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
    goal: GOAL,
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
  await wentIn(page);
  const after = await groups(page);
  assert.deepEqual(
    after.map(g => [g.kind, g.by, g.words, g.said, g.texts.map((t: any) => t.text), g.pictures.length, g.status]),
    [
      ['scrap', 'juno', 'Make the price smaller', 'typed', [], 1, 'sent'],
      ['drawing', 'board', '', null, ['Teal everywhere'], 0, 'sent'],
      ['drawing', 'board', '', null, [], 1, 'sent'],
    ],
    "the note cut from is the agent's scrap; the words and picture go, and the notes it made nothing of stay out",
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
  await wentIn(page);
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

test("the board's first mark on a call, before the notes page is asked for, is on the notes page in My journal", async () => {
  const myNotebook = () => (db.prepare("select id, archived from notebooks where kind = 'mine'").get() as any) ?? {};
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  assert.equal(pageNow(page.id).notebook, myNotebook().id);
  // (the book lists which notebook has a call's page, so HQ asks nothing of one at hang-up: calldraw.js)
  assert.equal((await h.board('/api/book')).body.pages.find((p: any) => p.id === page.id).notebook, myNotebook().id);
  const opened = (await h.board('/api/notebooks/call', { call })).body;
  assert.deepEqual([opened.page.id, opened.notebook], [page.id, myNotebook().id]);
  // what the book wrote on it the old way goes in as groups as the call ends, once
  const line = {
    color: '#2b2230',
    size: 6,
    points: [
      [20, 20, 0.5, 0],
      [300, 200, 0.5, 16],
    ],
  };
  await h.board('/api/book/page/save', { id: page.id, ink: [line], scraps: [] });
  await h.voice('call-end', { agent: 'juno', lines: ['Board: that line.'], token });
  await wentIn(page.id);
  const drawn = (await groups(page.id)).length;
  assert.ok(drawn > 0, 'carried as groups');
  await h.board('/api/notebooks');
  assert.equal((await groups(page.id)).length, drawn, 'carried once');
  assert.equal(myNotebook().archived, 0, 'My journal stays on the shelf');
});

test("a call's pages read like any page, a customer call's too, but a keys call's pages stay its agent's", async () => {
  const sketches = async (token: string) =>
    ((await h.agent('sketches', token)).body.sketches as { id: number }[]).map(p => p.id);
  const holds = async (job: number) => (await h.worker('customers', { job })).body.customers as boolean;
  const kit = await h.start({ agent: 'kit' });
  const { call, token } = await h.liveCall('juno');
  jobs.readerHanded({ id: 0, agent: 'juno', callId: call }); // (a look-up on the call handed it a customer's details)
  const page = (await h.board('/api/notebooks/call', { call })).body.page.id as number;
  await h.board('/api/book/note', { page, anchor, words: 'the colours here', said: 'spoken' });
  // (the agent's own note keeps the page: the board's scribble alone doesn't go in.)
  assert.equal((await h.voice('scrap', { call, words: 'Warmer colours', goal: GOAL })).status, 200);
  await h.voice('call-end', { agent: 'juno', lines: ['Board: that line.'], token });
  await wentIn(page);
  assert.ok((await sketches(kit.token)).includes(page));
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
  const keys = await h.liveCall('wren', card.id);
  const kept = (await h.board('/api/notebooks/call', { call: keys.call })).body.page.id as number;
  // the judge reads the board's typed note as asking to see it made: its versions come under it, on the call's page
  const typed = (
    await h.board('/api/notebooks/groups/create', {
      page: kept,
      texts: [{ x: 40, y: 80, w: 200, text: 'where it goes', color: '#2a2352' }],
    })
  ).body;
  tryNow({ grp: typed.id }, { id: 1, why: 'it asks to see where the key goes' });
  assert.equal(db.prepare('select 1 from book_pages where tries = ?').get(typed.id), undefined, 'no page of its own');
  assert.equal((await h.voice('scrap', { call: keys.call, words: 'The key goes here', goal: GOAL })).status, 200);
  const written = { x: 40, y: 60, w: 300, text: 'Under the mat', color: '#2F6BDC' };
  assert.equal((await h.board('/api/book/page/save', { id: kept, ink: [], scraps: [], texts: [written] })).status, 200);
  // (the voice line names the card it rang about again at hang-up: call.ts handOver)
  await h.voice('call-end', { agent: 'wren', lines: ['Board: done.'], request: card.id, token: keys.token });
  await wentIn(kept);
  // what the board wrote on the page goes to nobody, never through the CEO's routing check: its follow-up has it
  assert.deepEqual(sentTo(kept), []);
  const listed = await sketches(kit.token);
  assert.ok(!listed.includes(kept), `page ${kept} isn't listed`);
  assert.equal((await h.agent(`sketch?id=${kept}`, kit.token)).status, 404);
  const wren = await h.start({ agent: 'wren' });
  assert.equal((await h.agent(`sketch?id=${kept}`, wren.token)).status, 200, "its own agent's");
});

// Who each of a page's sent groups went to
const sentTo = (page: number) =>
  (
    db
      .prepare(
        `select distinct s.owner from notebook_groups g join book_notes n on n.id = g.note
          join book_sheets s on s.id = n.sheet where g.page = ? order by s.owner`,
      )
      .all(page) as { owner: string | null }[]
  ).map(r => r.owner);

test("a keys call's asks stay with its agent: a scrap naming another is refused, and a carried page goes to nobody", async () => {
  const card = jobs.createRequest({
    kind: 'credential',
    title: 'Another key',
    body: 'b',
    agent: 'wren',
    secrets: 'CALLNOTES_TEST_KEY_TWO',
  }) as { id: number };
  const keys = await h.liveCall('wren', card.id);
  // The board's first mark comes before the notes page is made, and the shelf carries that page into My journal
  const page = (await h.board('/api/book/page/new', { kind: 'call', call: keys.call, w: 1024, h: 768 })).body.id;
  const written = { x: 40, y: 60, w: 300, text: 'Behind the clock', color: '#2F6BDC' };
  await h.board('/api/book/page/save', { id: page, ink: [], scraps: [], texts: [written] });
  await h.board('/api/notebooks');
  assert.equal((await h.board('/api/notebooks/call', { call: keys.call })).body.page.id, page);
  const named = await h.voice('scrap', { call: keys.call, words: 'Juno files it', goal: GOAL, owner: 'juno' });
  assert.equal(named.status, 400);
  assert.equal((await h.voice('scrap', { call: keys.call, words: 'The key goes here', goal: GOAL })).status, 200);
  assert.deepEqual(
    ledger.items(keys.call).map(i => i.owner),
    ['wren'],
    "its list's item is the agent's",
  );
  await h.voice('call-end', { agent: 'wren', lines: ['Board: done.'], request: card.id, token: keys.token });
  await wentIn(page);
  assert.deepEqual(sentTo(page), [], "the board's words and the agent's scrap, for the follow-up");
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
