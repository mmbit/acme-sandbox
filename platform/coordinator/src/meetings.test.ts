// node --test src/meetings.test.ts   (throwaway DATA_DIR and the test company): agent meetings (meetings.ts), asked for,
// set by the CEO, their seats started together by the claim, the lines in them, and a schedule entry's `with:`.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { harness, type Running } from './harness.ts';

const h = await harness('meetings');
const { db } = h;
const meetings = await import('./meetings.ts');
const meetingseats = await import('./meetingseats.ts');
const chair = await import('./meetingchair.ts');
const memory = await import('./memory.ts');
const { tick } = await import('./schedule.ts');
const company = await import('./company.ts');
const { planChange } = await import('./db.ts');
const sizes = await import('./sizes.ts');
const { codeOf } = await import('./jobcodes.ts');
const { PROMPT_CHARS } = await import('./smallmodel.ts');

beforeEach(async () => {
  db.exec(`delete from jobs; delete from messages; delete from meetings; delete from meeting_seats; delete from meeting_lines;
  delete from meeting_asks; delete from schedule_runs; delete from seats`);
  await h.worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', until: 0 });
});

// A slot's claim, as the worker's slotLoop makes it: its seat, its engine, its own name and, paced, its seat's weekly
// reset.
const claimIn = async (slot: string, seat = 'claude-1', pacedUntil?: number) => {
  const r = await h.worker('claim', { seat, engine: 'claude', slot, pacedUntil });
  assert.equal(r.status, 200);
  return r.body && ({ ...r.body, seat } as Running);
};
// The claim's answer to a slot that holds a meeting's seat: what it holds, which the worker keeps its room for
const holds = async (slot: string) => (await claimIn(slot))?.held as { meeting: number; job: number } | undefined;
const status = (job: number) =>
  (db.prepare('select status from jobs where id = ?').get(job) as { status: string }).status;
const meetingStatus = (id: number) =>
  (db.prepare('select status from meetings where id = ?').get(id) as { status: string }).status;
// The chair's post in parts, as hq meeting close sends it.
const post = (headline: string, decision = 'We build it.') => ({
  headline,
  opening: 'We settled the plan.',
  projects: [{ name: 'Game', decisions: [decision] }],
  next: 'We start now.',
});

// Every seat of a meeting started, each in its own slot: the first n - 1 hold theirs, the last starts its own and the
// others start theirs at their next claim. By agent.
async function startSeats(n: number) {
  for (let i = 1; i < n; i++) assert.ok(await holds(`claude#${i}`), `claude#${i} holds a seat`);
  const started = [(await claimIn(`claude#${n}`))!];
  for (let i = 1; i < n; i++) started.push((await claimIn(`claude#${i}`))!);
  assert.ok(started.every(x => x?.kind === 'meeting'));
  return Object.fromEntries(started.map(x => [x.agent, x])) as Record<string, Running>;
}

// wren asks to meet bolt, and the CEO (juno) sets the meeting from that ask: juno's seat chairs it
async function setMeeting(topic = 'The level editor and the engine') {
  const wren = await h.start({ agent: 'wren', title: 'The levels' });
  const asked = await h.agent('meetings/ask', wren.token, { topic, with: ['bolt'] });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  const set = await h.agent('meetings/set', juno.token, { asks: [asked.body.id], topic });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  // (the jobs that asked and set it end, and the CEO's job for the ask ran, so only the seats and the test's work are queued)
  for (const j of [wren, juno]) await h.finish(j);
  const asksJob = (await h.claim('claude'))!;
  assert.equal(asksJob.title, meetings.ASKS_TITLE);
  await h.finish(asksJob);
  return { meeting: set.body.meeting as number, seats: set.body.seats as { agent: string; job: number }[] };
}

test("a meeting's seats start together: a free slot holds its seat until every seat has one, and only then do they start", async () => {
  const { meeting, seats } = await setMeeting();
  assert.deepEqual(
    seats.map(s => s.agent),
    ['wren', 'bolt', 'juno'],
    'the CEO, who chairs it, has a seat too',
  );
  const work = h.jobs.createJob({ agent: 'moss', title: 'Ordinary work', prompt: 'x' }).id;

  const held = await holds('claude#1');
  assert.equal(held?.meeting, meeting, 'the first slot holds a seat and starts nothing');
  assert.deepEqual(await holds('claude#1'), held, 'and holds it on its next claim');
  assert.equal(status(work), 'queued', "the held slot doesn't take other work");
  assert.ok(await holds('claude#2'));
  assert.equal(meetingStatus(meeting), 'planned');

  const third = await claimIn('claude#3');
  const [second, first] = [await claimIn('claude#2'), await claimIn('claude#1')];
  assert.deepEqual([third?.kind, second?.kind, first?.kind], ['meeting', 'meeting', 'meeting']);
  assert.deepEqual(
    [third!.id, second!.id, first!.id].sort(),
    seats.map(s => s.job).sort(),
    'each slot started a seat of its own',
  );
  assert.equal(meetingStatus(meeting), 'live');
  const by = Object.fromEntries([first!, second!, third!].map(x => [x.agent, x]));
  assert.match(
    by.wren.prompt,
    /^Meeting #\d+: The level editor and the engine\n\nWho's there: Wren \(wren, Head of Studio\), Bolt .*Juno \(juno, [^)]*\) chairs it\. It has no time limit/s,
  );
  assert.match(by.wren.prompt, /- wren asked to meet bolt: The level editor and the engine/);
  assert.doesNotMatch(by.wren.prompt, /You chair this meeting/);
  assert.match(by.juno.prompt, /You chair this meeting/);

  assert.equal((await claimIn('claude#4'))?.id, work, 'other work goes on in the other slots');
});

test('a gathering that takes HOLD_MS lets its slots go, and the meeting holds none while it rests', async () => {
  await setMeeting();
  const work = h.jobs.createJob({ agent: 'moss', title: 'Ordinary work', prompt: 'x' }).id;
  assert.ok(await holds('claude#1'));
  meetingseats.sweep(Date.now() + meetingseats.HOLD_MS);
  assert.equal((await claimIn('claude#1'))?.id, work, 'let go, the slot takes the next work');
  assert.equal(await claimIn('claude#2'), null, 'resting, nothing is held and nothing else is queued');
});

test('a hold is on its runner: one that hits its limit after the hold loses it, and the meeting waits for a ready runner', async () => {
  const { meeting } = await setMeeting();
  assert.ok(await holds('claude#1'));
  await h.worker('seat', { seat: 'claude-1', engine: 'claude', state: 'sleeping', until: Date.now() + 3_600_000 });
  await h.worker('seat', { seat: 'claude-2', engine: 'claude', state: 'ready', until: 0 });

  assert.ok(await claimIn('claude#2', 'claude-2'), 'the other slots hold seats on the ready runner');
  assert.ok(await claimIn('claude#3', 'claude-2'));
  assert.equal(meetingStatus(meeting), 'planned', "claude#1's hold on the sleeping runner doesn't count");
  assert.equal(meetingseats.holding('claude#1'), null, 'and is let go: the worker gives its room and place back');

  const first = await claimIn('claude#1', 'claude-2');
  assert.equal(first?.kind, 'meeting', 'claude#1 on a ready runner holds the last seat, which starts');
  assert.equal(meetingStatus(meeting), 'live');
  assert.equal((await claimIn('claude#2', 'claude-2'))?.kind, 'meeting');
  assert.equal((await claimIn('claude#3', 'claude-2'))?.kind, 'meeting');
});

test("a hold is on its runner's pace too: one paced while the seat can wait for its reset loses it, and the meeting waits", async () => {
  const { meeting } = await setMeeting();
  const week = Date.now() + 2 * 24 * 3_600_000;
  const pace = (seat: string, paced: boolean) =>
    h.worker('seat', {
      seat,
      engine: 'claude',
      state: 'ready',
      until: 0,
      week: 0.6,
      weekResets: week,
      pace: paced || undefined,
    });
  await pace('claude-1', false);
  await pace('claude-2', false);
  assert.ok(await claimIn('claude#1', 'claude-1'));
  await pace('claude-1', true); // (its week ran ahead: only work that must start before its reset, and a seat is undated)
  assert.equal(await claimIn('claude#1', 'claude-1', week), null, 'an empty claim releases its meeting hold');
  assert.equal(meetingseats.holding('claude#1'), null, 'without waiting for another slot to claim');

  assert.ok(await claimIn('claude#2', 'claude-2'), 'the other slots hold seats on the unpaced runner');
  assert.ok(await claimIn('claude#3', 'claude-2'));
  assert.equal(meetingStatus(meeting), 'planned', "claude#1's hold on the paced runner doesn't count");
  assert.equal(meetingseats.holding('claude#1'), null, 'and is let go');
  assert.equal(await claimIn('claude#1', 'claude-1', week), null, 'claude#1 on its paced runner holds nothing');
  assert.equal(meetingStatus(meeting), 'planned');

  await pace('claude-1', false);
  assert.equal((await claimIn('claude#1', 'claude-1'))?.kind, 'meeting', 'unpaced again, the last seat starts');
  assert.equal(meetingStatus(meeting), 'live');
  assert.equal((await claimIn('claude#2', 'claude-2'))?.kind, 'meeting');
  assert.equal((await claimIn('claude#3', 'claude-2'))?.kind, 'meeting');
});

test("a claim without a slot's name (an older worker) never starts a seat", async () => {
  await setMeeting();
  assert.equal((await h.worker('claim', { seat: 'seat-x', engine: 'claude' })).body, null);
});

test('the CEO hears asks in one queued job, and hq meeting asks shows the meetings already holding their agents', async () => {
  const { meeting, seats } = await setMeeting();
  const asksJobs = () =>
    db
      .prepare("select id from jobs where agent = ? and title = ? and status = 'queued'")
      .all('juno', meetings.ASKS_TITLE);
  const kit = await h.start({ agent: 'kit', title: 'Growth' });
  const asked = await h.agent('meetings/ask', kit.token, { topic: 'Launch timing', with: ['bolt'], by: '2h' });
  assert.equal(asked.body.heard, 'job');
  assert.equal(asksJobs().length, 1, 'no CEO session runs: a short job');
  const dex = await h.start({ agent: 'dex', title: 'Operations' });
  assert.equal((await h.agent('meetings/ask', dex.token, { topic: 'On call', with: ['kit'] })).body.heard, 'job');
  assert.equal(asksJobs().length, 1, 'a second ask waits for the same job, which reads every open ask');

  const juno = await h.start({ agent: 'juno', title: 'Meeting asks' });
  const [open, other] = (await h.agent('meetings/asks', juno.token)).body;
  assert.equal(open.id, asked.body.id);
  assert.deepEqual(other.overlap, [], "dex and kit aren't in a meeting");
  assert.deepEqual(
    open.overlap.map((m: any) => [m.meeting, m.seats]),
    [[meeting, ['wren', 'bolt', 'juno']]],
  );

  assert.equal(
    (await h.agent('meetings/join', kit.token, { meeting, ask: asked.body.id })).status,
    400,
    'the CEO only',
  );
  // (a meeting is one task: the CEO names its word as it sets it, and a seat added later carries its code.)
  const unnamed = await h.agent('meetings/set', juno.token, {
    asks: [asked.body.id],
    topic: 'Launch timing',
    code: '',
  });
  assert.match(unnamed.body.error, /a task needs its code: --code WORD/);
  const joined = await h.agent('meetings/join', juno.token, { meeting, ask: asked.body.id });
  assert.deepEqual(
    joined.body.seats.map((s: any) => s.agent),
    ['kit'],
  );
  const codes = new Set([...seats, ...joined.body.seats].map((s: { job: number }) => codeOf(s.job)));
  assert.equal(codes.size, 1);
  assert.notEqual([...codes][0], null);
  assert.deepEqual(
    (await h.agent('meetings/asks', juno.token)).body.map((a: any) => a.topic),
    ['On call'],
  );
});

test('in the meeting: say, listen (and the inbox hook) since the last read, hand in; the transcript in hq search', async () => {
  const { meeting } = await setMeeting('The editor’s save format');
  const { wren, bolt, juno } = await startSeats(3);

  assert.equal((await h.agent('meetings/say', wren.token, { text: 'JSON per level, one file each?' })).status, 200);
  await h.agent('meetings/say', bolt.token, { text: 'Yes, and a version field.' });
  const heard = await h.agent('meetings/listen', bolt.token, {});
  assert.deepEqual(
    heard.body.lines.map((l: any) => [l.agent, l.text]),
    [['wren', 'JSON per level, one file each?']],
  );
  assert.deepEqual(
    heard.body.seats.map((x: any) => x.agent),
    ['wren', 'bolt', 'juno'],
  );
  assert.equal(heard.body.progress, undefined, "the meeting's progress is the chair's");
  const again = await h.agent('meetings/listen', bolt.token, {});
  assert.deepEqual(again.body.lines, heard.body.lines, 'an answer that never arrived (no read yet) loses no line');
  await h.agent('meetings/read', bolt.token, { lines: heard.body.lines.map((l: any) => l.id) });
  assert.deepEqual((await h.agent('meetings/listen', bolt.token, {})).body.lines, [], 'read once hq printed them');

  const hook = await h.agent('inbox', wren.token, {});
  assert.deepEqual(
    hook.body.map((m: any) => [m.meeting, m.from, m.text]),
    [[meeting, 'bolt', 'Yes, and a version field.']],
  );
  await h.agent('meetings/say', bolt.token, { text: 'And keep filenames stable.' });
  assert.deepEqual((await h.agent('inbox', wren.token, {})).body, [], 'new lines wait for the unconfirmed batch');
  const wrenJob = wren.id;
  const retry = meetingseats.take(wrenJob, Date.now() + 61_000);
  assert.deepEqual(
    retry.map(l => l.text),
    ['Yes, and a version field.', 'And keep filenames stable.'],
  );
  await h.agent('inbox-ack', wren.token, { ids: [], lines: retry.map(l => l.line) });
  assert.deepEqual((await h.agent('meetings/listen', wren.token, {})).body.lines, [], 'the hook confirmed it');

  // (handed in, a seat stays in it and hears only the lines said to it.)
  assert.deepEqual(
    (await h.agent('meetings/hand-in', wren.token, { changed: 'game/levels: a task for the save format' })).body,
    { waiting: ['bolt'] },
  );
  assert.deepEqual(meetings.list().live[0].seats, ['wren', 'bolt', 'juno'], 'nobody leaves: everyone is still in it');
  await h.agent('meetings/say', bolt.token, { text: 'Filenames by level number.' });
  await h.agent('meetings/say', bolt.token, { text: 'Versioned from 1?', to: ['wren'] });
  assert.equal(
    (await h.agent('meetings/say', bolt.token, { text: 'x', to: ['kit'] })).status,
    400,
    'a seat in it only',
  );
  const toWren = (await h.agent('meetings/listen', wren.token, {})).body;
  assert.deepEqual(
    toWren.lines.map((l: any) => [l.text, l.to]),
    [['Versioned from 1?', ['wren']]],
    'handed in, it hears only what is said to it',
  );
  assert.deepEqual(
    toWren.seats.map((x: any) => [x.agent, x.chair, x.handed]),
    [
      ['wren', false, true],
      ['bolt', false, false],
      ['juno', true, false],
    ],
  );
  await h.agent('meetings/read', wren.token, { lines: toWren.lines.map((l: any) => l.id) });
  assert.equal((await h.agent('meetings/withdraw', wren.token, {})).status, 200);
  assert.deepEqual(
    (await h.agent('meetings/listen', wren.token, {})).body.lines.map((l: any) => l.text),
    ['Filenames by level number.', 'Versioned from 1?'],
    'its hand-in back, it hears on from where it handed in',
  );
  await h.agent('meetings/hand-in', wren.token, { changed: 'game/levels: a task for the save format, versioned' });
  assert.deepEqual((await h.agent('meetings/hand-in', bolt.token, { changed: 'nothing' })).body, { waiting: [] });
  assert.equal((await h.agent('meetings/hand-in', juno.token, { changed: 'x' })).status, 400, 'the chair closes');
  const early = await h.agent('meetings/close', juno.token, post('Levels are JSON'));
  assert.equal(early.status, 400, 'not before the tally, unless stalled');
  assert.deepEqual(
    (
      await h.agent('meetings/close', juno.token, {
        ...post('Levels are JSON', 'Levels are JSON, one file each.'),
        stalled: true,
      })
    ).body,
    { ended: true },
  );
  assert.equal(meetingStatus(meeting), 'done');

  const read = (await h.agent(`meetings/one?id=${meeting}`, bolt.token)).body;
  assert.deepEqual(
    read.lines.map((l: any) => l.agent),
    ['wren', 'bolt', 'bolt', 'bolt', 'bolt'],
  );
  assert.deepEqual(
    read.seats.map((s: any) => s.changed),
    ['game/levels: a task for the save format, versioned', 'nothing', null],
  );
  assert.equal(read.headline, 'Levels are JSON');
  assert.equal(
    read.summary,
    'We settled the plan.\n\n**Game**\n- Levels are JSON, one file each.\n\n**Next:** We start now.',
    'laid out from its parts',
  );
  await memory.refresh();
  const found = await memory.search('version field', { id: 0, agent: 'penny' });
  assert.ok(typeof found === 'object');
  assert.ok(
    found.hits.some((x: any) => x.pointer === `hq meeting ${meeting}`),
    JSON.stringify(found.hits),
  );
});

test("a live meeting's bubbles: the worker claims its new lines with their prompt, and each seat's latest line shows with its own", async () => {
  await setMeeting('The editor’s save format');
  const { wren, bolt } = await startSeats(3);
  const reasons = [
    'Yes, and a version field.',
    ...Array(300).fill('An old level must load after a format change.'),
  ].join(' ');
  await h.agent('meetings/say', wren.token, { text: 'JSON per level (#12), one file each?' });
  await h.agent('meetings/say', bolt.token, { text: reasons });
  const claimed = (await h.worker('gists/claim')).body;
  assert.equal(claimed.lines.length, 2);
  assert.ok(
    claimed.prompt.includes('JSON per level (#12), one file each?') && claimed.prompt.includes('a version field'),
  );
  assert.deepEqual((await h.worker('gists/claim')).body, {}, 'nothing more while its call is under way');
  const turns = [
    { id: claimed.lines[0], bubbles: ['One file for each level?'] },
    { id: claimed.lines[1], bubbles: ['Yes', 'With a version number in it'] },
  ];
  const invalidBubble = await h.worker('gists/answer', {
    lines: claimed.lines,
    result: { structured_output: { turns: [turns[0], { id: claimed.lines[1], bubbles: [null] }] } },
  });
  assert.match(invalidBubble.body.why, /invalid turn or bubbles/);
  assert.ok(
    meetings.list().live[0].said!.every(s => s.bubbles === null),
    'no partial batch is stored',
  );
  await h.worker('gists/answer', { lines: claimed.lines, result: { structured_output: { turns } } });
  const said = () => meetings.list().live[0].said!.map(s => [s.agent, s.text, s.bubbles]);
  assert.deepEqual(said(), [
    ['wren', 'JSON per level (#12), one file each?', turns[0].bubbles],
    ['bolt', reasons, turns[1].bubbles],
  ]);

  await h.agent('meetings/say', wren.token, { text: 'Agreed.' });
  const next = (await h.worker('gists/claim')).body;
  assert.equal(next.lines.length, 1, 'only the line past the latest in bubbles');
  assert.ok(next.prompt.includes(reasons), 'the whole turn it answers, however long');
  await h.worker('gists/answer', { lines: next.lines, error: 'fetch failed' });
  assert.deepEqual((await h.worker('gists/claim')).body.lines, next.lines, 'a failed call: due again at once');
  const invalid = await h.worker('gists/answer', { lines: next.lines, result: { structured_output: { turns: [] } } });
  assert.match(invalid.body.why, /every claimed line exactly once/);
  assert.deepEqual((await h.worker('gists/claim')).body, {}, 'two tries, then left without bubbles');
  assert.deepEqual(said()[1], ['wren', 'Agreed.', null]);

  await h.agent('meetings/say', bolt.token, { text: 'Two more. '.repeat(PROMPT_CHARS / 10) });
  assert.deepEqual(
    (await h.worker('gists/claim')).body,
    {},
    "past the model's context: no call, never a cut transcript",
  );
});

test('no time limit: the chair sees progress, the tally runs once all have handed in, the chair sends back and closes', async () => {
  const { meeting } = await setMeeting();
  const kitAsk = await h.agent('meetings/ask', (await h.start({ agent: 'kit', title: 'Growth' })).token, {
    topic: 'Late',
    with: ['wren'],
  });
  const { wren, bolt, juno } = await startSeats(3);
  const late = await h.agent('meetings/join', (await h.start({ agent: 'juno', title: 'Asks' })).token, {
    meeting,
    ask: kitAsk.body.id,
  });
  await h.finish((await claimIn('claude#4'))!); // (the CEO's job for kit's ask)
  const kit = (await claimIn('claude#5'))!;
  assert.equal(kit.id, late.body.seats[0].job, 'a seat joined to a live meeting starts at once');
  meetingseats.sweep(Date.now() + 24 * 3_600_000);
  assert.equal(meetingStatus(meeting), 'live', 'a day on, it still runs');

  const started = Date.parse(meetings.meeting(meeting)!.started!);
  const now = Date.now();
  meetingseats.say(wren.id, 'The save format first.', [], now - 1000);
  planChange({ project: 'game', what: 'a task for the save format', by: 'wren', meeting });
  meetingseats.say(bolt.id, 'And the level order?', [], now + 1000);
  meetingseats.say(wren.id, 'Still open.', [], now + 2000);
  assert.deepEqual(
    chair.progress(meetings.meeting(meeting)!, Date.now() + 24 * 60_000),
    {
      minutes: Math.floor((now - started) / 60_000) + 24,
      lines: 4,
      change: { by: 'wren', project: 'game', minutes: 24 },
      since: 2,
    },
    "the CEO's agenda line and wren's, then the plan change and two lines since it",
  );
  const heardByChair = (await h.agent('meetings/listen', juno.token, {})).body;
  assert.ok(heardByChair.progress, "the chair's listen has the progress");
  assert.equal(heardByChair.tally, null, 'and no tally before everyone has handed in');
  assert.equal((await h.agent('meetings/close', wren.token, post('x'))).status, 400, 'the chair only');

  for (const seat of [wren, bolt, kit]) await h.agent('meetings/hand-in', seat.token, { changed: 'nothing' });
  meetingseats.sweep();
  const tallied = () => JSON.parse(meetings.meeting(meeting)!.tally ?? 'null');
  assert.ok(tallied()?.at, 'all handed in: the tally plays the queue');
  assert.equal((await h.agent('meetings/reopen', bolt.token, { agents: ['wren'], text: 'x' })).status, 400);
  await h.agent('meetings/reopen', juno.token, { agents: ['bolt'], text: 'One thread for the editor, not three' });
  assert.equal(tallied(), null, 'a hand-in sent back: the tally goes');
  assert.deepEqual(
    (await h.agent('meetings/listen', bolt.token, {})).body.lines.at(-1),
    {
      id: (meetings.one(meeting) as any).lines.at(-1).id,
      at: (meetings.one(meeting) as any).lines.at(-1).at,
      agent: 'juno',
      text: 'One thread for the editor, not three',
      to: ['bolt'],
    },
    'sent back, it hears the meeting again, the line to it last',
  );
  await h.agent('meetings/hand-in', bolt.token, { changed: 'game/editor: one thread' });
  meetingseats.sweep();
  assert.ok(tallied()?.at);
  planChange({ project: 'game', what: 'one more task', by: 'wren' });
  assert.equal(tallied(), null, 'a plan change after the hand-in takes it back, and the tally');
  assert.equal(meetings.seatOfJob(wren.id)!.handed, null);
  await h.agent('meetings/hand-in', wren.token, { changed: 'game/levels: two tasks' });
  meetingseats.sweep();

  const refused = async (body: object) => {
    const r = await h.agent('meetings/close', juno.token, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    return JSON.stringify(r.body);
  };
  const editor = {
    headline: 'The editor comes first',
    opening: 'We build the editor first, in one thread.',
    projects: [{ name: 'Game', decisions: ['The editor is one thread, done today.', 'New levels wait for it.'] }],
    next: 'the editor starts now.',
  };
  const prose = Array.from({ length: 2 }, () => Array.from({ length: 100 }, () => 'word').join(' ')).join('\n');
  assert.match(
    await refused({ summary: prose, headline: 'Two long lines' }),
    /opening/,
    'a summary in prose, no parts',
  );
  assert.match(await refused({ ...editor, headline: '' }), /headline/, 'a headline apart from the topic');
  assert.match(
    await refused({ ...editor, headline: 'The editor comes first and new levels wait now' }),
    /9 words: say what was decided in at most 8/,
  );
  assert.match(await refused({ ...editor, headline: 'The editor\ncomes first' }), /headline/, 'on one line');
  assert.match(await refused({ ...editor, headline: 'The editor\rcomes first' }), /headline/, 'a carriage return too');
  assert.match(await refused({ ...editor, opening: '' }), /opening/);
  assert.match(await refused({ ...editor, projects: [] }), /--project/, 'at least one project');
  assert.match(await refused({ ...editor, projects: [{ name: 'Game', decisions: [] }] }), /--decision/);
  assert.match(await refused({ ...editor, projects: [{ name: '', decisions: ['x'] }] }), /--project/);
  assert.match(await refused({ ...editor, projects: [{ name: 'Game', decisions: ['One\nTwo'] }] }), /one line/);
  assert.match(await refused({ ...editor, projects: [{ name: 'Game', decisions: ['One\r\rTwo'] }] }), /one line/);
  assert.match(await refused({ ...editor, next: '' }), /--next/);
  assert.equal(meetingStatus(meeting), 'live', 'refused, the meeting goes on');
  const closed = await h.agent('meetings/close', juno.token, {
    ...editor,
    projects: [...editor.projects, { name: 'Site', decisions: ['<script>alert(1)</script>'] }],
  });
  assert.deepEqual(closed.body, { ended: true });
  assert.equal(meetingStatus(meeting), 'done');
  assert.match(
    (db.prepare('select stopping from jobs where id = ?').get(bolt.id) as { stopping: string }).stopping,
    /meeting #\d+ ended \(the chair closed it\)/,
  );
  const shown = company.gazette().find(p => p.slug === `meeting-${meeting}`);
  assert.equal(shown?.title, 'The editor comes first', 'the headline, not the topic');
  assert.ok(shown);
  assert.match(shown.html, /<p>We build the editor first, in one thread\.<\/p>/);
  assert.match(shown.html, /<strong>Game<\/strong>/);
  assert.match(
    shown.html,
    /<ul>\s*<li>The editor is one thread, done today\.<\/li>\s*<li>New levels wait for it\.<\/li>\s*<\/ul>/,
  );
  assert.match(shown.html, /<strong>Next:<\/strong> the editor starts now\./);
  assert.ok(shown.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(shown.html, /<script>/);
  const outcome = {
    id: meeting,
    topic: meetings.meeting(meeting)!.topic,
    ended: meetings.meeting(meeting)!.ended,
    why: 'the chair closed it',
    summary: [
      'We build the editor first, in one thread.',
      '',
      '**Game**',
      '- The editor is one thread, done today.',
      '- New levels wait for it.',
      '',
      '**Site**',
      '- <script>alert(1)</script>',
      '',
      '**Next:** the editor starts now.',
    ].join('\n'),
    seats: [
      { agent: 'wren', chair: false, changed: 'game/levels: two tasks' },
      { agent: 'bolt', chair: false, changed: 'game/editor: one thread' },
      { agent: 'juno', chair: true, changed: null },
      { agent: 'kit', chair: false, changed: 'nothing' },
    ],
    pointer: `hq meeting ${meeting}`,
  };
  for (const seat of [juno, wren, bolt, kit]) {
    const past = (await h.agent('history', seat.token)).body;
    assert.deepEqual(past.meetings, [outcome], `${seat.agent}'s hq history has the meeting's outcome`);
    assert.deepEqual(
      (await h.agent(`history?q=%23${meeting}`, seat.token)).body.meetings,
      [outcome],
      'and by its number',
    );
  }
  const printed = await h.hq(kit, 'history');
  assert.equal(printed.code, 0);
  for (const supplied of [outcome.topic, outcome.summary, outcome.pointer]) assert.ok(printed.out.includes(supplied));
  for (const seat of outcome.seats) {
    assert.ok(printed.out.includes(seat.agent));
    if (seat.changed !== null) assert.ok(printed.out.includes(seat.changed));
  }
});

test("the tally is of the meeting's latest inputs: every size settled, gone with any plan change or a joined ask", async t => {
  const { meeting } = await setMeeting();
  const { wren, bolt, juno } = await startSeats(3);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // (time passes for the sizer's tries while the seats' worker keeps reporting them, as it does every minute)
  const pass = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (const seat of [wren, bolt, juno]) await h.heartbeat(seat);
  };
  const ended = Date.now() - 24 * 3_600_000;
  for (const minutes of [10, 20, 30])
    h.pastJob({
      agent: 'moss',
      title: 'Due work',
      run: { started: ended - minutes * 60_000, ended },
      merged: ended + 3_600_000,
    });
  const work = h.jobs.createJob({
    agent: 'moss',
    title: 'Due work',
    prompt: 'Build it',
    thread: h.dueThread(),
    queuedBy: 'moss',
  }).id;
  const first = (await h.worker('sizes/claim')).body;
  assert.equal(first.job, work);
  await h.worker('sizes/answer', { job: work, brief: first.brief, error: 'fetch failed' });
  await pass(11 * 60_000);
  const second = (await h.worker('sizes/claim')).body;
  assert.equal(second.job, work);
  const { brief } = second;
  for (const seat of [wren, bolt]) await h.agent('meetings/hand-in', seat.token, { changed: 'nothing' });
  const tallied = () => JSON.parse(meetings.meeting(meeting)!.tally ?? 'null');
  const close = () => h.agent('meetings/close', juno.token, post('We build it'));

  meetingseats.sweep();
  assert.deepEqual(tallied(), { waiting: [{ job: work, failed: false }] }, 'a size still to come holds the tally');
  await pass(11 * 60_000);
  meetingseats.sweep();
  assert.deepEqual(
    tallied(),
    { waiting: [{ job: work, failed: true }] },
    'an unanswered final try expires: it needs a size by hand',
  );
  assert.match(JSON.stringify((await close()).body), new RegExp(`#${work}.*hq estimate set`));
  await h.worker('sizes/answer', { job: work, brief, error: 'fetch failed' });
  meetingseats.sweep();
  assert.deepEqual(
    tallied(),
    { waiting: [{ job: work, failed: true }] },
    'every try failed: it waits for a size by hand',
  );
  assert.match(JSON.stringify((await close()).body), new RegExp(`#${work}.*hq estimate set`));
  sizes.record({
    job: work,
    by: 'moss',
    agent_ms: 3_600_000,
    low_ms: 1_800_000,
    high_ms: 7_200_000,
    refs: [],
    why: 'x',
    brief,
  });
  meetingseats.sweep();
  assert.ok(tallied()?.at, 'settled: the tally plays');

  planChange({ project: 'due', what: 'a task moved', by: 'juno' });
  assert.equal(tallied(), null, "the chair's own plan change takes the tally back");
  meetingseats.sweep();
  assert.ok(tallied()?.at, 'and it plays again on the change');

  const kit = await h.start({ agent: 'kit', title: 'Growth' });
  const asked = await h.agent('meetings/ask', kit.token, { topic: 'Launch timing', with: ['wren'] });
  await h.agent('meetings/join', (await h.start({ agent: 'juno', title: 'Asks' })).token, {
    meeting,
    ask: asked.body.id,
  });
  assert.equal(tallied(), null, 'a joined ask takes the tally back');
  assert.equal(meetings.seatOfJob(wren.id)!.handed, null, 'and the hand-ins of its agents already there');
  meetingseats.sweep();
  assert.equal(tallied(), null, "no tally while the new seat and wren haven't handed in");
  assert.match(JSON.stringify((await close()).body), /not everyone has handed in \(wren, kit\)/);
  const parts = ['--headline', 'We revisit the open changes', '--opening', 'We stopped short.', '--project', 'Game'];
  const usage = await h.hq(juno, 'meeting', 'close', ...parts, '--decision');
  assert.match(usage.out, /usage: hq meeting close/, 'a part without its words');
  assert.match((await h.hq(juno, 'meeting', 'close', '--decision', 'x', ...parts)).out, /usage/, 'a decision first');
  const closing = await h.hq(juno, 'meeting', 'close', ...parts, '--decision', 'The open changes come back.');
  assert.match(closing.out, /Not closed: give the post its next step/);
  const stalled = await h.hq(
    juno,
    'meeting',
    'close',
    '--stalled',
    ...parts,
    '--decision',
    'The open changes come back.',
    '--next',
    'We meet again.',
  );
  assert.equal(stalled.code, 0, stalled.out);
  assert.equal(
    meetings.meeting(meeting)!.summary,
    'We stopped short.\n\n**Game**\n- The open changes come back.\n\n**Next:** We meet again.',
  );
  const past = (await h.agent('history', wren.token)).body.meetings;
  assert.equal(past.length, 1);
  assert.equal(past[0].id, meeting);
  assert.equal(
    past[0].seats.find((s: any) => s.agent === 'wren').changed,
    null,
    'a taken-back hand-in is not an outcome',
  );
  assert.ok(!past[0].seats.some((s: any) => s.agent === 'kit'), 'a seat cancelled before it started was not there');
  assert.deepEqual((await h.agent('history', kit.token)).body.meetings, [], 'an unstarted seat has no meeting history');
});

test("a schedule entry with `with:` sets a meeting at its time, its agent's seat the run's job", async () => {
  const entry =
    '- { id: strategy, agent: wren, at: "Mon 09:00", title: Weekly strategy review, prompt: "Three recommendations, talked through.", with: [bolt]';
  // (without its code no meeting is set, and the slot stays open till it has one.)
  writeFileSync(`${h.repo}/company/schedule.yaml`, `${entry} }\n`);
  tick(new Date('2026-10-05T07:30:00Z')); // Monday 09:30 in Amsterdam
  assert.deepEqual(meetings.list().planned, []);
  assert.equal(db.prepare("select 1 from schedule_runs where id = 'strategy'").get(), undefined);
  writeFileSync(`${h.repo}/company/schedule.yaml`, `${entry}, code: strategy }\n`);
  tick(new Date('2026-10-05T07:31:00Z'));
  const [m] = meetings.list().planned;
  assert.equal(m.topic, 'Weekly strategy review (2026-10-05)');
  assert.deepEqual(m.seats, ['wren', 'bolt', 'juno']);
  const run = db.prepare("select job from schedule_runs where id = 'strategy'").get() as { job: number };
  assert.equal((db.prepare('select agent, kind from jobs where id = ?').get(run.job) as any).kind, 'meeting');
  const seats = db
    .prepare('select j.code from meeting_seats s join jobs j on j.id = s.job where s.meeting = ?')
    .all(m.id);
  assert.deepEqual(new Set(seats.map((s: any) => s.code)), new Set(['STRATEGY']), 'every seat carries the code');
  // (the run is a thread of the routine's project, every seat in it)
  const threads = db
    .prepare(
      'select distinct t.id, t.name from meeting_seats s join jobs j on j.id = s.job join threads t on t.id = j.thread where s.meeting = ?',
    )
    .all(m.id)
    .map((t: any) => [t.id, t.name]);
  assert.deepEqual(threads, [[`strategy/job-${run.job}`, 'Weekly strategy review, 5 Oct']]);
  const read = meetings.one(m.id);
  assert.ok(typeof read === 'object');
  assert.equal(read.brief, 'Three recommendations, talked through.');
  assert.deepEqual(
    (await h.board('/api/meetings')).body.planned.map((x: any) => x.id),
    [m.id],
  );
});

test("a meeting doesn't gather while a seat of it has no ready seat to run on: its slots go to other work", async () => {
  const wren = await h.start({ agent: 'wren', title: 'The levels' });
  const asked = await h.agent('meetings/ask', wren.token, { topic: 'Reviews of the editor', with: ['nib'] });
  const juno = await h.start({ agent: 'juno', title: 'Asks' });
  const { meeting } = (await h.agent('meetings/set', juno.token, { asks: [asked.body.id], topic: 'Reviews' })).body;
  const asksJob = (await h.claim('claude'))!;
  await h.finish(asksJob);
  const work = h.jobs.createJob({ agent: 'moss', title: 'Ordinary work', prompt: 'x' }).id;
  assert.equal((await claimIn('claude#1'))?.id, work, "nib's Codex seat has no ready seat: wren's isn't held");
  assert.equal(meetingStatus(meeting), 'planned');
});

test('the agenda is every ask set or joined, and one joined to a live meeting is said in it, even with nobody new', async () => {
  const wren = await h.start({ agent: 'wren', title: 'The levels' });
  const ids = [];
  for (const topic of ['The save format', 'The level order', 'The editor shortcuts'])
    ids.push((await h.agent('meetings/ask', wren.token, { topic, with: ['bolt'] })).body.id);
  const juno = await h.start({ agent: 'juno', title: 'Asks' });
  const { meeting } = (await h.agent('meetings/set', juno.token, { asks: ids.slice(0, 2), topic: 'The editor' })).body;
  const asksJob = (await h.claim('claude'))!;
  await h.finish(asksJob);
  const { wren: a, bolt: b } = await startSeats(3);
  for (const seat of [a, b]) {
    assert.match(seat.prompt, /- wren asked to meet bolt: The save format\n- wren asked to meet bolt: The level order/);
  }
  const joined = await h.agent('meetings/join', juno.token, { meeting, ask: ids[2] });
  assert.deepEqual(joined.body.seats, [], 'wren and bolt are seated already');
  for (const seat of [a, b])
    assert.deepEqual(
      (await h.agent('meetings/listen', seat.token, {})).body.lines.map((l: any) => [l.agent, l.text]),
      [['juno', `On the agenda now: wren asked to meet bolt: The editor shortcuts (ask #${ids[2]})`]],
    );
});

test("a job holding a customer's own details can't ask for a meeting, or say or hand in anything in one", async () => {
  const { meeting } = await setMeeting();
  const marked = await h.start({ agent: 'kit', title: 'A customer mail' });
  h.jobs.handedCustomerData(marked.id);
  const asked = await h.agent('meetings/ask', marked.token, { topic: 'About a customer', with: ['bolt'] });
  assert.equal(asked.status, 400);
  const { wren: a } = await startSeats(3);
  h.jobs.handedCustomerData(a.id);
  for (const [route, body] of [
    ['meetings/say', { text: 'The customer wrote…' }],
    ['meetings/hand-in', { changed: 'nothing' }],
  ] as const) {
    const r = await h.agent(route, a.token, body);
    assert.equal(r.status, 400, route);
  }
  assert.equal(
    (db.prepare('select count(*) n from meeting_lines where meeting = ?').get(meeting) as { n: number }).n,
    0,
  );
});

test("the chair's instructions carry the company's own meeting guidance when it has a playbook for it, and only then", () => {
  const file = `${process.env.REPO_DIR}/${chair.MEETINGS}`;
  rmSync(file, { force: true });
  assert.equal(chair.chair(), chair.CHAIR, 'none: the generic guidance alone');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'Name the product first.\n');
  try {
    const instructions = chair.chair();
    assert.ok(instructions.includes(chair.CHAIR));
    assert.ok(instructions.includes('Name the product first.'));
  } finally {
    rmSync(file);
  }
});
