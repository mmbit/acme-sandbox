// Review's visual judgment and the before/after card that releases its merge decision.
import { db } from './db.ts';
import * as decisions from './decisions.ts';
import { createJob, endRequest, threadOf } from './jobs.ts';
import { returnFeedback } from './review.ts';
import { reviewSettings } from './reviewsettings.ts';

export function reviewStep(round: number, stage?: string | null) {
  if (stage === 'merge') return '';
  return `

## Major visual changes to something live
${round === 1 ? 'On this first round, judge' : 'For visual changes introduced by these fixes, judge'} from the diff and the previews whether this makes a major visual change to something live that people see.
Live here means: ${reviewSettings().live}
Major means a page or screen changes in a way the board would notice: a new layout, palette, type, illustration or
style. A bug fix, copy edit or single button does not count. This is your judgment, never a file-pattern rule.
Add "major_visual": true or false to your JSON report. The ruling settles this judgment from the reports, diff and
previews. If true, HQ holds the merge with a decision and asks the author for one before/after card. Keep the ordinary
review decision for correctness: visual approval does not replace review, and is not a blocking code finding or a
"board" review verdict. One card covers the thread's visual changes waiting together. It shows the changed pages
before and after on phone and desktop, with Go live (recommended) and Changes first.`;
}

export function record(pr: { number: number; branch: string; author: string; sha: string | null }, major: boolean) {
  if (!major || !pr.sha) return;
  const work = db
    .prepare("select id from jobs where branch = ? and kind = 'work' order by id desc limit 1")
    .get(pr.branch) as { id: number } | undefined;
  const decision = decisions.holdMerge({ ...pr, sha: pr.sha }, work ? threadOf(work.id) : null);
  if (decision.replacedCard)
    endRequest(decision.replacedCard, 'More visual changes joined, so a new card will show the whole set');
  if (!decision.needsCard) return;
  prepareCard(decision.id, decision.author!);
}

// A pull request ended, closed or merged without this decision's Go live: it leaves the hold.
export function closed(pr: number) {
  const decision = decisions.retireMerge(pr);
  if (!decision) return;
  if (decision.replacedCard)
    endRequest(
      decision.replacedCard,
      decision.needsCard
        ? 'Some visual changes were closed or went live another way, so a new card will show the remaining changes'
        : 'The visual changes were closed or went live another way, so there is nothing left to approve',
    );
  if (decision.needsCard) prepareCard(decision.id, decision.author);
}

function prepareCard(id: number, author: string) {
  createJob({
    agent: author,
    kind: 'work',
    thread: null,
    title: 'Show the visual changes before they go live',
    prompt: `Review found a major visual change to something live. Decision #${id} holds its merge.
Prepare one card for all the pull requests held by this decision (hq decision show ${id} lists them). Show the changed pages
before and after, on phone and desktop. Read the Board requests playbook and the craft notes on pictures and reviews.
Include a "Before and after:" list with one bullet per page and viewport in this form:
- What changed: <before picture> <after picture> <its live link>
Keep the pictures under products/_cycles/ and available before the changes merge. Do not publish the changed site or app.
File it with hq ask --decides ${id}, recommending Go live with Changes first as the other option. HQ supplies
those two choices. Keep the card short and complete in itself, without repository or pull-request links.
This job prepares the card, not the visual change. Do not push to the held branches. End once the card is filed.
If a previous card was closed because the waiting set changed, replace its pictures with the current waiting set.`,
  });
}

export function waitReason(pr: number) {
  const decision = decisions.heldMerge(pr);
  if (!decision) return undefined;
  return `Waiting for the before/after visual decision #${decision.id}${decision.request ? ` on card #${decision.request}` : ': the author is preparing its card'}`;
}

// The structured option decides whether the old ruling can stand. Free text remains feedback, never an approval parser.
export function answered(card: number, questions: { answer?: string }[] | null, answer: string) {
  if (!decisions.mergeCard(card) || questions?.[0]?.answer === 'Go live') return;
  for (const pr of decisions.cardMerges(card)) {
    db.prepare("update decision_merges set sha = '' where pr = ?").run(pr.number);
    returnFeedback(
      pr,
      'The board wants visual changes first',
      `The board saw the before/after card and chose Changes first. Its answer:\n\n${answer}\n\nUpdate this branch accordingly. The panel reviews again when you are done, including whether the visual changes need a new card.`,
    );
  }
}
