// The end of a paid basket's records, once the law no longer keeps them (the order history's, history.ts).
// A paid basket's records end on 1 January after the years the front's manifest names for its delivery country
// (basket.kept_years: {NL: 7}; KEPT_YEARS for one it doesn't name), counted from the end of the year it was paid in: its
// session, its lines, and what each module keeps of it (payments.recordsEnded). Unpaid ones stay as payments leaves them.
import { db, inOneStep } from './db.ts';
import { FRONT } from './approvals.ts';
import { manifest } from './manifests.ts';
import { companyDay } from './company.ts';
import * as payments from './payments.ts';

const KEPT_YEARS = 10; // the longer of the EU's: an OSS sale's (VAT Directive art. 369k(2))

const keptYears = () => {
  const named = (manifest(FRONT)?.basket as any)?.kept_years;
  return named && typeof named === 'object' ? (named as Record<string, unknown>) : {};
};
const yearsFor = (country: string | null) => {
  const years = keptYears()[country ?? ''];
  return Number.isInteger(years) && (years as number) > 0 ? (years as number) : KEPT_YEARS;
};
export function endRecords(now = Date.now()) {
  const year = Number(companyDay(now).slice(0, 4));
  const fewest = Math.min(KEPT_YEARS, ...Object.keys(keptYears()).map(yearsFor));
  // a day's margin over the company's time zone; each is judged by its own year below
  const before = `${year - fewest}-01-02`;
  const paid = db
    .prepare(
      `select p.id, p.country, min(l.paid_at) paid_at from payments p join pay_lines l on l.session = p.id
    where p.product = ? and p.basket is not null and p.status in ('paid', 'refunded') group by p.id having min(l.paid_at) < ?`,
    )
    .all(FRONT, before) as { id: string; country: string | null; paid_at: string }[];
  const ended = paid.filter(
    pay => Number(companyDay(Date.parse(pay.paid_at)).slice(0, 4)) + yearsFor(pay.country) < year,
  );
  for (const pay of ended) {
    try {
      inOneStep(() => endSession(pay.id));
    } catch (err) {
      console.error(`History: ${pay.id}'s records could not end:`, err instanceof Error ? err.message : err);
    }
  }
  if (ended.length)
    payments.log(
      `the records of ${ended.length} paid basket${ended.length === 1 ? '' : 's'} ended, past the years the law keeps them.`,
    );
}
function endSession(session: string) {
  for (const hook of payments.recordsEnded) hook(session);
  db.prepare('delete from session_lines where session = ? or line in (select id from pay_lines where session = ?)').run(
    session,
    session,
  );
  db.prepare('delete from pay_lines where session = ?').run(session);
  db.prepare('delete from baskets where id = (select basket from payments where id = ?)').run(session);
  db.prepare('delete from payments where id = ?').run(session);
}
