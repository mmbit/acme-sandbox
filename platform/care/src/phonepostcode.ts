// The phone's lighter check, for where an order stands and nothing more: its number and the postcode it goes to. Each
// stall compares the postcode with its order's delivery address in code (kits/payments `postcode`), and answers the
// same, after the same time, for a wrong postcode, no such order or one that isn't its own. A match opens the order's
// status to the call (phonecall.ts `status`, apart from a code's `granted`).
import { phoneStalls } from './config.ts';
import { limit, underLimit, now } from './db.ts';
import * as apps from './apps.ts';
import { save, normOrder, type Conv } from './phonecall.ts';

const DAY_MS = 24 * 60 * 60_000;
// A caller who misheard their own postcode, or gave an old one, has two more goes on a call. Across calls, five an order
// number a day: Belgium's postcodes are four digits, about 1,150 in use, so someone guessing has well under a 1 in 200
// chance a day, and gets the status only
export const POSTCODE_TRIES = 3;
const POSTCODES_A_DAY = 5;

// a postcode as said, its letters and digits only, upper case ("1234 ab" is "1234AB"), as the stalls compare it
export const normPostcode = (s: unknown) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);

// 'away': a stall couldn't be asked (a restart, a timeout), so nothing is told, a match included: the try is given
// back, and the day's count for the order number is taken only once every stall has answered
export async function checkPostcode(
  c: Conv,
  order: string,
  postcode: string,
): Promise<'right' | 'wrong' | 'limited' | 'away' | 'none'> {
  const o = normOrder(order),
    p = normPostcode(postcode),
    stalls = phoneStalls(c.shop),
    day = `phone-postcode:${c.shop}:${o}`;
  if (o.length < 3 || p.length < 4 || !stalls.length) return 'none';
  const tried = c.state.phone.postcodes ?? 0;
  if (tried >= POSTCODE_TRIES || !underLimit(day, POSTCODES_A_DAY, DAY_MS)) return 'limited';
  c.state.phone.postcodes = tried + 1;
  save(c);
  const answers = await Promise.all(
    stalls.map(async app => ({ app, answer: await apps.call(app, 'postcode', { order: o, postcode: p }) })),
  );
  if (answers.some(a => typeof a.answer?.match !== 'boolean')) {
    c.state.phone.postcodes = (c.state.phone.postcodes ?? 1) - 1;
    save(c);
    return 'away';
  }
  // (counted now: parallel calls past the check above find the day's count full here)
  if (!limit(day, POSTCODES_A_DAY, DAY_MS)) return 'limited';
  const hit = answers.find(a => a.answer.match);
  if (!hit) return 'wrong';
  c.state.phone.status = { app: hit.app, order: o, at: now() };
  save(c);
  return 'right';
}
