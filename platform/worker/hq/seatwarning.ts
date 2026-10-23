// hq seat-warning: the board's optional warnings about its subscriptions running low.
import * as api from './api.ts';
import { print, stop } from './output.ts';
import { takeValues } from './flags.ts';

const USAGE =
  'usage: hq seat-warning [off | --week-percent N | --five-hour-percent N | --week-hours N | --five-hour-hours N]...';
export const seatWarning = {
  help: `
   hq seat-warning [off | --week-percent N | --five-hour-percent N | --week-hours N | --five-hour-hours N]...
                                                     read or replace the warning, after the board's word (CEO or Process).
                                                     Percent: usage reached. Hours: within N hours of running out before
                                                     reset, at the current workload. 0: any run-out forecast before reset.
                                                     Only the supplied thresholds stay on. New companies start off.`,
  async run(given: string[]) {
    if (given[0] === '--help') return print(USAGE);
    if (!given.length) return show(await api.call('seat-warnings'));
    if (given.length === 1 && given[0] === 'off')
      return show(await api.call('seat-warnings', { body: api.withSpeaker({ warning: null }) }));
    const flags = ['--week-percent', '--five-hour-percent', '--week-hours', '--five-hour-hours'];
    const { values, args } = takeValues(given, flags, 'Warning unchanged');
    if (args.length || !Object.keys(values).length) stop(USAGE);
    const warning: Record<string, Record<string, number>> = {};
    for (const [flag, value] of Object.entries(values)) {
      if (!value.trim() || !Number.isFinite(Number(value))) stop('Warning unchanged: thresholds must be numbers.');
      const window = flag.startsWith('week-') ? 'week' : 'five_hour';
      (warning[window] ??= {})[flag.endsWith('percent') ? 'percent' : 'hours'] = Number(value);
    }
    show(await api.call('seat-warnings', { body: api.withSpeaker({ warning }) }));
  },
};

function show(answer: api.Answer) {
  if (!api.isSuccess(answer.status)) stop(api.errorIn(answer.body, 'Could not read or set the warning.'));
  print(JSON.stringify(JSON.parse(answer.body), null, 2));
}
