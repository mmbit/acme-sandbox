// The busy notice: wherever the chat says how long a person takes, it adds "it may take longer" in the
// company's busy season, when the email queue is long, or when Care's switch says so. HQ holds the switch and the queue
// (hq.ts reads them); the company's rule is its plug-in's `busy` (company.ts); this decides.
import { workingDaysBetween } from './days.ts';
import { settings } from './company.ts';

export type HqState = { busy: 'auto' | 'on' | 'off'; queue: { waiting: number; oldest: string | null } };
let state: HqState = { busy: 'auto', queue: { waiting: 0, oldest: null } };
export const set = (s: HqState) => { state = s; };

export function why(t = Date.now()): string | null {
  const q = state.queue, oldest = q.oldest ? workingDaysBetween(Date.parse(q.oldest), t) : 0, rule = settings.busy;
  // past the days we aim for, "we aim for 3" alone would mislead, so it stays on whatever the switch says
  if (oldest > rule.aim) return `an email has waited over ${rule.aim} working days`;
  if (state.busy === 'off') return null;
  if (state.busy === 'on') return 'switched on in Care';
  const season = rule.season(t);
  if (season) return season;
  if (q.waiting > rule.waiting) return `more than ${rule.waiting} emails waiting`;
  if (oldest > rule.days) return `an email has waited over ${rule.days} working days`;
  return null;
}
export const busy = (t = Date.now()) => why(t) !== null;
