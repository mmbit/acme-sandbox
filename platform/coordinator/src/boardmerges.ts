// Saved board merge answers apply only to the ruling and head the board reviewed.
import { db } from './db.ts';

type Authorization = {
  request: number;
  id: number;
  pr: number;
  round: number;
  sha: string;
  answered: string;
  answer: string;
  status: string;
};

export function authorization(pr: number) {
  const saved = db
    .prepare(
      `select r.id request, j.id, j.pr, j.round, j.sha, r.answered, r.answer, r.status
    from requests r join jobs j on j.id = r.job join prs p on p.number = r.pr
    where r.id = ?
    and p.status = 'board' and j.pr = p.number and j.round = p.round and j.sha = p.sha
    and j.id > p.review_since and j.voided is null and j.status = 'done'`,
    )
    .get(latestRequest(pr)?.id ?? null) as Authorization | undefined;
  return saved?.status === 'answered' && answerAction(saved.answer) === 'merge' ? saved : undefined;
}

// The board's merge answer to a ruling, read by that ruling: it holds through the author's re-sync and merge check.
export function answeredMerge(ruling: number) {
  const card = db
    .prepare(
      "select answer, answered from requests where job = ? and kind = 'review' and status = 'answered' order by id desc limit 1",
    )
    .get(ruling) as { answer: string; answered: string } | undefined;
  return card && answerAction(card.answer) === 'merge' ? card.answered : undefined;
}

export const latestRequest = (pr: number) =>
  db
    .prepare("select id, status, answer from requests where kind = 'review' and pr = ? order by id desc limit 1")
    .get(pr) as { id: number; status: string; answer: string } | undefined;

export function answerAction(answer: string) {
  const action = answer.trim();
  if (/^merge\b/i.test(action)) return 'merge';
  if (/^close\b/i.test(action)) return 'close';
  return 'feedback';
}
