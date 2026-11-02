// Author work that must finish or push before a review ruling can act.
import { db } from './db.ts';
import { OPEN_JOBS } from './jobs.ts';

export function since(branch: string, afterJob: number) {
  return db
    .prepare(
      `select id, status, status in ${OPEN_JOBS} going from jobs where kind = 'work'
    and branch = ? and (id > ? or status in ${OPEN_JOBS}) order by going desc, id desc limit 1`,
    )
    .get(branch, afterJob) as { id: number; status: string; going: number } | undefined;
}
