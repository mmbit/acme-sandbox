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
                                                     and how long ago it was written (every 10 minutes)
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
    await printWritten(`(the report of ${asOf}, ${age(asOf)})`, text.replace(/\n$/, ''));
  },
};

// How old the report is now, beside its time: one written every 10 minutes that's older than that has missed its
// writes, and nothing since it (a job started, one ended) is in it. A call's report tool keeps this line at the top
// of every answer (platform/voice/reads.py), so an old report never reads as live.
export function age(asOf: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(asOf)) / 60_000));
  if (minutes < 1) return 'written under a minute ago';
  if (minutes < 120) return `written ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `written ${hours} h ${minutes % 60} min ago` : `written ${Math.floor(hours / 24)} days ago`;
}
