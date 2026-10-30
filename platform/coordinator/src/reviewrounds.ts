// The formal review process (the review-panel playbook, "Rounds"): each round's briefing, chosen by its stage, for its
// reviewers, its ruling and its author. The first round is free for all: the author fixes or answers every finding.
// From a later round on (or once the thread's deadline is near) only blocking findings hold the merge, and the rest
// goes into the author's follow-up job, done after the work is live (followups.ts). What blocks is narrow on internal
// work (it breaks HQ, loops without end, loses data). What's shipped to users keeps its release bar.
// From the upstream round on, the pull request shows its project owner that something before review went wrong. No
// round closes anything. Work triage judged throwaway gets one light review: it blocks only on what blocks every round,
// reports nothing else, and leaves no follow-up job, as a follow-up job's own pull request leaves none: what doesn't
// block on either ends with it.
// (its messages say deliverable, the board's word for a thread)
import { reviewSettings } from './reviewsettings.ts';

export type Stage = 'first' | 'later' | 'upstream';
const HOUR_MS = 3_600_000;

// A round's stage, by its number and its thread's deadline (ms, null without one), in today's settings. Whether a ruling
// owes its line on what went wrong before review goes by what its job was asked when it was made (review.ts
// owesDiagnosis), not by this.
export function stageOf(round: number, deadline: number | null, now = Date.now()): Stage {
  const { later, upstream, nearDeadlineHours } = reviewSettings().rounds;
  if (round >= upstream) return 'upstream';
  if (round >= later || (deadline !== null && deadline - now <= nearDeadlineHours * HOUR_MS)) return 'later';
  return 'first';
}

// What blocks on every round, by what the change touches: what's shipped to users (review.shipped) or internal work
const everyRound = (
  shipped: string,
) => `Within the assigned scope, what blocks on every round: a security problem (secrets, keys, sign-in, customers' data, a way
around the review, the gates or the sandbox), and a change that doesn't do what the board asked (its own section below,
where there is one). Besides those, it depends on what the change touches. On what's shipped to users (${shipped}):
a real bug (the code does the wrong thing on inputs it will meet, shown as inputs → wrong outcome) and anything a
customer could see or meet (what a product, a page or a mail shows or does, the house rules). On everything else, the
company's internal work (HQ and its tools among it), only what really gets in the board's way: it breaks HQ or the
work it carries, it loops without end, or it loses data. Small bugs, styling, tidiness and hypothetical cases there
don't block: the board would rather have the work live and see it.`;
const NONBLOCKING = `Everything else is nonblocking, in the fixes' own code too: it doesn't hold the merge.`;
// Where what doesn't hold the merge goes: the author's follow-up job, or nowhere on a follow-up job's own pull request
// (the line, and what a later round's reviewers and ruling do with the nonblocking findings)
const LEFT = {
  later: {
    line: `What's left when this pull request merges goes into one follow-up job for its author, queued in the same
deliverable and done after the work is live.`,
    reviewer: "Report one only when it's worth that job.",
    ruling: 'Put those in "nonblocking".',
  },
  ended: {
    line: `What's left when this pull request merges ends there: no follow-up job comes after it.`,
    reviewer: 'Report only what blocks.',
    ruling: 'Leave those out.',
  },
};
// What else the first look asks, for the reviewers and for the ruling
const FIRST_LOOK = {
  reviewer: `The first look is free for all: raise anything worth raising, and the author fixes or answers every finding. On
what's shipped to users, code the next person can't live with blocks too (below). On internal work it's a nonblocking note.`,
  ruling: `On what's shipped to users, in the first look, so does code the next person can't live with (CODE_STYLE.md: hard to
read or change, history in comments, general code copied into an app instead of a kit). "nonblocking" is the rest
worth doing: the author fixes or answers each this round, so with any, decide "changes". From the next round on none
holds the merge.`,
};
const THROWAWAY_REST = `Triage judged this throwaway work, which runs once or twice and goes to the archive, so this is its one
light review: whether it does what its task and the board asked, not its technology. Only what blocks on every round
holds its merge, and with none of that the ruling decides "merge". Refactoring, conventions, readability,
documentation, polish and hardening that isn't security are no findings on it, blocking or not.`;

export type Briefing = {
  // the reviewers' section, after the change's bar
  reviewer: string;
  // the ruling's line on what blocks (the panel's ruling and the check of the fixes)
  ruling: string;
  // what the consolidator's own touch-ups may cover
  touchups: string;
  // the author's job after a "changes"
  author: string;
  // the ruling's JSON field for a word on what went wrong before review
  field: string;
};

// What a round's briefing knows of the work: triage judged it throwaway, or it's a follow-up job's (followups.ts isFollowUp).
// Neither leaves a follow-up job (followups.ts collect).
export type Work = { throwaway?: boolean; followUp?: boolean };

// Round `round`'s briefing at `stage`, for `work`
export function briefing(stage: Stage, round: number, { throwaway = false, followUp = false }: Work = {}): Briefing {
  const { rounds, shipped } = reviewSettings();
  const always = everyRound(shipped);
  const left = followUp || throwaway ? LEFT.ended : LEFT.later;
  const first: Briefing = {
    reviewer: `
## Round ${round}: the first look
${always} ${throwaway ? THROWAWAY_REST : FIRST_LOOK.reviewer} ${left.line}`,
    ruling: `${always} ${throwaway ? THROWAWAY_REST : FIRST_LOOK.ruling} ${left.line}`,
    touchups: `- Only when it saves the author a round: at least one blocking finding can be fixed this way. Then make the safe
  nonblocking fixes too.`,
    author: `Fix the blocking findings. Fix or answer each nonblocking one too: fix it where that's quick and safe, else say
in your report why not. From the next round on only blocking findings hold the merge. ${left.line}`,
    field: '',
  };
  const later = (why: string): Briefing => ({
    reviewer: `
## Round ${round}: ${why}
${always} Only those block now. ${throwaway ? `${THROWAWAY_REST} ${left.line}` : `${NONBLOCKING} ${left.line} ${left.reviewer}`}`,
    ruling: `${always} Only those block now. ${throwaway ? `${THROWAWAY_REST} ${left.line}` : `${NONBLOCKING} ${left.line} ${left.ruling}`} With no
blocking finding, decide "merge", whatever else is listed.`,
    touchups: `- Only when it saves the author a round: at least one blocking finding can be fixed this way. Make only the
  blocking fixes. ${left.line}`,
    author: `Fix only the blocking findings, and keep each fix small: most blocking findings on a later round sit in the code
the last fix wrote. Give new code a fix adds its own test before you push. Leave the nonblocking findings. ${left.line}`,
    field: '',
  });
  if (stage === 'first') return first;
  if (stage === 'later') return later(round > 1 ? 'a later round' : "the deliverable's deadline is near");
  const past = later(`past ${rounds.upstream - 1} rounds`);
  const upstreamLine = `This pull request is on round ${round}: past ${rounds.upstream - 1} rounds, something before review is wrong (the
brief, the design, how the work was split, its tests), not only this code. Its project owner sees it.`;
  return {
    ...past,
    reviewer: `${past.reviewer}\n${upstreamLine}`,
    ruling: `${past.ruling}\n${upstreamLine} Say in "upstream", in one line, what you think went wrong before review.`,
    author: `${past.author}\n${upstreamLine} Where the brief or the design is what keeps failing, say so in your report.`,
    field: `, "upstream": "what went wrong before review, in one line"`,
  };
}
