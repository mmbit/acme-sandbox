// HQ's calls to the CEO about something broken, which reach them whatever holds the rest of the work: a job of the CEO's
// marked as an incident (jobs.incident), first in line (expedited), and claimed as well on the worker's incident slot,
// which no shortage of memory or seat pacing keeps from starting (as the intercom's slot, which stays the board's).
// - A deploy that broke HQ (wakes.ts readDeploys, deploys.broke): the server went back to the last good deploy by
//   itself and reverted the commits since on main (infra/revert.py). The CEO finds which broke it, has it fixed and
//   brings the rest back.
// - Work that stopped moving (stalls.ts, jam.ts) with a deploy shortly before: the CEO judges whether the deploy is the
//   cause, and reverts what it brought (hq revert), stops what holds the worker (hq stop), or leaves it, saying why.
// The board hears only what needs its judgment (hq ask). One job a cause while it's open.
import { db, remember, setting } from './db.ts';
import { createJob } from './jobs.ts';
import { ceo } from './company.ts';

// (how long after a deploy work that stops moving may be its doing)
export const AFTER_DEPLOY_MS = 3 * 3600_000;
type Deploy = { sha: string; finished: string };

const DECIDE = `Your report is the log's: nobody reads it live. Ask the board (hq ask) only for a decision that's the board's.`;

export function deployBroke(d: { sha: string; broke: string; reverted: string }) {
  const sha = d.sha.slice(0, 9),
    revert = /^[0-9a-f]{40}$/.test(d.reverted.trim()) ? d.reverted.trim().slice(0, 9) : null;
  return open(`deploy:${d.sha}`, `HQ didn't come up on the deploy of ${sha}: find what broke it`, [
    `HQ didn't come up on the deploy of ${sha}, so the server went back to the last good deploy by itself (infra/sync.sh). What its check said (infra/hq-up.sh):`,
    d.broke.trim() || '(nothing)',
    revert
      ? `The server reverted the commits since the last good deploy on main, in ${revert} (git show ${revert} lists them), so the next merge doesn't bring them back. Find which of them broke HQ: the check's words say how, and \`node --test platform/coordinator/src/pagecheck.test.ts\` runs the same check. Then queue its author the fix (hq job), and bring the rest back in one job: a branch that reverts ${revert} without the culprit's part.`
      : `The server didn't revert them on main (${d.reverted.trim() || 'no revert ran'}), so every deploy after it fails the same way and HQ stays on the last good one, without the work merged since. Find which commit broke HQ and revert it now: hq revert <commit> "why" (the server makes the revert within a minute). Then queue its author the fix (hq job).`,
    DECIDE,
  ]);
}

// Work that stopped moving since `since` (what: in HQ's words): an incident when a deploy finished in the AFTER_DEPLOY_MS
// before it, or always (the worker jammed: jam.ts), its job's id (one already open for this cause, or a new one);
// undefined when it's neither.
export function stalled(cause: string, what: string, since: number, always = false) {
  const from = new Date(since - AFTER_DEPLOY_MS).toISOString(),
    to = new Date(since).toISOString();
  const deploys = db
    .prepare('select sha, finished from deploys where ok = 1 and finished between ? and ? order by finished')
    .all(from, to) as Deploy[];
  if (!deploys.length && !always) return undefined;
  const before = db
    .prepare('select sha from deploys where ok = 1 and finished < ? order by finished desc limit 1')
    .get(from) as { sha: string } | undefined;
  const merged = db
    .prepare(
      `select p.number, p.author, (select title from jobs where pr = p.number and kind = 'work' order by id limit 1) title
      from prs p where p.merged_at between ? and ? order by p.merged_at`,
    )
    .all(new Date(since - AFTER_DEPLOY_MS - 3600_000).toISOString(), to) as {
    number: number;
    author: string;
    title: string | null;
  }[];
  const last = deploys.at(-1)?.sha.slice(0, 9);
  return open(`stall:${cause}`, last ? 'Work stopped moving after a deploy: is it the cause?' : 'Work stopped moving', [
    `HQ's own alarm: ${what}, since ${clock(since)}.${last ? " A deploy came shortly before: judge whether it's the cause." : ''}`,
    last
      ? `The deploys in the ${AFTER_DEPLOY_MS / 3600_000} hours before it began:\n` +
        deploys.map(d => `- ${d.sha.slice(0, 9)}, finished ${clock(d.finished)}`).join('\n') +
        `\nWhat they brought: git log --first-parent --format='%h %ae %s' ${before ? `${before.sha.slice(0, 9)}..` : '-30 '}${last}` +
        (merged.length
          ? `\nThe pull requests merged then:\n${merged.map(p => `- PR #${p.number} (${p.author})${p.title ? `: ${p.title}` : ''}`).join('\n')}`
          : '')
      : `No deploy came in the ${AFTER_DEPLOY_MS / 3600_000} hours before it.`,
    `Decide now, from the evidence (hq report: HQ's speed, the worker's room, the jobs; what each change touched), as every hour it lasts the work waits:
- A deploy is the cause: hq revert <commit>... "why" reverts those commits on main (the merge commits on main's first-parent line): the server makes the revert within a minute and the next deploy takes it out. Their work stays on their branches: queue its author the fix (hq job), to come back with it.
- Jobs hold the worker: hq stop <job> "why".
- Neither, or it has ended: leave it, and say why.`,
    DECIDE,
  ]);
}

// The cause's open job, or a new one
function open(cause: string, title: string, parts: string[]) {
  const key = `incident:${cause}`,
    known = Number(setting(key)) || 0;
  if (known && db.prepare("select 1 from jobs where id = ? and status in ('queued', 'running')").get(known))
    return known;
  try {
    const { id } = createJob({ agent: ceo(), title, prompt: parts.join('\n\n'), expedite: true, incident: true });
    remember(key, String(id));
    return id;
  } catch (err) {
    // (a CEO no seat runs: the alarms that have another way go on with it, jam.ts's card)
    console.error(`incidents: the CEO couldn't be called (${cause}):`, (err as Error).message);
    return undefined;
  }
}

const clock = (t: number | string) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
