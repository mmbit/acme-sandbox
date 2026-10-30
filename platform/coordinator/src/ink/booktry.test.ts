// node --test src/ink/booktry.test.ts   (a try: its run, its versions under the note, a later note reaching it)
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
const tryOn = async (g: { id: number; page: number }) =>
  (await h.board(`/api/notebooks/pages/groups?page=${g.page}`)).body.groups.find((x: any) => x.id === g.id).try;
const VERDICT = { id: 1, why: 'it asks to see the basket made bigger' };

test('a try starts an expedited try run for the owner, its versions coming under the note on its own page', async () => {
  const g = await scrap('What if the basket were much bigger?');
  const notebook = (db.prepare('select notebook from book_pages where id = ?').get(g.page) as any).notebook;
  const before = (await pagesOf(notebook)).map(p => p.id);
  const job = tryNow({ grp: g.id }, VERDICT)!;
  const row = db.prepare('select * from jobs where id = ?').get(job) as any;
  assert.deepEqual([row.kind, row.agent, row.expedite, row.thread, row.status], ['try', 'kit', 1, null, 'queued']);
  assert.match(row.prompt, new RegExp(`hq answer g${g.id} --expect`));
  assert.match(row.prompt, /--version "<two words>" --picture <png> --patch <file>/);
  assert.match(row.prompt, /1180 × 820/);
  assert.match(row.prompt, /Its versions land under the note/);
  // no page of its own: nothing jumps to another page
  assert.deepEqual(
    (await pagesOf(notebook)).map(p => p.id),
    before,
  );
  assert.deepEqual(await tryOn(g), { state: 'coming', expect: null, by: 'kit', name: 'Kit', reason: null });
  // (the count it says comes with it, never a count of versions not there: frames still to come)
  db.prepare('update notebook_groups set expect = 3 where id = ?').run(g.id); // (hq answer --expect 3)
  assert.equal((await tryOn(g)).expect, 3);
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
  // (a run that ended: the next note on it is a try again)
  db.prepare("update jobs set status = 'done' where id = ?").run(job);
  const again = tryNow({ grp: reply }, VERDICT)!;
  assert.notEqual(again, job);
  // (its brief: the note, and what the board wrote on which version, the next ones starting from it)
  const brief = (db.prepare('select prompt from jobs where id = ?').get(again) as any).prompt;
  assert.match(brief, /The note: “Try the header darker\?”/);
  assert.match(brief, /wrote on the version “Late sun” \(the header in a late-afternoon brown\)/);
  assert.match(brief, /“This, but softer”\. The next versions start from that one/);
  assert.match(brief, /```diff\ndiff --git a\/header b\/header\n\+#3a2f2a\n```/);
  assert.equal((db.prepare('select tried from notebook_groups where id = ?').get(g.id) as any).tried, again);
});

test('a try that ends with no version says so under the note, never "0 versions"', async () => {
  const g = await scrap('Bolder buttons?');
  const job = tryNow({ grp: g.id }, VERDICT)!;
  db.prepare('update notebook_groups set expect = 2 where id = ?').run(g.id);
  db.prepare("update jobs set status = 'done', result = ? where id = ?").run(
    'Looked at it.\nThe buttons are bold already: a bolder weight breaks the grid.',
    job,
  );
  assert.deepEqual(await tryOn(g), {
    state: 'empty',
    expect: 2,
    by: 'kit',
    name: 'Kit',
    reason: 'Kit made no version: The buttons are bold already: a bolder weight breaks the grid.',
  });
  db.prepare("update jobs set status = 'failed' where id = ?").run(job);
  assert.equal((await tryOn(g)).reason, "Kit's try ended without a version. Write on the scrap to ask again.");
  db.prepare("update jobs set status = 'stopped' where id = ?").run(job);
  assert.equal((await tryOn(g)).reason, "Kit's try was stopped before it made a version.");
  // one version made, and it's made: no reason
  db.prepare(
    `insert into book_slips (note, by, job, text, created, grp, style, version) values (null, 'kit', ?, 'bolder', ?, ?, 'version', 'Heavy')`,
  ).run(job, new Date().toISOString(), g.id);
  assert.deepEqual([(await tryOn(g)).state, (await tryOn(g)).reason], ['made', null]);
  // and new groups land on its page, as on any
  const next = await scrap('And the footer');
  assert.equal(next.page, g.page);
});

test("a note the board types on a live call's page gets no quick run: the call's agent is with the board", async () => {
  const { pageFor } = await import('./callnotes.ts');
  const { answerNow } = await import('./bookanswer.ts');
  const { call } = await h.liveCall('juno');
  const page = pageFor(call)!;
  const typed = (
    await h.board('/api/notebooks/groups/create', {
      page: page.id,
      texts: [{ x: 40, y: 80, w: 200, text: 'Is the price right?', color: '#2a2352' }],
    })
  ).body;
  assert.equal(onCall({ grp: typed.id }), call);
  assert.equal(answerNow({ grp: typed.id }, VERDICT), null);
});
