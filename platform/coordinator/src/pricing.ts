// A product's plans and their prices, from the product's own files, and what a payer's choice of them comes to: the one
// place a plan's total is worked out (plans.ts).
//
// product.yaml's `plans:`, inline or a YAML file in the product's folder that it names (plans: plans.yaml):
//   plans:
//     - {id: plan, name: Basic, month: 500, up_front: [6, 12], tiers: [extra]}
//   tiers:
//     - {id: extra, name: Extra, month: 400}
//   tester: {en: ..., nl: ...}
// month: cents a month, VAT included. A plan is paid by the month unless it says `monthly: false`, and up front for each
// number of months up_front names. tester: what a tester invite's door says its voucher is for (shares.ts), by language.
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { REPO_DIR } from './config.ts';
import { manifest } from './manifests.ts';
import type { Refused } from './payments.ts';

export type Tier = { id: string; name: string; month: number };
export type Plan = Tier & { monthly: boolean; up_front: number[]; tiers: string[] };
export type Plans = { plans: Plan[]; tiers: Tier[]; tester: Record<string, string> };
// A payer's choice: the plan, its tiers, and the months paid up front (null: by the month)
export type Choice = { plan: Plan; tiers: Tier[]; months: number | null };
export class PlansError extends Error {}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/,
  PLANS_FILE = /^[\w-][\w.-]{0,80}\.ya?ml$/;
const MOST_MONTHS = 36;

// The product's plans, null when it names none; PlansError when they can't be read
export function plansOf(slug: string): Plans | null {
  const named = manifest(slug)?.plans;
  if (named == null) return null;
  const where = `products/${slug}'s plans`;
  if (typeof named !== 'string') return checked(named, where);
  if (!PLANS_FILE.test(named)) throw new PlansError(`${where}: a YAML file in the product's folder, like plans.yaml`);
  let source: unknown;
  try {
    source = YAML.parse(readFileSync(`${REPO_DIR}/products/${slug}/${named}`, 'utf8'));
  } catch (err) {
    throw new PlansError(
      `${where}: ${named} can't be read (${err instanceof Error ? err.message.split('\n')[0] : err})`,
    );
  }
  return checked(source, where);
}

// The plans as the manifest gives them, each part checked, or why not
function checked(source: any, where: string): Plans {
  const wrong = (what: string): never => {
    throw new PlansError(`${where}: ${what}`);
  };
  const listOf = (v: unknown, name: string) => (v == null ? [] : Array.isArray(v) ? v : wrong(`${name} is a list`));
  const priced = (x: any, kind: string): Tier => {
    if (!ID.test(String(x?.id ?? ''))) wrong(`a ${kind}'s id: 1-40 lower-case letters, digits or -`);
    if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 60)
      wrong(`${kind} ${x.id}'s name: 1-60 characters`);
    if (!Number.isInteger(x.month) || x.month < 1) wrong(`${kind} ${x.id}'s month: whole cents a month, VAT included`);
    return { id: x.id, name: x.name.trim(), month: x.month };
  };
  const tiers = listOf(source?.tiers, 'tiers').map(x => priced(x, 'tier'));
  const plans = listOf(source?.plans, 'plans').map(x => {
    const plan = priced(x, 'plan'),
      upFront = listOf(x.up_front, `plan ${x.id}'s up_front`),
      own = listOf(x.tiers, `plan ${x.id}'s tiers`);
    if (
      !upFront.every(n => Number.isInteger(n) && n >= 1 && n <= MOST_MONTHS) ||
      new Set(upFront).size !== upFront.length
    )
      wrong(`plan ${x.id}'s up_front: different numbers of months, 1 to ${MOST_MONTHS}`);
    if (!own.every(t => tiers.some(tier => tier.id === t)) || new Set(own).size !== own.length)
      wrong(`plan ${x.id}'s tiers: ids from tiers, once each`);
    const monthly = x.monthly !== false;
    if (!monthly && !upFront.length) wrong(`plan ${x.id} is paid neither by the month nor up front`);
    return { ...plan, monthly, up_front: upFront as number[], tiers: own as string[] };
  });
  if (!plans.length) wrong('at least one plan');
  for (const list of [plans, tiers]) if (new Set(list.map(x => x.id)).size !== list.length) wrong('each id once');
  const tester: Record<string, string> = {};
  for (const [lang, text] of Object.entries(source?.tester ?? {}))
    if (typeof text === 'string' && text.trim()) tester[lang] = text.trim();
  return { plans, tiers, tester };
}

// A payer's choice from a request ({plan, tiers?: ids or a comma-separated string, period: 'monthly' | months}), checked
// against the product's plans
export function choiceOf(plans: Plans, b: any): Choice | Refused {
  const plan = plans.plans.find(p => p.id === b?.plan);
  if (!plan) return [400, `plan: one of ${plans.plans.map(p => p.id).join(', ')}`, 'plan_unknown'];
  const ids: unknown[] =
    b.tiers == null || b.tiers === '' ? [] : Array.isArray(b.tiers) ? b.tiers : String(b.tiers).split(',');
  if (!ids.every(id => plan.tiers.includes(String(id))) || new Set(ids).size !== ids.length) {
    const allowed = plan.tiers.length ? `some of ${plan.tiers.join(', ')}, once each` : 'none go with this plan';
    return [400, `tiers: ${allowed}`, 'tier_unknown'];
  }
  const tiers = ids.map(id => plans.tiers.find(t => t.id === String(id))!);
  const period = b.period === 'monthly' ? 'monthly' : Number(b.period);
  if (period === 'monthly' ? !plan.monthly : !plan.up_front.includes(period)) {
    const periods = [...(plan.monthly ? ['monthly'] : []), ...plan.up_front];
    return [400, `period: ${periods.join(', ')}`, 'period_unknown'];
  }
  return { plan, tiers, months: period === 'monthly' ? null : period };
}

// What one payment for a choice comes to, VAT included: the plan's and its tiers' month, times the months it pays (one
// for a month, or for a monthly plan's each month)
export const totalOf = (choice: Pick<Choice, 'plan' | 'tiers'>, months: number | null) =>
  (choice.plan.month + choice.tiers.reduce((n, t) => n + t.month, 0)) * (months ?? 1);
export const quoteOf = (choice: Choice) => ({
  plan: choice.plan.id,
  tiers: choice.tiers.map(t => t.id),
  period: choice.months === null ? 'monthly' : 'up_front',
  months: choice.months,
  total: totalOf(choice, choice.months),
});
// The plans as a product shows them: each plan's and tier's name and month
export const shownOf = ({ plans, tiers }: Plans) => ({ plans, tiers });
// A plan and its tiers by name, as a payer chose them: the board's list of a tester invite (shares.ts)
export function namesOf(slug: string, plan: string, tiers: string[]) {
  let plans: Plans | null = null;
  try {
    plans = plansOf(slug);
  } catch {
    /* the ids name them */
  }
  const named = (id: string, list: Tier[] = []) => list.find(x => x.id === id)?.name ?? id;
  return [named(plan, plans?.plans), ...tiers.map(t => named(t, plans?.tiers))];
}

// A date months later on the same day of the month, or the month's last day when it has fewer (31 January and a month:
// 28 or 29 February), as Stripe bills a month.
export function addMonths(ms: number, months: number) {
  const d = new Date(ms),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.getTime();
}
