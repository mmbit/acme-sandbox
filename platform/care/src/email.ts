// Sends the care service's email (sign-in codes and links, the helper's answers, chat copies, the board's replies) through
// Lettermint's sending API. With no key, a local run (the harness, the tests) keeps the message in `outbox` instead;
// anywhere else a send without a key fails, so nobody is told a code or a copy is on its way when nothing went.
// The provider and why, its DNS records and the board's steps: platform/care/docs/email.md.
import { settings } from './company.ts';
import * as numbers from './numbers.ts';

// The key is the server's own (never a job's): the board pastes it on the desk phone.
const KEY = process.env.CARE_EMAIL_API_KEY ?? '';
const API = (process.env.CARE_EMAIL_API ?? 'https://api.lettermint.co/v1').replace(/\/+$/, '');
// the sender is the company's (its plug-in's `sender`, company.ts): 'Name <someone@its.domain>'; the domain is its own
const from = () => settings.sender;
export const domain = () => from().replace(/^.*@/, '').replace(/>$/, '').toLowerCase();
const TIMEOUT_MS = 15_000;
const OUTBOX_MAX = 100;
const LOCAL = process.env.CARE_LOCAL === '1';

export type Kind = string; // the message's tag at the email service: 'code', 'link', 'answer', 'copy', or a company tool's own
// app: the app it's about, whose day counts it once the email service has it (Care › Numbers' `emails`). aiGenerated: the
// model wrote some of the text, so the message carries the AI mark (AI_HEADERS).
export type Email = { to: string, subject: string, text: string, kind: Kind, app: string, aiGenerated?: boolean, replyTo?: string, from?: string };
export type Sent = { ok: true, id: string } | { ok: false, error: string, refused?: true }; // refused: this message can never go, trying again won't help

// The machine-readable mark on an email the model wrote (AI Act art. 50(2)). No mail standard names one. This is the
// field the IETF's AI-Disclosure draft (draft-abaris-aicdh) defines for HTTP, in its syntax: a reader that knows the field
// knows the mail. `machine-generated` is its value for what no person reviewed before it went.
const AI_HEADERS = { 'AI-Disclosure': 'mode=machine-generated' };

// what would have gone on a local run without a key, newest last (the harness's log shows it; tests read it)
export const outbox: (Email & { from: string, at: string, headers?: Record<string, string> })[] = [];
// whether a send can work: false on the server until the board has entered the key, and then send_code says so rather
// than tell the customer a code is on its way
export const sending = KEY !== '' || LOCAL;
// a local run's outbox can play the email service being down or slow (the tests): while `down`, every send fails; each
// send takes `slow` ms
export const local = { down: false, slow: 0 };

// one plain address, nothing a header could be built from (no name part, comma, angle bracket or line break)
const ADDRESS = /^[^\s@<>,;:"()\[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// the sender is always the company's: 'Name <someone@its.domain>' or the bare address
const sender = () => new RegExp(`^(?:[^<>"\\r\\n]{1,60} <)?[a-z0-9._+-]+@${domain().replace(/\./g, '\\.')}>?$`, 'i');

// a•••@example.com: enough to tell two log lines apart, not enough to know who
export const mask = (address: string) => `${address.slice(0, 1)}•••${address.slice(address.indexOf('@'))}`;

function refusal(m: Email & { from: string }) {
  if (!ADDRESS.test(m.to)) return 'to: one plain email address, like anna@example.com';
  if (m.replyTo !== undefined && !ADDRESS.test(m.replyTo)) return 'replyTo: one plain email address';
  if (!sender().test(m.from) || (m.from.includes('<') !== m.from.endsWith('>'))) return `from: an address at ${domain()}, like ${from()}`;
  if (!m.subject.trim() || /[\r\n]/.test(m.subject) || m.subject.length > 200) return 'subject: one line, at most 200 characters';
  if (m.text.trim().length < 3) return 'text: the message is empty';
  return null;
}

export async function send(email: Email): Promise<Sent> {
  const m = { ...email, from: email.from ?? from() };
  const headers = m.aiGenerated ? AI_HEADERS : undefined;
  const refused = refusal(m);
  if (refused) return { ok: false, error: refused, refused: true };

  if (!KEY && !LOCAL) {
    console.error(`email: a ${m.kind} for ${mask(m.to)} not sent: no CARE_EMAIL_API_KEY`);
    return { ok: false, error: 'no CARE_EMAIL_API_KEY: nothing sent' };
  }
  if (!KEY) {
    if (local.slow) await new Promise(r => setTimeout(r, local.slow));
    if (local.down) return { ok: false, error: 'the outbox is playing the email service down (a local run)' };
    outbox.push({ ...m, ...(headers ? { headers } : {}), at: new Date().toISOString() });
    if (outbox.length > OUTBOX_MAX) outbox.shift();
    // a local run only (the harness, never the server): the subject is shown too, so a tester can read the code in it
    console.log(`email: kept a ${m.kind} for ${mask(m.to)} (no CARE_EMAIL_API_KEY, not sent): ${m.subject}`);
    return { ok: true, id: `outbox-${Date.now()}-${outbox.length}` };
  }

  // Plain text only, and tracking off on every message as well as in the dashboard: a plain-text mail can't carry a
  // pixel and Lettermint doesn't rewrite its links, but the flags keep it that way if a route is ever switched on.
  const body = {
    from: m.from, to: [m.to], subject: m.subject, text: m.text, tag: m.kind,
    ...(m.replyTo ? { reply_to: [m.replyTo] } : {}),
    ...(headers ? { headers } : {}),
    settings: { track_opens: false, track_clicks: false },
  };
  let res: Response;
  try {
    res = await fetch(`${API}/send`, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-lettermint-token': KEY },
    });
  } catch (err: any) {
    return { ok: false, error: `could not reach the email service (${err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? err})` };
  }
  const answer: any = await res.json().catch(() => ({}));
  if (res.ok && typeof answer.message_id === 'string') {
    // only what the email service took counts toward its plan's monthly limit
    numbers.count(m.app, 'emails');
    return { ok: true, id: answer.message_id };
  }
  // 422 { message, errors }, others { error: { code, message } } (Lettermint's API reference). The error is logged, so it
  // carries the status and the provider's code (a 422's: the fields it refused) only, never its message: that can echo the
  // recipient
  const code = (res.status === 422 && answer.errors && typeof answer.errors === 'object' ? Object.keys(answer.errors) : [answer.error?.code])
    .filter(c => typeof c === 'string' && /^[\w.-]{1,40}$/.test(c)).slice(0, 5).join(', ');
  return { ok: false, error: `the email service said ${res.status}${code ? ` (${code})` : ''}`, ...(res.status === 422 ? { refused: true as const } : {}) }; // 422: the message itself was refused
}
