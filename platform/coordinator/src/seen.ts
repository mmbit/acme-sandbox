// What the board has read in HQ, kept here so all its devices show the same unread counts.
// Per list, the newest item it has seen: Mail's newest mail id, each Gazette feed's newest post time, the desk
// phone's newest card time (when it was filed or last changed), and the intercom's newest chat line id.
// HQ counts anything newer as unread. A mark only moves forward, so a device that's behind can't bring old items back.
import { db } from './db.ts';

const LISTS = new Map<string, 'number' | 'string'>([['mail', 'number'], ['gazette.board', 'string'], ['gazette.company', 'string'],
  ['desk', 'string'], ['intercom', 'number']]);   // (desk; intercom)
db.exec('create table if not exists seen (list text primary key, newest text not null)');

// { list: newest } for every list the board has read something in
export function all() {
  const rows = db.prepare('select list, newest from seen').all() as { list: string; newest: string }[];
  return Object.fromEntries(rows.map(r => [r.list, JSON.parse(r.newest)]));
}

// A mail id, or a Gazette post's time
function fits(type: 'number' | 'string', newest: unknown): newest is number | string {
  if (type === 'number') return Number.isSafeInteger(newest);
  return typeof newest === 'string' && newest.length <= 64;
}

// The board has seen `list` up to `newest`: the marks as they stand after it, or why not
export function mark(list: unknown, newest: unknown) {
  const name = String(list), type = LISTS.get(name);
  if (!type) return 'no such list';
  if (!fits(type, newest)) return `newest must be a ${type}`;
  const now = all()[name];
  if (now === undefined || newest > now) {
    db.prepare('insert or replace into seen (list, newest) values (?, ?)').run(name, JSON.stringify(newest));
  }
  return all();
}
