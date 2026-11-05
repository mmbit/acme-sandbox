// The marks on a call's page its agent heard (callguests.ts markForVoice): who, and the group as it was (bookseen.ts
// drawnOf), so its seen tick (groupanswers.ts seenTick) holds until more is drawn on it.
import { db } from '../db.ts';
import { drawnOf } from './bookseen.ts';

db.exec(
  'create table if not exists ink_heard (grp integer primary key, by text not null, drawn text not null, at text not null)',
);
type Drawn = { id: number; ink: string; texts: string; pictures: string; words: string };
export const heard = (g: Drawn, by: string) =>
  db
    .prepare(
      `insert into ink_heard (grp, by, drawn, at) values (?, ?, ?, ?)
        on conflict(grp) do update set by = excluded.by, drawn = excluded.drawn, at = excluded.at`,
    )
    .run(g.id, by, drawnOf(g), new Date().toISOString());
// Who heard the group as it is now, if anyone did
export const heardBy = (g: Drawn) =>
  (
    db.prepare('select by from ink_heard where grp = ? and drawn = ?').get(g.id, drawnOf(g)) as
      { by: string } | undefined
  )?.by;
