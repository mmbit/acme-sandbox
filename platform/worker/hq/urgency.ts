// Record the board's urgent work with one command at any existing work level.
import * as api from './api.ts';
import { print, stop, text } from './output.ts';

export const urgent = {
  help: `
   hq urgent <milestone|job|task> <id> [on|off]          record the board's urgent work, or clear it (default on).
                                                     Urgent work bypasses seat pacing, and expedited work counts as
                                                     urgent. A deadline only orders work within the pace. A milestone
                                                     passes urgency to its jobs and tasks, and a job to its tasks.
                                                     Reviews and fixes carry their work's urgency, and a board
                                                     call's follow-up is urgent by itself.
                                                     Milestone: project key. Job: project/slug. Task: task number.`,
  async run([level, id, state = 'on', ...rest]: string[]) {
    if (!['milestone', 'job', 'task'].includes(level) || !id || !['on', 'off'].includes(state) || rest.length)
      stop('usage: hq urgent <milestone|job|task> <id> [on|off]');
    const answer = await api.orStop(
      api.call('urgent', { body: { level, id, urgent: state === 'on' } }),
      'Urgency was not changed',
    );
    if (!api.isSuccess(answer.status)) stop(`Urgency was not changed: ${api.errorIn(answer.body, 'no answer')}`);
    const changed = JSON.parse(answer.body) as {
      name: string;
      urgent: boolean;
      effective: boolean;
      expedited: boolean;
    };
    const still = changed.expedited ? 'it is expedited' : 'its parent or source work is urgent';
    const inherited = !changed.urgent && changed.effective ? ` (still urgent: ${still})` : '';
    print(`${text(changed.name)}: urgent ${changed.urgent ? 'on' : 'off'}${inherited}.`);
  },
};
