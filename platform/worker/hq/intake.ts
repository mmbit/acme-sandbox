// hq intake: a card on the CEO's intercom reply in the onboarding (the intake playbook), drawn by HQ under that line.
import * as api from './api.ts';
import { readTextOrStdin } from './files.ts';
import { print, shown, stop } from './output.ts';

const USAGE = 'usage: hq intake switches <file> | - · hq intake asks';

export const intake = {
  help: `
   hq intake switches <file> | -                     the CEO's intercom turn: your reply shows a card of switches for
                                                     what runs by itself, your picks set, in the board's language. The
                                                     intercom's Send sends them as they stand as the board's next line.
                                                     The file (- : on stdin) is JSON: {"title", "says" (what that line
                                                     starts with), "none" (what it says with all off), "note"?,
                                                     "switches": [{"name", "said"? (the name mid-sentence), "what",
                                                     "on"}]}
   hq intake asks                                    the CEO's intercom turn: your reply shows HQ's ask keys under it
                                                     (Set up a routine…, Hire someone…), each starting the board's
                                                     sentence. One card a reply: again replaces it`,

  async run([kind, given, ...rest]: string[]) {
    if (rest.length || !(kind === 'asks' ? !given : kind === 'switches' && given)) stop(USAGE);
    const card = kind === 'switches' ? { ...switchesIn(given), kind } : { kind };
    const answer = await api.call('intake', { body: card });
    const set = api.parseOrNull(answer.body) ?? {};
    if (shown(set.ok) !== 'true') stop(`No card set: ${api.errorIn(answer.body) || 'no answer'}`);
    print(`The ${kind === 'asks' ? 'ask keys go' : 'switches card goes'} under your reply when this turn ends.`);
  },
};

// The switches card's JSON in a file, or on stdin for "-"
function switchesIn(given: string) {
  const from = given === '-' ? 'stdin' : given;
  let text = '';
  try {
    text = readTextOrStdin(given);
  } catch (e) {
    stop(`No card set: ${from} can't be read (${(e as NodeJS.ErrnoException).code ?? e}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    stop(`No card set: ${from} isn't JSON.`);
  }
}
