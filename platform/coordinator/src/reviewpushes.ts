// The latest push while a round's panel is out or its board card awaits an answer (review.ts startReview). It waits
// for the ruling and board answer before review continues on the newer head.
import { db } from './db.ts';
import type { Check } from './review.ts';
import type { ChangedLines } from './findings.ts';

// startReview's arguments, as the worker reported the push
export type Push = {
  pr: number;
  branch: string;
  author: string;
  files: string[];
  sha?: string;
  links: string[];
  frontmatter: { path: string; text: string | null }[];
  knowledge: { docs: { path: string; text: string }[]; files: string[] };
  pushedSince?: { sha: string; files: string[] };
  gates?: Check;
  tests?: Check;
  lines?: ChangedLines;
};

export const keep = (push: Push) =>
  db
    .prepare('insert or replace into review_waiting_pushes (pr, push, at) values (?, ?, ?)')
    .run(push.pr, JSON.stringify(push), new Date().toISOString());

export const waits = (pr: number) => !!db.prepare('select 1 from review_waiting_pushes where pr = ?').get(pr);

export const drop = (pr: number) => db.prepare('delete from review_waiting_pushes where pr = ?').run(pr);

export function take(pr: number) {
  const row = db.prepare('delete from review_waiting_pushes where pr = ? returning push').get(pr) as
    { push: string } | undefined;
  return row && (JSON.parse(row.push) as Push);
}

export const all = () =>
  (db.prepare('select pr from review_waiting_pushes order by pr').all() as { pr: number }[]).map(row => row.pr);

// A pass on a commit the branch had left by its ruling: the push after it is new work, never a merge check
export const leavePass = (ruling: number) =>
  db.prepare('insert or ignore into review_left_passes (ruling) values (?)').run(ruling);
export const passLeft = (ruling: number) =>
  !!db.prepare('select 1 from review_left_passes where ruling = ?').get(ruling);
