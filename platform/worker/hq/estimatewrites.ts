// hq estimate's writes: a queued job's size (set) and a done job's adjusted time (adjust), moved out of estimate.ts.
import { readFileSync } from 'node:fs';
import * as api from './api.ts';
import { budgetLine, confidenceLine } from './costs.ts';
import { changeLines } from './deadlines.ts';
import { plural, print, stop } from './output.ts';
import { duration } from './waits.ts';

export const WRITES_HELP = `   hq estimate set <job> <JSON> "why"                re-size a queued or running job: its agent time (90m, 2h, 1h30m)
                                                     changes the saved task estimate and names the deliverables whose
                                                     ETA moved. Your own running job, once you know it's bigger or
                                                     smaller (the why goes on the feed and to the CEO); the CEO any
                                                     job, HQ's fix and merge rounds included; the estimates role
                                                     (org.yaml's roles.estimates) re-sizes queued work too
   hq estimate adjust <job> <time | none> "why"      a done job's adjusted time: what its work would cost now that a
   hq estimate adjust - < list.json                  process change made its measured time stale, with why (the change
                                                     and what it changed in this job). The measurement stays; the
                                                     picks and hq estimate count the adjusted time, and show both.
                                                     none withdraws it. On stdin: [{"job": n, "time": "40m", "why":
                                                     "..."}, ...], each job its own reason. The estimates role and
                                                     the CEO only`;

// hq estimate set: the job's new size, and what it moved.
export async function setSize([target, time, why = '', ...rest]: string[]) {
  const job = /^#?([0-9]+)$/.exec(target ?? '')?.[1];
  if (!job || !time || rest.length) stop('usage: hq estimate set <job> <time: 90m, 2h, 1h30m> ["why"]');
  const answer = await api.change('sizes', { body: api.withSpeaker({ job: Number(job), time, why }) });
  const set = api.parseOrNull(answer.body);
  if (set?.ok !== true) stop(`Couldn't re-size #${job}: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Job #${job} is sized at ${duration(set.size.agent_ms / 60_000)} of agent time now.`);
  print(budgetLine(set.size.token_budget), confidenceLine(set.size.confidence));
  if (set.moves) print(...changeLines(set, 'the new size'));
}

// hq estimate adjust: past jobs' adjusted times (the coordinator's adjusted.ts), one from the arguments or a list on
// stdin.
export async function adjustTimes(given: string[]) {
  const usage =
    'usage: hq estimate adjust <job> <time: 40m, 1h10m, or none> "why", or hq estimate adjust - < list.json';
  let list: unknown;
  if (given.length === 1 && given[0] === '-') {
    try {
      list = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      stop(`${usage}: stdin isn't JSON`);
    }
    if (!Array.isArray(list)) stop(`${usage}: stdin is a list, [{"job": n, "time": "40m", "why": "..."}]`);
  } else {
    const [target, time, why, ...rest] = given;
    const job = /^#?([0-9]+)$/.exec(target ?? '')?.[1];
    if (!job || !time || !why || rest.length) stop(usage);
    list = [{ job: Number(job), time, why }];
  }
  const answer = await api.change('estimate/adjust', { body: api.withSpeaker({ adjustments: list }) });
  const done = api.parseOrNull(answer.body);
  if (!Array.isArray(done?.adjusted)) stop(`Nothing adjusted: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    `Adjusted ${plural(done.adjusted.length, 'past job')}: ${done.adjusted.map((id: number) => `#${id}`).join(', ')}.`,
  );
}
