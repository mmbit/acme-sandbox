// hq room: retained room and notice records without consuming notices.
import * as api from './api.ts';
import { takeValues } from './flags.ts';
import { print, stop } from './output.ts';

const USAGE = 'usage: hq room [spells | deliveries | runs] [--after <cursor>]';
export const room = {
  help: `
   hq room [spells | deliveries | runs] [--after <cursor>]
                                                     Process-only read of existing room state and one history page.
                                                     JSON includes next cursor and explicit missing measurements.
                                                     Deliveries start at 0.0, other populations at 0. Notices are not
                                                     consumed. See platform/coordinator/docs/room-records.md.`,
  async run(given: string[]) {
    if (given.length === 1 && given[0] === '--help') return print(USAGE);
    const { values, args } = takeValues(given, ['--after'], 'Nothing read');
    const population = args[0] ?? 'spells';
    if (args.length > 1) stop(USAGE);
    const query = new URLSearchParams({ population });
    if (values.after !== undefined) query.set('after', values.after);
    const answer = await api.call(`room/records?${query}`);
    if (answer.status !== 200) stop(api.errorIn(answer.body, "Couldn't read room records."));
    print(JSON.stringify(JSON.parse(answer.body), null, 2));
  },
};
