// The follow-through tests' shared fixture: agreements on calls with the board, the hourly checks and the alarms they
// raise, set and read the way the coordinator keeps them.
import assert from 'node:assert/strict';
import type { harness } from './harness.ts';

// What a case starts without. Threads too: no two open threads share a name, so a case drawing one again starts clean.
// And what the summary's threats read, which summary.test.ts makes through its
// modules' routes.
const RESET = `delete from jobs; delete from runs; delete from calls; delete from call_items; delete from followthrough_checks;
  delete from requests; delete from prs; delete from seats; delete from threads; delete from thread_needs;
  delete from plan_changes; delete from test_results; delete from helper_runs; delete from proposals;
  delete from meeting_asks; delete from predictions; delete from sizes;
  delete from settings where key = 'followthrough.alarm' or key like 'stall.%' or key in ('company.paused', 'runs.held')`;

// After the harness, as it must come before any of the coordinator's modules.
export async function followthroughFixture(h: Awaited<ReturnType<typeof harness>>) {
  const { db } = h;
  const { ceo } = await import('./company.ts');
  const { setting } = await import('./db.ts');
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  // a whole hour, so t and t + n minutes fall in the same hour slot
  const t0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;

  const reset = () => db.exec(RESET);
  const DAY = 24 * HOUR;
  const agreed = createAgreement.bind(null, db, t0, ceo);
  // (each with its thread and that thread's window.)
  const checks = () =>
    db
      .prepare(
        `select c.slot, c.job, c.verdict, j.agent, j.thread, t.deadline, t.aim from followthrough_checks c
        join jobs j on j.id = c.job left join threads t on t.id = j.thread order by c.slot`,
      )
      .all() as ({ slot: string; job: number; verdict: string | null; agent: string } & Placed)[];
  const alarm = () => JSON.parse(setting('followthrough.alarm') ?? 'null')?.line ?? null;
  // The Process team's jobs about broken checks
  const told = () =>
    db
      .prepare(
        `select j.id, j.agent, j.prompt, j.status, j.thread, t.deadline, t.aim from jobs j left join threads t on t.id = j.thread
        where j.title like '%follow-through check isn''t working%' order by j.id`,
      )
      .all() as ({ id: number; agent: string; prompt: string; status: string } & Placed)[];
  // The engine a queued job runs on, for a claim that takes it
  const jobEngine = (id: number) =>
    (db.prepare('select engine from jobs where id = ?').get(id) as { engine: string }).engine;
  const handedOut = callHandedOut.bind(null, h, what => agreed(what, t0, 'bolt'));
  const startCheck = async () => {
    const job = await h.claim('claude');
    assert.equal(job?.id, checks().at(-1)!.job);
    return { ...job!, agent: ceo() };
  };

  return { MIN, HOUR, DAY, t0, reset, agreed, handedOut, checks, alarm, told, jobEngine, startCheck };
}

// bolt's call with an item on it (agreed's), whose follow-up (on `thread` if given) hands the item to chime (hq job
// --item) and ends done, with chime's job running.
async function callHandedOut(
  h: Awaited<ReturnType<typeof harness>>,
  agreed: (item: Item) => { call: number; item: number },
  what: Item,
  thread?: string,
) {
  const { call, item } = agreed(what);
  const followUp = await h.start({ agent: 'bolt', title: 'Follow up on your call with the board', thread });
  h.db.prepare('update calls set job = ? where id = ?').run(followUp.id, call);
  // (an item with no time says it has none, so the CEO isn't asked for one: askwindow.ts)
  const handed = await h.agent('job', followUp.token, {
    agent: 'chime',
    title: 'Wire the key',
    prompt: 'Do it',
    item,
    ...(what.due == null && { by: 'none' }),
  });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  await h.finish(followUp);
  // By id, so a thread PR's queued review isn't claimed in its place.
  const wire = await h.claimJob(handed.body.id);
  return { call, item, followUp: followUp.id, handed: handed.body, wire };
}

// A job's thread and its window
type Placed = { thread: string | null; deadline: number | null; aim: number | null };

type Item = { kind?: string; what?: string; quote?: string; status?: string; job?: number; due?: number };

// A call with the board (the CEO's unless named) and one item on it, with the time given for it on the call (due, ms)
// when it has one; returns the call and the item.
function createAgreement(
  db: Awaited<ReturnType<typeof harness>>['db'],
  defaultAt: number,
  ceo: () => string,
  item: Item = {},
  at = defaultAt,
  agent = ceo(),
  call: { status?: string; job?: number; request?: number; resumes?: number[] } = {},
) {
  const id = Number(
    db
      .prepare('insert into calls (ts, agent, lines, status, job, request, resumes) values (?, ?, ?, ?, ?, ?, ?)')
      .run(
        new Date(at).toISOString(),
        agent,
        '[]',
        call.status ?? 'ended',
        call.job ?? null,
        call.request ?? null,
        call.resumes ? JSON.stringify(call.resumes) : null,
      ).lastInsertRowid,
  );
  const itemId = db
    .prepare(
      'insert into call_items (call, kind, owner, what, quote, status, job, due, ts) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      item.kind ?? 'decision',
      ceo(),
      item.what ?? 'No game work until the projects build lands',
      item.quote ?? 'Hold the game work tonight, all of it, until the projects build is merged.',
      item.status ?? 'open',
      item.job ?? null,
      item.due ?? null,
      new Date(at).toISOString(),
    ).lastInsertRowid;
  return { call: id, item: Number(itemId) };
}
