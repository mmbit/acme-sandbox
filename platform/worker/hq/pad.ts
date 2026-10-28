// hq pad: the CEO's page, the half of its heartbeat it writes itself (the coordinator's pad.ts and heartbeat.ts).
import * as api from './api.ts';
import { readStdin } from './files.ts';
import { print, stop } from './output.ts';

type Version = { id: number; text: string; by: string; job: number | null; at: string };

export const pad = {
  help: `
   hq pad                                            the CEO's page: our goals and why, the bets on each, what it watches
                                                     and when it judges it, what it does next. Every hourly check and every
                                                     call with the CEO reads it, and the board sees it atop the projects
   hq pad --history                                  every version, newest first, with its time and job
   hq pad write -                                    the CEO's jobs rewrite it whole, from stdin. Times live in queued jobs
                                                     and deliverables' windows: the page names them, never holds them`,

  async run([command, ...rest]: string[]) {
    if (command === 'write') {
      if (rest.length !== 1 || rest[0] !== '-') stop('usage: hq pad write - < page.md');
      const answer = await api.change('pad', { body: { text: readStdin() } });
      if (!api.isSuccess(answer.status)) stop(`The page is as it was: ${api.errorIn(answer.body, 'no answer')}`);
      return print('The page is rewritten: every check and call reads it from now.');
    }
    if (command === '--history' && !rest.length) {
      const { versions } = (await api.orStop(api.getJson('pad?history=1'), "Couldn't read the page's versions.")) as {
        versions: Version[];
      };
      if (!versions.length) return print('No page yet.');
      return print(
        versions.map(v => `== ${v.at.slice(0, 16).replace('T', ' ')} UTC, ${by(v)}\n${v.text}`).join('\n\n'),
      );
    }
    if (command !== undefined) stop('usage: hq pad [--history], or hq pad write - < page.md');
    const { page } = (await api.orStop(api.getJson('pad'), "Couldn't read the page.")) as { page: Version | null };
    print(
      page ? `${page.text}\n\n(written ${page.at.slice(0, 16).replace('T', ' ')} UTC, ${by(page)})` : 'No page yet.',
    );
  },
};

const by = (v: Version) => (v.job ? `${v.by}'s #${v.job}` : v.by);
