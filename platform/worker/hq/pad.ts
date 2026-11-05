// hq pad: the CEO's page, its memory across its work (the coordinator's pad.ts): add (the CEO's call tool) and a
// rewrite on the version read.
import * as api from './api.ts';
import { readStdin } from './files.ts';
import { print, stop } from './output.ts';

type Version = { id: number; text: string; by: string; job: number | null; at: string; call: number | null };

export const pad = {
  help: `
   hq pad                                            the CEO's page, its memory across all its work: our goals and the
                                                     bets on each, what it watches and does next, and whatever a later
                                                     call, check or follow-up must still know. Every job and call of the
                                                     CEO starts with it, and the board sees it atop the projects
   hq pad --history                                  every version, newest first, with its time and job
   hq pad write - --version <id>                     the CEO's jobs rewrite it whole, from stdin, on the version they read
                                                     (hq pad names it) right before: a page changed since is refused.
                                                     Times live in queued jobs and deliverables' windows: the page names
                                                     them, never holds them
   hq pad add -                                      words from stdin added at the page's end, as it is now: what a
                                                     call with the CEO settles goes on at once (its page tool)`,

  async run([command, ...rest]: string[]) {
    if (command === 'write') {
      const [from, flag, version, ...more] = rest;
      if (from !== '-' || more.length || (flag !== undefined && (flag !== '--version' || !/^\d+$/.test(version ?? ''))))
        stop('usage: hq pad write - --version <id> < page.md (hq pad names the version)');
      const answer = await api.change('pad', { body: { text: readStdin(), version: version && Number(version) } });
      if (!api.isSuccess(answer.status)) stop(`The page is as it was: ${api.errorIn(answer.body, 'no answer')}`);
      return print('The page is rewritten: every job and call of the CEO reads it from now.');
    }
    if (command === 'add') {
      if (rest.length !== 1 || rest[0] !== '-') stop('usage: hq pad add - < words.md');
      const answer = await api.change('pad/add', { body: { add: readStdin() } });
      if (!api.isSuccess(answer.status)) stop(`The page is as it was: ${api.errorIn(answer.body, 'no answer')}`);
      return print("On the page: every job, check and call of the CEO's reads it from now.");
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
    if (command !== undefined)
      stop('usage: hq pad [--history], hq pad write - --version <id> < page.md, or hq pad add - < words.md');
    const { page } = (await api.orStop(api.getJson('pad'), "Couldn't read the page.")) as { page: Version | null };
    print(
      page
        ? `${page.text}\n\n(version ${page.id}, written ${page.at.slice(0, 16).replace('T', ' ')} UTC, ${by(page)})`
        : 'No page yet.',
    );
  },
};

const by = (v: Version) => (v.job ? `${v.by}'s #${v.job}` : v.call ? `${v.by}'s call #${v.call}` : v.by);
