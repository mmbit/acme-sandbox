// What products owe the board: a return after its feedback (review notes, a card's answer), with the owner's job that
// brings it back (the coordinator's owed.ts).
import * as api from './api.ts';
import { minute, plural, print, present, stop, text } from './output.ts';

export const owed = {
  help: `
   hq owed                                           products that owe the board a return after its feedback (review notes, a card's
                                                     answer): each has its owner and the job that brings it back
   hq owed close <slug> "why"                        the board's words ask for nothing back (it approved, launched or dropped it):
                                                     the owner's job (or the CEO) closes what the product owes, saying why`,

  async run([action, slug, why]: string[]) {
    if (action === 'close') return closeOwed(slug, why);
    const list: Owed[] = JSON.parse(await api.orStop(api.get('owed'), "Couldn't list what the board is owed."));
    if (list.length === 0) return print('No product owes the board a return.');
    for (const product of list) print(owedLine(product));
  },
};

async function closeOwed(slug: string | undefined, why: string | undefined) {
  if (!slug || !why) stop('usage: hq owed close <slug> "why"');
  const answer = await api.change('owed-close', { body: { slug, why }, timeoutMs: 30_000 });
  if (answer.status !== 200) stop(`Couldn't close it: ${api.errorIn(answer.body, 'no answer')}`);
  print(`${slug} owes the board nothing more.`);
}

type Owed = {
  slug: string;
  name: string;
  agent: string;
  opened: string;
  pieces: number;
  closed?: string;
  outcome?: string;
  stalled?: boolean;
  job?: number;
  job_status?: string;
  follow_ups?: number;
};

function owedLine(product: Owed) {
  const since = `${text(product.slug)} (${text(product.name)}), ${text(product.agent)}'s, since ${minute(product.opened)}`;
  return `${since}, ${plural(product.pieces, 'piece')} of feedback: ${whereItStands(product)}`;
}

function whereItStands({ closed, outcome, stalled, job, job_status, follow_ups }: Owed) {
  if (present(closed)) return `closed ${minute(closed)}, ${text(outcome)}`;
  if (present(stalled)) return `nobody on it since job #${job} (${text(job_status)}), after ${follow_ups} follow-ups`;
  return `job #${job} (${text(job_status ?? 'none')})`;
}
