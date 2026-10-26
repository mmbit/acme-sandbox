// The formal review process (the review-panel playbook, "Rounds"): each round's briefing, chosen by its stage, for its
// reviewers, its ruling and its author. What blocks on every round is the same; what else may block, and where the rest
// goes, isn't. The first round may block on code the next person can't live with and leaves the rest for the author to
// fix if they like; from a later round on (or once the thread's deadline is near) only security, real bugs and what a
// customer could meet block, and the rest goes to the project's follow-ups (followups.ts); from the upstream round on, the
// pull request shows its project owner that something before review went wrong. No round closes anything. Work triage
// judged throwaway blocks only on what blocks every round, and reports nothing else.
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

const ALWAYS = `Within the assigned scope, what blocks on every round: a security problem (secrets, keys, sign-in, customers' data, a way around the review,
the gates or the sandbox); a real bug (the code does the wrong thing on inputs it will meet, shown as inputs → wrong
outcome); anything a customer could see or meet (what a product, a page or a mail shows or does, the house rules);
and a change that doesn't do what the board asked (its own section below, where there is one).`;
const FOLLOW_UPS = `Refactoring, conventions, readability, documentation and hardening that isn't security, in the fixes' own code
too, are nonblocking: they don't go back to the author, but into the project's follow-ups, a thread of their own that the
project's owner prioritises and assigns.`;
// What else blocks in the first look, for the reviewers and for the ruling
const FIRST_LOOK = {
  reviewer: `In the first look, code the next person can't live with blocks too (below). Refactoring, conventions,
documentation and hardening that isn't security are otherwise nonblocking notes, which the author may fix now.`,
  ruling: `In the first look, so does code the next person can't live with (CODE_STYLE.md: hard to
read or change, history in comments, general code copied into an app instead of a kit). "nonblocking" is the rest
worth doing: the author may fix it now, and what's left when it merges goes to the project's follow-ups.`,
};
const THROWAWAY_REST = `Triage judged this throwaway work, which runs once or twice and goes to the archive: refactoring,
conventions, readability, documentation and hardening that isn't security are no findings on it, blocking or not.`;

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

// Round `round`'s briefing at `stage`, for work triage judged throwaway or not
export function briefing(stage: Stage, round: number, throwaway = false): Briefing {
  const { upstream } = reviewSettings().rounds;
  const first: Briefing = {
    reviewer: `
## Round ${round}: the first look
${ALWAYS} ${throwaway ? THROWAWAY_REST : FIRST_LOOK.reviewer}`,
    ruling: `${ALWAYS} ${throwaway ? THROWAWAY_REST : FIRST_LOOK.ruling}`,
    touchups: `- Only when it saves the author a round: at least one blocking finding can be fixed this way. Then make the safe
  nonblocking fixes too.`,
    author: `Fix the blocking findings. The nonblocking ones are yours to fix too where that's quick and safe; what you leave
goes to the project's follow-ups when the pull request merges.`,
    field: '',
  };
  const later = (why: string): Briefing => ({
    reviewer: `
## Round ${round}: ${why}
${ALWAYS} Only those block now. ${throwaway ? THROWAWAY_REST : `${FOLLOW_UPS} Report one only when it's worth that thread.`}`,
    ruling: `${ALWAYS} Only those block now. ${throwaway ? THROWAWAY_REST : `${FOLLOW_UPS} Put those in "nonblocking".`}`,
    touchups: `- Only when it saves the author a round: at least one blocking finding can be fixed this way. Make only the
  blocking fixes: the nonblocking findings go to the project's follow-ups.`,
    author: `Fix only the blocking findings, and keep each fix small: most blocking findings on a later round sit in the code
the last fix wrote. Give new code a fix adds its own test before you push. The nonblocking findings aren't yours: they
go to the project's follow-ups.`,
    field: '',
  });
  if (stage === 'first') return first;
  if (stage === 'later') return later(round > 1 ? 'a later round' : "the thread's deadline is near");
  const past = later(`past ${upstream - 1} rounds`);
  const upstreamLine = `This pull request is on round ${round}: past ${upstream - 1} rounds, something before review is wrong (the
brief, the design, how the work was split, its tests), not only this code. Its project owner sees it.`;
  return {
    ...past,
    reviewer: `${past.reviewer}\n${upstreamLine}`,
    ruling: `${past.ruling}\n${upstreamLine} Say in "upstream", in one line, what you think went wrong before review.`,
    author: `${past.author}\n${upstreamLine} Where the brief or the design is what keeps failing, say so in your report.`,
    field: `, "upstream": "what went wrong before review, in one line"`,
  };
}
