// node --test src/goingon.test.ts   (throwaway DATA_DIR and the test company): what a call hears is going on, in its
// briefing and fresh from hq now (the eta tool with no query): everyone HQ counts at work, why each runs while a hold is
// on, and what each open card holds up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('goingon', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'projects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
    ),
});
const { db, jobs } = h;
const projects = await import('./projects.ts');
const windows = await import('./windows.ts');
const forecast = await import('./forecast.ts');

const HOUR = 3600_000;
const thread = (project: string, slug: string) =>
  (projects.createThread({ project, name: `The ${slug}`, goal: 'It works', slug }) as { id: string }).id;
const card = (title: string, agent: string | null = null, job: number | null = null) =>
  Number(
    db
      .prepare("insert into requests (created, agent, job, kind, title, body) values (?, ?, ?, 'decision', ?, 'x')")
      .run(new Date().toISOString(), agent, job, title).lastInsertRowid,
  );
const iso = (ms: number) => new Date(ms).toISOString();
// A run on its thread from a given time: claimed in no thread (a paused one starts nothing), then put there
const runOn = async (agent: string, title: string, thread: string | null, started: number) => {
  const run = await h.start({ agent, title });
  db.prepare('update jobs set thread = ?, started = ? where id = ?').run(thread, iso(started), run.id);
  return run;
};
const lineOf = (text: string, id: number) => text.split('\n').find(l => l.startsWith(`- #${id},`)) ?? '';

test("a call hears who's at work as HQ counts them, why each runs through the hold, and what each card holds up", async () => {
  const now = Date.now();
  const levels = thread('game', 'levels'),
    art = thread('game', 'art'),
    checkout = thread('shop', 'checkout');
  windows.set(projects.findThread(checkout)!, { deadline: now + 3 * HOUR, aim: now + 3 * HOUR }, 'moss');
  const lift = jobs.createJob({
    agent: 'wren',
    title: 'Lift the hold',
    prompt: 'x',
    queuedBy: 'wren',
    thread: levels,
    word: 'LIFT',
  }).id;
  const before = await runOn('wren', 'Draw the caves', levels, now - 2 * HOUR);
  const leaked = await runOn('kit', 'Tune the caves', levels, now - 10 * 60_000);
  const windowed = await runOn('moss', 'Pay by card', checkout, now - 30 * 60_000);
  const loose = await runOn('bolt', 'Tidy the logs', null, now - 5 * 60_000);
  assert.equal(
    (await h.worker('team', { job: before.id, id: 'ada', name: 'ada', lead: 'wren', state: 'working' })).status,
    200,
  );
  // The hold: the levels paused an hour ago until the lift merges, the art until the board decides
  db.prepare(
    "insert into pauses (project, thread, why, by, at) values ('game', ?, 'The trial goes first', 'juno', ?)",
  ).run(levels, iso(now - HOUR));
  db.prepare('insert into pause_until (pause, job) select id, ? from pauses where thread = ?').run(lift, levels);
  const style = card('Pick the art style', 'wren');
  db.prepare("insert into decisions (name, by, at, request) values ('the art style', 'juno', ?, ?)").run(
    iso(now),
    style,
  );
  db.prepare(
    "insert into pauses (project, thread, why, by, at, decision) values ('game', ?, 'Waits for the style', 'juno', ?, last_insert_rowid())",
  ).run(art, iso(now));
  // A card the lift is queued after, one its asker is parked on, and one nothing waits on
  const image = card('Build the runtime image', 'wren', before.id);
  db.prepare('insert into request_waits (job, request) values (?, ?)').run(lift, image);
  const parked = jobs.createJob({ agent: 'kit', title: 'Ask for the budget', prompt: 'x', word: 'BUDGET' }).id;
  const budget = card('A budget for the trial', 'kit', parked);
  db.prepare("update jobs set status = 'blocked', request = ? where id = ?").run(budget, parked);
  card('Approve the logo');
  forecast.refresh(now);

  const onCall = await h.voice('call-context', { agent: 'juno', lang: 'en' });
  const prompt = onCall.body.prompt as string;
  const fresh = await h.agent('now', onCall.body.token);
  assert.equal(fresh.status, 200, 'the call token reads it: the eta tool with no query');
  for (const text of [prompt, fresh.body.text as string]) {
    assert.match(
      text,
      /HQ counts 5 at work, as the board sees it: 4 agents on 4 runs, and 1 team member inside them\./,
    );
    assert.match(
      text,
      /- Paused: game\/levels, until it's resumed; once #\d+ "Lift the hold" \(wren's, queued\) merges or ends, its owner judges whether to lift it\. Why: The trial goes first/,
    );
    assert.match(
      text,
      /- Paused: game\/art, until the board decides "the art style", on its card "Pick the art style"\./,
    );
    assert.match(
      lineOf(text, before.id),
      /wren: Draw the caves \(job on seat-\d+, since .*\), in "The levels" \(The game\), no window\. Through the hold: it started before game\/levels was paused .*, and a pause doesn't stop a run under way\. Its team: Ada\./,
    );
    assert.match(
      lineOf(text, leaked.id),
      /Through the hold: game\/levels is paused since .*, yet this started after it: a leak\./,
    );
    assert.match(
      lineOf(text, windowed.id),
      /in "The checkout" \(The shop\), window to .* Through the hold: its thread isn't paused \(it has a window\)\./,
    );
    assert.match(
      lineOf(text, loose.id),
      /in no thread\. Through the hold: it is in no thread, so no project or thread pause reaches it\./,
    );
    assert.match(
      text,
      /- Build the runtime image, asked by Wren for "The levels": holds up #\d+ "Lift the hold" \(wren's, queued after it, in "The levels"\)\./,
    );
    assert.match(
      text,
      /- A budget for the trial, asked by Kit: holds up #\d+ "Ask for the budget" \(kit's, parked on it\)\./,
    );
    assert.match(
      text,
      /- Pick the art style, asked by Wren: keeps game\/art paused until it's answered; the plan of "The art" counts on its answer\./,
    );
    assert.match(text, /- Approve the logo: nothing in HQ waits on it: no job is queued after it/);
  }
  assert.ok(prompt.indexOf('Going on right now') < prompt.indexOf('Queued or waiting for the board'));

  // Fresh each time it's asked: a run that ends leaves the list, without a new call
  await h.finish(loose, { status: 'done' });
  const later = (await h.hq({ token: onCall.body.token, agent: 'juno' }, 'now')).out;
  assert.match(later, /HQ counts 4 at work, as the board sees it: 3 agents on 3 runs, and 1 team member inside them\./);
  assert.equal(lineOf(later, loose.id), '');
  assert.match(lineOf(prompt, loose.id), /Tidy the logs/, "the briefing keeps what was going on at the call's start");
});

test('with no hold on, the call hears so, and no run gives a reason to be let through', async () => {
  db.exec('delete from pauses; delete from pause_until; delete from requests; delete from team');
  for (const { id, seat } of db.prepare("select id, seat from jobs where status = 'running'").all() as {
    id: number;
    seat: string;
  }[])
    await h.worker('finish', { job: id, seat, status: 'done' });
  const run = await runOn('bolt', 'Tidy the logs again', null, Date.now());
  const { text } = (await h.agent('now', (await h.voice('call-context', { agent: 'juno', lang: 'en' })).body.token))
    .body;
  assert.match(text, /No hold is on: nothing is paused\./);
  assert.doesNotMatch(lineOf(text, run.id), /Through the hold/);
  assert.match(text, /Waiting on the board's desk phone, each with the work that waits on it:\n- none/);
});

test('a card a pause waits for names the threads that need the paused one, though none of their work waits on it', async () => {
  db.exec('delete from pauses; delete from pause_until; delete from requests; delete from request_waits');
  const decisions = await import('./decisions.ts');
  const plan = await import('./plan.ts');
  const murals = thread('game', 'murals'),
    tills = thread('shop', 'tills');
  const queue = (agent: string, title: string, on: string, word: string) =>
    jobs.createJob({ agent, title, prompt: 'x', queuedBy: agent, thread: on, word }).id;
  const painting = queue('wren', 'Paint the murals', murals, 'MURALS');
  queue('moss', 'Ring up the tills', tills, 'TILLS');
  assert.deepEqual(plan.need(tills, murals, 'moss'), { ok: true });
  const look = decisions.create('the mural look', [murals], 'juno');
  assert.equal(typeof look, 'object', String(look));
  const asked = jobs.createRequest({
    kind: 'decision',
    title: 'Pick the mural look',
    body: 'Pick the look before the murals start.',
    agent: 'juno',
    decides: (look as { id: number }).id,
  });
  assert.equal(typeof asked, 'object', String(asked));
  forecast.refresh(Date.now());

  const token = (await h.voice('call-context', { agent: 'juno', lang: 'en' })).body.token;
  const { text } = (await h.agent('now', token)).body;
  assert.match(
    text,
    /- Pick the mural look, asked by Juno: keeps game\/murals paused until it's answered; the plan of "The murals", "The tills" counts on its answer\./,
  );
  const named = (await h.hq({ token, agent: 'juno' }, 'projects', 'the', 'tills')).out;
  assert.match(named, /- The tills: .*the board: "Pick the mural look"/);

  // The murals' work parked on a card of its own still waits for the decision's card, and so does the tills' plan
  const budget = card('A budget for the murals', 'wren', painting);
  db.prepare("update jobs set status = 'blocked', request = ? where id = ?").run(budget, painting);
  forecast.refresh(Date.now());
  const parked = (await h.agent('now', token)).body.text;
  assert.match(
    parked,
    /- Pick the mural look, asked by Juno: keeps game\/murals paused until it's answered; the plan of "The murals", "The tills" counts on its answer\./,
  );
  const stillNamed = (await h.hq({ token, agent: 'juno' }, 'projects', 'the', 'tills')).out;
  assert.match(stillNamed, /- The tills: .*the board: "Pick the mural look"/);
});
