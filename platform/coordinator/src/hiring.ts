// Work for a colleague who is being hired: `hq job --after <the hiring job> <new agent>` while org.yaml on main doesn't
// have them yet (company/playbooks/founding.md). The job waits with no engine any seat runs, takes the agent's engine
// once the hiring is merged and deployed, and is cancelled, with word to whoever queued it, if the hire never lands.
import { db } from './db.ts';
import { publish } from './events.ts';
import { createJob, findAgent, boardId } from './jobs.ts';
import { cancelJob } from './ledger.ts';
import { codeOf } from './jobcodes.ts';

export const HIRING = 'hiring';   // jobs.engine while its agent isn't on main yet: no seat claims it
const ID = /^[a-z][a-z0-9-]{0,31}$/;   // an agent id: the name in lowercase
// From the hiring's merge until org.yaml has them: the deploy pulls main every minute (infra/sync.sh), so this is slack
// for a deploy that's slow or held up.
const GRACE_MS = 30 * 60_000;

// Why a job for an agent org.yaml on main doesn't have is refused, or null when it waits for their hiring: an agent id
// that isn't the board's, after a work job whose pull request hasn't merged or closed yet.
export function refusal(agent: string, after: number | undefined, me: { id: number; call?: boolean }) {
  const own = me.id && !me.call ? ` with --after ${me.id}` : '';
  const how = `${agent} isn't in company/org.yaml on main. If ${own ? 'this job hires them' : 'a job is hiring them'} (org.yaml, a profile), queue ` +
    `their work${own || ' --after that job'}: it starts once the hiring is merged`;
  if (!ID.test(agent) || boardId(agent) || !after) return how;
  return pending(after) ? null : `${how}. Job #${after} isn't a job whose hiring can still land: it ended, and its pull request (if any) merged or closed`;
}

// A work job whose changes may still reach main: not ended, or its pull request still open.
const pending = (job: number) => !!db.prepare(`select 1 from jobs a where a.id = ? and a.kind = 'work'
  and (a.status not in ('done', 'failed', 'stopped', 'cancelled')
    or exists (select 1 from prs where branch = coalesce(a.branch, 'job/' || a.id) and status in ('open', 'stuck', 'board')))`).get(job);

const released = new Map<number, number>();   // a waiting job: when its hiring was first seen merged or closed
// Every minute (server.ts): a waiting job whose agent is on main now gets their engine, and one whose hiring merged or
// closed without them is cancelled after GRACE_MS, and its queuer hears why.
export function sweep(now = Date.now()) {
  const waiting = db.prepare("select id, agent, title, after, queued_by from jobs where status = 'queued' and engine = ?").all(HIRING) as
    { id: number; agent: string; title: string; after: number | null; queued_by: string | null }[];
  for (const j of waiting) {
    const agent = findAgent(j.agent);
    if (agent) {
      db.prepare('update jobs set engine = ? where id = ?').run(agent.engine ?? 'claude', j.id);
      publish({ type: 'log', agent: j.agent, text: `${agent.name ?? j.agent} is hired: job #${j.id} can start` });
      released.delete(j.id);
      continue;
    }
    if (j.after && pending(j.after)) continue;
    const since = released.get(j.id) ?? now;
    released.set(j.id, since);
    if (now - since < GRACE_MS) continue;
    released.delete(j.id);
    const why = `${j.agent} isn't in company/org.yaml on main ${GRACE_MS / 60_000} minutes after job #${j.after} ended and its pull request merged or closed`;
    if (!cancelJob(j.id, why)) continue;
    // (the cancelled job's task: its code.)
    if (j.queued_by && findAgent(j.queued_by)) createJob({ agent: j.queued_by, code: codeOf(j.id) ?? undefined, title: `Not hired: ${j.agent}`,
      prompt: `Job #${j.id} (${j.title}), which you queued for ${j.agent}, was cancelled: ${why}. If you still want them, hire ` +
        `them (org.yaml, a profile) in a pull request and queue their work again --after that job; if not, give the work to a colleague.` });
  }
}
