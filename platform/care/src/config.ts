// Care's settings, read once from the environment (infra/products.py sets them; a local run and the tests set their own).
// Keys only from here, never logged. What's the company's comes from its plug-in (company.ts).
const env = process.env;
const json = (s: string | undefined) => { try { return JSON.parse(s ?? '') ?? {}; } catch { return {}; } };

export const PORT = Number(env.PORT ?? 8080);
// the address to listen on: every interface unless set (the container's default); the eval sets 127.0.0.1
export const HOST = env.CARE_HOST || undefined;
export const DATA_DIR = env.DATA_DIR ?? '/data';

// ---- the apps: each one's base URL and CARE_TOKEN, keyed by what Caddy puts in X-Care-App ('shop', 'shop@preview')
export const APPS: Record<string, string> = json(env.CARE_APPS);
// ---- the shops: the apps (stalls) one chat session spans, keyed by what Caddy puts in X-Care-Shop. Stalls on one
// origin share the cookie, so they share the session: its grants, its thread and its chat, and a checked email's
// orders come from every app of the shop. A shop not listed is a shop of one, its own app (an app on a host of its own).
export const SHOPS: Record<string, string[]> = json(env.CARE_SHOPS);
export const appsOf = (shop: string): string[] => Array.isArray(SHOPS[shop]) ? SHOPS[shop] : [shop];
// ...and of those, the ones whose orders care can ask for (an order endpoint in CARE_APPS): a shop's own pages (the front)
// have none
export const withOrders = (shop: string): string[] => appsOf(shop).filter(a => a in APPS);
// ...and the stalls the phone line asks for an order number: the shop's, then its preview's, where an order placed for real
// on the preview shop (a tester's) is kept
export const phoneStalls = (shop: string): string[] => [
  ...withOrders(shop),
  ...(Array.isArray(SHOPS[`${shop}@preview`]) ? withOrders(`${shop}@preview`) : []),
];
// The app a conversation (of this shop, with this state) is about, for its spend, its counts and a person's card: the app
// of the orders the helper looked at, when they're all one app's; the shop's, when they're several apps'; else the stall
// the customer is in (engine.ts stall)
export function aboutOf(shop: string, state: { orderApps?: string[]; stall?: string }): string {
  const a = state.orderApps ?? [];
  return a.length === 1 ? a[0] : a.length > 1 ? shop : state.stall ?? shop;
}
// care's own model calls for HQ (inbox.ts: the hello@ email drafts): an app of their own in the ledger (a day cap of
// its own, CAP.appDay) and in Care › Numbers' month (numbers.ts), which is all the month's cap counts
export const HQ_APP = 'hq';
export const TOKENS: Record<string, string> = json(env.CARE_TOKENS);
// the apps' names (CARE_NAMES) and what each makes (CARE_THINGS) go over the plug-in's (company.ts use()); which
// knowledge folder an app reads (kb/<x>), when it isn't its own slug's
export const KB: Record<string, string> = json(env.CARE_KB);

// ---- keys (server keys from the board's desk phone, never a partner key: those reach every agent job)
export const ANTHROPIC_KEY = env.CARE_ANTHROPIC_API_KEY ?? '';
export const ANTHROPIC_API = env.CARE_ANTHROPIC_API ?? 'https://api.anthropic.com';
// signs the links in the service's own emails; made on first start if not given (db.ts)
export const LINK_KEY = env.CARE_LINK_KEY ?? '';

// ---- the model (the eval picks). 'fake' plays a scripted provider for tests and the local harness.
// Without a key the stand-in model answers only on a local run; on the server a missing key is the model being down
// (anthropic.ts), so customers get the outage card and a person, never the stand-in's words.
export const PROVIDER = env.CARE_PROVIDER ?? (ANTHROPIC_KEY || env.CARE_LOCAL !== '1' ? 'anthropic' : 'fake');
// the model itself is the company's choice (its plug-in's `model`, or CARE_MODEL: company.ts)
export const EFFORT = env.CARE_EFFORT ?? 'low';

// ---- HQ (the Care app): cards out, the busy switch and the board's asks in
export const HQ_URL = env.CARE_HQ_URL ?? '';
export const HQ_TOKEN = env.CARE_HQ_TOKEN ?? '';

// ---- caps in code, on top of the provider console's own monthly limit (docs/switch-on.md, "The model key"), in euros
export const CAP = {
  month: Number(env.CARE_CAP_MONTH ?? 19),        // every app and purpose together: set just short of the console's limit (the default, a €20 one)
  appDay: Number(env.CARE_CAP_APP_DAY ?? 2),
  // one person's, each for the company's day (ledger.ts): a conversation's, and before any check (level 0) a
  // session's and an IP's
  conversation: Number(env.CARE_CAP_CONVERSATION ?? 0.5),
  sessionUnverified: Number(env.CARE_CAP_SESSION ?? 0.15),
  ipDayUnverified: Number(env.CARE_CAP_IP_DAY ?? 0.6),
  // HQ's own drafts' share of the month (HQ_APP), over the plug-in's hqMonth (ledger.ts)
  hqMonth: env.CARE_CAP_HQ_MONTH ? Number(env.CARE_CAP_HQ_MONTH) : null,
  // the phone's own month (phone.ts), over the plug-in's phoneMonth
  phoneMonth: env.CARE_CAP_PHONE_MONTH ? Number(env.CARE_CAP_PHONE_MONTH) : null,
  calls: 60,                                       // model calls per conversation a day, then the helper offers email
};
// a claim photo's body still coming after this is dropped, and its room freed (photos.ts admit()): 3 MB on a slow phone
// line takes about a minute; the tests shorten it
export const UPLOAD_MS = Number(env.CARE_UPLOAD_MS ?? 60_000);
export const EUR_PER_USD = Number(env.CARE_EUR_PER_USD ?? 0.86);
// ---- the provider's prepaid credit, for an account with no auto-recharge (ledger.ts credit()), in dollars: what it
// held at a time (what was loaded, or the console's balance then), and the monthly spend limits of other keys drawing on
// it (an eval workspace's), counted as spent in full each month. Without CARE_CREDIT_USD nothing is watched.
// A plan's monthly API credit on the same account (Anthropic's for Max and Team plans). It is spent before the prepaid
// one and gone at the end of each billing cycle. CARE_CREDIT_MONTHLY_USD is its dollars. CARE_CREDIT_MONTHLY_FROM is the
// start of the first cycle it came in (a date, or with a UTC time). The cycle renews on that day each month (the
// month's last day in a shorter one).
const MONTHLY_CREDIT = env.CARE_CREDIT_MONTHLY_USD
  ? { usd: Number(env.CARE_CREDIT_MONTHLY_USD), from: Date.parse(env.CARE_CREDIT_MONTHLY_FROM ?? '') }
  : null;
export const CREDIT = env.CARE_CREDIT_USD
  ? {
      usd: Number(env.CARE_CREDIT_USD),
      at: Date.parse(env.CARE_CREDIT_AT ?? ''),
      othersMonthUsd: Number(env.CARE_CREDIT_OTHERS_USD ?? 0),
      monthly: MONTHLY_CREDIT,
    }
  : null;
if (CREDIT) {
  const numbers = [CREDIT.usd, CREDIT.at, CREDIT.othersMonthUsd, MONTHLY_CREDIT?.usd ?? 0, MONTHLY_CREDIT?.from ?? 0];
  if (!numbers.every(Number.isFinite)) {
    throw new Error(
      'CARE_CREDIT_USD needs a number, CARE_CREDIT_AT a date, CARE_CREDIT_OTHERS_USD a number or nothing, ' +
        'CARE_CREDIT_MONTHLY_USD a number or nothing and CARE_CREDIT_MONTHLY_FROM a date with it',
    );
  }
}

// ---- the phone (phone.ts): the voice line's routes on a port of their own, opened
// only with a token (the voice container's, infra/sync.sh), and the shop the phone answers for: CARE_PHONE_SHOP, else the
// first shop of CARE_SHOPS that isn't a preview's (a company's front), else its only app
export const PHONE = {
  port: Number(env.CARE_PHONE_PORT ?? 8081),
  token: env.CARE_PHONE_TOKEN ?? '',
  shop: env.CARE_PHONE_SHOP || Object.keys(SHOPS).find(s => !s.endsWith('@preview')) || (Object.keys(APPS).length === 1 ? Object.keys(APPS)[0] : ''),
};

// set by the tests and the local harness: plain http on localhost (the cookie's Secure flag stays on in production)
export const LOCAL = env.CARE_LOCAL === '1';
