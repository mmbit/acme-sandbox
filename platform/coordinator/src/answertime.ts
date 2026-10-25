// When the board is expected to answer its open cards, from the cards it answered before (the play's input: backlog.ts). (out of backlog.ts)
import { db, prepared } from './db.ts';
import { median } from './arithmetic.ts';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// When the board is expected to answer an open card: the median time cards of its kind took over the last two weeks
// (any kind's, with fewer than FEW of its own), counting only those that took longer than this one has been open so
// far. None took that long: as the play starts. The hour of the day (the board sleeps) isn't played yet.
const ANSWERS_OVER_MS = 2 * WEEK_MS,
  FEW = 3;
export function answerTimes(now: number) {
  const answered = db
    .prepare(
      `select kind, (julianday(answered) - julianday(created)) * 86400000 ms from requests
      where answered is not null and answered > ?`,
    )
    .all(iso(now - ANSWERS_OVER_MS)) as { kind: string; ms: number }[];
  return (request: number) => {
    const card = prepared('select kind, created from requests where id = ?').get(request) as
      { kind: string; created: string } | undefined;
    if (!card) return now;
    const created = Date.parse(card.created),
      open = now - created;
    const own = answered.filter(a => a.kind === card.kind);
    const longer = (own.length >= FEW ? own : answered).map(a => a.ms).filter(ms => ms > open);
    const typical = median(longer);
    return typical === null ? now : Math.max(now, Math.round(created + typical));
  };
}
