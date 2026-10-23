// hq report: the server's status report (infra/report.sh, every 10 minutes and at each deploy) as HQ keeps it, two
// days of them (the coordinator's oversight.ts).
import * as api from './api.ts';
import { takeValues } from './flags.ts';
import { print, printWritten, stop } from './output.ts';

export const report = {
  help: `
   hq report [--at <time>] [--since <time>]          the server's status report: the newest whole, or the newest at or
                                                     before --at; --since: only what changed from the report of that time
                                                     (a diff whose hunks name their section). Times in UTC, as ISO
                                                     (2026-10-17T10:05Z); the first line says the report's own time
   hq report --list                                  the times of the reports HQ keeps (two days, oldest first)`,

  async run(given: string[]) {
    if (given.length === 1 && given[0] === '--list') {
      const { kept } = (await api.orStop(api.getJson('report?list=1'), "Couldn't list the reports.")) as {
        kept: string[];
      };
      return print(...(kept.length ? kept : ['No status report has reached HQ yet.']));
    }
    const { values, args } = takeValues(given, ['--at', '--since'], 'Nothing read');
    if (args.length) stop('usage: hq report [--at <time>] [--since <time>] | --list');
    const answer = await api.call(`report?${new URLSearchParams(values)}`, { timeoutMs: 60_000 });
    if (answer.status !== 200) stop(api.errorIn(answer.body, "Couldn't read the report."));
    const { text, asOf } = JSON.parse(answer.body) as { text: string; asOf: string };
    await printWritten(`(the report of ${asOf})`, text.replace(/\n$/, ''));
  },
};
