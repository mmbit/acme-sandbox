// node --test src/schedule.test.ts   (company/schedule.yaml in the test company; tick() is what the server runs every
// minute, here at a time of the test's)
import { test, mock, type TestContext } from 'node:test';
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

// ---- an entry for each agent (each: agent).
// org.yaml's desks for a test, and again later in it: each department's agents (an id, or "id:engine"), with the rest of
// the test company's chart (the board, roles, alumni) as it is
const desks = (t: TestContext, departments: Record<string, string[]>) => {
  const file = `${h.repo}/company/org.yaml`, before = readFileSync(file, 'utf8');
  const seat = (a: string) => { const [id, engine = 'claude'] = a.split(':'); return `      - { id: ${id}, name: ${id}, engine: ${engine} }\n`; };
  const desk = ([id, agents]: [string, string[]]) => `  - id: ${id}\n    name: ${id}\n    agents:\n${agents.map(seat).join('')}`;
  const write = (seated: Record<string, string[]>) =>
    writeFileSync(file, before.replace(/^departments:\n[\s\S]*?(?=^roles:)/m, `departments:\n${Object.entries(seated).map(desk).join('\n')}\n`));
  write(departments);
  t.after(() => writeFileSync(file, before));
  return write;
};
const weekOfNov2 = Date.parse('2026-11-01T23:00:00Z');   // Monday 2 November 00:00 in Amsterdam
// Ticks every hour of a week, at half past, from a Monday 00:00 in Amsterdam: the hour into the week each agent's run came
function tickWeek(title: string, monday: number, before = (_hour: number) => {}) {
  const came = new Map<string, number>();
  for (let hour = 0; hour < 168; hour++) {
    before(hour);
    tick(new Date(monday + hour * 36e5 + 30 * 60e3));
    for (const run of titles(new RegExp(`^${title} \\(`))) {
      const agent = run.match(/ ([a-z0-9-]+)\)$/)![1];
      if (!came.has(agent)) came.set(agent, hour);
    }
  }
  return came;
}

test('an entry for each agent runs once a week for every agent on a desk, spread over the week, and again the next', async t => {
  writeFileSync(`${h.repo}/company/shows.yaml`, '');
  desks(t, { executive: ['juno'], platform: ['bolt', 'lark', 'chime'], care: ['poppy:api'], security: ['nib:codex'] });
  const lead = await h.start({ agent: 'bolt' });   // a lead with a team member in Platform, whom HQ shows on its desk
  assert.equal((await h.worker('team', { job: lead.id, lead: 'bolt', id: 'scout', name: 'scout', parent: 'bolt', state: 'working' })).status, 200);
  schedule('- { id: memory, agent: juno, at: weekly, each: agent, title: Memory, routine: morning-round, code: MEMORY }');
  const came = tickWeek('Memory', weekOfNov2);
  assert.deepEqual(titles(/^Memory/), ['juno', 'bolt', 'lark', 'chime', 'nib'].map(a => `Memory (2026-11-02 ${a})`),
    'one each, never the team member, the alumni or the board; Poppy (on an engine no seat runs) is skipped, Nib after her still runs');
  // six on the desks: one every 28 hours from Monday 00:00
  assert.deepEqual(['juno', 'bolt', 'lark', 'chime', 'nib'].map(a => came.get(a)), [0, 28, 56, 84, 140]);
  const runs = (h.jobs.listJobs() as any[]).filter(j => /^Memory/.test(j.title)).sort((a, b) => a.id - b.id);
  assert.deepEqual(runs.map(j => j.agent), ['juno', 'bolt', 'lark', 'chime', 'nib'], "each its agent's own job");
  tick(new Date(weekOfNov2 + 7 * 864e5 + 30 * 60e3));
  assert.deepEqual(titles(/^Memory/).slice(5), ['Memory (2026-11-09 juno)'], 'the next week starts again');
  await h.finish(lead);
});

test("a hire or a departure that moves the agents' moments mid-week runs nobody twice", async t => {
  writeFileSync(`${h.repo}/company/shows.yaml`, '');
  const seat = desks(t, { executive: ['juno'], platform: ['bolt', 'lark', 'chime'] });
  schedule('- { id: moved, agent: juno, at: weekly, each: agent, title: Moved, prompt: x }');
  const came = tickWeek('Moved', weekOfNov2 + 14 * 864e5, hour => {
    if (hour === 60) seat({ executive: ['juno', 'fern'], platform: ['bolt', 'lark', 'chime'] });   // Wednesday noon: the others' moments move later
    if (hour === 100) seat({ executive: ['fern'], platform: ['bolt', 'lark', 'chime'] });   // Friday 04:00: Juno leaves, and they move earlier
  });
  assert.deepEqual(titles(/^Moved/).map(title => title.match(/ ([a-z]+)\)$/)![1]).sort(), ['bolt', 'chime', 'fern', 'juno', 'lark']);
  assert.equal(came.get('fern'), 60, 'the hire, whose moment had passed, runs at once');
});

test("HQ says an entry for each agent runs weekly and when the next agent's run comes, and it has no Run now", async t => {
  writeFileSync(`${h.repo}/company/shows.yaml`, '');
  desks(t, { executive: ['juno'], platform: ['bolt', 'lark', 'chime'] });
  schedule('- { id: words, agent: juno, at: weekly, each: agent, title: Words, prompt: x, model: claude-sonnet-5-5 }');
  const monday = new Date('2026-10-26T02:00:00Z'), sunday = new Date('2026-11-01T22:00:00Z');   // 03:00 and 23:00 in Amsterdam
  assert.deepEqual([(await shown(monday)).words.when, (await shown(monday)).words.next], ['weekly, each agent', 'due now']);
  tick(monday);
  // four on the desks: Bolt's moment is Monday 00:00 + 42 hours
  assert.deepEqual([(await shown(monday)).words.next, (await shown(monday)).words.soon], ['tomorrow 18:00', 1440 + 18 * 60]);
  tick(sunday);
  assert.deepEqual(titles(/^Words/), ['juno', 'bolt', 'lark', 'chime'].map(a => `Words (2026-10-26 ${a})`), 'missed moments run late within the week');
  assert.equal((await shown(sunday)).words.next, 'tomorrow 00:00');
  assert.equal((runNow('words') as [number, string])[0], 400);
  const run = (await h.claim('claude'))!;
  assert.deepEqual([run.title, run.agentInfo.model], ['Words (2026-10-26 juno)', 'claude-sonnet-5-5']);
});

test('an entry that sets `each: agent` or `at: weekly` without the other, or with `with:`, is left out and never runs', async t => {
  writeFileSync(`${h.repo}/company/shows.yaml`, '');
  desks(t, { executive: ['juno'], platform: ['bolt'] });
  const logged = t.mock.method(console, 'error', () => {});
  schedule(
    '- { id: half-at, agent: juno, at: weekly, title: Half, prompt: x }',
    '- { id: half-each, agent: juno, at: "07:00", each: agent, title: Half, prompt: x }',
    '- { id: meeting, agent: juno, at: weekly, each: agent, with: [bolt], title: Half, code: HALF, prompt: x }',
    '- { id: whole, agent: juno, at: weekly, each: agent, title: Whole, prompt: x }',
  );
  tickWeek('Half', weekOfNov2 + 21 * 864e5);
  assert.deepEqual(titles(/^Half/), []);
  assert.deepEqual(Object.keys(await shown(new Date())), ['whole']);
  assert.ok(logged.mock.calls.some(c => /^Schedule entry half-at: `each: agent` takes `at: weekly`/.test(c.arguments[0])));
});
