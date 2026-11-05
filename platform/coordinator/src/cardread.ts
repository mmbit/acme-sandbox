// The card reader's read of a colleague's card before the board's desk phone.
// Where org.yaml names one (roles.cards: the CEO, usually), the card waits off the desk phone while they judge whether
// it's the board's to decide and whether it reads at once. Then they pass it on, in its author's words or their own, or
// answer it in the board's place, which its asker hears as they would the board's answer (jobs.ts settleRequest).
import { db } from './db.ts';
import { projects, roles } from './company.ts';
import * as jobs from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import { carried, goalLine } from './ledger.ts';
import * as later from './later.ts';
import { made, madeCode } from './made.ts';

// Whether a card waits for the reader: every agent's but the reader's own. A card about one of the board's notes or
// pages, or for its book, answers what the board itself raised, so it goes to it at once. A card on a decision the CEO
// named is already the board's. A job marked as about customers keeps their details out of the reader's brief.
export function waitsForRead(agent: string, job: number | undefined, card: Record<string, unknown>) {
  const reader = roles().cards;
  if (!reader || agent === reader || card.book || card.note != null || card.page != null || card.decides) return false;
  const marked = job !== undefined && db.prepare('select 1 from jobs where id = ? and customers = 1').get(job);
  return !marked;
}

// The reader's job reading the card, as soon as it can (made.ts made), and the card's hold naming it. jobs.ts createRead
// files the card with the hold and queues this in the same step.
export function queueRead(id: number, now = Date.now()) {
  const card = db.prepare('select * from requests where id = ?').get(id) as Card;
  const { id: job } = jobs.createJob({
    agent: roles().cards!,
    code: madeCode('checks', 'hq', STANDING.cardRead),
    title: `Read ${card.agent}'s card before the board does: ${card.title}`.slice(0, 200),
    prompt: brief(card),
    effort: 'medium',
  });
  made('checks', 'hq', { id: job }, projects().made.checks?.hq ? { asap: now } : undefined);
  db.prepare('update request_holds set work = ? where request = ? and work = ?').run(
    `${later.READ}${job}`,
    id,
    later.READ,
  );
  return job;
}

// hq card pass: the reader lets the card go on to the desk phone, with a new title if it gives one. It shows at once
// unless it also waits for work going live or a day of its own.
export function pass(id: number, title: unknown) {
  const hold = later.readHold(id);
  if (!hold) return 404;
  if (title !== undefined) {
    const words = String(title).trim();
    if (!words) return [400, "a card's title cannot be empty: give it a title before passing it on"] as const;
    db.prepare('update requests set title = ? where id = ?').run(words, id);
  }
  return { ok: true, shows: later.unhold(id, [hold.work]) };
}

// The open cards a reader's job still holds for its read (jobs.ts finishJob: a job that ends leaving one failed)
export const unread = (job: number) =>
  (
    db
      .prepare(
        "select h.request from request_holds h join requests r on r.id = h.request where h.work = ? and r.status = 'open'",
      )
      .all(`${later.READ}${job}`) as { request: number }[]
  ).map(h => h.request);

type Card = {
  id: number;
  agent: string;
  job: number | null;
  kind: string;
  urgency: string;
  title: string;
  body: string;
  topic: string | null;
  questions: string | null;
};

// What the reader reads: the card as filed, why the board wanted the work it comes from, and the three ways on
// (its third check, asking only what only the board can answer; its cut to no questions; its fourth, several true
// answers as tick boxes)
function brief(card: Card) {
  const item = card.job === null ? undefined : carried(card.job);
  // (whole, in hq ask's --questions shape, which hq rewrite takes back)
  const questions = card.questions ? JSON.stringify(JSON.parse(card.questions), null, 2) : '';
  return [
    `${card.agent} filed card #${card.id} for the board's desk phone. Every colleague's card comes to you first and waits off the desk phone until you pass it on or answer it. Read it as the board will: on a tablet, between other things, without having followed the work.`,
    `The card (${card.kind}, ${card.urgency}${card.topic ? `, under "${card.topic}"` : ''}):\n\nTitle: ${card.title}\n\n${card.body}${questions ? `\n\nIts questions, the fields the board answers in:\n${questions}` : ''}`,
    item ? goalLine(item) : '',
    `Ask four things.
1. Is it the board's to decide? Read company/CHARTER.md ("Who's who") and company/AUTHORITY.md for what this company reserves for the board. A change to what it asked for that would lose what it wanted it for also goes to it. Keys, approvals and steps only it can take are its own too. How work is done, whether it's done well enough, proof, measurements, sizes, order, and scope that still gives the board what it wanted are the owner's or yours.
2. Does it read at once? One plain question in everyday words, as you'd ask it across a table: no names of our deliverables, tools or measures the board hasn't heard, nothing it has to decode.
3. Does it ask only what it must? Every question and photo costs the board time: keep only what changes the work and only the board can answer, not what anything else can tell (a photo the author can read, their own files, how the thing is made). Photos or questions, never both for the same thing. Cut the rest.
4. Can the board answer truthfully? Where several of a choice's answers can be true together (where it saw something, which of these apply), it's a question field with \`"many": true\`, tick boxes, with \`"picked": []\` when the board ticks what applies; a decision between options, with one true answer, stays one pick.`,
    `Then one of these:
- It's the board's, reads at once, asks only what it must and can be answered truthfully: \`hq card pass ${card.id}\`.
- It's the board's but doesn't read at once, asks more than it must or picks one where several can be true: \`hq rewrite ${card.id} <file>\` with the card in plain words and cut to what it must ask (the same choices and steps, its questions only those that pass 3, within the same limits)${questions ? `, with \`--questions <file.json>\`: its questions above in the same shape, each title, detail and option in plain words, the board's answers to those kept still meaning the same to the work waiting for it, or \`[]\` when none pass (its photos or text ask it all)` : ''}, and with \`--questions\` the tick boxes 4 asks for (a \`Choose:\` list of things that can be true together becomes one such field). Then \`hq card pass ${card.id} --title "the title in plain words"\` if its title needs it too, else \`hq card pass ${card.id}\`.
- It isn't the board's: \`hq card settle ${card.id} <file>\`, your answer, judged from what the board wants. ${card.agent} and the work waiting for the card hear it as they would the board's, and the board never sees the card.
Say in your report which you did and why, in a line.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
