// Record the board's urgent work with one command: on its whole milestone, or on one piece of it.
import * as api from './api.ts';
import { plural, print, stop, text } from './output.ts';

export const urgent = {
  help: `
   hq urgent <milestone> [on|off]                    record the board's urgent work on its whole milestone (its project
                                                     key), or clear it (default on). Every deliverable and task in it,
                                                     and all work filed under it later, bypasses seat pacing with it.
                                                     Work that must stay out keeps its own pause (a pause holds urgent
                                                     work) or moves to a milestone of its own. Expedited work counts as
                                                     urgent. A deadline only orders work within the pace. Reviews and
                                                     fixes carry their work's urgency, and a board call's follow-up is
                                                     urgent by itself
   hq urgent job|task <id> [on|off]                  one piece only: a deliverable (project/slug) or a task (its
                                                     number). Its milestone's other work, and any filed there later,
                                                     still waits on pacing. A job passes urgency to its tasks`,
  async run(given: string[]) {
    const piece = given[0] === 'job' || given[0] === 'task';
    const [level, id, state = 'on', ...rest] = piece || given[0] === 'milestone' ? given : ['milestone', ...given];
    if (!id || !['on', 'off'].includes(state) || rest.length)
      stop('usage: hq urgent <milestone> [on|off], or one piece: hq urgent job|task <id> [on|off]');
    const answer = await api.orStop(
      api.call('urgent', { body: { level, id, urgent: state === 'on' } }),
      'Urgency was not changed',
    );
    if (!api.isSuccess(answer.status)) stop(`Urgency was not changed: ${api.errorIn(answer.body, 'no answer')}`);
    const changed = JSON.parse(answer.body) as Changed;
    const still = changed.expedited ? 'it is expedited' : 'its parent or source work is urgent';
    const inherited = !changed.urgent && changed.effective ? ` (still urgent: ${still})` : '';
    print(
      `${text(changed.name)}: urgent ${changed.urgent ? 'on' : 'off'}${inherited}.`,
      ...(changed.urgent && changed.reach ? reachLines(level, changed.reach) : []),
    );
  },
};

type Reach = {
  milestone: { id: string; name: string; urgent: boolean };
  deliverables: number;
  keptOut: string[];
  missed: number;
  siblings: number;
};
type Changed = { name: string; urgent: boolean; effective: boolean; expedited: boolean; reach: Reach | null };

// What the flag covers on a milestone, or what a piece's flag leaves out of its milestone (the coordinator's urgency.ts
// reachOf)
function reachLines(level: string, reach: Reach) {
  const milestone = text(reach.milestone.name);
  if (level === 'milestone')
    return [
      `It covers its ${plural(reach.deliverables, 'open deliverable')} and all work filed under ${milestone} later.`,
      ...(reach.keptOut.length
        ? [`Kept out by their own pause, which holds urgent work: ${reach.keptOut.map(text).join(', ')}.`]
        : []),
    ];
  if (reach.milestone.urgent) return [`Its milestone, ${milestone}, is urgent already.`];
  const missed = [
    ...(reach.siblings ? [`its deliverable's ${plural(reach.siblings, 'other open task')}`] : []),
    ...(reach.missed ? [`${milestone}'s ${plural(reach.missed, 'other open deliverable')}`] : []),
    `work filed under ${milestone} later`,
  ];
  return [
    `Still on pacing: ${missed.join(', ')}. hq urgent ${text(reach.milestone.id)} marks the whole milestone (a pause of its own keeps out what must stay out).`,
  ];
}
