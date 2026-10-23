// Email out: the one door the platform sends an email through, one address for one send (a gated tool's email to a
// customer; a guest's code: guests.ts), or a few with copies for the board's business mail (outbox.ts). The addresses are
// the caller's for that send: they're never stored or logged here (a failed send's answer is kept with any address masked).
//
// The company picks its email service (the board's to decide: the provider and its price) and names it in
// company/infra.env (EMAIL_SERVICE; Lettermint is the one built in). Until it's named and its key is in, test mode sends
// nothing: the rendered email comes back to the caller instead (`test`), so a flow can be tried end to end. Live mode
// refuses (503), so nothing is made that can't reach its reader. Another service is one entry in `services` below.
// Setting it up (the account, the DNS records, the key): platform/care/docs/email.md.
//
// An email the service took can still not reach its reader (a bounce, an address it suppresses, its own spam filter).
// Lettermint says so on its webhook, the same one as its leaves (readNotice below; its events NOT_DELIVERED): the send's
// `about` names which email in HQ's log, NEEDS A PERSON, and the failure is kept with the others.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { db, redacted } from './db.ts';
import { address, redact, secret } from './secrets.ts';
import { ZONE as zone } from './config.ts';
import { companyDay, infra, mailDomains, names, roles } from './company.ts';
import { publish } from './events.ts';

// A send that didn't go, kept with the service's answer, so why can be read after a deploy has taken the log with it
// (infra/report.sh shows the last week's). Kept FAILURE_KEEP_DAYS.
const FAILURE_KEEP_DAYS = 30;
const keepSince = () => new Date(Date.now() - FAILURE_KEEP_DAYS * 86400e3).toISOString();
db.exec('create table if not exists mail_failures (id integer primary key, ts text not null, status integer not null, answer text not null)');
redacted('mail_failures', 'answer');
// The emails the service took, by its own id for each, with the send's `about` and the delivery failure already told
// (failed: its event), so the webhook names the email and tells it once. Kept FAILURE_KEEP_DAYS.
db.exec('create table if not exists mail_sent (id text primary key, ts text not null, about text, failed text)');
redacted('mail_sent', 'about');

// attachments: files to send with it (photos, say). to: one address, or several (with cc: the business mail the board sends
// from HQ, outbox.ts); from: one of our own addresses (ours()), hello@ if none;
// html: an HTML part beside the text, for a machine that reads one (a review platform's trigger email); messageId: the
// email's own Message-ID, so an answer threaded to it can be told apart (outbox.ts); route: the service's route it goes
// out on (a list's, apart from order and support mail), else the service's default; headers: more of the email's own
// (a list's List-Unsubscribe, say).
// name: the sender's name the email shows (a person's, for a letter the board signs: outbox.ts), else the company's.
// about: which email this is, as HQ's log names it if it never reaches its reader ("the basket email for cs_…"), never an
// address.
// (messageId)
export type Mail = { to: string | string[]; cc?: string[]; from?: string; name?: string; subject: string; text: string; html?: string; replyTo?: string;
  attachments?: { filename: string; content: Buffer; type: string }[]; messageId?: string; route?: string; headers?: Record<string, string>; about?: string };
// scope 'recipient': the service refused the address it was given, not the email (a list email skips that address).
export class MailError extends Error {
  status: number; scope?: 'recipient';
  constructor(status: number, message: string, scope?: 'recipient') { super(message); this.status = status; this.scope = scope; }
}

// The emails the service took or may have taken, per day on the company's clock: one per recipient, copies included, as its plan counts
// them. A count only, never an address or a subject (house rule 7). The watch adds them up (mailplan.ts).
db.exec('create table if not exists mailout_days (day text primary key, emails integer not null)');

const KEY = 'CARE_EMAIL_API_KEY';
// name → send(key, mail), answering the service's id for the email; throws on anything but the service's yes: a MailError
// of 504 when it may have gone (no answer, a timeout, the service's own error), any other when it surely didn't. The
// company names its service in company/infra.env (EMAIL_SERVICE); the environment's CARE_EMAIL_SERVICE overrides it (tests).
const services: Record<string, { send: (key: string, m: Mail) => Promise<string>; maxBytes: number }> = {
  lettermint: { send: lettermint, maxBytes: 25_000_000 },
};
const serviceName = () => process.env.CARE_EMAIL_SERVICE || infra().EMAIL_SERVICE || '';
const service = () => services[serviceName()]?.send;
// The most one email may be at each service, its attachments in base64 included (Lettermint: 25 MB).
export const maxBytes = () => services[serviceName()].maxBytes;

export const ready = (mode: 'test' | 'live') => mode === 'test' || (!!service() && !!secret(KEY));
// (test mode without a key renders the email too: a local run with the service named sends nothing)
const live = () => !!service() && !!secret(KEY);
// whether a send in this mode only renders the email back (test mode without the service).
export const renders = (mode: 'test' | 'live') => mode === 'test' && !live();

// Our mail domains (company.ts mailDomains), HQ's zone without any. Mail goes out from the first, the public one, and
// comes in at all of them.
export const domains = () => { const d = mailDomains(); return d.length ? d : zone ? [zone] : []; };
export { address } from './secrets.ts';
// A sender is ours (an address at the domain we send from), never one a caller made up.
export const ours = (v: unknown) => { const a = address(v), at = domains()[0]; return a && at && a.toLowerCase().endsWith(`@${at}`) ? a : null; };
// Mail domains anyone can have an address at (a mail service's, a provider's), where "the same domain" says nothing of
// who someone is: the big services under any country's ending (gmail.com, hotmail.nl, yahoo.co.uk) and the rest by name
const SHARED = new Set(['me.com', 'mac.com', 'pm.me', 'hey.com', 'fastmail.com', 'fastmail.fm', 'tuta.io', 'mail.ru', 'qq.com', '163.com', '126.com',
  'naver.com', 'web.de', 't-online.de', 'freenet.de', 'orange.fr', 'free.fr', 'wanadoo.fr', 'laposte.net', 'sfr.fr', 'libero.it', 'btinternet.com',
  'sky.com', 'virginmedia.com', 'comcast.net', 'att.net', 'verizon.net', 'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'home.nl', 'xs4all.nl',
  'hetnet.nl', 'casema.nl', 'chello.nl', 'upcmail.nl', 'zeelandnet.nl', 'telfort.nl', 'tele2.nl', 'online.nl', 'quicknet.nl', 'caiway.nl', 'skynet.be',
  'telenet.be', 'proximus.be']);
const SHARED_BRAND = /^(gmail|googlemail|hotmail|outlook|live|msn|windowslive|yahoo|ymail|rocketmail|aol|icloud|gmx|proton|protonmail|zoho|yandex|mail|email|inbox|tutanota|tutamail)\.[a-z]{2,3}(\.[a-z]{2})?$/;
export const sharedDomain = (domain: string) => SHARED.has(domain) || SHARED_BRAND.test(domain);
// Where a reply goes when a send names no case's address: hello@, the mailbox people read (mail.ts), never the sender's.
export const hello = () => domains()[0] ? `hello@${domains()[0]}` : undefined;

// id: the service's own id for the email it took (a receipt to keep, never proof it arrived).
export function send(mode: 'live', m: Mail): Promise<{ id: string }>;
export function send(mode: 'test' | 'live', m: Mail): Promise<{ test?: Omit<Mail, 'to' | 'attachments'> & { attachments?: string[] }; id?: string }>;
export async function send(mode: 'test' | 'live', m: Mail) {
  // A send refused before it reaches the service is kept too, like the service's own refusals. The addresses go out as
  // address() reads them.
  const refuse = (e: MailError) => { recordFailure(e); return e; };
  const to = [m.to].flat().map(address), cc = (m.cc ?? []).map(address), all = [...to, ...cc];
  if (!to.length || !all.every(a => a)) throw refuse(new MailError(400, 'email: an email address', 'recipient'));
  m = { ...m, to: to as string[], ...(m.cc ? { cc: cc as string[] } : {}) };
  if (m.from !== undefined && !ours(m.from)) throw refuse(new MailError(400, 'from: one of our own addresses'));
  if (Object.entries(m.headers ?? {}).some(([name, value]) => !/^[!-9;-~]{1,76}$/.test(name) || /[\r\n]/.test(value)))
    throw refuse(new MailError(400, 'headers: a printable name without a colon, and a value on one line'));
  if (mode === 'test' && !live()) return { test: { subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments.map(a => a.filename) } : {}) } };   // (attachments: their names)
  const send = service(), key = secret(KEY);
  if (!send || !key) throw refuse(new MailError(503, 'no email service on the server yet'));
  let id: string;
  try { id = await send(key, m); } catch (e) {
    const err = e instanceof MailError ? e : new MailError(502, `the email service did not take the email (the caller may retry): ${clean(String((e as Error)?.message ?? e)).slice(0, 200)}`);
    if (err.status === 504) count(all.length);
    recordFailure(err);
    throw err;
  }
  count(all.length);
  db.prepare('insert or ignore into mail_sent (id, ts, about) values (?, ?, ?)').run(id, new Date().toISOString(), m.about ? clean(m.about).slice(0, 200) : null);
  db.prepare('delete from mail_sent where ts < ?').run(keepSince());
  return { id };
}

const recordFailure = (e: MailError) => keepFailure(e.status, `${e.scope ? `${e.scope}: ` : ''}${e.message}`);
function keepFailure(status: number, answer: string) {
  answer = answer.slice(0, 300);
  console.error(`email: a send failed (${status}): ${answer}`);
  db.prepare('insert into mail_failures (ts, status, answer) values (?, ?, ?)').run(new Date().toISOString(), status, answer);
  db.prepare('delete from mail_failures where ts < ?').run(keepSince());
}

// ---- the service's word on an email it took
// Lettermint's events (https://lettermint.co/docs/platform/webhooks/events, read 2026-10-13) for an email that won't
// reach its reader, each as HQ's log says it. A soft bounce isn't one: Lettermint tries again, and says failed if it gives up.
const NOT_DELIVERED: Record<string, string> = {
  'message.hard_bounced': 'bounced it: the address takes no mail',
  'message.failed': "couldn't deliver it",
  'message.suppressed': 'skipped it: the address is on its suppression list',
  'message.policy_rejected': 'held it back as spam (its own filter, before sending)',
};
// Once an email: kept with the failures, and HQ's log names it (the send's about) for a person
function notDelivered({ id, event, outcome, status, why }: Undelivered) {
  const unrecorded = db.prepare('insert or ignore into mail_sent (id, ts) values (?, ?)').run(id, new Date().toISOString()).changes === 1;
  if (db.prepare('update mail_sent set failed = ? where id = ? and failed is null').run(event, id).changes === 0) return;
  const sent = db.prepare('select ts, about from mail_sent where id = ?').get(id) as { ts: string; about: string | null };
  // The service's project also carries the support chat's emails (platform/care/src/email.ts), which HQ never labels
  const about = sent.about ?? (unrecorded ? "an email HQ can't name (the support chat's, or an older one)" : `an email HQ sent at ${sent.ts.slice(0, 16)} UTC`);
  why = clean(why).slice(0, 160);
  keepFailure(status, `delivery: ${event} (${about})${why ? `: ${why}` : ''}`);
  publish({ type: 'log', agent: roles().process, text: `Email: NEEDS A PERSON: ${about} didn't reach its reader: the email service ${outcome}${why ? ` (${why})` : ''}.` });
}

// The service's own words, before any cut to length: an address echoed in them is masked (never kept or logged), and so
// is a key (a cut key would no longer match).
const clean = (text: string) => redact(text.replace(/[^\s@<>"(),;:]+@[^\s@<>"(),;:]+/g, '[address]'));

// Adds the emails the service took or may have taken to today's count
const count = (emails: number) => db.prepare('insert into mailout_days (day, emails) values (?, ?) on conflict (day) do update set emails = emails + excluded.emails')
  .run(companyDay(Date.now()), emails);
// The emails the service took or may have taken in a month (YYYY-MM), on the company's clock
export const emailsIn = (month: string) => (db.prepare("select coalesce(sum(emails), 0) n from mailout_days where day like ? || '-%'").get(month) as { n: number }).n;

// Lettermint's sending API (POST /v1/send, the x-lettermint-token header; its fields as https://lettermint.co/docs/api-reference/sending/send
// names them, read 2026-10-12: `route` the route's id, `headers` custom headers): plain text (with the caller's HTML part, if
// any), from the company's hello@ or the address the caller named (replies go to replyTo when there is one), opens and clicks never tracked. EMAIL_API points it
// elsewhere (tests).
async function lettermint(key: string, m: Mail): Promise<string> {
  const api = (process.env.EMAIL_API ?? 'https://api.lettermint.co/v1').replace(/\/+$/, ''), from = m.from ?? hello();
  if (!from) throw new MailError(503, 'no mail domain to send from');
  let res: Response;
  try {
    // (a minute with attachments: they may be many MB to upload)
    res = await fetch(`${api}/send`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(m.attachments?.length ? 60_000 : 15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-lettermint-token': key },
      body: JSON.stringify({ from: `${shownName(m.name ?? names().name)} <${from}>`, to: [m.to].flat(), subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}),
        ...(m.cc?.length ? { cc: m.cc } : {}), ...(m.replyTo ? { reply_to: [m.replyTo] } : {}), settings: { track_opens: false, track_clicks: false },
        ...(m.route ? { route: m.route } : {}),
        // (Lettermint keeps a Message-ID it's given only with X-LM-Preserve-Message-ID)
        ...(m.messageId || m.headers ? { headers: { ...m.headers, ...(m.messageId ? { 'Message-ID': m.messageId, 'X-LM-Preserve-Message-ID': 'true' } : {}) } } : {}),
        // attachments, base64 (Lettermint takes 25 MB a message, base64 included)
        ...(m.attachments?.length ? { attachments: m.attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.type })) } : {}) }) });
  } catch (e: any) {
    throw new MailError(504, `no answer from the email service (${String(e?.cause?.code ?? e?.name ?? 'error').slice(0, 60)}): it may have gone`);
  }
  const answer: any = (await res.json().catch(() => null)) ?? {};
  if (res.ok && typeof answer.message_id === 'string') return answer.message_id;
  if (res.ok || res.status >= 500) throw new MailError(504, `the email service answered ${res.status}: it may have gone`);
  // A 422's body is { message, errors: { field: [...] } }, and an array item's field reads to.0 (Lettermint's SDKs).
  // Only to and cc is the address's own refusal. Any other key, or none, keeps it the email's refusal, never an
  // address's. A daily limit's 422 has an error code and a message, and no field.
  // A suppressed address isn't refused here: Lettermint takes it and reports it as the delivery's outcome.
  const fields = res.status === 422 && answer.errors && typeof answer.errors === 'object' ? Object.keys(answer.errors) : [];
  const scope = fields.length && fields.every(f => /^(to|cc)(\.\d+)?$/.test(f)) ? 'recipient' as const : undefined;
  // (its code too, and a 422's fields)
  const code = [answer.error?.code, typeof answer.error === 'string' ? answer.error : undefined, ...fields].filter(c => typeof c === 'string' && c).map(clean).join(', ').slice(0, 100);
  throw new MailError(502, `the email service refused it (${res.status}${code ? ` ${code}` : ''}: ${clean(String(answer.error?.message ?? answer.message ?? res.statusText)).slice(0, 200)})`, scope);
}
// The sender's name as the From line shows it: letters, digits, spaces and . , & ' - only, quoted when it holds a comma
// or a full stop ("Ada Board, Testco").
function shownName(name: string) {
  const plain = name.replace(/[^\p{L}\p{N} .,&'-]/gu, '').trim();
  return /[.,]/.test(plain) ? `"${plain}"` : plain;
}

// ---- the service's notices: an address that left a list through the service's own leave link, or an email it took and
// couldn't deliver (above)
// A service that adds a leave link of its own to a list's email (Lettermint's hosted unsubscribe, on a broadcast route)
// tells us through its webhook, signed with the webhook's secret (EMAIL_WEBHOOK_SECRET, a server key), so the list can
// take the address off as its own leave link does (listmail.ts).
const WEBHOOK_KEY = 'EMAIL_WEBHOOK_SECRET';
// address: as address() reads it; at: when it left, an ISO time
export type Left = { address: string; at: string };
// An email the service took and won't deliver: its id for it (send's answer), its event and how HQ's log says it, the
// receiving server's status (0 if none) and the service's reason.
type Undelivered = { id: string; event: string; outcome: string; status: number; why: string };
// name → read(secret, headers, raw body): the addresses one notice says left (none for any other notice) and the email
// it says won't arrive, if it's that notice; or the status to answer one that isn't the service's (401) or can't be read (400)
type Notice = { left: Left[]; undelivered?: Undelivered };
const notices: Record<string, (key: string, headers: IncomingHttpHeaders, body: Buffer) => Notice | number> = {
  lettermint: lettermintNotice,
};
// Whether the leaves from the service's own link reach us: a service with notices needs its webhook's secret first
export const hearsLeaves = () => !notices[serviceName()] || !!secret(WEBHOOK_KEY);
// One notice from the service (a webhook's POST, its raw body): 503 until its secret is in, so the service tries again
export function readNotice(headers: IncomingHttpHeaders, body: Buffer): Left[] | number {
  const read = notices[serviceName()],
    key = secret(WEBHOOK_KEY);
  if (!read) return 404;
  if (!key) return 503;
  const notice = read(key, headers, body);
  if (typeof notice === 'number') return notice;
  if (notice.undelivered) notDelivered(notice.undelivered);
  return notice.left;
}

// Lettermint's webhook (https://lettermint.co/docs/platform/webhooks/signing and /events, read 2026-10-13):
// X-Lettermint-Signature `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with the secret as it is (whsec_…),
// X-Lettermint-Delivery the same t, at most 300 seconds off. `message.unsubscribed` (data.recipient, unsubscribed_at) is
// its hosted leave link or a one-click; `suppression.added` with reason unsubscribe or spam_complaint (data.value, the
// envelope's timestamp) is the same leave or a complaint, which Lettermint keeps on the route that sent it. Hard bounces
// and the board's manual blocks aren't a reader leaving. NOT_DELIVERED's events (data.message_id; data.reason, or the
// receiving server's data.response) are an email that won't arrive.
const TOLERANCE_S = 300;
function lettermintNotice(key: string, headers: IncomingHttpHeaders, body: Buffer): Notice | number {
  const signature = String(headers['x-lettermint-signature'] ?? '');
  const signed = signature.match(/(?:^|,)\s*t=(\d{1,12})\s*(?=,|$)/)?.[1];
  const offered = [...signature.matchAll(/(?:^|,)\s*v1=([0-9a-f]{64})\s*(?=,|$)/g)].map(m => Buffer.from(m[1], 'hex'));
  if (!signed || String(headers['x-lettermint-delivery'] ?? '') !== signed) return 401;
  if (Math.abs(Date.now() / 1000 - Number(signed)) > TOLERANCE_S) return 401;
  const expected = createHmac('sha256', key).update(`${signed}.`).update(body).digest();
  if (!offered.some(v1 => timingSafeEqual(v1, expected))) return 401;
  let notice: any;
  try {
    notice = JSON.parse(body.toString('utf8'));
  } catch {
    return 400;
  }
  const facts = notice?.data ?? {};
  const outcome = NOT_DELIVERED[notice?.event];
  if (outcome && typeof facts.message_id === 'string')
    return {
      left: [],
      undelivered: {
        id: facts.message_id.slice(0, 100),
        event: notice.event,
        outcome,
        status: Number(facts.response?.status_code) || 0,
        why: String(facts.reason ?? facts.response?.content ?? ''),
      },
    };
  const unsubscribed = notice?.event === 'message.unsubscribed';
  const suppressed =
    notice?.event === 'suppression.added' &&
    facts.type === 'email' &&
    ['unsubscribe', 'spam_complaint'].includes(facts.reason);
  const left = address(unsubscribed ? facts.recipient : suppressed ? facts.value : null);
  if (!left) return { left: [] };
  const at = new Date(unsubscribed ? (facts.unsubscribed_at ?? notice.timestamp) : notice.timestamp);
  return { left: [{ address: left, at: (isNaN(at.getTime()) ? new Date() : at).toISOString() }] };
}
