// A day's allowance of model calls, kept in its own day-keyed table (day, and how many today): the ink's readings, the
// book's judgings, the page titles. takeOne() counts one more today, or says false once today's limit is used; days
// older than a week go.
import { companyDay } from './company.ts';
import { db } from './db.ts';

// How long a day's count is kept
const KEPT_MS = 7 * 24 * 60 * 60_000;

export function dayAllowance(table: string, column: string, limit: number) {
  db.exec(`create table if not exists ${table} (day text primary key, ${column} integer not null)`);
  const read = db.prepare(`select ${column} as n from ${table} where day = ?`),
    add = db.prepare(
      `insert into ${table} (day, ${column}) values (?, 1) on conflict (day) do update set ${column} = ${column} + 1`,
    ),
    drop = db.prepare(`delete from ${table} where day < ?`);
  return function takeOne() {
    const day = companyDay(Date.now());
    if (((read.get(day) as { n: number } | undefined)?.n ?? 0) >= limit) return false;
    add.run(day);
    drop.run(companyDay(Date.now() - KEPT_MS));
    return true;
  };
}
