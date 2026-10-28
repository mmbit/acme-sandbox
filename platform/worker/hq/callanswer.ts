// hq answer-note: on a call with the board, its agent's answer written on a note the board drew on the call's page, in
// the board's book beside the note (the coordinator's ink/callanswer.ts; the call's answer_note tool, hq_tools.py).
// The words come on stdin, never in argv (any uid can read /proc/<pid>/cmdline): they're from the call.
import * as api from './api.ts';
import { readWords } from './files.ts';
import { print, stop } from './output.ts';

export const answerNote = {
  help: `
   hq answer-note <n> -                              (on a call with the board) your answer to the board's note n on
                                                     the call's page, the words on stdin: written in its book beside
                                                     the note, as an agent's answer`,

  // (a refusal opens "Nothing written", as the call's answer_note tool reads it: hq_tools.py.)
  async run([n, from, ...rest]: string[]) {
    if (!/^[0-9]+$/.test(n ?? '') || from !== '-' || rest.length) stop('usage: hq answer-note <n> -');
    const words = readWords('-').trim();
    if (!words) stop('Nothing written: an answer has words');
    const answer = await api.change('call-answer', { body: { note: Number(n), words } });
    const done = api.parseOrNull(answer.body);
    if (!done?.slip) stop(`Nothing written: ${api.errorIn(answer.body, 'HQ refused it')}`);
    print(`Your answer is written beside note ${n} in the board's book.`);
  },
};
