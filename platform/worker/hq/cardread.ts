// hq card: the card reader's read of a colleague's card before the board's desk phone. They pass the card on, or answer it in the board's place.
import * as api from './api.ts';
import { isFile, readText } from './files.ts';
import { print, stop } from './output.ts';

const USAGE = 'usage: hq card pass <id> [--title "title"], or hq card settle <id> <answer-file>';

export const card = {
  help: `
   hq card pass <id> [--title "title"]               the card reader (org.yaml roles.cards): a colleague's card you've
                                                     read goes on to the board's desk phone, as it's the board's to
                                                     decide and reads at once (hq rewrite plainer words first, and
                                                     give a plainer title if it needs one)
   hq card settle <id> <answer-file>                 the card reader: answer a colleague's card in the board's place, as
                                                     it isn't the board's to decide. Its asker and the work waiting for
                                                     it hear your answer as they would the board's, and the board never
                                                     sees it. Not a card for keys, an approval or the board's own uploads`,

  async run([step, id, ...rest]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '')) stop(USAGE);
    if (step === 'pass') return pass(Number(id), rest);
    if (step === 'settle') return settle(Number(id), rest);
    stop(USAGE);
  },
};

async function pass(id: number, rest: string[]) {
  const titled = rest[0] === '--title' && rest.length === 2;
  if (rest.length && !titled) stop('usage: hq card pass <id> [--title "title"]');
  const reply = await api.call('request-pass', { body: { id, ...(titled && { title: rest[1] }) } });
  if (!api.isSuccess(reply.status))
    stop(`Card #${id} didn't go on: ${api.errorIn(reply.body, "it isn't an open card waiting for your read")}.`);
  const passed = JSON.parse(reply.body) as { shows: boolean };
  print(
    passed.shows
      ? `Card #${id} is on the board's desk phone.`
      : `Card #${id} goes on to the board's desk phone once the rest of what it waits for is in (work going live, or its day).`,
  );
}

async function settle(id: number, rest: string[]) {
  const [answerPath] = rest;
  if (rest.length !== 1 || !isFile(answerPath)) stop('usage: hq card settle <id> <answer-file>');
  const answer = readText(answerPath).trim();
  if (!answer) stop(`Nothing was settled: ${answerPath} is empty. Your answer goes in it.`);
  const reply = await api.call('request-settle', { body: { id, answer } });
  if (!api.isSuccess(reply.status))
    stop(`Card #${id} wasn't settled: ${api.errorIn(reply.body, "it isn't an open card waiting for your read")}.`);
  print(
    `Card #${id} is answered in the board's place. Its asker hears your answer, and the board never sees the card.`,
  );
}
