// The harness's calls: recorded follow-ups with carried items, and live calls from the voice line.
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

type Voice = (route: string, body?: unknown) => Promise<{ status: number; body: any }>;

export async function recordedCalls(db: DatabaseSync, voice: Voice) {
  const ledger = await import('./ledger.ts');
  // A recorded call linked to its follow-up job.
  const storedCall = (id: number | null, agent: string, job: number) =>
    db.prepare("insert into calls (id, ts, agent, lines, job) values (?, 'now', ?, '[]', ?)").run(id, agent, job);
  const carriedItem = (job: number, agent: string) => {
    const call = Number(storedCall(null, agent, job).lastInsertRowid);
    const item = ledger.add(
      call,
      {
        kind: 'task',
        owner: agent,
        what: 'Build the plan',
        goal: 'Settle the build plan',
        quote: 'Plan it, then build it.',
      },
      null,
    );
    assert.ok(typeof item === 'object');
    assert.ok(typeof ledger.link(item.id, { ref: 'The build plan' }, agent, job) === 'object');
    return item;
  };
  // A live call as the voice line starts it, about this desk phone request if any: its id, token and key for HQ's
  // uploads. The agent's earlier calls not followed up yet ended a day ago, so the new one doesn't carry on from them
  // (call.ts carriedOn; no route moves the clock).
  const liveCall = async (agent: string, request = 0) => {
    db.prepare("update calls set ts = ? where agent = ? and status = 'ended' and processed_at is null").run(
      new Date(Date.now() - 25 * 3600_000).toISOString(),
      agent,
    );
    const started = await voice('call-context', { agent, lang: 'en', request });
    if (started.status !== 200) throw new Error(`call-context for ${agent}: ${JSON.stringify(started.body)}`);
    return started.body as { call: number; token: string; key: string };
  };
  return { storedCall, carriedItem, liveCall };
}
