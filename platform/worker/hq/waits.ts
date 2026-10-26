// What holds work, in words: hq estimate, hq when and hq thread say it, and the coordinator's summary (threats.ts) reads
// it from here too, each with its own clock. Nothing imported.
// The board (a card, answered about `at`, or the company paused), the seats out until a time, work queued ahead for the
// same slots, a job it waits for, a deploy, nothing that will come by itself (stalled: with the thread or project whose
// pause holds it, when one does), or past the horizon. The coordinator's play writes these (playtypes.ts).
export type Wait =
  | { on: 'board'; request?: number; at?: number; paused?: true }
  | { on: 'seats'; engine: string; until: number }
  | { on: 'queue'; engine: string; minutes: number; pausing?: true }
  | { on: 'job'; job: number }
  | { on: 'deploy' }
  | { on: 'stalled'; why: string; pause?: string } // (pause)
  | { on: 'horizon'; days: number };

export function waitWords(w: Wait, at: (ms: number) => string) {
  if (w.on === 'board')
    return w.paused
      ? "the board's pause of the company"
      : `the board's answer${w.request ? ` on card #${w.request}` : ''}${w.at ? `, expected about ${at(w.at)}` : ''}`;
  if (w.on === 'seats') return `the ${w.engine} seats, out until ${at(w.until)}`;
  if (w.on === 'queue' && w.pausing)
    return `pausing lower-order work for the ${w.engine} seats (${duration(w.minutes)})`;
  if (w.on === 'queue')
    return `work queued ahead on the ${w.engine} seats${w.minutes ? ` (${duration(w.minutes)})` : ''}`;
  if (w.on === 'job') return `job #${w.job}`;
  if (w.on === 'deploy') return 'a deploy';
  if (w.on === 'stalled') return w.why;
  return `nothing that ends within ${w.days} days`;
}

export function duration(minutes: number) {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h${whole % 60 ? ` ${whole % 60} min` : ''}`;
}
