// The tests' shared fixture for the board's sent notes: the CEO's routing check run the way the worker and the CEO run
// it, through the claim, a task of the notes (hq job --notes: routing's forTask) and the finish.
import assert from 'node:assert/strict';

const EVER = new Date(0).toISOString();

// After the coordinator's DATA_DIR and repo are set, as it imports the coordinator's modules.
export async function routingFixture() {
  const jobs = await import('./jobs.ts');
  const routing = await import('./routing.ts');
  // The check claimed (first in the claim's order on its agent's engine), every note it routes made a task for `to` (by
  // default the notes' owner: one owner's notes), and the check finished. The task, whose it is, and how.
  const routed = (check: number, to?: string, thread?: string) => {
    const claimed = jobs.claim(`routing-${check}`, jobs.findAgent(jobs.jobAgent(check)!)!.engine);
    assert.equal(claimed?.id, check, `check #${check} is claimed first`);
    const owner =
      to ??
      (routing.log(EVER) as { job: number; routed: string | null; owner: string }[]).find(
        r => r.job === check && !r.routed,
      )!.owner;
    const me = { id: check, agent: claimed.agent };
    const notes = (routing.log(EVER) as { note: number; job: number; routed: string | null }[])
      .filter(r => !r.routed)
      .map(r => r.note);
    const task = routing.forTask(me, owner, notes);
    assert.ok(typeof task === 'object', `routed: ${task}`);
    const { id: job } = jobs.createJob({
      agent: owner,
      title: 'The notes’ work',
      prompt: task.text,
      queuedBy: me.agent,
      thread,
    });
    task.take(job);
    jobs.finish(check, { status: 'done' });
    return { job, agent: owner, how: 'task' as const };
  };
  return { routed };
}
