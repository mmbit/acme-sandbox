// The harness's stored plan states that no route makes: dependency cycles the commands refuse to create, closed
// threads, and a project's owner.
import type { DatabaseSync } from 'node:sqlite';

export function storedPlans(db: DatabaseSync) {
  // Persisted dependency cycles that the commands refuse to create.
  const storedTaskPlacement = (id: number, thread: string) =>
    db.prepare('update jobs set thread = ?, seq = null where id = ?').run(thread, id);
  const storedWait = (id: number, onJob: number) =>
    db.prepare('insert into waits (job, on_job) values (?, ?)').run(id, onJob);
  // Closed threads leave no open placeholder in a test's forecast.
  const closedThreads = (id: string | null = null) =>
    db.prepare("update threads set status = 'done' where status = 'open' and ($id is null or id = $id)").run({ id });
  // A stored project's owner for tests of hand-offs into its threads.
  const storedProjectOwner = (project: string, owner: string) =>
    db.prepare('update projects set owner = ? where id = ?').run(owner, project);
  return { storedTaskPlacement, storedWait, closedThreads, storedProjectOwner };
}
