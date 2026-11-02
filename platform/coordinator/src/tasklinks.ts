// Retained held-branch relationships shared by task time and feature accounting.
import { db } from './db.ts';
export function heldBranches() {
  const rows = db
    .prepare(
      `select distinct m.job, p.branch from card_merges m
    join prs p on p.number = m.pr`,
    )
    .all() as { job: number; branch: string }[];
  return new Map([...Map.groupBy(rows, row => row.job)].map(([job, held]) => [job, held.map(row => row.branch)]));
}
