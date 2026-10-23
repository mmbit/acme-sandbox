// hq followthrough: the CEO's hourly read of what the board agreed against the work under way, and the check's verdict
// (the coordinator's followthrough.ts). hq summary: the CEO's picture of where things stand (its summary.ts).
import * as api from './api.ts';
import { print, stop } from './output.ts';

export const followthrough = {
  help: `
   hq followthrough                                  the CEO's follow-through read: what the board agreed on its calls that
                                                     still stands and the work on each, what's running and starts next,
                                                     and the last check
   hq followthrough ok                               HQ's hourly follow-through check found all on track (its verdict)
   hq followthrough acted "line"                     it found something off and fixed the cause: what and how, in a line
   hq followthrough requeue <job> "line"             a failed job's work on what the board agreed goes to the agent whose
                                                     call it is, as a job that takes it over: what was off, in a line`,

  async run([command, ...rest]: string[]) {
    if (command === 'requeue') {
      const [job, line] = rest;
      if (!/^[0-9]+$/.test(job ?? '')) stop('usage: hq followthrough requeue <failed job> "what was off"');
      const answer = await api.call('followthrough-requeue', {
        body: { job: Number(job), said: line ?? '' },
        timeoutMs: 30_000,
      });
      if (answer.status !== 200) stop(`Nothing was queued: ${api.errorIn(answer.body, 'no answer')}`);
      const queued = JSON.parse(answer.body) as { id: number; agent: string };
      return print(`Queued job #${queued.id} for ${queued.agent}: it takes over #${job}'s work.`);
    }
    if (command === undefined) {
      const answer = JSON.parse(await api.orStop(api.get('followthrough'), "Couldn't read the follow-through."));
      return print(answer.text);
    }
    if (command !== 'ok' && command !== 'acted')
      stop('usage: hq followthrough [ok | acted "line" | requeue <job> "line"]');
    const [line] = rest;
    const answer = await api.call('followthrough-verdict', {
      body: { verdict: command, said: line ?? '' },
      timeoutMs: 30_000,
    });
    if (answer.status !== 200) stop(`Couldn't record it: ${api.errorIn(answer.body, 'no answer')}`);
    print(command === 'ok' ? 'Recorded: on track.' : 'Recorded: acted.');
  },
};

export const summary = {
  help: `
   hq summary                                        the CEO's picture: what the board asked for and how long it has
                                                     waited, what finished since the last check, the alarms on now, what
                                                     threatens the plan, and whether the queue grew. HQ tells nobody of
                                                     these: what to do is yours`,

  async run(args: string[]) {
    if (args.length) stop('usage: hq summary');
    const answer = JSON.parse(await api.orStop(api.get('summary'), "Couldn't read the summary."));
    print(answer.text);
  },
};
