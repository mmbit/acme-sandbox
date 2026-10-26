// The company's formal stage boundaries, required visual checks and who draws a windowed thread's fixes.
import { yamlFile } from './company.ts';

// A visual check (visual.ts): the paths (those in except aside), the command that renders their previews, what to look
// for in them, and the folder the author's records go in.
export type VisualCheck = { paths: string[]; except?: string[]; run: string; look: string; record: string };
// The rounds' stages (reviewrounds.ts): the round from which only security, real bugs and what a customer could meet
// block, the one from which a pull request shows something went wrong before review, and how near a thread's deadline
// turns its first round into a later one
const ROUNDS = { later: 2, upstream: 6, nearDeadlineHours: 12 };
// drawWindowedChanges: a "changes" ruling on a thread with a window gives the PR's author its fix task at once
// (proposals.ts deliverFindings) rather than waiting for the project owner to draw it
export function reviewSettings() {
  const r = yamlFile('company/org.yaml').review ?? {};
  return {
    rounds: { ...ROUNDS, ...r.rounds } as typeof ROUNDS,
    visual: (r.visual ?? []) as VisualCheck[],
    // A description for reviewer judgment, never a path rule.
    live: String(r.live ?? "Public sites and apps already in use, and HQ's own look."),
    drawWindowedChanges: r.drawWindowedChanges === true,
  };
}
