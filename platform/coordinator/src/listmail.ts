// List emails: a product's own email to
// one address on its own list (a sign-up's confirmation, a letter, the news someone asked for), in the product's own
// words, with a way to leave in every one.
//
//   POST /api/list/email {kind, lang, to, slots, leave}
//     → {status: 'sent'}, or in test mode without the email service {status: 'test', test_email: {subject, text, html}}
//   A refusal → {error}, with its status. 422 refuses this address alone, HQ's check or the email service's (the caller
//   skips it), and every other refusal holds for any address. 504 is no refusal: the email service gave no answer, so
//   the email may have gone.
// Same headers and token as /api/pay (payments.ts caller).
//
// - The words are the product's, reviewable in the repo: products/<slug>/care/list-emails.yaml, the kind as the key,
//   then the language, each with a subject and a body. Its `footer:` (a text per language, with {leave}) closes every
//   email.
// - A company's own kinds (`kinds` below) are <prefix>:<id>. Each takes its words from where it keeps them and sends
//   only when it says so: a letter only after the board's yes on its own card, say.
// - Slots: `link`, an https URL on the product's own address or on a public product's; and what a company's own module
//   adds to `slots`. A slot the words use must be there, and a {word} that isn't a slot is refused rather than mailed.
// - The words carry mailpage.ts's little markup (headings, lists, small print), and the footer is the small print.
// - leave: the address's own leave link, on the product's own address. It fills the footer's {leave} and the
//   List-Unsubscribe headers with RFC 8058's one-click POST, which the product's leave page must take.
// - <<…>> in the words means "not final yet": live mode refuses that kind and language (409). Test mode renders it, so
//   the preview shows the gap.
// - It goes out on the company's list route at the email service (company/infra.env EMAIL_LIST_ROUTE), apart from
//   order and support mail: plain text with an HTML part in the product's own look (the care/email-look.yaml its other
//   emails have; a simple page without one), no pixel, links as they are, opens and clicks never tracked.
//   Without the route nothing goes (503); test mode without the email service renders it back instead.
// - HQ keeps nothing of a list email and never logs one: the address is the product's, for this send only.
//
//   POST /api/list/notices   the email service's webhook (mailout.ts readNotice, signed): an address that left through
//     the service's own leave link, which it adds to every list email (Lettermint's hosted unsubscribe), or complained.
//     HQ keeps its hash and when (list_left), never the address, LEFT_KEEP_DAYS, and hands them to the product's list
//     at its sync (listLeft). The list takes off a sign-up from before then, as its own leave link does. Until the
//     service's notices can reach us (its webhook's secret in), nothing goes (503). The same webhook says when an email
//     HQ sent won't arrive (a bounce, its spam filter): mailout.ts keeps and tells that itself.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { infra, yamlFile } from './company.ts';
import { isPublic } from './approvals.ts';
import { type Caller, type Refused, json, ownUrl, productRequest, reply } from './payments.ts';
import * as mailout from './mailout.ts';
import * as mailpage from './mailpage.ts';
import { readBody } from '../../../shared/routes/routes.ts';

export type Words = { subject: string; body: string };
// A company's own kind of list email: its words in one language (or why not), and why it can't go now (or null)
export type Kind = {
  words(slug: string, id: string, lang: string): Words | Refused;
  refusal(c: Caller, id: string): Refused | null;
};
export const kinds = new Map<string, Kind>();

// Each slot: what it takes, and its value in the email (null: refused). A link's value is linked in the HTML part.
export type Slot = { takes: string; fill(value: unknown, c: Caller): string | null; link?: boolean };
export const slots: Record<string, Slot> = {
  link: {
    takes: "an https URL on this product's own address, or a public product's",
    fill: (v, c) => ourUrl(v, c)?.href ?? null,
    link: true,
  },
};
// A short plain text: a name, say. Never a link, so a product's bug can't put one in its words.
export const textSlot = (max: number): Slot => ({
  takes: `a short text (${max} characters at most), not a link`,
  fill: v => {
    const text = typeof v === 'string' ? v.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim() : '';
    return text && text.length <= max && !/https?:|www\./i.test(text) ? text : null;
  },
});

const WORDS = (slug: string) => `products/${slug}/care/list-emails.yaml`;
const LOOK = (slug: string) => `products/${slug}/care/email-look.yaml`;
const KIND = /^[a-z][a-z0-9_]{0,30}$/;
const OWN_KIND = /^([a-z][a-z0-9_]{0,30}):([a-z0-9][a-z0-9-]{0,40})$/;
const LANG = /^[a-z]{2}$/;
const ONE_CLICK = 'List-Unsubscribe=One-Click';

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const asked = await productRequest(req, res, { post: true });
  if (asked) reply(res, await email(asked.caller, asked.body));
}

export async function email(c: Caller, b: any): Promise<Refused | object> {
  const kind = String(b.kind ?? ''),
    lang = String(b.lang ?? '');
  const filled = b.slots && typeof b.slots === 'object' ? b.slots : {};
  const own = kind.match(OWN_KIND);
  if (!KIND.test(kind) && !(own && kinds.has(own[1])))
    return [
      400,
      `kind: a kind in ${WORDS(c.slug)}, or ${[...kinds.keys()].map(k => `${k}:<id>`).join(', ') || 'one of the company'}`,
    ];
  if (!LANG.test(lang)) return [400, 'lang: a two-letter language code (en, nl, de)'];
  const to = mailout.address(b.to);
  if (!to) return [422, 'to: one email address, its domain in ASCII (a-z, 0-9 and -)'];
  const leave = ownUrl(b.leave, c.slug);
  if (!leave || leave.username || leave.password)
    return [400, "leave: the address's own leave link, an https URL on this product's own address"];
  const ownKind = own ? kinds.get(own[1]) : undefined;
  const refused = own && ownKind ? ownKind.refusal(c, own[2]) : null;
  if (refused) return refused;
  const words = own && ownKind ? ownKind.words(c.slug, own[2], lang) : listWords(c.slug, kind, lang);
  if (Array.isArray(words)) return words;
  const footer = footerOf(c.slug, lang);
  if (Array.isArray(footer)) return footer;
  const mail = render(c, words, footer, filled, leave.href, lang);
  if (Array.isArray(mail)) return mail;
  const marker =
    c.mode === 'live' ? `${words.subject}\n${words.body}\n${footer}`.match(mailpage.UNFINISHED)?.[0] : undefined;
  if (marker)
    return [409, `the ${kind} email in ${lang} still holds ${marker}: its words aren't final yet, so nothing is sent`];
  if (!mailout.ready(c.mode)) return [503, 'no email service on the server yet'];
  const route = infra().EMAIL_LIST_ROUTE;
  if (!route && !mailout.renders(c.mode))
    return [503, "no list route at the email service yet (company/infra.env's EMAIL_LIST_ROUTE), so nothing is sent"];
  if (!mailout.renders(c.mode) && !mailout.hearsLeaves())
    return [
      503,
      "no word yet from the email service's own leave link (EMAIL_WEBHOOK_SECRET, its webhook's secret), so nothing is sent",
    ];
  const headers = { 'List-Unsubscribe': `<${leave.href}>`, 'List-Unsubscribe-Post': ONE_CLICK };
  try {
    const sent = await mailout.send(c.mode, { to, ...mail, replyTo: mailout.hello(), route, headers });
    return sent.test ? { status: 'test', test_email: mail } : { status: 'sent' };
  } catch (e) {
    if (!(e instanceof mailout.MailError)) throw e;
    if (e.scope === 'recipient') return [422, e.message];
    return [[400, 503, 504].includes(e.status) ? e.status : 502, e.message];
  }
}

// ---- leaving through the email service's own link
const LEFT_KEEP_DAYS = 7;
const BODY_LIMIT = 65_536;
db.exec('create table if not exists list_left (hash text primary key, at text not null)');

export async function handleNotice(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    req.resume();
    return json(res, 405, { error: 'POST' });
  }
  const body = await readBody(req, BODY_LIMIT); // the bytes as the service signed them
  if (!body) return json(res, 413, { error: `a notice of ${BODY_LIMIT} bytes at most` });
  const left = mailout.readNotice(req.headers, body);
  if (typeof left === 'number') return json(res, left, { error: 'not a notice from the email service' });
  for (const leaver of left) recordLeft(leaver);
  if (left.length) console.log(`list: ${left.length} address(es) left through the email service's own link`);
  return json(res, 200, { ok: true });
}

// What a product's list takes off at its sync: each address that left (its hash) and when
export function listLeft(): { hash: string; at: string }[] {
  db.prepare('delete from list_left where at < ?').run(
    new Date(Date.now() - LEFT_KEEP_DAYS * 86_400_000).toISOString(),
  );
  return db.prepare('select hash, at from list_left order by at').all() as { hash: string; at: string }[];
}

// An address as a list matches it: sha256 of the address in lower case, in hex (a product hashes its own the same way)
export const leftHash = (address: string) => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

const recordLeft = (leaver: mailout.Left) =>
  db
    .prepare(
      `insert into list_left (hash, at) values (?, ?)
      on conflict (hash) do update set at = max(at, excluded.at)`,
    )
    .run(leftHash(leaver.address), leaver.at);

// ---- the words
function listWords(slug: string, kind: string, lang: string): Words | Refused {
  const words = yamlFile(WORDS(slug))?.[kind]?.[lang];
  if (kind === 'footer' || typeof words?.subject !== 'string' || typeof words?.body !== 'string')
    return [400, `no ${kind} email in ${lang} for ${slug} (${WORDS(slug)})`];
  return { subject: words.subject, body: words.body };
}
export function footerOf(slug: string, lang: string): string | Refused {
  const footer = yamlFile(WORDS(slug))?.footer?.[lang];
  if (typeof footer !== 'string' || !footer.includes('{leave}'))
    return [
      400,
      `no footer in ${lang} with {leave} for ${slug} (${WORDS(slug)}): every list email closes with a way to leave`,
    ];
  return footer;
}

// The email as it goes: the words with their slots filled, the footer after the body, and the HTML part of the same
// text. (exported for a company's own previews: a letter's pictures for its card)
export function render(
  c: Caller,
  words: Words,
  footer: string,
  filled: Record<string, unknown>,
  leave: string,
  lang: string,
) {
  const names = Object.keys(slots);
  const { slot, notSlot } = mailpage.slotsOf(names);
  const unknown =
    `${words.subject}\n${words.body}`.match(notSlot)?.[0] ?? footer.replaceAll('{leave}', '').match(/\{[a-z_]+\}/)?.[0];
  if (unknown) return [400, `${unknown} in the words isn't a slot HQ fills`] as Refused;
  const values: Record<string, string> = {};
  for (const [, name] of `${words.subject}\n${words.body}`.matchAll(slot)) {
    const value = slots[name].fill(filled[name], c);
    if (value === null) return [400, `slots.${name}: ${slots[name].takes}`] as Refused;
    values[name] = value;
  }
  const subject = mailpage.subjectOf(words.subject, slot, values);
  const look = mailpage.readLook(LOOK(c.slug));
  if (typeof look === 'string') return [400, look] as Refused;
  const linkSlots = [...names.filter(name => slots[name].link), 'leave'];
  const mail = mailpage.fill(
    `${words.body.trim()}\n\n---\n${footer.trim()}`,
    { ...values, leave },
    look ?? PLAIN,
    { lang, subject },
    linkSlots,
  );
  return { subject, text: mail.text, html: mail.html! };
}

// A link in a list email: the product's own address, or a public product's (a stall's page in the shop's news, say:
// its shelf, /<slug>/, or its own host, <slug>.<zone>). In test mode another product's preview counts too.
function ourUrl(v: unknown, c: Caller) {
  let url: URL;
  try {
    url = new URL(String(v ?? ''));
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (ownUrl(v, c.slug)) return url;
  const named = [url.pathname.split('/')[1] ?? '', url.hostname.split('.')[0]];
  const other = named.find(
    slug => /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug) && (c.mode === 'test' || isPublic(slug)) && ownUrl(v, slug),
  );
  return other ? url : null;
}

// ---- the HTML part of a product without a look of its own: a simple page, its links plain
const FONT = "font:16px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222222";
const PLAIN: mailpage.Look = {
  page: `<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{subject}</title></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;color:#222222;${FONT}">
<div style="max-width:560px;margin:0 auto">
{content}
</div>
</body></html>
`,
  styles: {
    h2: `margin:24px 0 8px;${FONT};font-size:19px;font-weight:700`,
    p: `margin:0 0 16px;${FONT}`,
    ul: 'margin:0 0 16px;padding:0 0 0 22px',
    li: `margin:0 0 4px;${FONT}`,
    a: 'color:#1a5fb4',
    small: `margin:0 0 12px;${FONT};font-size:13px;color:#666666`,
  },
};
