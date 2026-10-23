// The schedule as it ran before its routines had projects, for the tests of their move into them (projects.test.ts):
// an entry's run recorded with its job (made in no thread, by the test), and the routines' projects gone again after.
import { db } from './db.ts';
import { ROUTINES } from './schedule.ts';

export const legacyRun = (entry: string, slot: string, job: number) =>
  db.prepare('insert into schedule_runs (id, slot, job) values (?, ?, ?)').run(entry, slot, job);
export const clearRoutines = () => db.prepare('delete from projects where by = ?').run(ROUTINES);
