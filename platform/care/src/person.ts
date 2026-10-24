// The way to a person, and the other steps that come from templates: the greeting, the
// email card, the outage message. They never need the model, so they work exactly when it's down (AI Act art. 50). The
// model decides *that* a customer asked for a person (helper.ts's ask_for_person); this code counts the asks and decides
// what follows: the email card, or first one case for trying here, made once per conversation, if the company chose that
// (company.ts `chatFirst`).
import { db, now } from './db.ts';
import { t, mask, day } from './texts.ts';
import { settings, nameOf, thingOf, type Outage } from './company.ts';
import * as sessions from './session.ts';
import * as hq from './hq.ts';
import * as rights from './rights.ts';
import { healthTerm } from '../public/health.js';
import type { Out, Widget } from './engine.ts';

// visitor: what the plug-in read of the request of the device it answers (company.ts `visitor`)
export type Ctx = { live: any; conv: { id: number; shop: string; email: string | null; state: any }; session: sessions.Session;
  lang: string; busy: boolean; out: Out; down: boolean; visitor: Record<string, string> };
// what the app makes, in the sentence: German writes every noun with a capital ("mit meinem Becher"). The app is the stall
// the customer is in (engine.ts stall)
const thing = (c: Ctx) => { const x = thingOf(c.live.stall); return c.lang === 'de' ? x[0].toUpperCase() + x.slice(1) : x; };
const tx = (c: Ctx, key: string, vars: Record<string, string | number> = {}) =>
  t(key, c.lang, { app: nameOf(c.live.stall), thing: thing(c), ...vars }, c.busy, c.live.stall);
const opt = (c: Ctx, kind: string, extra: any = {}) => ({ kind, label: tx(c, kind), ...extra });

// the opening: it says it's an AI before the customer types, and what the helper can actually do (the app's own words,
// texts.ts); no person line
export function greeting(c: Ctx) {
  c.out.say(tx(c, 'hi'));
  c.out.say(tx(c, 'can'));
  c.out.say(tx(c, 'what'), { type: 'choice', start: true, options: ['parcel', 'damage', 'broken'].map(k => ({ kind: 'message', label: tx(c, k) })) });
}

// Where a person's reply goes, and how far the customer got (the mark on the Care card)
export function replyTo(c: Ctx): { to: string; checked: 'checked' | 'order' | 'none' } | null {
  const s = sessions.current(c.session) ?? c.session;
  if (sessions.level(s) === 2 && s.email) return { to: s.email, checked: 'checked' };
  if (s.orderEmail && s.orders.length) return { to: s.orderEmail, checked: 'order' };
  if (c.conv.state.replyTo) return { to: c.conv.state.replyTo, checked: 'none' };
  return null;
}

// The model recognised an ask, and why (helper.ts's ask_for_person). A request to exercise a data right isn't one: it
// goes to the team at once (rights.ts)
export const REASONS = ['asked', 'insisted', 'complaint', 'dispute', 'no_photos', 'cant_help'] as const;
export type Reason = (typeof REASONS)[number];
// an ask: the model's, by its reason, or the ⋯ menu's "Email a person"
export type Ask = Reason | 'menu';
// With `chatFirst`, the first ask for one of the reasons in `caseFor` (never an insist), while the helper can help, gets
// one case for trying here; anything else, and every ask without it, the email card. Counted here, not by the model.
// (`caseFor`)
export function ask(c: Ctx, reason: string, note?: string): 'case' | 'card' {
  if (reason !== 'insisted' && settings.caseFor.includes(reason as Reason) && pitch(c)) return 'case';
  card(c, note);
  return 'card';
}
// The ⋯ menu's "Email a person": with `chatFirst` and 'menu' in `caseFor`, the same one case first, in the template's
// words, since no model writes this one; else the email card
export function menu(c: Ctx) {
  if (!settings.caseFor.includes('menu') || !pitch(c)) return card(c);
  c.out.say(tx(c, 'person_case'), caseButtons(c));
}
// the one case for trying here, with `chatFirst`, unless it was made already, a person has it, a personal handover
// waits for an address, or the helper is down
function pitch(c: Ctx) {
  const st = c.conv.state;
  if (!settings.chatFirst || st.caseMade || st.handed || st.step === 'person-email' || st.step === 'health-email' || c.down) return false;
  st.caseMade = true; st.asks = (st.asks ?? 0) + 1; c.live.save();
  return true;
}
// the buttons under the helper's one case: "Let's try here" is the easy path, "Email a person" a real button beside it
export const caseButtons = (c: Ctx): Widget => ({ type: 'choice', options: [opt(c, 'try_here', { primary: true, kind: 'message', label: tx(c, 'try_here') }), opt(c, 'email_person')] });

// the email card: the wait said plainly, no second pitch, no "are you sure"
export function card(c: Ctx, note?: string) {
  const st = c.conv.state;
  st.caseMade = true; st.asks = (st.asks ?? 0) + 1;
  // the model wrote this note: the card marks it while it's still the model's words (summary()).
  if (note) st.note = st.modelNote = String(note).slice(0, 1500);
  const r = replyTo(c);
  if (st.handed) { c.live.save(); return again(c, r?.to ?? ''); }
  if (!r) { st.step = 'person-email'; c.live.save(); return c.out.say(`${tx(c, 'person_lead')} ${tx(c, 'person_address')}`); }
  c.out.say(tx(c, 'person_lead'));
  summary(c, r);
}
function summary(c: Ctx, r: { to: string; checked: string }) {
  const st = c.conv.state;
  st.step = null; c.live.save();
  const how = r.checked === 'checked' ? tx(c, 'checked') : r.checked === 'order' ? tx(c, 'order_email') : tx(c, 'as_typed');
  c.out.say(tx(c, 'person_card'), { type: 'summary', kind: 'handover', title: tx(c, 'person_title'),
    rows: [[tx(c, 'reply_to'), `${mask(r.to)} (${how})`], [tx(c, 'this_chat'), tx(c, 'whole_chat')], [tx(c, 'reply_row'), tx(c, 'reply_how')]],
    note: st.note ?? '', ...(st.note && st.note === st.modelNote ? { noteAiGenerated: true } : {}),
    options: [opt(c, 'send_person', { primary: true, args: { to: r.to, checked: r.checked } }), opt(c, 'not_now')] });
}

// An address the customer gave for a step (typed while the model is up, through the model's reply_address; or a message
// that is only an address while it's down). It must be one the customer typed: the caller checks. The data requests
// waiting for one take it whatever step asked last (a question for the team in between), and that step's work goes on
// too (rights.ts).
export function address(c: Ctx, email: string) {
  const st = c.conv.state, e = email.trim().toLowerCase(), forRights = waitsForRights(st);
  if (forRights) rights.address(c, e);
  if (st.step === 'person-email') { st.replyTo = e; return summary(c, { to: e, checked: 'none' }); }
  if (st.step === 'team-email') { st.replyTo = e; st.step = null; return question(c, st.question ?? ''); }
  // filed as an effect: the model's reply_address runs in a draft, and a dropped draft (restore()) must file nothing, or
  // the next address would file the same message twice; a template's effects run at once
  if (st.step === 'health-email') { const mid = st.healthMsg; st.replyTo = e; st.step = null; c.live.save(); return c.out.effect(() => c.live.template((o: Out) => healthCase({ ...c, out: o }, { to: e, checked: 'none' }, mid))); }
  return forRights ? undefined : false;
}

// ask_team: the question goes to the team, and the answer comes by email. No code needed: no order data goes out.
export function question(c: Ctx, q: string) {
  const st = c.conv.state, r = replyTo(c);
  st.question = String(q).slice(0, 1000);
  if (!r) { st.step = 'team-email'; c.live.save(); return c.out.say(tx(c, 'team_address')); }
  // the case is an effect: a draft that's discarded (a follow-up while it was held) files nothing
  const words = st.question;
  c.out.effect(() => open(c, 'question', r, words));
  st.question = null; c.live.save();
  c.out.say(tx(c, 'team_sent', { to: mask(r.to) }));
}

// General feedback for the team, in the helper's own general words: chat and phone alike (phonetools.ts). A note nobody
// replies to, so it carries nothing that says who it's from: one with an email address or a long number in it (an order,
// a phone number) is refused, for the model to write it again in general words
export const FEEDBACK = 'General feedback about us, the shop or this service (praise, a wish, something that could be better), not a question to answer or a problem with an order: when they ask you to pass it on, or plainly mean it for us. feedback: what it is about, in one or two sentences of your own, in general words: never a name, an email address, a phone or order number, or anything else that says who it is from. The team reads it; nobody can reply to them from it. Say so plainly after it.';
export const FEEDBACK_ONLY = 'Not passed on: write it again in general words, without an email address, a phone or order number or a name.';
export function feedbackWords(x: unknown) {
  const f = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return f && !/@|\d(?:[\s./()-]?\d){4,}/.test(f) ? f : null; // (a number as it's said: '06 12 34 56 78')
}
// pass_on_feedback: general feedback (about the shop, the chat, the service) goes to the team as a note to read, in the
// helper's general words: no reply address, no orders, nothing of the conversation, so nobody can reply from it. An effect,
// like a question: a draft that's discarded files nothing
export function feedback(c: Ctx, words: string) {
  const text = String(words).slice(0, 500);
  c.out.effect(() => {
    db.prepare("insert into cases (app, conversation, kind, email, checked, words, facts, lang, created) values (?, ?, 'feedback', null, 'none', ?, '{}', ?, ?)")
      .run(c.live.stall, c.conv.id, text, c.lang, now());
    hq.nudge();
  });
}

// A case for HQ's Care app. The reply address goes with it, filled in here, never by the model.
// health: a health detail goes to a person with it, so no model drafts for it (drafts.ts) and HQ's card says so
// The card names the app the conversation is about (engine.ts about()); a question, the stall whose knowledge didn't
// answer it (answers.ts tries that knowledge again). An order of another app says whose.
function open(c: Ctx, kind: string, r: { to: string; checked: string }, words: string, facts: any = {}, health = false) {
  const s = sessions.current(c.session) ?? c.session;
  // a health detail the customer sent to a person in this chat goes on this case's card too (hq.ts chat(…, true))
  health ||= !!db.prepare("select 1 from messages where conversation = ? and health = 'person'").get(c.conv.id);
  const app: string = kind === 'question' ? c.live.stall : c.live.about();
  const orders = s.orders.map(o => o.app === app ? o.id : `${o.id} (${nameOf(o.app)})`);
  // the numbers the customer was told for them, which a phone fault may be noted under (hq.ts withFaults)
  const numbers = [...new Set(s.orders.flatMap(o => o.number ? [o.number] : []))];
  const id = Number(db.prepare('insert into cases (app, conversation, kind, email, checked, words, facts, lang, created, health) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(app, c.conv.id, kind, r.to, r.checked, words, JSON.stringify({ orders, ...(numbers.length ? { numbers } : {}), ...facts }), c.lang, now(), health ? 1 : null).lastInsertRowid);
  hq.nudge();
  return `H-${1000 + id}`;
}

// The tap sends to the address the card showed (the tap runs exactly what was shown). If the
// reply address has changed since (another order checked, a code for another email), nothing goes: a fresh card instead.
function send(c: Ctx, note: string | undefined, shown: { to?: string; checked?: string }) {
  const st = c.conv.state, r = replyTo(c);
  if (!r) return card(c);
  if (st.handed) return again(c, r.to);
  if (shown.to !== r.to || shown.checked !== r.checked) { c.out.say(tx(c, 'person_changed')); return summary(c, r); }
  const words = [note ?? st.note ?? '', ...(st.afterCap ?? [])].filter(Boolean).join('\n\n');
  st.note = null; st.afterCap = null;
  // The note is the customer's to edit, so it's checked like a typed message: one with a health detail
  // isn't filed until the customer chose on the health card, which says first that a person reads it and no AI does.
  // It's held like a typed one (engine.ts healthTap()): "Edit my message" brings this card back with the note in it,
  // "Send it to a person instead" files it as a health case (health()).
  if (healthTerm(words)) {
    const mid = c.live.store('me', words, { health: 'held' });
    st.healthNote = mid; c.live.save();
    return c.live.healthCard(c.out, mid);
  }
  st.handed = open(c, 'person', r, words); st.modelNote = null; c.live.save(); // (modelNote)
  c.out.say(tx(c, 'sent', { to: mask(r.to), ref: st.handed }));
  sentMore(c);
}

// "Edit my message" on the health card a note got (send() above): the email card again, with the note to change
export function editNote(c: Ctx, note: string) {
  const r = replyTo(c);
  c.conv.state.note = String(note).slice(0, 1500);
  return r ? summary(c, r) : card(c);
}

// "Send it to a person instead" on the health-detail card (engine.ts): the message (marked 'person', so
// no model ever reads it) goes to a person case of its own that no model drafts for, or, when an email to a person has
// already gone, with that one (hq.ts `more`). With no reply address yet, the next step asks for one.
export function health(c: Ctx, mid: number) {
  const st = c.conv.state, r = replyTo(c);
  // a person case already filed from this chat gets it as `more` (hq.ts): no model drafts for that one from now on either
  db.prepare("update cases set health = 1 where conversation = ? and kind = 'person'").run(c.conv.id);
  if (st.handed) return again(c, r?.to ?? '');
  if (!r) { st.step = 'health-email'; st.healthMsg = mid; c.live.save(); return c.out.say(tx(c, 'person_address')); }
  healthCase(c, r, mid);
}
function healthCase(c: Ctx, r: { to: string; checked: string }, mid: number) {
  const st = c.conv.state;
  const words = (db.prepare("select text from messages where id = ? and conversation = ? and health = 'person'").get(mid, c.conv.id) as any)?.text ?? '';
  st.handed = open(c, 'person', r, words, {}, true); st.caseMade = true; st.healthMsg = null; c.live.save();
  c.out.say(tx(c, 'sent', { to: mask(r.to), ref: st.handed }));
  sentMore(c);
}

// The email to a person this chat sent (state.handed), as HQ's state last said it stands (hq.ts replies()): when the
// board's last reply to it went, and whether its card is done (not while an ask for a person waits for HQ to hear it)
export function handedCase(st: any): { id: number; replied: number | null; settled: boolean } | null {
  const m = /^H-(\d+)$/.exec(String(st.handed ?? ''));
  const r = m ? (db.prepare('select id, replied, settled, asked from cases where id = ?').get(Number(m[1]) - 1000) as any) : null;
  return r ? { id: r.id, replied: r.replied ?? null, settled: r.settled === 1 && r.asked == null } : null;
}
// An ask for a person after this chat's email to one went: what the chat has since goes to that case's card as for a
// person (hq.ts, a `more` with person: true), back on the board's list, and the words say whether a reply went already.
// Without an ask, what the helper answers itself stays off the list
function again(c: Ctx, to: string) {
  const h = handedCase(c.conv.state), ref = c.conv.state.handed;
  if (h) c.out.effect(() => { db.prepare('update cases set asked = ? where id = ?').run(now(), h.id); hq.nudge(); });
  if (!h?.replied) return c.out.say(tx(c, 'already', { ref, to: mask(to) }));
  return c.out.say(tx(c, 'already_answered', { ref, to: mask(to), day: day(h.replied, c.lang) }));
}

// What they add goes with the email. A stop never comes back, so the line doesn't say the chat carries on
const sentMore = (c: Ctx) => c.out.say(tx(c, c.live.waits ? 'sent_more_down' : 'sent_more'));

// A tap on a template's button. Returns true if handled here; false hands it to the helper as a message (a starting chip,
// "Let's try here").
export function tap(c: Ctx, kind: string, args: any, answer: any, template: (f: (o: Out) => unknown) => void) {
  const w = (f: (cc: Ctx) => unknown) => { template(o => f({ ...c, out: o })); return true; };
  switch (kind) {
    case 'email_person': return w(cc => card(cc));
    case 'send_person': return w(cc => send(cc, typeof answer?.note === 'string' ? answer.note.slice(0, 1500) : undefined, args));
    case 'not_now': c.conv.state.step = null; c.live.save(); return w(cc => cc.out.say(tx(cc, 'kept_back')));
    case 'snap_no': return w(cc => cc.out.say(tx(cc, 'snap_declined'))); // nothing was sent, and the help goes on as before
    default: return false;
  }
}

// A message that is only an email address answers a step waiting for one, with the model up or down; nothing else is
// read without the model (no phrase lists: the outage message's own "Email a person" and the ⋯ menu are the way to a person).
export function offline(c: Ctx, text: string, template: (f: (o: Out) => unknown) => void) {
  const m = /^\s*([^\s@<>(),;:"'][^\s@<>(),;:"]*@[^\s@<>(),;:"']+\.[a-z]{2,})\s*$/i.exec(text);
  if (!m || (!c.conv.state.step && !waitsForRights(c.conv.state))) return false;
  template(o => address({ ...c, out: o }, m[1]));
  return true;
}
const waitsForRights = (st: any) => !!st.rights?.waiting?.length;

// the outage message: plain and true, no drawing, and one small "Email a person" link at its end, whatever the cause and
// whether or not email can be sent: a person stays one tap away. With `chatFirst`, what they write waits for the
// helper, so only `linkFor`'s causes end in the link, by default a stop, which lasts the rest of the day (the ⋯ menu
// still has one)
export function outageCard(c: Ctx) {
  const cause = c.live.down as Outage;
  const link = !settings.chatFirst || settings.linkFor.includes(cause);
  // a stop by one person's budget for the day says when the helper answers again
  const stop = c.conv.state.stop === 'error' ? 'stopped' : 'stopped_today';
  c.out.say(tx(c, cause === 'stop' ? stop : cause === 'cap' ? 'down_cap' : 'down'), { type: 'outage', cause, options: link ? [opt(c, 'email_person')] : [] });
}
