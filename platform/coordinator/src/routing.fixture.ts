// The tests' shared fixture for the board's sent notes: the CEO's routing check run the way the worker and the CEO run
// it, through the claim, routing's own route and the finish.
import assert from 'node:assert/strict';

const EVER = new Date(0).toISOString();

// After the coordinator's DATA_DIR and repo are set, as it imports the coordinator's modules.
export async function routingFixture() {
  const jobs = await import('./jobs.ts');
  const routing = await import('./routing.ts');
  // The check claimed (first in the claim's order on its agent's engine), every note it routes sent to `to` (by default the
  // notes' owner: one owner's notes), and the check finished. The job they went to, and how.
  const routed = (check: number, to?: string) => {
    const claimed = jobs.claim(`routing-${check}`, jobs.findAgent(jobs.jobAgent(check)!)!.engine);
    assert.equal(claimed?.id, check, `check #${check} is claimed first`);
    const owner =
      to ??
      (routing.log(EVER) as { job: number; routed: string | null; owner: string }[]).find(
        r => r.job === check && !r.routed,
      )!.owner;
    const went = routing.route({ id: check, agent: claimed.agent }, owner, []);
    assert.ok(typeof went === 'object', `routed: ${went}`);
    jobs.finish(check, { status: 'done' });
    return went;
  };
  return { routed };
}
