// hq tooling: counts only, never transcript content.
import * as api from './api.ts';
import { print, stop } from './output.ts';
import { takeValues } from './flags.ts';

const USAGE = 'usage: hq tooling [--since <ISO time>] [--until <ISO time>]';
export const tooling = {
  help: `
   hq tooling [--since <ISO time>] [--until <ISO time>] content-free run measurements as JSON, Process only. Defaults
                                                     to the last three days. Missing metrics mean unmeasured, never
                                                     zero. Read platform/worker/tooling/README.md for definitions and limits.`,
  async run(given: string[]) {
    if (given.length === 1 && given[0] === '--help')
      return print(USAGE, 'Read platform/worker/tooling/README.md for measurement definitions.');
    const { values, args } = takeValues(given, ['--since', '--until'], 'Nothing read');
    if (args.length) stop(USAGE);
    const answer = await api.call(`tooling?${new URLSearchParams(values)}`);
    if (answer.status !== 200) stop(api.errorIn(answer.body, "Couldn't read the tooling counts."));
    print(JSON.stringify(JSON.parse(answer.body), null, 2));
  },
};
