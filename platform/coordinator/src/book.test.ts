// node --test src/book.test.ts   (the harness: the test company, the real server, the board's session, a job's hq)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp, { type OutputInfo } from 'sharp';
import { harness } from './harness.ts';

const h = await harness('book');
const { base, agent, db } = h;
const { ORIGIN } = await import('./config.ts');
const { BOARD_CALL } = await import('./jobs.ts');
const booknotes = await import('./booknotes.ts');
const booksheets = await import('./booksheets.ts');
const sketchbook = await import('./sketchbook.ts');
const DIR = `${h.dataDir}/book`;

const STROKE = {
  color: '#2B2230',
  size: 8,
  points: [
    [10, 20, 0.5, 0],
    [190, 120, 0.6, 16],
  ],
};
const red = (w = 40, h = 30) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
const SNIP = `data:image/png;base64,${(await red(20, 10)).toString('base64')}`;
const anchor = (more: Record<string, unknown> = {}) => ({
  v: 1,
  url: `${ORIGIN}/?open=projects#t=secret`,
  el: { selector: '#projects > li:nth-child(2)', tag: 'li', text: 'Margin', box: { x: 10, y: 400, w: 300, h: 40 } },
  view: { w: 1024, h: 768, x: 0, y: 300, dpr: 2 },
  ink: [STROKE],
  ...more,
});
const newPage = async (body: Record<string, unknown>) =>
  (await h.board('/api/book/page/new', { w: 800, h: 600, ...body })).body;
const addNote = (body: Record<string, unknown>) =>
  h.board('/api/book/note', { anchor: anchor(), words: '', said: 'typed', ...body });
const upload = async (page: number, bytes: Buffer) =>
  (await fetch(`${base}/api/book/scrap?id=${page}`, {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/png' },
  }).then(r => r.json())) as { file: string; url: string };
const picture = async (url: string) => {
  const res = await fetch(base + url, { headers: { cookie: h.boardCookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  return sharp(Buffer.from(await res.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true });
};
const pixel = (p: { data: Buffer; info: OutputInfo }, x: number, y: number) => [
  ...p.data.subarray((y * p.info.width + x) * p.info.channels, (y * p.info.width + x) * p.info.channels + 3),
];

test('a page is made today, saved with its ink and scraps, and drawn here as a picture, with no browser', async () => {
  const page = await newPage({ kind: 'free', label: '  Shop header\nidea ' });
  assert.equal(page.label, 'Shop header idea');
  assert.equal(page.kind, 'free');
  for (const refused of [
    { kind: 'sheet', url: '/?open=projects' },
    { kind: 'sheet', owner: 'nobody', url: '/' },
    { kind: 'diary' },
  ])
    assert.equal(
      (await h.board('/api/book/page/new', { w: 800, h: 600, ...refused })).status,
      400,
      JSON.stringify(refused),
    );
  const scrap = await upload(page.id, await red());
  assert.match(scrap.file, new RegExp(`^${page.id}-s-[0-9a-f]{8}\\.png$`));
  const placed = { file: scrap.file, x: 300, y: 300, w: 80, h: 60, tilt: 0 };
  const saved = await h.board('/api/book/page/save', { id: page.id, ink: [STROKE], scraps: [placed], h: 1200 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.h, 1200, 'a page grows downward');
  assert.equal((await h.board('/api/book/page/save', { id: page.id, ink: [], scraps: [], h: 99_999 })).status, 400);

  // drawn twice the page's size: the paper, the scrap in its white border, the ink over it (read twice at once)
  const [drawn] = await Promise.all([picture(saved.body.picture), picture(saved.body.picture)]);
  assert.deepEqual([drawn.info.width, drawn.info.height], [1600, 2400]);
  assert.deepEqual(pixel(drawn, 1500, 2300), [255, 253, 248], 'paper');
  assert.deepEqual(pixel(drawn, 680, 660), [255, 0, 0], "the scrap's picture");
  assert.deepEqual(pixel(drawn, 604, 700), [255, 255, 255], 'its border');
  assert.ok(
    pixel(drawn, 20, 40).every(c => c < 80),
    'the ink',
  );
  const kept = readdirSync(DIR).filter(f => new RegExp(`^${page.id}-[0-9a-f]{8}\\.png$`).test(f));
  assert.equal(kept.length, 1, 'one kept, however many read it at once, until the next change');
  assert.equal(statSync(`${DIR}/${kept[0]}`).mode & 0o777, 0o600);

  const today = (await h.board('/api/book')).body;
  assert.equal(today.day, today.today);
  assert.ok(today.pages.some((p: any) => p.id === page.id));
  assert.deepEqual(today.days[0], { day: today.today, pages: today.pages.length });
  assert.equal((await h.board(`/api/book/page?id=${page.id}`)).body.scraps[0].url, scrap.url);
  assert.equal((await h.board('/api/book/page/delete', { id: page.id })).status, 200);
  assert.ok(!readdirSync(DIR).some(f => f.startsWith(`${page.id}-`)), 'its files go with it');
});

test("label, archive and a picture's upload at the book's own routes, refused for a page that isn't there", async () => {
  const page = await newPage({ kind: 'free' });
  const labelled = await h.board('/api/book/page/label', { id: page.id, label: 'Mug handle' });
  assert.deepEqual([labelled.body.label, labelled.body.updated], ['Mug handle', page.updated]);
  assert.equal((await h.board('/api/book/page/label', { id: page.id, label: 'x'.repeat(81) })).status, 400);
  assert.equal((await h.board('/api/book/page/archive', { id: page.id, archived: true })).body.archived, true);
  assert.equal((await h.board(`/api/book/page?id=${page.id}`)).body.archived, true);
  assert.equal((await h.board('/api/book/page/archive', { id: page.id, archived: 'yes' })).status, 400);

  const send = (id: number, bytes: Buffer, type = 'image/png') =>
    fetch(`${base}/api/book/scrap?id=${id}`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': type },
    }).then(r => r.status);
  assert.equal(await send(page.id, await red(), 'image/gif'), 415);
  assert.equal(await send(page.id, Buffer.from('<svg onload=alert(1)>')), 400);
  assert.equal(await send(page.id, await red(2001, 2)), 413, "past HQ's 2,000 px");
  assert.ok(!readdirSync(DIR).some(f => f.startsWith(`${page.id}-s-`)), 'nothing refused is kept');

  assert.equal((await h.board('/api/book/page/delete', { id: page.id })).status, 200);
  assert.equal(await send(page.id, await red()), 404);
  for (const path of ['label', 'archive', 'delete'])
    assert.equal((await h.board(`/api/book/page/${path}`, { id: page.id, label: 'x', archived: true })).status, 404);
});

test("a note joins its page owner's sheet, numbered; a free page's joins nobody's; a wrong anchor is refused", async () => {
  const wrens = await newPage({ kind: 'sheet', owner: 'wren', url: '/?open=studio' });
  const one = (await addNote({ page: wrens.id, words: 'Bigger, please', said: 'spoken', snip: SNIP })).body;
  const two = (await addNote({ page: wrens.id })).body;
  assert.equal(one.sheet.owner, 'wren');
  assert.equal(two.sheet.id, one.sheet.id);
  assert.deepEqual(
    two.sheet.notes.map((n: any) => [n.n, n.words, n.said]),
    [
      [1, 'Bigger, please', 'spoken'],
      [2, '', null],
    ],
  );
  assert.equal(one.note.anchor.url, `${ORIGIN}/?open=projects#t=…`, "the fragment's values left out");
  assert.equal(one.asked, null);
  const free = await newPage({ kind: 'free' });
  assert.equal((await addNote({ page: free.id })).body.sheet.owner, null);

  const refused = async (a: unknown) => (await addNote({ page: wrens.id, anchor: a })).body.error;
  assert.match(await refused(anchor({ v: 2 })), /version 1/);
  assert.match(await refused(anchor({ url: 'http://[' })), /the page's address/);
  assert.match(await refused(anchor({ el: { ...anchor().el, text: 'x'.repeat(201) } })), /at most 200 characters/);
  assert.match(await refused(anchor({ view: { w: 1024, h: 768, x: 0, y: null, dpr: 2 } })), /numbers/);
  assert.match(
    await refused(anchor({ ink: [{ ...STROKE, points: Array.from({ length: 120_001 }, () => [1, 1, 0.5, 0]) }] })),
    /full/,
  );

  // moved to another owner's sheet, wiped, reordered: numbered again each time
  const kits = (await h.board('/api/book/note/move', { id: one.note.id, to: 'kit' })).body;
  assert.deepEqual([kits.sheet.owner, kits.note.n], ['kit', 1]);
  const wrensNow = (await h.board('/api/book/sheets')).body.open.find((s: any) => s.owner === 'wren');
  assert.deepEqual(
    wrensNow.notes.map((n: any) => [n.id, n.n]),
    [[two.note.id, 1]],
  );
  const three = (await addNote({ page: wrens.id, words: 'And the logo' })).body;
  assert.deepEqual(
    (await h.board('/api/book/sheet/order', { id: wrensNow.id, notes: [three.note.id, two.note.id] })).body.notes.map(
      (n: any) => [n.id, n.n],
    ),
    [
      [three.note.id, 1],
      [two.note.id, 2],
    ],
  );
  assert.equal((await h.board('/api/book/note/delete', { id: three.note.id })).status, 200);
  assert.equal((await h.board('/api/book/sheets')).body.open.find((s: any) => s.owner === 'wren').notes[0].n, 1);
});

test("send, then undo within ten seconds: nothing goes; send and let it go: one task for the page's owner, the board's word", async () => {
  const page = await newPage({ kind: 'sheet', owner: 'moss', url: '/?open=gazette' });
  const sheet = (await addNote({ page: page.id, words: 'The headline wraps badly', snip: SNIP })).body.sheet;
  const sending = (await h.board('/api/book/send', { id: sheet.id })).body;
  assert.equal(sending.status, 'sending');
  assert.ok(sending.send_at - Date.now() > 9_000 && sending.send_at - Date.now() <= 10_000);
  const undone = (await h.board('/api/book/undo', { id: sheet.id })).body;
  assert.equal(undone.status, 'open');
  booksheets.deliverDue(Date.now() + 60_000);
  assert.equal(
    (await h.board('/api/book/sheets')).body.open.find((s: any) => s.id === sheet.id).status,
    'open',
    'undone: nothing went',
  );
  assert.ok(!h.db.prepare("select 1 from jobs where agent = 'moss'").get());

  await h.board('/api/book/send', { id: sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  assert.equal((await h.board('/api/book/undo', { id: sheet.id })).body.error, 'too late to undo: the sheet has gone');
  const sent = (await h.board('/api/book/sheets')).body.sent.find((s: any) => s.id === sheet.id);
  assert.equal(sent.status, 'sent');
  const job = h.db.prepare('select * from jobs where id = ?').get(sent.job) as any;
  assert.deepEqual([job.agent, job.kind, job.status], ['moss', 'work', 'queued']);
  assert.match(
    job.title,
    /^The board's notes on \/\?open=projects$/,
    "the address the note was made on, not its sheet page's",
  );
  const review = h.db.prepare('select * from review_notes where job = ?').get(job.id) as any;
  assert.equal(review.status, 'sent');
  assert.match(
    job.prompt,
    new RegExp(`## Note #${review.id} on ${ORIGIN.replace(/[.]/g, '\\.')}/\\?open=projects#t=…\\n`),
  );
  assert.match(job.prompt, /Note \(typed on the page\): The headline wraps badly/);
  assert.match(job.prompt, /hq answer <id>/);
  assert.doesNotMatch(job.prompt, /could have written one/, "HQ's own pages need no word on who wrote a note");
  assert.ok(
    (h.db.prepare(`select ${BOARD_CALL('j')} board from jobs j where id = ?`).get(job.id) as any).board,
    "the board's word",
  );
  // its snip, with hq note, for moss's job (the review record's copy)
  const running = await h.claimJob(job.id);
  const tmp = mkdtempSync(`${tmpdir()}/book-note-`);
  assert.match((await h.hq({ ...running, tmp }, 'note', String(review.id))).out, /The headline wraps badly/);
  await h.finish(running);

  // a page nobody owns: the CEO's routing check, as review notes are
  const free = await newPage({ kind: 'free' });
  const nobodys = await addNote({ page: free.id, words: 'Who does the gift card?', said: 'written' });
  const loose = (await addNote({ page: free.id, words: 'A gift card for the shop', said: 'written' })).body.sheet;
  await h.board('/api/book/send', { id: loose.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const check = (h.db.prepare('select job from book_sheets where id = ?').get(loose.id) as any).job;
  assert.deepEqual(
    { ...(h.db.prepare('select agent, title from jobs where id = ?').get(check) as any) },
    { agent: 'juno', title: "Route the board's notes" },
  );
  // (and the HQ note the owner's job above ended without fixing, back to routing: feedback.ts ended)
  assert.equal(
    (h.db.prepare('select count(*) n from note_routes where job = ?').get(check) as any).n,
    loose.notes.length + 1,
  );
  assert.ok(nobodys.body.asked, 'its question asked at once, apart from the sheet');
});

test("a page of HQ's notes by its address, any day and any owner: its own only, open and sent", async () => {
  const page = await newPage({ kind: 'sheet', owner: 'nib', url: '/' });
  const here = { url: `${ORIGIN}/?open=gazette#t=x` };
  const mine = (await addNote({ page: page.id, words: 'On the Gazette', anchor: anchor(here) })).body.note;
  await addNote({ page: page.id, words: 'Elsewhere', anchor: anchor({ url: `${ORIGIN}/?open=gazettes` }) });
  await addNote({
    page: page.id,
    words: 'A preview',
    anchor: anchor({ url: 'https://hello.preview.test/?open=gazette' }),
  });
  h.db.prepare("update book_pages set day = '2026-10-01' where id = ?").run(page.id);
  const read = (await h.board(`/api/book/notes?url=${encodeURIComponent('/?open=gazette')}`)).body;
  assert.deepEqual(
    read.notes.map((n: any) => n.id),
    [mine.id],
  );
  assert.equal((await h.board('/api/book/notes?url=gazette')).status, 400);
  // however many notes the book has on other pages (an address that holds this one's too), the page's own come back
  // (on another owner's sheet: a sheet the later tests write on holds 200)
  const other = (
    await addNote({
      page: page.id,
      to: 'sable',
      words: 'Elsewhere again',
      anchor: anchor({ url: `${ORIGIN}/?open=gazettes` }),
    })
  ).body.note;
  const elsewhere = {
    v: 1 as const,
    url: `${ORIGIN}/?open=gazettes`,
    el: null,
    view: { w: 390, h: 844, x: 0, y: 0, dpr: 2 },
    ink: [],
  };
  h.db.exec('begin');
  for (let i = 0; i < 1500; i++)
    booknotes.insertNote(other.sheet, page.id, 'board', elsewhere, { words: '', said: null }, null, null);
  h.db.exec('commit');
  const still = (await h.board(`/api/book/notes?url=${encodeURIComponent('/?open=gazette')}`)).body;
  assert.deepEqual(
    still.notes.map((n: any) => n.id),
    [mine.id],
  );
});

test('a note that joins a sheet in its ten seconds stays behind, on a new open sheet for the same owner', async () => {
  const page = await newPage({ kind: 'sheet', owner: 'dex', url: '/?open=numbers' });
  const sheet = (await addNote({ page: page.id, words: 'Seen before the tap' })).body.sheet;
  await h.board('/api/book/send', { id: sheet.id });
  await new Promise(done => setTimeout(done, 5));
  const late = (await addNote({ page: page.id, words: 'Posted in the seconds to undo' })).body;
  assert.equal(late.sheet.id, sheet.id, 'it joins the sheet while it can still be undone');
  const first = (await h.board('/api/book/sheets')).body.open.find((s: any) => s.id === sheet.id).notes[0];
  await h.board('/api/book/note/link', { id: late.note.id, to: first.id, linked: true });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const { open, sent } = (await h.board('/api/book/sheets')).body;
  assert.deepEqual(
    sent.find((s: any) => s.id === sheet.id).notes.map((n: any) => n.words),
    ['Seen before the tap'],
  );
  const after = open.find((s: any) => s.owner === 'dex');
  assert.deepEqual(
    after.notes.map((n: any) => [n.id, n.n, n.status, n.links]),
    [[late.note.id, 1, 'open', []]],
    'alone on its new sheet, its link to a note that went gone',
  );
  const job = h.db
    .prepare('select prompt from jobs where id = (select job from book_sheets where id = ?)')
    .get(sheet.id);
  assert.doesNotMatch((job as any).prompt, /Posted in the seconds to undo/);
});

test("a sheet's task names every address its notes were made on, once each, in the order they came", async () => {
  const page = await newPage({ kind: 'sheet', owner: 'penny', url: '/?open=shop' });
  const on = (url: string, words: string) => addNote({ page: page.id, words, anchor: anchor({ url: ORIGIN + url }) });
  const sheet = (await on('/?open=shop#t=a', 'The price is too small')).body.sheet;
  await on('/basket', 'The basket forgets the gift note');
  await on('/?open=shop#t=b', 'And the photo is cropped');
  await h.board('/api/book/send', { id: sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const job = h.db
    .prepare('select title from jobs where id = (select job from book_sheets where id = ?)')
    .get(sheet.id);
  assert.equal((job as any).title, "The board's notes on /?open=shop, /basket");
});

test('an answer clips onto its note, a tick closes it, and writing under it is a new note for the owner', async () => {
  const page = await newPage({ kind: 'sheet', owner: 'kit', url: '/?open=numbers' });
  const sheet = (await addNote({ page: page.id, words: 'Show last week too' })).body.sheet;
  await h.board('/api/book/send', { id: sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const jobId = (h.db.prepare('select job from book_sheets where id = ?').get(sheet.id) as any).job;
  const review = (h.db.prepare('select id from review_notes where job = ?').get(jobId) as any).id;
  const job = await h.claimJob(jobId);
  const other = await h.start({ agent: 'wren' });
  assert.equal(
    (await agent('answer', other.token, { note: review, text: 'Mine?' })).status,
    404,
    "only the note's own job's agent",
  );
  const slip = (
    await agent('answer', job.token, {
      note: review,
      text: 'Done: last week sits beside this one',
      link: 'https://numbers.preview.example',
      picture: SNIP,
    })
  ).body.slip;
  assert.deepEqual(
    [slip.by, slip.name, slip.text, slip.link],
    ['kit', 'Kit', 'Done: last week sits beside this one', 'https://numbers.preview.example'],
  );
  assert.equal(
    (await agent('answer', job.token, { note: review, text: 'x', link: 'http://numbers.preview.example' })).body.error,
    'a link is an https address',
  );
  const pic = await fetch(base + slip.picture, { headers: { cookie: h.boardCookie } });
  assert.equal(pic.headers.get('content-type'), 'image/png');
  await h.finish(job);
  await h.finish(other);

  const ticked = (await h.board('/api/book/slip/tick', { id: slip.id, ticked: true })).body;
  assert.equal(ticked.note.status, 'closed');
  assert.ok(ticked.slip.ticked);
  assert.equal((await h.board('/api/book/slip/tick', { id: slip.id, ticked: false })).body.note.status, 'sent');
  const reply = (await h.board('/api/book/slip/reply', { id: slip.id, words: 'And the week before?' })).body;
  assert.equal(reply.sheet.owner, 'kit');
  assert.equal(reply.note.answers, slip.id);
  assert.deepEqual(reply.note.anchor.el, anchor().el, 'anchored where the note was');
  assert.ok(reply.asked, 'a question, asked now');
});

test('a "?" note starts its owner\'s quick run, not a queued job; its answer is a slip, and the intercom never hears it', async () => {
  const page = await newPage({ kind: 'sheet', owner: 'wren', url: '/?open=studio' });
  const asked = (await addNote({ page: page.id, words: 'Is this the new font？', said: 'spoken' })).body;
  const run = h.db.prepare('select * from jobs where id = ?').get(asked.asked) as any;
  assert.deepEqual([run.agent, run.kind, run.status], ['wren', 'chat', 'queued']);
  assert.match(run.prompt, /Is this the new font？/);
  assert.match(run.prompt, /your final message is the answer/);
  assert.equal((await h.board('/api/chat')).body.thinking, false, "not the intercom's turn");
  const claimed = await h.claimJob(run.id);
  await h.finish(claimed, { status: 'done', result: 'Yes: Fraunces, since this morning.' });
  const note = (await h.board(`/api/book/notes?page=${page.id}`)).body.notes[0];
  assert.deepEqual(
    note.slips.map((s: any) => [s.by, s.text]),
    [['wren', 'Yes: Fraunces, since this morning.']],
  );
  assert.equal(note.status, 'open', 'still on the sheet, to send with the rest');
  assert.ok(!h.db.prepare("select 1 from chat where text like '%Fraunces%'").get(), 'nothing on the intercom');
  // words corrected to a question ask then; one already asking doesn't ask again
  const plain = (await addNote({ page: page.id, words: 'The font' })).body;
  assert.ok(
    (await h.board('/api/book/note/edit', { id: plain.note.id, words: 'The font?', said: 'typed' })).body.asked,
  );
  assert.equal(
    (await h.board('/api/book/note/edit', { id: plain.note.id, words: 'The new font?', said: 'typed' })).body.asked,
    null,
  );
});

test('old sketches fold in as free pages under their numbers, ink, scraps and waiting kept; hq sketch and a call read them', async () => {
  const old = `${h.dataDir}/sketches`;
  mkdirSync(old, { recursive: true });
  const placed = await red(),
    waiting = await red(60, 40);
  writeFileSync(`${old}/901-s-0000000a.png`, placed);
  writeFileSync(`${old}/901-s-0000000b.png`, waiting);
  writeFileSync(`${old}/901-0000000c.png`, await red(10, 10));
  db.exec(`create table sketches (id integer primary key autoincrement, who text not null default 'board',
    label text not null default '', archived integer not null default 0, created text not null, updated text not null,
    w integer not null, h integer not null, ink text not null default '[]', strokes integer not null default 0,
    picture text, sent text, scraps text not null default '[]', waiting text not null default '[]', opened text)`);
  db.prepare(
    `insert into sketches (id, label, created, updated, w, h, ink, strokes, picture, scraps, waiting)
    values (901, 'Tote bag', '2026-10-24T09:00:00.000Z', '2026-10-24T10:00:00.000Z', 1200, 800, ?, 1, '901-0000000c.png', ?, ?)`,
  ).run(
    JSON.stringify([STROKE]),
    JSON.stringify([
      { file: '901-s-0000000a.png', x: 10, y: 10, w: 40, h: 30, tilt: 2 },
      { file: '901-s-0000000d.png', x: 90, y: 10, w: 40, h: 30, tilt: 0 }, // (its file gone)
    ]),
    JSON.stringify([{ file: '901-s-0000000b.png' }]),
  );
  db.prepare("update sqlite_sequence set seq = 950 where name = 'sketches'").run(); // (sketches up to 950 were made)
  assert.equal(sketchbook.foldSketches(), 1);
  assert.ok(!existsSync(old), 'its folder moved into the book');
  assert.ok(!db.prepare("select 1 from sqlite_master where name = 'sketches'").get());
  const page = (await h.board('/api/book/page?id=901')).body;
  assert.deepEqual([page.kind, page.label, page.day, page.ink.length], ['free', 'Tote bag', '2026-10-24', 1]);
  assert.deepEqual(
    page.scraps.map((s: any) => s.file),
    ['901-s-0000000a.png'],
    'a scrap whose file is gone left out',
  );
  assert.deepEqual(
    page.waiting.map((s: any) => s.file),
    ['901-s-0000000b.png'],
    "review mode's picture still waits",
  );
  assert.equal(readFileSync(`${DIR}/901-s-0000000a.png`).length, placed.length);
  assert.equal(sketchbook.foldSketches(), 0, 'once');
  assert.equal((await newPage({ kind: 'free' })).id, 951, "a deleted sketch's number is not made again");

  const job = await h.start({ agent: 'juno' });
  const tmp = mkdtempSync(`${tmpdir()}/book-hq-`);
  const run = await h.hq({ ...job, tmp }, 'sketch', '901');
  assert.match(run.out, /^Page #901 “Tote bag” → /);
  const saved = /→ (\S+)/.exec(run.out)![1];
  assert.equal((await sharp(saved).metadata()).width, 2400);
  assert.match(
    (await h.hq({ ...job, tmp }, 'sketches')).out,
    /#901 {2}\S+ \S+ UTC {2}“Tote bag” {2}1 stroke {2}1 picture/,
  );
  await h.finish(job);

  const { call, token } = await h.liveCall('juno');
  const shown = await h.voice('sketch', { call, sketch: 'tote' });
  assert.equal(shown.status, 200);
  assert.match(shown.body.line, /^Page #901 “Tote bag” of the board's book: made 2026-10-24 09:00 UTC/);
  assert.equal((await sharp(Buffer.from(shown.body.picture.data, 'base64')).metadata()).width, 1568);
  assert.equal((await h.voice('sketch', { call, sketch: '99999' })).body.error.split('.')[0], 'No page #99999');
  await h.voice('call-end', { agent: 'juno', lines: [], token });
});

test("a question corrected before the send goes as it reads now; a page with notes on an open sheet isn't deleted", async () => {
  const page = await newPage({ kind: 'sheet', owner: 'dex', url: '/?open=ops' });
  const asked = (await addNote({ page: page.id, words: 'Should the header be blue?' })).body;
  assert.ok(asked.asked, 'asked now: its review row is made');
  assert.equal((await h.board('/api/book/page/delete', { id: page.id })).status, 409);
  await h.board('/api/book/note/edit', { id: asked.note.id, words: 'Keep the header green', said: 'typed' });
  await h.board('/api/book/send', { id: asked.sheet.id });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const { job } = (await h.board('/api/book/sheets')).body.sent.find((s: any) => s.id === asked.sheet.id);
  const { prompt } = h.db.prepare('select prompt from jobs where id = ?').get(job) as { prompt: string };
  assert.match(prompt, /Keep the header green/);
  assert.doesNotMatch(prompt, /blue/);
  assert.equal(
    (h.db.prepare('select note from review_notes where job = ?').get(job) as { note: string }).note,
    'Keep the header green',
  );
  assert.equal((await h.board('/api/book/page/delete', { id: page.id })).status, 200, 'sent, the page can go');
});

test('words read late replace only the words they were read for: the board typed others since, they stay', async () => {
  const page = await newPage({ kind: 'sheet', owner: 'dex', url: '/?open=ops' });
  const { note } = (await addNote({ page: page.id, said: 'written' })).body;
  const read = (words: string, was: string) =>
    h.board('/api/book/note/edit', { id: note.id, words, said: 'written', was });
  assert.equal((await read('Lighter ink', '')).body.note.words, 'Lighter ink', 'still wordless: the words go in');
  await h.board('/api/book/note/edit', { id: note.id, words: 'Darker, please', said: 'typed' });
  const late = await read('Lighter ink again', 'Lighter ink');
  assert.equal(late.status, 409);
  assert.deepEqual(
    [booknotes.note(note.id)!.words, booknotes.note(note.id)!.said],
    ['Darker, please', 'typed'],
    "the board's words stay",
  );
});

test("a question on a Codex agent's page is a quick run on Claude as that agent, taken by the chat slot's claim", async () => {
  const page = await newPage({ kind: 'sheet', owner: 'nib', url: '/?open=reviews' });
  const asked = (await addNote({ page: page.id, words: 'Which round is this?' })).body;
  const run = h.db.prepare('select agent, kind, engine from jobs where id = ?').get(asked.asked) as any;
  assert.deepEqual([run.agent, run.kind, run.engine], ['nib', 'chat', 'claude']);
  // (the earlier tests' questions, still waiting, go first: ended unanswered)
  let claimed = (await h.claim('claude', { kind: 'chat' }))!;
  while (claimed.id !== asked.asked) {
    await h.finish(claimed, { status: 'done' });
    claimed = (await h.claim('claude', { kind: 'chat' }))!;
  }
  await h.finish(claimed, { status: 'done', result: 'Round 2.' });
  const note = (await h.board(`/api/book/notes?page=${page.id}`)).body.notes[0];
  assert.deepEqual(
    note.slips.map((s: any) => [s.by, s.text]),
    [['nib', 'Round 2.']],
  );
});

test('a line between two numbers links the notes: shown on both, gone with a move, and the job reads which go together', async () => {
  const page = await newPage({ kind: 'sheet', owner: 'moss', url: '/?open=gazette&post=2' });
  const notes: any[] = [];
  for (const words of ['The headline is too long', 'Warmer, like Inkbath', 'And the byline'])
    notes.push((await addNote({ page: page.id, words })).body);
  const sheet = notes[0].sheet.id;
  const linked = (await h.board('/api/book/note/link', { id: notes[0].note.id, to: notes[1].note.id, linked: true }))
    .body;
  const links = (id: number) => linked.notes.find((n: any) => n.id === id).links;
  assert.deepEqual(links(notes[0].note.id), [notes[1].note.id]);
  assert.deepEqual(links(notes[1].note.id), [notes[0].note.id], 'both ways');
  assert.deepEqual(links(notes[2].note.id), []);
  assert.equal(
    (await h.board('/api/book/note/link', { id: notes[0].note.id, to: notes[0].note.id, linked: true })).body.error,
    'a note goes with another note, not itself',
  );
  const elsewhere = (await addNote({ page: (await newPage({ kind: 'free' })).id })).body.note;
  assert.equal(
    (await h.board('/api/book/note/link', { id: notes[0].note.id, to: elsewhere.id, linked: true })).body.error,
    'notes go together on one sheet',
  );
  // a link to a note that moves to another sheet goes with the move; linked again, and the third one too
  await h.board('/api/book/note/link', { id: notes[2].note.id, to: notes[1].note.id, linked: true });
  await h.board('/api/book/note/move', { id: notes[2].note.id, to: 'kit' });
  const now = (await h.board('/api/book/sheets')).body.open.find((s: any) => s.id === sheet);
  assert.deepEqual(
    now.notes.map((n: any) => n.links),
    [[notes[1].note.id], [notes[0].note.id]],
  );
  const kits = (await h.board('/api/book/sheets')).body.open.find((s: any) => s.owner === 'kit');
  assert.deepEqual(kits.notes.find((n: any) => n.id === notes[2].note.id).links, []);
  // unlinked, linked again: the job's brief says which go together, by the numbers it reads them under
  await h.board('/api/book/note/link', { id: notes[1].note.id, to: notes[0].note.id, linked: false });
  assert.deepEqual((await h.board('/api/book/sheets')).body.open.find((s: any) => s.id === sheet).notes[0].links, []);
  await h.board('/api/book/note/link', { id: notes[1].note.id, to: notes[0].note.id, linked: true });
  await h.board('/api/book/send', { id: sheet });
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const review = (id: number) => (h.db.prepare('select review from book_notes where id = ?').get(id) as any).review;
  const { job } = (await h.board('/api/book/sheets')).body.sent.find((s: any) => s.id === sheet);
  const { prompt } = h.db.prepare('select prompt from jobs where id = ?').get(job) as { prompt: string };
  assert.match(
    prompt,
    new RegExp(`The headline is too long\\n(?:.+\\n)*?Goes with note #${review(notes[1].note.id)}\\.`),
  );
  assert.match(prompt, new RegExp(`Warmer, like Inkbath\\n(?:.+\\n)*?Goes with note #${review(notes[0].note.id)}\\.`));
  assert.equal((await h.board('/api/book/sheets')).body.sent.find((s: any) => s.id === sheet).notes[0].links.length, 1);
});

test('a free page is sent to an agent on its own: a one-off sheet in its ten seconds, undone, then sent as a page to read', async () => {
  const kitsPage = await newPage({ kind: 'sheet', owner: 'kit', url: '/?open=shop' });
  const batch = (await addNote({ page: kitsPage.id, words: 'Prices with shipping in' })).body.sheet;
  const page = await newPage({ kind: 'free', label: 'Gift card' });
  await h.board('/api/book/page/save', { id: page.id, ink: [STROKE], scraps: [] });
  assert.equal(
    (await h.board('/api/book/page/send', { id: kitsPage.id, to: 'kit' })).body.error,
    'a free page is sent on its own; a sheet goes with its plane',
  );
  assert.equal((await h.board('/api/book/page/send', { id: page.id, to: 'nobody' })).body.error, 'to is an agent');
  const sending = (await h.board('/api/book/page/send', { id: page.id, to: 'kit' })).body;
  assert.deepEqual([sending.owner, sending.status, sending.page], ['kit', 'sending', page.id]);
  assert.ok(sending.send_at - Date.now() > 9_000);
  assert.deepEqual(
    sending.notes.map((n: any) => [n.n, n.page, n.words, n.anchor.el, n.anchor.ink.length, !!n.snip]),
    [[1, page.id, 'Gift card', null, 0, true]],
  );
  // never the agent's batch: its open sheet stays as it was, and new notes join that
  const kits = (await h.board('/api/book/sheets')).body.open.filter((s: any) => s.owner === 'kit');
  assert.deepEqual(kits.map((s: any) => s.id).sort(), [batch.id, sending.id].sort());
  assert.equal((await addNote({ page: kitsPage.id, words: 'And the basket' })).body.sheet.id, batch.id);
  // the page's picture is its snip
  const snip = await fetch(base + sending.notes[0].snip, { headers: { cookie: h.boardCookie } });
  assert.equal(snip.headers.get('content-type'), 'image/png');

  // undone: the one-off sheet is gone, as if never sent
  assert.deepEqual((await h.board('/api/book/undo', { id: sending.id })).body, { id: sending.id, status: 'undone' });
  assert.ok(!(await h.board('/api/book/sheets')).body.open.some((s: any) => s.id === sending.id));
  assert.equal((h.db.prepare('select count(*) n from book_notes where sheet = ?').get(sending.id) as any).n, 0);

  // sent: a job for kit about the page itself, hq sketch to read it
  const again = (await h.board('/api/book/page/send', { id: page.id, to: 'kit' })).body;
  booksheets.deliverDue(Date.now() + booknotes.SEND_MS);
  const sent = (await h.board('/api/book/sheets')).body.sent.find((s: any) => s.id === again.id);
  assert.equal(sent.status, 'sent');
  const job = h.db.prepare('select agent, title, prompt from jobs where id = ?').get(sent.job) as any;
  assert.equal(job.agent, 'kit');
  assert.equal(job.title, `A page from the board's book: page #${page.id} “Gift card”`);
  assert.match(job.prompt, new RegExp(`\`hq sketch ${page.id}\``));
  assert.match(job.prompt, /Gift card/);
  assert.equal(
    (await h.board('/api/book/sheets')).body.open.find((s: any) => s.id === batch.id).status,
    'open',
    "kit's batch still waits for its own plane",
  );
});
