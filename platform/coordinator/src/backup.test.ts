// node --test src/backup.test.ts   (the test company; backup-status.json written by hand, as infra/backup.py would)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

const h = await harness('backup');   // the test company's process role is Bolt
const { check, KEYS } = await import('./backup.ts');   // (check: what the server runs every half hour, at a time of the test's)

const H = 3600e3, T0 = Date.parse('2026-10-01T02:31:00Z');
const status = (s: object) => writeFileSync(`${h.dataDir}/backup-status.json`, JSON.stringify(s));
// a key's time is its file's: the board saved them then
const savedAt = (t: number, keys = KEYS) => { for (const k of keys) utimesSync(`${h.dataDir}/secrets/${k}`, t / 1000, t / 1000); };
const events = async () => (await h.feed()).filter(e => e.type === 'log' && e.agent === 'bolt' && /backup/.test(e.text) && !e.text.startsWith('New job')).map(e => e.text);
const jobs = (title: RegExp) => (h.jobs.listJobs() as any[]).filter(j => title.test(j.title));
// what a job is told: its brief, as the worker claims it (the CEO's alarms queued before it are claimed on the way)
const claimed = async (title: RegExp): Promise<Running> => {
  const j = await h.claim('claude');
  assert.ok(j, `a job ${title} is queued`);
  return title.test(j.title) ? j : claimed(title);
};
const brief = async (title: RegExp) => (await claimed(title)).prompt as string;
// the CEO's (Juno's) alarms, by title
const alarms = () => jobs(/backup/).filter(j => j.agent === 'juno').map(j => j.title);
const bolt = await h.start({ agent: 'bolt' });
const keys = async (secrets: Record<string, string>) => {
  const id = await h.ask(bolt, { kind: 'credential', title: 'The R2 keys', body: 'Paste them', secrets: Object.keys(secrets).join(',') });
  return (await h.answer(id, '', { secrets })).status;
};

test("the four keys are saved on the desk phone, each refused in a shape that isn't it", async () => {
  for (const [k, bad] of Object.entries({ BACKUP_R2_ENDPOINT: 'https://evil.example/r2.cloudflarestorage.com', BACKUP_R2_ACCESS_KEY_ID: 'short',
    BACKUP_R2_SECRET_ACCESS_KEY: 'AKIA' + 'x'.repeat(60), BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-1' + 'Q'.repeat(58) }))
    assert.equal(await keys({ [k]: bad }), 400, `${k} refuses ${bad}`);   // a private key pasted by mistake included
  assert.equal(await keys({ BACKUP_R2_ENDPOINT: `https://${'a1'.repeat(16)}.r2.cloudflarestorage.com/company-backups` }), 200);
  assert.equal(await keys({ BACKUP_R2_ENDPOINT: `https://${'a1'.repeat(16)}.eu.r2.cloudflarestorage.com`, BACKUP_R2_ACCESS_KEY_ID: 'b2'.repeat(16),
    BACKUP_R2_SECRET_ACCESS_KEY: 'c3'.repeat(32), BACKUP_AGE_RECIPIENT: 'age1' + 'q'.repeat(58) }), 200);
});

test('silent until the keys are in; a missed night reaches the feed once, and Bolt and the CEO get one job; a key saved again is no backup', async () => {
  savedAt(T0 - 20 * H);
  check(T0);   // keys in 20 hours ago, no run yet: not late
  assert.deepEqual(await events(), []);
  check(T0 + 7 * H);   // 27 hours: the first night never ran
  assert.equal((await events()).length, 1);
  assert.match((await events())[0], /No off-site backup yet \(1 night missed\)\. It hasn't run at all\. A job for Bolt is queued/);
  assert.match(await brief(/^Off-site backup missed/), /backup/);
  assert.deepEqual(alarms(), ['The off-site backup failed']);
  const alarm = await claimed(/^The off-site backup failed/);
  assert.match(alarm.prompt, /1 night missed.*A job for Bolt is queued.*is your call/s);
  await h.finish(alarm);

  assert.equal(await keys({ BACKUP_R2_SECRET_ACCESS_KEY: 'd4'.repeat(32) }), 200);
  savedAt(T0 + 8 * H, ['BACKUP_R2_SECRET_ACCESS_KEY']);   // the board fixes the token that morning
  check(T0 + 9 * H);
  assert.equal((await events()).length, 1, 'no "backups are back" without a backup');
  check(T0 + 31 * H);   // the next night still has none
  assert.match((await events()).at(-1)!, /No off-site backup yet \(2 nights missed\)/);
  assert.equal(jobs(/^Off-site backup missed/).length, 1, 'the same run of bad nights: no second job');
  assert.deepEqual(alarms(), ['The off-site backup failed'], 'nor a second alarm');
  const reader = await h.start({ agent: 'juno', title: 'The morning round' });
  assert.match((await h.agent('summary', reader.token)).body.text, /^- No off-site backup yet \(2 nights missed\)/m);
  await h.finish(reader);

  status({ ok_at: '2026-10-02T02:32:00+00:00', tried_at: '2026-10-02T02:32:00+00:00', state: 'ok', bucket_bytes: 4e7 });
  check(Date.parse('2026-10-02T09:00:00Z'));
  assert.match((await events())[2], /Off-site backups are back: the latest is from 2 Oct, 04:32/);
  assert.deepEqual(alarms(), ['Off-site backups are back', 'The off-site backup failed'], 'the CEO hears it too');

  status({ ok_at: '2026-10-02T02:32:00+00:00', tried_at: '2026-10-03T02:40:00+00:00', state: 'failed', error: 'R2 said 403 AccessDenied to PUT daily/x\u0007' });
  check(Date.parse('2026-10-03T04:00:00Z'));   // 25.5 hours: not yet
  assert.equal((await events()).length, 3);
  check(Date.parse('2026-10-03T05:00:00Z'));
  check(Date.parse('2026-10-03T12:00:00Z'));   // same night: nothing new
  assert.equal((await events()).length, 4);
  assert.match((await events())[3], /since 2 Oct, 04:32 \(1 night missed\)\. Last try: R2 said 403 AccessDenied to PUT daily\/x \. A job for Bolt is queued/);
  check(Date.parse('2026-10-04T05:00:00Z'));   // the second night too: a second alert, no second job
  assert.match((await events())[4], /\(2 nights missed\).* A job for Bolt to find out why was queued already\./);
  assert.equal(jobs(/^Off-site backup missed/).length, 2);
  assert.equal(alarms().length, 3, 'a new run of bad nights: a new alarm');
  assert.match(await brief(/last good 2026-10-02T02:32/), /R2 said 403 AccessDenied/);
});

test('a bucket nearing the free tier is said once, and again only after a good night without it', async () => {
  const warn = "the bucket is past 8 GB of R2's free 10 GB", said = async () => (await events()).filter(e => e.includes('past 8 GB')).length;
  status({ ok_at: '2026-10-05T02:32:00+00:00', state: 'ok', warn });
  check(Date.parse('2026-10-05T03:00:00Z'));
  check(Date.parse('2026-10-05T04:00:00Z'));
  assert.equal(await said(), 1);
  assert.equal(jobs(/^An off-site backup heads-up/).length, 1, "the CEO's alarm");
  status({ ok_at: '2026-10-05T02:32:00+00:00', tried_at: '2026-10-06T02:32:00+00:00', state: 'failed', error: 'R2 unreachable', warn: null });
  check(Date.parse('2026-10-06T03:00:00Z'));
  status({ ok_at: '2026-10-07T02:32:00+00:00', state: 'ok', warn });
  check(Date.parse('2026-10-07T03:00:00Z'));
  assert.equal(await said(), 1, 'a failed night in between (no heads-up computed) is no all-clear');
  status({ ok_at: '2026-10-08T02:32:00+00:00', state: 'ok', warn: null });
  check(Date.parse('2026-10-08T03:00:00Z'));
  status({ ok_at: '2026-10-20T02:32:00+00:00', state: 'ok', warn });
  check(Date.parse('2026-10-20T03:00:00Z'));
  assert.equal(await said(), 2, 'cleared on a good night, then back: told again');
  status({ ok_at: '2026-10-21T02:32:00+00:00', tried_at: '2026-10-21T02:32:00+00:00', state: 'ok', warn: null, in_progress: true });   // tonight's figure leaves out the repo's copy
  check(Date.parse('2026-10-21T02:40:00Z'));
  status({ ok_at: '2026-10-21T02:32:00+00:00', state: 'ok', warn });   // the repo's copy takes it past 8 GB again
  check(Date.parse('2026-10-21T03:00:00Z'));
  assert.equal(await said(), 2, 'a night still on its repo step is no all-clear');
});

test('the repo\'s copy stale: one job for Bolt per heads-up, none when it is only the free tier\'s room', async () => {
  const stale = 'no copy of the repo since 2026-11-12 02:32 UTC';
  status({ ok_at: '2026-11-14T02:32:00+00:00', tried_at: '2026-11-14T02:32:00+00:00', state: 'ok', warn: stale, repo_warn: stale,
    repo_error: "not uploaded: the repo's copy (9.1 GB) wouldn't leave room in R2's free 10 GB for the next month's database backups" });
  check(Date.parse('2026-11-14T03:00:00Z'));
  assert.equal(jobs(/^Off-site backup: the repo/).length, 0);
  assert.doesNotMatch((await events()).at(-1)!, /job for Bolt/);
  const fetchStale = "the repo's copy is GitHub's as of 2026-11-13 02:32 UTC: fetching from GitHub has failed since";
  for (const day of [15, 15, 16]) {   // the same streak the next night: no second job
    status({ ok_at: `2026-11-${day}T02:32:00+00:00`, tried_at: `2026-11-${day}T02:32:00+00:00`, state: 'ok', warn: fetchStale, repo_warn: fetchStale,
      repo_error: 'GitHub: remote: Invalid username or token.' });
    check(Date.parse(`2026-11-${day}T03:00:00Z`));
  }
  assert.equal(jobs(/^Off-site backup: the repo/).length, 1);
  assert.match((await events()).at(-1)!, /heads-up: .*fetching from GitHub has failed since\. A job for Bolt is queued/);
  assert.match(await brief(/^Off-site backup: the repo/), /fetching from GitHub has failed since.*Invalid username or token/);
});

test('a night still making the repo\'s copy queues no job; one stopped mid-way does, from its time limit', async () => {
  const stale = 'no copy of the repo since 2026-12-08 02:32 UTC', before = jobs(/^Off-site backup: the repo/).length;
  const unfinished = (day: number) => ({ ok_at: `2026-12-${day}T02:32:00+00:00`, tried_at: `2026-12-${day}T02:32:00+00:00`, state: 'ok',
    warn: stale, repo_warn: stale, repo_error: "the repo's copy didn't finish (the unit stopped mid-way?)", in_progress: true });
  status(unfinished(10));   // the database's backup is in, the repo's copy under way
  check(Date.parse('2026-12-10T02:35:00Z'));
  assert.equal(jobs(/^Off-site backup: the repo/).length, before, 'nothing while the night runs');
  status({ ok_at: '2026-12-10T02:32:00+00:00', tried_at: '2026-12-10T02:32:00+00:00', state: 'ok', warn: null, repo_warn: null });
  check(Date.parse('2026-12-10T03:00:00Z'));   // the copy went in
  assert.equal(jobs(/^Off-site backup: the repo/).length, before);
  status(unfinished(11));   // the next night stops on its repo step, and its status stays
  check(Date.parse('2026-12-11T04:00:00Z'));
  assert.equal(jobs(/^Off-site backup: the repo/).length, before, 'still within the unit\'s two hours');
  check(Date.parse('2026-12-11T04:33:00Z'));
  assert.equal(jobs(/^Off-site backup: the repo/).length, before + 1);
  assert.match(await brief(/^Off-site backup: the repo/), /since 2026-12-08.*didn't finish/);
});

test('invoices or agreements not copied off the server in time: the CEO hears once, and Bolt gets one job', async () => {
  const late = "invoices or agreements due off the server since 2026-11-17 aren't copied yet";
  for (const day of [19, 20]) {   // two nights with the same record still waiting: one heads-up, one job
    status({ ok_at: `2026-11-${day}T02:32:00+00:00`, tried_at: `2026-11-${day}T02:32:00+00:00`, state: 'ok', warn: late, records_warn: late,
      records_error: 'not uploaded: records/documents/2026-11-17-40.tar.gz.age would take the records past their 2 GB (a flood of mail to invoices@ or documents@?)' });
    check(Date.parse(`2026-11-${day}T03:00:00Z`));
  }
  assert.equal(jobs(/^Off-site backup: invoices/).length, 1);
  assert.equal((await events()).filter(e => e.includes(late)).length, 1);
  assert.match((await events()).at(-1)!, /heads-up: .*aren't copied yet\. A job for Bolt is queued/);
  assert.match(await brief(/^Off-site backup: invoices/), /due off the server since 2026-11-17.*past their 2 GB/);
  // a task apart from the stale repo copy's, each with a code of its own
  assert.notEqual(jobs(/^Off-site backup: invoices/)[0].code, jobs(/^Off-site backup: the repo/)[0].code);
});

test('a night failed for how it is set up queues Bolt\'s job at once; a network failure waits the 26 hours', async () => {
  const good = '2026-12-01T02:32:00+00:00', refused = /^Off-site backup set up wrong/;
  status({ ok_at: good, tried_at: '2026-12-02T02:32:00+00:00', state: 'failed', error: 'R2 unreachable (URLError) for GET the bucket' });
  check(Date.parse('2026-12-02T03:00:00Z'));
  assert.equal(jobs(/last good 2026-12-01/).length, 0, 'a network failure: nothing before the 26 hours');
  status({ ok_at: good, tried_at: '2026-12-02T03:32:00+00:00', state: 'failed', config_error: true,
    error: 'R2 said 403 AccessDenied to GET the bucket company-backups' });
  check(Date.parse('2026-12-02T04:00:00Z'));
  check(Date.parse('2026-12-02T04:30:00Z'));
  assert.equal(jobs(refused).length, 1, 'one job, at the first refused try');
  assert.equal((await events()).filter(e => e.includes('since 1 Dec')).length, 0, 'the feed still waits for a missed night');
  assert.match(await brief(refused), /403 AccessDenied.*no later night mends by itself/);
  check(Date.parse('2026-12-02T05:00:00Z'));   // 26 hours: the missed night's alert, no second job
  assert.match((await events()).at(-1)!, /since 1 Dec, 03:32 \(1 night missed\).*A job for Bolt to find out why was queued already\./);
  assert.equal(jobs(/last good 2026-12-01/).length, 1);
});
