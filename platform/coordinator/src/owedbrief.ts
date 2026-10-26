// What the job holding a product's return reads (owed.ts): the brief of a job owed.ts made, and how a return ends.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import { productProject } from './made.ts';
import * as sorting from './sorting.ts';
import { folder, ownerOf } from './owedproducts.ts';

// The prompt of a job this module made (rebuilt whenever a piece joins it, until it starts): every piece of the return
// in full, its own first, since a job before it may never have run or read its prompt, and the one way it ends.
export function brief(owing: { id: number; slug: string; opened: string }, job: number) {
  const { name } = ownerOf(owing.slug);
  const pieces = db.prepare('select * from owed_pieces where owed = ? order by id').all(owing.id) as any[];
  const mine = pieces.filter(piece => piece.job === job),
    before = pieces.filter(piece => piece.job !== job);
  const earlier = earlierFeedback(before);
  const cards = db
    .prepare(
      `select id from requests r join request_products t on t.request = r.id
    where t.slug = ? and t.back = 1 and r.created >= ? order by r.id`,
    )
    .all(owing.slug, owing.opened) as { id: number }[];
  const counts = mine.map(piece =>
    piece.kind === 'notes' ? noteCount(JSON.parse(piece.notes).length) : `card #${piece.request}'s answer`,
  );
  const heading = before.length || !mine.length ? `${name} back to the board` : `Board feedback on ${name}`;
  const title = `${heading}${counts.length ? `: ${counts.join(', ')}` : ''}`.slice(0, 140);
  const parts = [
    `You own bringing ${name} (${folder(owing.slug)}) back to the board after its feedback. HQ keeps that open, \
as owed to the board, until you do.`,
    ...mine.map(piece => piece.text),
    earlier.length
      ? `## Feedback on ${name} that jobs before this one had\n\nWork from what's on main and in their reports \
(\`hq history '#<job>'\`): they may have fixed some of it already, or never run.\n\n${earlier.join('\n\n')}`
      : '',
    cards.length
      ? `Cards that brought it back since this feedback began: ${cards.map(card => `#${card.id}`).join(', ')}. If they \
already cover all of it, close it (below).`
      : '',
    `## How this ends\n\n${duty(owing.slug, name)}`,
    pieces.some(piece => piece.kind === 'answer') ? jobs.AUDIENCE : '',
  ];
  // (its template title until its owner names it, and held for that sort again: sorting.ts.)
  db.prepare(
    "update jobs set title = coalesce(?, title), prompt = ? where id = ? and status = 'queued' and session is null",
  ).run(sorting.named(job) ? null : title, parts.filter(Boolean).join('\n\n'), job);
  sorting.hold(job, {
    from: 'hq',
    project: productProject(owing.slug) ?? null,
    keep: true,
    why: `HQ made this job for the board's feedback on ${name}, and to bring ${name} back to the board.`,
  });
}
// The pieces jobs before this one had, by job, each with how it ended and how its report opens.
function earlierFeedback(before: { job: number; text: string }[]) {
  const earlierJobs = [...new Set(before.map(piece => piece.job as number))];
  return earlierJobs.map(earlierJob => {
    const row = db.prepare('select status, result from jobs where id = ?').get(earlierJob) as
      { status: string; result: string | null } | undefined;
    const words = before
      .filter(piece => piece.job === earlierJob)
      .map(piece => piece.text)
      .join('\n\n');
    // a report holding a customer's own details stays with its job (jobs.ts holdsCustomerData)
    return `### Job #${earlierJob} (${row?.status ?? 'gone'}) had this${jobs.holdsCustomerData(earlierJob) ? '' : opening(row?.result)}\n\n${words}`;
  });
}
const noteCount = (count: number) => `${count} review note${count === 1 ? '' : 's'}`;
function opening(result: string | null | undefined) {
  if (!result) return '';
  const start = result.replace(/\s+/g, ' ').slice(0, 300).trim();
  return ` (its report opens: "${start}${result.length > 300 ? '…' : ''}")`;
}
// How a return ends, for whoever holds it. The card recommends nothing, and leads with pictures.
export const duty = (
  slug: string,
  name: string,
) => `${name} back on the board's desk phone. One card for it (hq ask or hq request, with \
\`--back ${slug}\`): it leads with a picture of each change as it was and as it is now, with its preview link (the card's \
"Before and after:" list). HQ gives it the board's two answers, Good now, or notes on the preview in review mode (they come \
back as feedback of their own), so it has no choices or recommendation of yours. What changed for each point, in words, \
folds under More. A point you won't act on goes on that card, with why.
- A fix that needs a pull request: shoot each change before you make it (the board's own note's screenshot will do) and once \
it's built, at a phone's width, into products/_cycles/; push it and end your job. HQ then queues your job to bring it back \
after it merges, so the card shows what's on the preview.
- Nothing to fix, or it's merged already: send the card now.
- The board's words ask for nothing back (it approved, launched or dropped it): \`hq owed close ${slug} "why"\` instead.
More feedback on ${name} that arrives meanwhile joins this job if it hasn't started, or the next one, never a parallel job.`;
