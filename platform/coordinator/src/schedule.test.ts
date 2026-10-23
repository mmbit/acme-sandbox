// node --test src/schedule.test.ts   (company/schedule.yaml in the test company; tick() is what the server runs every
// minute, here at a time of the test's)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('schedule');
test.afterEach(h.cancelQueued);
const { tick, runNow } = await import('./schedule.ts');
const schedule = (...entries: string[]) => writeFileSync(`${h.repo}/company/schedule.yaml`, entries.join('\n'));
const titles = (title: RegExp) => (h.jobs.listJobs() as any[]).filter(j => title.test(j.title)).sort((a, b) => a.id - b.id).map(j => j.title);
// GET /api/schedule: the recurring work as the board sees it, at a time of the test's
const shown = async (at: Date) => {
  mock.timers.enable({ apis: ['Date'], now: at });
  try { return Object.fromEntries(((await h.board('/api/schedule')).body as any[]).map(e => [e.id, e])); } finally { mock.timers.reset(); }
};
const rotation = [1, 2].map(k => `- { id: pass-${k}, agent: bolt, at: "Sat 02:00", week: ${k} of 2, title: Pass ${k}, prompt: x }`);

test('a rotation runs one entry a week, taking turns, and HQ shows the turn next to the time', async () => {
  schedule(...rotation);
  for (const day of ['03', '10', '17']) tick(new Date(`2026-10-${day}T00:30:00Z`));   // Saturdays 02:30 in Amsterdam
  assert.deepEqual(titles(/^Pass/), ['Pass 1 (2026-10-03)', 'Pass 2 (2026-10-10)', 'Pass 1 (2026-10-17)']);
  assert.equal((await shown(new Date()))['pass-1'].when, 'Saturdays 02:00, week 1 of 2');
});

test('turns carry on across New Year, and a malformed week never runs', async () => {
  schedule('- { id: ny-1, agent: bolt, at: "Sat 02:00", week: 1 of 4, title: NY 1, prompt: x }',
    '- { id: ny-2, agent: bolt, at: "Sat 02:00", week: 2 of 4, title: NY 2, prompt: x }',
    '- { id: ny-5, agent: bolt, at: "Sat 02:00", week: 5 of 4, title: NY 5, prompt: x }',
    '- { id: ny-other, agent: bolt, at: "Sat 02:00", week: every other, title: NY other, prompt: x }');
  for (const day of ['2026-12-26', '2027-01-02']) tick(new Date(`${day}T01:30:00Z`));
  assert.deepEqual(titles(/^NY/), ['NY 1 (2026-12-26)', 'NY 2 (2027-01-02)']);
  const now = await shown(new Date());
  assert.deepEqual([now['ny-5'].next, now['ny-other'].next], [null, null]);
});

test('an entry can run on a lighter model and effort than its agent', async () => {
  schedule('- { id: releases, agent: bolt, at: "07:00", title: Releases, prompt: x, model: claude-sonnet-5-5, effort: low }',
    '- { id: plain, agent: bolt, at: "07:00", title: Plain, prompt: x }');
  writeFileSync(`${h.repo}/company/models.yaml`, 'claude: { model: claude-opus-5-5, effort: high }\n');
  tick(new Date('2026-10-05T06:00:00Z'));   // Monday 08:00 in Amsterdam
  const [light, plain] = [(await h.claim('claude'))!, (await h.claim('claude'))!];
  assert.deepEqual([light.title, light.agentInfo.model, light.agentInfo.effort], ['Releases (2026-10-05)', 'claude-sonnet-5-5', 'low']);
  assert.deepEqual([plain.title, plain.agentInfo.model, plain.agentInfo.effort], ['Plain (2026-10-05)', 'claude-opus-5-5', 'high']);
});

test('HQ says when each entry runs next, in the company\'s time', async () => {
  schedule(...rotation, '- { id: n-daily, agent: bolt, at: "07:45", title: Daily, prompt: x }', '- { id: n-weekly, agent: bolt, at: "Mon 07:30", title: Weekly, prompt: x }',
    '- { id: n-4h, agent: bolt, at: "every 4h", title: Four-hourly, prompt: x }');
  const fri6 = new Date('2026-10-02T04:00:00Z'), fri8 = new Date('2026-10-02T06:00:00Z');   // Friday 06:00 and 08:00 in Amsterdam
  let at = await shown(fri6);
  assert.equal(at['n-daily'].next, 'today 07:45');
  assert.deepEqual([at['n-4h'].next, at['n-4h'].soon], ['due now', -1], 'its 04h slot has not run: due now comes first');
  at = await shown(fri8);
  assert.equal(at['n-daily'].next, 'due now', "its time came and it hasn't run: within the minute");
  assert.deepEqual([at['n-weekly'].next, at['n-weekly'].soon], ['Monday 07:30', 3 * 1440 + 7 * 60 + 30]);
  tick(fri8);
  assert.equal((await shown(fri8))['n-daily'].next, 'tomorrow 07:45');
  assert.equal((await shown(new Date('2026-10-02T09:30:00Z')))['n-4h'].next, 'today 12:00', '11:30: the 08h slot ran');
  const late = new Date('2026-10-02T20:30:00Z');   // 22:30: the 20h slot
  tick(late);
  assert.equal((await shown(late))['n-4h'].next, 'tomorrow 00:00');
  at = await shown(new Date('2026-10-04T10:00:00Z'));   // a Sunday: week 1 of 2 had 3 October, week 2 has 10 October
  assert.deepEqual([at['pass-1'].next, at['pass-2'].next], ['Sat 17 Oct 02:00', 'Saturday 02:00']);
});

test("a run records the job it made and its entry's kind, for the usage report's share of refactoring (report.sh reads the table)", () => {
  schedule('- { id: tidy, agent: bolt, at: "Wed 02:00", title: Tidy, prompt: x, downtime: true, kind: refactoring }');
  tick(new Date('2026-10-07T00:30:00Z'));   // Wednesday 02:30 in Amsterdam
  const run = h.db.prepare("select s.kind, j.title from schedule_runs s join jobs j on j.id = s.job where s.id = 'tidy'").get();
  assert.deepEqual({ ...run }, { kind: 'refactoring', title: 'Tidy (2026-10-07)' });
});

test("a routine's shared text comes first, then the company's own additions; one that can't be read runs once it can", async () => {
  const base = readFileSync(`${h.repo}/shared/routines/morning-round.md`, 'utf8').trim();
  const entries = ['- { id: routine-round, agent: bolt, at: "07:00", title: Round, routine: morning-round, prompt: "Also the Gazette." }',
    '- { id: routine-plain, agent: bolt, at: "07:00", title: Plain, routine: morning-round }',
    '- { id: routine-out, agent: bolt, at: "07:00", title: Out, routine: ../secrets }'];
  schedule(...entries, '- { id: routine-typo, agent: bolt, at: "07:00", title: Typo, routine: morning-rounds }');
  const thu = new Date('2026-10-08T05:30:00Z');   // Thursday 07:30 in Amsterdam
  tick(thu);
  assert.equal((await h.claim('claude'))!.prompt, `${base}\n\nOur own additions:\nAlso the Gazette.`);
  assert.equal((await h.claim('claude'))!.prompt, base);
  assert.deepEqual(titles(/^(Typo|Out)/), [], 'a routine that is no file, or no plain name, makes no job');
  schedule(...entries, '- { id: routine-typo, agent: bolt, at: "07:00", title: Typo, routine: morning-round }');
  tick(thu);
  assert.deepEqual(titles(/^Typo/), ['Typo (2026-10-08)'], 'still open for when it is fixed');
});

test('a show in shows.yaml runs as its producer, from the show routine; Run now starts one at once and the scheduled one still comes', async () => {
  schedule();
  writeFileSync(`${h.repo}/company/shows.yaml`, ['- { id: digest, name: The Digest, at: "06:45", hosts: [bolt] }',
    '- { id: idea, name: Not yet, hosts: [bolt] }'].join('\n'));
  const base = readFileSync(`${h.repo}/shared/routines/show.md`, 'utf8').trim();
  const fri = new Date('2026-10-16T04:50:00Z');   // Friday 06:50 in Amsterdam
  assert.equal((await shown(fri))['show-digest'].when, 'daily 06:45');
  assert.deepEqual([(await shown(fri))['show-idea'].when, (await shown(fri))['show-idea'].next], ['on demand', null]);
  const now = runNow('show-digest', new Date('2026-10-16T04:40:00Z'));
  assert.ok('job' in now);
  assert.deepEqual(runNow('show-digest', new Date('2026-10-16T04:40:30Z')), [409, 'Already started this minute']);
  assert.deepEqual(runNow('nothing'), [404, 'No recurring entry nothing']);
  tick(fri);
  assert.deepEqual(titles(/^On Air/), ['On Air: The Digest (2026-10-16 06:40, on demand)', 'On Air: The Digest (2026-10-16)']);
  assert.ok('job' in runNow('show-idea', fri), 'a show with no time runs on demand');
  const job = (await h.claim('claude'))!;
  assert.equal(job.agent, 'bolt');
  assert.equal(job.prompt, `${base}\n\nOur own additions:\nThe show: \`digest\` in company/shows.yaml.`);
});
