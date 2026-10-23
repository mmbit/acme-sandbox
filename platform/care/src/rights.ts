// A request to exercise a data right (to see, correct or delete their data, restrict or object to its use, take a copy
// along): a case of its own for the person who handles these, with the customer's own words and the moment the chat
// received them. It needs no yes and no ask for a person. The knowledge never answers or closes it (answers.ts takes
// questions only) and no model drafts its reply (drafts.ts), so it waits in HQ until a person handles it.
import { db, now } from './db.ts';
import { t, mask } from './texts.ts';
import { settings, nameOf } from './company.ts';
import { healthTerm } from '../public/health.js';
import * as hq from './hq.ts';
import { replyTo, type Ctx } from './person.ts';

export const RIGHTS = ['access', 'correction', 'erasure', 'restriction', 'objection', 'portability', 'other'] as const;
export type Right = (typeof RIGHTS)[number];
export const isRight = (x: unknown): x is Right => RIGHTS.includes(x as Right);
// for the person handling it, on every card (GDPR art. 12(3) and (4))
const HANDLING =
  'Answer within one month of receipt. An extension (two months more, for a complex or numerous request) or a refusal, ' +
  'with its reason and the right to complain to the supervisory authority, is told within that month too. Before giving ' +
  'or deleting what is held under the reply address, confirm the request from that address unless it was checked.';
const IDLE_MS = 30 * 60_000; // a conversation this quiet sends its request without a reply address

// privacy_request: every right one request asks for, and the customer's messages that make it (their numbers, [#12]):
// they go as they wrote them, and the earliest one's time is the receipt. A message with a health detail never goes
// (engine.ts holds or removes it).
// email: a reply address the customer typed (the caller checks). Returns what the model hears.
export function request(c: Ctx, rights: Right[], numbers: number[], email?: string) {
  const st = c.conv.state;
  const before: number[] = st.rights?.messages ?? [];
  const asked = [...new Set(numbers)].filter(n => !before.includes(n));
  const rows = asked.length
    ? (db
        .prepare(
          `select id, at, text, health from messages where conversation = ? and who = 'me' and text != ''
    and id in (${asked.map(() => '?').join(', ')}) order by id`,
        )
        .all(c.conv.id, ...asked) as any[])
    : [];
  const words = rows.filter(r => r.health == null && !healthTerm(r.text));
  if (!words.length || words.length !== asked.length)
    return {
      filed: false,
      note: asked.length
        ? "Every reference must name a message of the customer's in this chat that can go with it (a health detail never goes): nothing was filed."
        : 'That request has gone to the team already.',
    };
  if (email) st.replyTo = email.trim().toLowerCase();
  const known = replyTo(c);
  const reply = email
    ? { to: st.replyTo, checked: known?.to === st.replyTo && known?.checked === 'checked' ? 'checked' : 'none' }
    : known;
  // filed as an effect: a draft that's dropped (a follow-up while it was held) files nothing, and the next one files the
  // same messages with the same receipt
  c.out.effect(() => {
    const earlier: Waiting[] = st.rights?.waiting ?? [];
    const filed = file(c, rights, words, earlier.at(-1));
    const waiting = [...earlier.filter(w => w.case !== filed.case), filed];
    if (reply) for (const w of waiting) release(c.conv.id, w.case, reply);
    st.rights = { messages: [...before, ...words.map(w => w.id)], waiting: reply ? [] : waiting };
    if (!reply) st.step = 'rights-email';
    c.live.save();
  });
  if (!reply) {
    c.out.say(t('rights_address', c.lang));
    return { filed: true, note: 'The server asked for the reply address.' };
  }
  c.out.say(t('rights_sent', c.lang, { to: mask(reply.to) }));
  return { filed: true };
}

// The reply address for the requests waiting for one (person.ts address(), whatever step asked for it last): a held one
// goes now, and one that went without it (the chat had gone quiet) goes again, with the other cases under that address,
// for its card in HQ to take them
export function address(c: Ctx, email: string) {
  const st = c.conv.state;
  c.out.effect(() => {
    for (const w of st.rights.waiting as Waiting[]) release(c.conv.id, w.case, { to: email, checked: 'none' });
    st.rights.waiting = [];
    st.replyTo = email;
    if (st.step === 'rights-email') st.step = null;
    c.live.save();
  });
  c.out.say(t('rights_sent', c.lang, { to: mask(email) }));
}

// A quiet or deleted conversation releases its request even without a reply address.
export function due(at: number) {
  const waiting = db
    .prepare(
      `select id, conversation from cases where kind = 'rights' and held = 'address'
    and (conversation is null or conversation in (select id from conversations where last < ?))`,
    )
    .all(at - IDLE_MS) as any[];
  for (const c of waiting) release(c.conversation, c.id, { to: null, checked: 'none' });
}

// A request filed without a reply address, kept in the conversation's state until one comes: its case, and the moment
// its earliest words were received
type Waiting = { case: number; received: number };

// One case per request. Words that come while it waits for its address join it, and its receipt is the earliest of
// theirs. Without an address it's held: the address releases it, or hq.ts sends it without one once the conversation
// has gone quiet.
function file(
  c: Ctx,
  rights: Right[],
  words: { id: number; at: number; text: string }[],
  last: Waiting | undefined,
): Waiting {
  const text = words.map(w => w.text).join('\n\n');
  const open =
    last && (db.prepare("select words, facts from cases where id = ? and held = 'address'").get(last.case) as any);
  const received = open ? Math.min(last.received, words[0].at) : words[0].at;
  const dates = { received: moment(received), answer_by: monthAfter(received) };
  if (open) {
    const facts = JSON.parse(open.facts);
    const merged = { ...facts, right: [...new Set([...facts.right, ...rights])], ...dates };
    db.prepare('update cases set words = ?, facts = ? where id = ?').run(
      `${open.words}\n\n${text}`,
      JSON.stringify(merged),
      last.case,
    );
    return { case: last.case, received };
  }
  const facts = { right: [...new Set(rights)], ...dates, other_cases: [], handling: HANDLING };
  const id = Number(
    db
      .prepare(
        `insert into cases (app, conversation, kind, checked, words, facts, lang, created, held)
      values (?, ?, 'rights', 'none', ?, ?, ?, ?, 'address')`,
      )
      .run(c.live.about(), c.conv.id, text, JSON.stringify(facts), c.lang, now()).lastInsertRowid,
  );
  return { case: id, received };
}

// the case with its reply address, and the other cases it may concern, goes to HQ. One HQ already has goes again: its
// card takes the address it went without (HQ's care.ts take()). One the board deleted meanwhile is gone.
function release(conversation: number | null, id: number, r: { to: string | null; checked: string }) {
  const row = db.prepare('select facts from cases where id = ?').get(id) as any;
  if (!row) return;
  const facts = JSON.parse(row.facts);
  facts.other_cases = others(conversation, r.to, id);
  db.prepare('update cases set email = ?, checked = ?, facts = ?, held = null, sent_hq = null where id = ?').run(
    r.to,
    r.checked,
    JSON.stringify(facts),
    id,
  );
  hq.nudge();
}

// The other cases a person may need to look at for it (a copy to delete, what to give): this conversation's and those
// with the same reply address, each with the app it's from
function others(conversation: number | null, email: string | null, self: number) {
  const rows = db
    .prepare('select id, app from cases where id != ? and (conversation = ? or lower(email) = lower(?)) order by id')
    .all(self, conversation, email) as any[];
  return rows.map(x => `H-${1000 + x.id} (${nameOf(x.app)})`);
}

// a moment and a day on the company's clock, as the person handling it reads them
const parts = (at: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: settings.timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(at)
      .map(p => [p.type, Number(p.value)]),
  );
const moment = (at: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: settings.timeZone, dateStyle: 'long', timeStyle: 'short' }).format(at) +
  ` (${settings.timeZone})`;
// The last day to answer: the same date a month on, or that month's last day when it has no such date (GDPR art. 12(3),
// counted as Regulation 1182/71 art. 3(2)(c) counts a period in months)
function monthAfter(at: number) {
  const { year, month, day } = parts(at);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const due = new Date(Date.UTC(year, month, Math.min(day, last)));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'long' }).format(due);
}
