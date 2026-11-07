// A call's prototype builds as rows (callbuilds.ts builds them): which job is which build, and what its placeholder
// shows. Apart from callbuilds.ts, on the database alone, so the call's page (ink/groupanswers.ts) and the prototypes
// (callprototypes.ts) read them without loading the call's whole module graph.
import { db } from './db.ts';

db.exec(`create table if not exists call_builds (job integer primary key, call integer not null,
  name text not null collate nocase, grp integer not null, version integer not null, about text not null default '',
  heard integer not null default 0)`);
export type Build = {
  job: number;
  call: number;
  name: string;
  grp: number;
  version: number;
  about: string;
  heard: number;
};

// The build a job is, if it is one
export const buildOf = (job: number) =>
  db.prepare('select * from call_builds where job = ?').get(job) as Build | undefined;

// The minutes builds usually take, from their brief to their version on the page: the middle one of the latest that
// landed (null: too few to say)
export function usualMinutes() {
  const took = (
    db
      .prepare(
        `select (julianday(p.made) - julianday(j.created)) * 1440 minutes from call_builds b
          join jobs j on j.id = b.job join call_prototypes p on p.call = b.call and p.name = b.name and p.version = b.version
          order by b.job desc limit 9`,
      )
      .all() as { minutes: number }[]
  )
    .map(r => r.minutes)
    .sort((x, y) => x - y);
  return took.length >= 3 ? Math.max(1, Math.round(took[took.length >> 1])) : null;
}

// What a group's placeholder shows of the build it's tried by (groupanswers.ts tryOf): that it's a prototype, its
// version and how long builds usually take. null: not a build's.
export function placeholderOf(grp: number, job: number) {
  const b = db.prepare('select version from call_builds where job = ? and grp = ?').get(job, grp) as
    { version: number } | undefined;
  return b ? { version: b.version, minutes: usualMinutes() } : null;
}
