// HQ's check on the email service's plan, for the watch (watch.ts): the emails sent in the calendar month so far, HQ's
// own (mailout.ts) and the support chat's (care-numbers.ts), against the company's limit. Past it, the process role hears
// that the plan should move up before the service refuses mail (infra/products.md, "HQ's watch").
import { setting, remember } from './db.ts';
import { createJob } from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import * as company from './company.ts';
import * as mailout from './mailout.ts';
import * as careNumbers from './care-numbers.ts';

// the month whose job went out: one job a month at most
const ALERTED_MONTH = 'watch.emailsMonth';

// The month of the company's day against company/org.yaml's `watch.emailsPerMonth`. Without that setting it checks
// nothing.
export function checkMonth(day: string) {
  const limit = Number(company.yamlFile('company/org.yaml')?.watch?.emailsPerMonth);
  const month = day.slice(0, 7);
  if (!(limit > 0) || setting(ALERTED_MONTH) === month) return true;
  const ours = mailout.emailsIn(month);
  const chat = careNumbers.emailsIn(month);
  const emails = ours + chat;
  if (emails < limit) return true;
  createJob({
    agent: company.roles().process,
    word: STANDING.mailPlan, // (its task code's word)
    title: `${emails} emails sent in ${month}: move the email plan up before mail is refused`,
    prompt:
      `HQ's watch counted ${emails} emails sent so far in ${month}, on the company's clock. The company's limit is ` +
      `${limit} a month (company/org.yaml, watch.emailsPerMonth). HQ sent ${ours} itself: the board's replies, order ` +
      `and basket emails, guests' codes and business mail. The support chat's service sent ${chat}. Each recipient ` +
      'counts, copies included, as the email service counts its plan.\n\n' +
      "The email plan should move up before the month reaches the plan's own quota. Past it, the service refuses mail: " +
      "codes, receipts and the board's replies would never arrive. The plan is the board's: it costs money, and the " +
      "service's account is the board's. Bring it to the board on one card (hq request), with what company/DECISIONS.md " +
      'already decided about it. The watch says this once a month.',
  });
  remember(ALERTED_MONTH, month);
  return true;
}
