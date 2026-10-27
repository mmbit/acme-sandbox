// The status report's "== stripe, live" section (infra/report.sh), run by the coordinator container's node from stdin:
// the live account as the live key reads it, HQ's latest live payments, and how far each of the latest unpaid live
// checkouts got at Stripe. Types, codes, counts and minutes only, never an id, name, email or address (charter rule 7):
// every word taken from Stripe passes a list of its values or `code` below. platform/coordinator's
// src/stripe-live-report.test.ts runs it against a stand-in Stripe.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const api = process.env.STRIPE_API ?? 'https://api.stripe.com';
let key = '';
try {
  key = readFileSync((process.env.SECRETS_DIR ?? '/data/secrets') + '/STRIPE_LIVE_RESTRICTED_KEY', 'utf8').trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error; /* no key saved: reported below */
}
const live = /^(rk|sk)_live_/.test(key);
const day = t => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);
const due = r =>
  r && {
    currently_due: r.currently_due,
    past_due: r.past_due,
    eventually_due: r.eventually_due,
    pending_verification: r.pending_verification,
    disabled_reason: r.disabled_reason,
    current_deadline: day(r.current_deadline),
    errors: (r.errors ?? []).map(e => e.requirement + ': ' + e.code),
  };
if (!live) console.log('no live key saved');
else {
  const r = await fetch(api + '/v1/account', {
    headers: { authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const a = r && (await r.json().catch(() => ({})));
  if (!r) console.log('Stripe: no answer');
  else if (!r.ok)
    console.log(
      'Stripe ' +
        r.status +
        ': ' +
        String(a?.error?.message ?? '')
          .replace(/[rs]k_(live|test)_\S+/g, '[key]')
          .slice(0, 300),
    );
  else
    console.log(
      JSON.stringify(
        {
          checked: new Date().toISOString(),
          charges_enabled: a.charges_enabled,
          payouts_enabled: a.payouts_enabled,
          details_submitted: a.details_submitted,
          capabilities: a.capabilities,
          requirements: due(a.requirements),
          future_requirements: due(a.future_requirements),
        },
        null,
        1,
      ),
    );
}
const db = new DatabaseSync((process.env.DATA_DIR ?? '/data') + '/hq.db', { timeout: 5000, readOnly: true });
console.table(
  db
    .prepare(
      "select product, substr(created,1,16) created, amount, currency, status, refund_status, substr(updated,1,16) updated from payments where mode = 'live' order by created desc limit 15",
    )
    .all(),
);

// ---- how far the latest unpaid live checkouts got: one read of each at Stripe, its payment intent with its method and
// its latest charge. HQ sends no Stripe-Version, so the account's own API version answers (printed from Stripe's
// header). From API version 2022-08-01 a Checkout Session's payment intent is made only when the buyer first submits
// the page, so an unpaid session without one was never tried. On an older version the intent comes with the session;
// then one without a method, an error or a charge wasn't tried either, which is what "tried" reads.
const UNPAID = 8;
const rows = db
  .prepare(
    `select p.id, substr(p.created, 1, 16) created, p.amount, p.country, coalesce((select group_concat(product, ' ')
  from (select distinct l.product from session_lines sl join pay_lines l on l.id = sl.line where sl.session = p.id order by l.product)), p.product) stalls
  from payments p where p.mode = 'live' and p.status in ('expired', 'cancelled', 'open') and p.id like 'cs\\_live\\_%' escape '\\'
  and p.id not like 'cs\\_live\\_vouchers\\_%' escape '\\' order by p.created desc limit ?`,
  )
  .all(UNPAID);
// A word of Stripe's as it may be printed: a lowercase code (a method type, an error or decline code), never an object's
// id (prefix_ and a long run of letters and digits), a name or an address; else '?'
const code = word =>
  typeof word === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(word) && !/^[a-z]{2,6}_[a-z0-9]{10,}$/.test(word)
    ? word
    : word == null
      ? '-'
      : '?';
// (a field Stripe sends as null is '-', one missing from its answer '?')
const oneOf = (values, word) => (values.includes(word) ? word : word === null ? '-' : '?');
const SESSION = ['open', 'complete', 'expired'],
  PAYMENT = ['paid', 'unpaid', 'no_payment_required'];
const INTENT = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
];
const CANCELLED = [
  'abandoned',
  'automatic',
  'duplicate',
  'expired',
  'failed_invoice',
  'fraudulent',
  'requested_by_customer',
  'void_invoice',
];
const LOCALE = /^(auto|[a-z]{2}(-[A-Z0-9]{2,4})?)$/,
  COUNTRY = /^[A-Z]{2}$/,
  SLUGS = /^[a-z0-9][a-z0-9 -]{0,200}$/;
const minutes = (from, to) =>
  Number.isFinite(from) && Number.isFinite(to) ? String(Math.round((to - from) / 60)) : '-';
const object = value => (value && typeof value === 'object' ? value : null);
// What HQ named for a session, from its metadata: its words, or on an older
// session the hash of what it left out
const namedBy = meta =>
  typeof meta?.named === 'string'
    ? meta.named.split(' ').map(code).join(' ')
    : /^[0-9a-f]{12}$/.test(meta?.methods ?? '')
      ? '#' + meta.methods
      : '-';
async function readCheckout(row) {
  const expansions = new URLSearchParams([
    ['expand[]', 'payment_intent.payment_method'],
    ['expand[]', 'payment_intent.latest_charge'],
  ]);
  const response = await fetch(`${api}/v1/checkout/sessions/${encodeURIComponent(row.id)}?${expansions}`, {
    headers: { authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const session = response && (await response.json().catch(() => null));
  const shown = [row.created, SLUGS.test(row.stalls ?? '') ? row.stalls : '?', (row.amount / 100).toFixed(2)];
  if (!response) return { version: null, cells: [...shown, 'Stripe: no answer'] };
  const version = response.headers.get('stripe-version');
  if (!response.ok || !object(session))
    return {
      version,
      cells: [...shown, `Stripe ${response.status}: ${code(session?.error?.code ?? session?.error?.type)}`],
    };
  const intent = object(session.payment_intent),
    charge = object(intent?.latest_charge),
    error = object(intent?.last_payment_error);
  const method = object(intent?.payment_method),
    failed = object(error?.payment_method);
  const tried = method?.type ?? failed?.type ?? object(charge?.payment_method_details)?.type;
  const why =
    [error?.code ?? charge?.failure_code, error?.decline_code]
      .filter(word => word != null)
      .map(code)
      .join('/') || '-';
  const triedAt = charge?.created ?? (method || failed ? intent.created : undefined);
  return {
    version,
    cells: [
      ...shown,
      `${oneOf(SESSION, session.status)}/${oneOf(PAYMENT, session.payment_status)}`,
      COUNTRY.test(row.country ?? '') ? row.country : '-',
      LOCALE.test(session.locale ?? '') ? session.locale : session.locale === null ? '-' : '?',
      (Array.isArray(session.payment_method_types) ? session.payment_method_types : []).map(code).join(' ') || '-',
      namedBy(object(session.metadata)),
      code(tried),
      intent ? oneOf(INTENT, intent.status) : session.payment_intent === null ? '-' : '?',
      intent ? oneOf(CANCELLED, intent.cancellation_reason) : '-',
      why,
      minutes(session.created, triedAt),
      minutes(session.created, session.expires_at),
    ],
  };
}
console.log();
if (!rows.length) console.log('No unpaid live checkouts.');
else if (!live) console.log(`${rows.length} unpaid live checkouts, not read: no live key saved.`);
else {
  const read = await Promise.all(rows.map(readCheckout));
  const version = read.map(one => one.version).find(v => /^[0-9a-z.-]{1,40}$/.test(v ?? ''));
  console.log(
    `How far the latest ${rows.length} unpaid live checkouts got (Stripe API version ${version ?? 'not given'}; minutes from the page opening):`,
  );
  console.log(
    '| created (UTC) | stalls | € | Stripe | country | locale | offered | named | tried | intent | cancelled | error | tried after | open for |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { cells } of read) console.log('| ' + cells.join(' | ') + ' |');
  console.log(
    'named: the methods HQ named, the rest left out (an older session: # and a hash of what it left out); tried: the method a payment was tried with (-: none); intent -: Stripe made none, nobody submitted the page.',
  );
}
