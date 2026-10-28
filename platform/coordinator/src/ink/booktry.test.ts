// node --test src/ink/booktry.test.ts   (a try: its versions page, its run, a later note reaching it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from '../harness.ts';

const h = await harness('booktry');
const { db } = h;
const { ORIGIN } = await import('../config.ts');
const { tryNow, tryHolds, onCall } = await import('./booktry.ts');

const SNIP = `data:image/png;base64,${(
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer()
).toString('base64')}`;
const anchor = {
  v: 1,
  url: `${ORIGIN}/?open=shop`,
  el: null,
  view: { w: 1180, h: 820, x: 0, y: 0, dpr: 2 },
  ink: [],
};
const scrap = async (words: string) =>
  (await h.board('/api/notebooks/groups/scrap', { anchor, words, said: 'typed', snip: SNIP, owner: 'kit' })).body;
const pagesOf = async (notebook: number) =>
  (await h.board(`/api/notebooks/pages?notebook=${notebook}`)).body.pages as any[];
const VERDICT = { id: 1, why: 'it asks to see the basket made bigger' };

test('a try makes its versions page after the note’s, and starts an expedited try run for the owner', async () => {
  const g = await scrap('What if the basket were much bigger?');
  const notebook = (db.prepare('select notebook from book_pages where id = ?').get(g.page) as any).notebook;
  // (a page after it, so the versions page goes between them)
  const after = (await h.board('/api/notebooks/pages/create', { notebook })).body.id as number;
  const job = tryNow({ grp: g.id }, VERDICT)!;
  const row = db.prepare('select * from jobs where id = ?').get(job) as any;
  assert.deepEqual([row.kind, row.agent, row.expedite, row.thread, row.status], ['try', 'kit', 1, null, 'queued']);
  assert.match(row.prompt, new RegExp(`hq answer g${g.id} --expect`));
  assert.match(row.prompt, /--version "<two words>" --picture <png> --patch <file>/);
  assert.match(row.prompt, /1180 × 820/);
  const order = await pagesOf(notebook);
  const at = order.findIndex(p => p.id === g.page);
  assert.equal(order[at + 1].tries, g.id);
  assert.equal(order[at + 1].title, 'Kit tries: What if the basket were much bigger?');
  assert.equal(order[at + 2].id, after);
  assert.equal(order[at].tries, null);
  // (the groups route: the versions page names its group, the group its versions page)
  const versions = (await h.board(`/api/notebooks/pages/groups?page=${order[at + 1].id}`)).body;
  assert.deepEqual([versions.tries, versions.tried.id], [g.id, g.id]);
  const page = (await h.board(`/api/notebooks/pages/groups?page=${g.page}`)).body;
  assert.equal(page.groups.find((x: any) => x.id === g.id).tries_page, order[at + 1].id);
  assert.equal(tryHolds(g.id, job), true);
  assert.equal(tryHolds(g.id, job + 1), false);
  assert.equal(onCall({ grp: g.id }), null);
  // the chat slot never takes it; a work slot takes it at once, ahead of work queued before it
  h.jobs.createJob({ agent: 'moss', title: 'earlier work', prompt: 'x', engine: 'claude', word: 'EARLIER' } as any);
  assert.equal(await h.claim('claude', { kind: 'chat' }), null);
  assert.equal((await h.claim('claude'))!.id, job);
  db.prepare('delete from jobs where title = ?').run('earlier work');
});

test('a note on a version while its try runs goes to that run, not a second', async () => {
  const g = await scrap('Try the header darker?');
  const job = tryNow({ grp: g.id }, VERDICT)!;
  db.prepare("update jobs set status = 'running' where id = ?").run(job);
  const now = new Date().toISOString();
  // (the reply under one of its versions, its patch kept)
  const { writeFileSync } = await import('node:fs');
  const { DIR } = await import('../pagescraps.ts');
  writeFileSync(`${DIR}/patch-late-sun.diff`, 'diff --git a/header b/header\n+#3a2f2a');
  const version = Number(
    db
      .prepare(
        `insert into book_slips (note, by, job, text, created, grp, style, version, patch)
          values (null, 'kit', ?, 'the header in a late-afternoon brown', ?, ?, 'version', 'Late sun', 'patch-late-sun.diff')`,
      )
      .run(job, now, g.id).lastInsertRowid,
  );
  const reply = Number(
    db
      .prepare(
        `insert into notebook_groups (page, parent, answers, kind, by, words, created, updated) values (?, ?, ?, 'reply', 'board', ?, ?, ?)`,
      )
      .run(g.page, g.id, version, 'This, but softer', now, now).lastInsertRowid,
  );
  assert.equal(tryNow({ grp: reply }, VERDICT), job);
  const tries = db
    .prepare("select count(*) n from jobs where kind = 'try' and status in ('queued', 'running')")
    .get() as any;
  assert.equal(tries.n, 2); // (this note's run and the first test's, nothing new)
  const m = db.prepare('select * from messages where job = ?').get(job) as any;
  assert.equal(m.recipient, 'kit');
  assert.match(m.text, /This, but softer/);
  // the versions page is still the one: one per note
  const pages = db.prepare('select count(*) n from book_pages where tries = ?').get(g.id) as any;
  assert.equal(pages.n, 1);
  // (a run that ended: the next note on it is a try again, on the same versions page)
  db.prepare("update jobs set status = 'done' where id = ?").run(job);
  const again = tryNow({ grp: reply }, VERDICT)!;
  assert.notEqual(again, job);
  // (its brief: the note, and what the board wrote on which version, the next ones starting from it)
  const brief = (db.prepare('select prompt from jobs where id = ?').get(again) as any).prompt;
  assert.match(brief, /The note: “Try the header darker\?”/);
  assert.match(
    brief,
    /wrote on the version “Late sun” \(the header in a late-afternoon brown; its frame is on page \d+\)/,
  );
  assert.match(brief, /“This, but softer”\. The next versions start from that one/);
  assert.match(brief, /```diff\ndiff --git a\/header b\/header\n\+#3a2f2a\n```/);
  assert.equal((db.prepare('select tried from notebook_groups where id = ?').get(g.id) as any).tried, again);
  assert.equal((db.prepare('select count(*) n from book_pages where tries = ?').get(g.id) as any).n, 1);
});

test('new groups never land on a versions page', async () => {
  const g = await scrap('Bolder buttons?');
  tryNow({ grp: g.id }, VERDICT);
  const next = await scrap('And the footer');
  assert.equal(next.page, g.page);
});

test("on a call: the note's verdict goes to the line with it, its agent writes the answer, a try's start is news", async () => {
  const { onPublish } = await import('../events.ts');
  const { call, token } = await h.liveCall('juno');
  const page = (await h.board('/api/book/page/new', { kind: 'call', call, w: 1024, h: 768 })).body;
  const { note } = (
    await h.board('/api/book/note', { page: page.id, anchor, words: 'Is the price right?', said: 'typed' })
  ).body;
  assert.equal(onCall({ note: note.id }), call);
  db.prepare(
    "insert into ink_verdicts (note, reply, why, words, created) values (?, 'answer', 'a question for the call', ?, ?)",
  ).run(note.id, note.words, new Date().toISOString());
  const heard = (await h.voice(`note?id=${note.id}&call=${call}`)).body;
  assert.deepEqual([heard.verdict, heard.versions], [{ reply: 'answer', why: 'a question for the call' }, []]);
  // the call's agent writes it (its answer_note tool), by the note's number on the call's page
  const wrote = await h.agent('call-answer', token, { note: note.n, words: 'Yes: it matches the shop.' });
  assert.equal(wrote.status, 200);
  const slip = db.prepare('select * from book_slips where id = ?').get(wrote.body.slip) as any;
  assert.deepEqual([slip.note, slip.by, slip.text, slip.style], [note.id, 'juno', 'Yes: it matches the shop.', 'text']);
  assert.equal((await h.agent('call-answer', token, { note: 9, words: 'x' })).status, 404);
  const job = (await h.start({ agent: 'kit' })) as any;
  assert.equal((await h.agent('call-answer', job.token, { note: note.n, words: 'x' })).status, 403);
  // a try on a call's note: its versions page after the call's, and the line hears of it through HQ
  const events: any[] = [];
  const off = onPublish(e => void (e.type === 'book' && e.call && events.push(e)));
  const run = tryNow({ note: note.id }, VERDICT)!;
  await new Promise(res => setTimeout(res, 50));
  off?.();
  assert.equal((db.prepare('select kind from jobs where id = ?').get(run) as any).kind, 'try');
  const versions = db.prepare('select * from book_pages where tries_note = ?').get(note.id) as any;
  assert.equal(versions.label, 'Juno tries: Is the price right?');
  assert.deepEqual(
    events.map(e => [e.call, e.note]),
    [[call, note.id]],
  );
});

test("a call's note wiped, its versions kept for Undo: a reply on one is refused", async () => {
  const { pageFor } = await import('./callnotes.ts');
  const { call } = await h.liveCall('juno');
  const page = pageFor(call)!;
  const { note } = (await h.board('/api/book/note', { page: page.id, anchor, words: 'cooler?', said: 'typed' })).body;
  const run = tryNow({ note: note.id }, VERDICT)!;
  const slip = Number(
    db
      .prepare(
        `insert into book_slips (note, by, job, text, created, style, version)
          values (?, 'juno', ?, 'a cooler grey', ?, 'version', 'Slate')`,
      )
      .run(note.id, run, new Date().toISOString()).lastInsertRowid,
  );
  assert.equal((await h.board('/api/book/note/delete', { id: note.id })).status, 200);
  assert.ok(db.prepare('select 1 from book_pages where tries_note = ?').get(note.id), 'its versions page kept');
  assert.equal((await h.board('/api/notebooks/groups/reply', { answer: slip, words: 'This one' })).status, 404);
});
