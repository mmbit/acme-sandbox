// A paid basket of the shop's for tests, stored as payments.ts and codes.ts keep one (no route short of a Stripe
// checkout and its webhook makes one): its things (and a line of the shop's own going with the first, when asked), and
// whether its buyer had paid for one before (null: not known). The test's own db, opened after its DATA_DIR is set.
import type { DatabaseSync } from 'node:sqlite';

let baskets = 0;
export function paidBasket(
  db: DatabaseSync,
  at: string,
  things: number,
  back: boolean | null,
  o: { mode?: string; status?: string; amount?: number; own?: boolean } = {},
) {
  const n = ++baskets,
    session = `cs_live_basket${n}`,
    paidAt = `${at}T10:00:00.000Z`,
    mode = o.mode ?? 'live';
  db.prepare(
    `insert into payments (id, created, product, mode, reference, amount, currency, status, updated, basket)
    values (?, ?, 'front', ?, ?, ?, 'eur', ?, ?, ?)`,
  ).run(session, paidAt, mode, `bk${n}`, o.amount ?? 3995, o.status ?? 'paid', paidAt, `bk${n}`);
  for (let i = 0; i < things + (o.own ? 1 : 0); i++) {
    const line = `ln_basket${n}_${i}`;
    db.prepare(
      `insert into pay_lines (id, created, product, mode, reference, amount, currency, description, ships_in, cutoff,
      status, session, paid_at, updated, goes_with) values (?, ?, 'pebblepost', ?, ?, 3995, 'eur', '', 1, 12, 'paid', ?, ?, ?, ?)`,
    ).run(line, paidAt, mode, line, session, paidAt, paidAt, i === things ? `ln_basket${n}_0` : null);
    db.prepare('insert into session_lines (session, line, position, card, saved) values (?, ?, ?, 3995, 0)').run(
      session,
      line,
      i,
    );
  }
  if (back !== null)
    db.prepare('insert into code_orders (session, mode, paid, newcomer) values (?, ?, ?, ?)').run(
      session,
      mode,
      at,
      back ? 0 : 1,
    );
}
