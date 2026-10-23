// The fixed texts: what the helper says from templates, never from the model (the greeting, the outage card, the way to
// a person, button labels). They work with the model down, which is when the way to a person matters most (AI Act art.
// 50: a way to a human, always). These are the engine's English defaults for every key; a company's own words, in each
// of its languages, are its plug-in's `texts` (company.ts), and an app's own over those (its `apps/<kb folder>.json`). t()
// takes a key from the app's words first, then the company's: the language asked for, then the company's first
// language, then these.
import { settings } from './company.ts';
import { db } from './db.ts';
import { folderOf } from './kb.ts';

export type Lang = string;
// a language the company speaks (its plug-in's `langs`), or its first one
export const lang = (s: unknown): Lang => { const l = String(s ?? '').slice(0, 2).toLowerCase(); return settings.langs.includes(l) ? l : settings.langs[0]; };

type T = Record<string, string>;
const EN: T = {
  hi: 'Hi, I’m {helper}, {app}’s AI helper.',
  can: 'I can look up your order and see where your parcel is, right here and at any hour.',
  what: 'What’s happened?',
  parcel: 'Where’s my order?', damage: 'Something’s wrong with my {thing}', broken: 'Something isn’t working',
  aim: 'we aim to reply within {days} working days', busy: ' It’s a busy time, so it may take longer.',
  try_here: 'Let’s try here', email_person: 'Email a person', send_person: 'Email it to a person', not_now: 'Not now',
  // the ⋯ menu's "Email a person" with `chatFirst`, before any ask: the chat's case for trying here first
  person_case: 'I can probably help you faster right here, at any hour: tell me what you need. A person answers by email, and {aim}.{busy}',
  ask_team: 'Yes, ask the team', no_thanks: 'No thanks',
  person_lead: 'Of course. A person answers by email: {aim}.{busy}',
  person_address: 'What email should they reply to? You don’t need an order for this; if it’s about one, add its number.',
  person_card: 'Here’s what the person will see. You can change the note before it goes.',
  person_changed: 'Nothing has gone yet: the address for the reply has changed since that card.',
  person_title: 'By email, to a person', reply_to: 'Reply goes to', this_chat: 'This chat', whole_chat: 'the whole conversation',
  reply_row: 'Reply', reply_how: 'by email; {aim} (slower than this chat){busy}',
  checked: 'checked', order_email: 'the order’s email', as_typed: 'as you typed it',
  sent: 'Sent. A person will reply to {to}; {aim}.{busy} Reference {ref}.',
  sent_more: 'If you think of anything else, write it here and I’ll add it.',
  sent_more_down: 'If you think of anything else, write it here: {helper} adds it when it’s back.',
  already: 'Your email to a person has already gone (reference {ref}): they’ll reply to {to}; {aim}.{busy} Anything you write here goes with it.',
  kept_back: 'Kept. Nothing has gone to a person.',
  team_sent: 'Done: I’ve asked the team. The answer comes by email to {to}; {aim}.{busy} If it’s something other customers ask too, I’ll know it next time.',
  team_address: 'What email should the answer go to?',
  // a data request (rights.ts): passed on at once, never an offer to email a person
  rights_sent: 'I’ll pass your data request to the team for handling. They reply by email to {to}, within one month at the latest.',
  rights_address: 'I’ll pass your data request to the team for handling. What email should they reply to? You don’t need a purchase for this.',
  down: 'Our AI helper can’t answer right now. The AI service it runs on isn’t responding. What you write here is kept and answered as soon as it’s back.',
  down_cap: 'Our AI helper can’t answer right now. What you write here is kept and answered as soon as it’s back.',
  stopped: 'Our AI helper can’t answer any more in this conversation. A person can: tap “Email a person” and they answer by email; {aim}.{busy}',
  stopped_today: 'Our AI helper can’t answer any more today, only again from tomorrow. A person can: tap “Email a person” and they answer by email; {aim}.{busy}',
  back: 'I’m back. Let me catch up on what you wrote.',
  waiting: 'Waiting for {helper}',
  expired: 'That button has expired. Tell me what you’d like instead.',
  copy_sent: 'A copy of this chat is on its way to {to}.', copy_check: 'I can send a copy once you’ve confirmed your email in the chat.',
  copy_later: 'I’ve sent a few copies already. You can ask for another in an hour.',
  code_sent: 'I’ve sent a 6-digit code to {to}. Type it here or in the boxes.',
  code_failed: 'Sorry, that code didn’t go out after all. Ask me again in a little while, or a person can help: just ask.',
  code_ok: 'Thanks, that’s you.', code_wrong: 'That code doesn’t match. Check the latest email from us and try again.',
  code_spent: 'That code can’t be used any more. I can send a new one.',
  link_ok: 'Hi again. I know it’s you from the link in our email.', link_bad: 'That link has expired or was already used. I can check your order another way.',
  subject_code: 'Your code for {app}: {code}',
  body_code: 'Your code for the {app} chat is {code}. It works for 10 minutes.\n\nIf you didn’t ask for it, you can ignore this email: nothing changes.\n\n{app}',
  subject_copy: 'Your chat with {helper} ({app})',
  sign: '{helper}, {app}’s AI helper',
  // the line while a tool works (helper.ts; a company's own tools name theirs)
  status_check_order: 'Checking your order…', status_order_status: 'Checking where it is…', status_my_orders: 'Looking up your orders…',
  // ---- claim photos (photos.ts): the slots, the note shown before the camera opens, the widget's own words
  shot_box: 'The outer box, as it arrived', shot_box_hint: 'The whole box in the picture.',
  shot_label: 'The shipping label', shot_label_hint: 'Close enough to read. It shows your address, so only our team sees it.',
  shot_box_damage: 'The damage to the box', shot_box_damage_hint: 'Up close: dents, tears or wet patches.',
  shot_product: 'The whole {thing}', shot_product_hint: 'Laid flat, in good light.',
  shot_closeup: 'The fault, up close', shot_closeup_hint: 'As close as your camera stays sharp.',
  shot_contents: 'Everything that was in the box', shot_contents_hint: 'Laid out side by side.',
  photos_note: 'Please keep faces and other people’s things out of the photos. Only our team sees them (and our partner, if they need them to put it right); {helper} doesn’t.',
  photo_take: 'Take or choose a photo', photo_again: 'Take it again', photo_sending: 'Sending…', photo_got: 'Got it',
  photo_sent: '📷 {label}',
  photo_bad: 'That photo didn’t come through. Could you take it again?',
  photo_big: 'That photo is too big for me. Could you take it again with your phone’s camera?',
  photo_case: 'That’s all the photos I can take for this. Tap “{done}”, and the team will ask by email if they need more.',
  photo_day: 'That’s a lot of photos for one day. Tap “{done}”, and the team will ask by email if they need more.',
  photo_busy: 'I can’t take photos just now. Try again in a minute.', photos_done: 'That’s all the photos',
  // the team's answer to a question, by email from a knowledge entry (answers.ts): never in the chat. Its first lines say
  // it's from an AI (AI Act art. 50(1))
  subject_team: 'Your question to {app}: the answer ({ref})',
  team_intro: 'Hello, this is {helper}, {app}’s AI helper: an AI, not a person.\n\nThis answers the question you asked in the chat on {app}’s website on {date}.',
  team_reply: 'If that doesn’t answer it, just reply to this email: a person reads it, and {aim}.',
  // the bug-report consent (its three buttons carry equal weight)
  snap_title: 'Send the team a snapshot?',
  snap_text: 'It helps us find the bug. We’d send a picture of this page as it looks now, a short technical log from the last few minutes (errors and the steps you took, without what you typed, email addresses or long numbers) and one line on what went wrong. The picture may show your name, order or address.',
  snap_fine: 'We keep it until the bug is fixed, at most 90 days. You can ask us to delete it any time.',
  snap_see: 'See what we’d send', snap_send: 'Send it', snap_no: 'No thanks',
  snap_sent: 'Sent, thank you: the team has it (reference {ref}).', snap_declined: 'That’s fine: nothing was sent.',
  // an answer that reached its most model calls (model.ts TURN_ROUNDS) with tools' results still unread; the phone's
  // is phone_rounds_out
  rounds_out: 'Sorry, I couldn’t finish looking into that. Could you ask me again?',
  // "Did this help?" (engine.ts helped()): the card's question and buttons, and the one line after "Not really"
  helped_q: 'Did this help?', helped_yes: 'Yes', helped_not: 'Not really', helped_no: 'If that doesn’t work for you, a person can look at it: just ask.',
  // ---- the phone (phone.ts), all spoken: the opening's AI line and transcript
  // line (AI Act art. 50(1), GDPR art. 13), said by the voice line; the line after an objection; and what the tools have
  // said: the way to a person (said as it stands), the code's one answer, its daily limit, a fault noted; and a turn's
  // most model calls reached (rounds_out's)
  phone_ai: 'Hi, this is {helper}, an AI assistant.',
  // before a reply in a language the opening didn't have.
  phone_reply_ai: 'I’m {helper}, an AI assistant.',
  phone_transcript: 'I keep a written transcript of this call, never a recording, to help with your order. Say so if you’d rather I didn’t.',
  phone_ask: 'What can I help you with?', // (the opening's last words)
  phone_objected: 'That’s fine: I won’t keep a transcript of this call.',
  phone_person: 'A person answers by email, and {aim}. The address is on our website.',
  phone_code_sent: 'If that’s one of our orders, a code is on its way to the email address it was ordered with. It works for 10 minutes: read it out to me when it comes.',
  phone_code_limit: 'That order number has had all the codes it can have today. A person can help by email.',
  phone_fault: 'I’ve noted that, with today’s date. To have it put right, send photos by email or in the chat on our website.',
  phone_rounds_out: 'Sorry, I couldn’t finish looking into that. Could you ask me again?',
  // the lighter checks: the postcode's limit, an answer by email after the call
  // kept, its daily limit, and the email's line when the knowledge and the order don't answer it (phoneanswer.ts)
  phone_postcode_limit: 'I can’t check any more postcodes for that order just now.',
  phone_answer_kept: 'If that’s one of our orders, the answer goes to the email address it was ordered with, after this call.',
  phone_answer_limit: 'That order number has had all the email answers it can have today. A person can help by email.',
  phone_answer_unknown: 'I couldn’t find the answer to that in what I know. A person can: just reply to this email, and {aim}.{busy}',
  // ---- the health-detail check (engine.ts): its card, its two buttons of equal weight (the person
  // route is explicit consent, art. 9(2)(a)), and the line after the helper finds one the check missed
  health_card: '**This looks like a health detail.** {helper} doesn’t need health details to help with your order, so we haven’t sent this. If you send it to a person instead, someone on our team reads it (not {helper} or any other AI) and uses it only to answer this message. You can ask us to delete it any time.',
  health_edit: 'Edit my message', health_person: 'Send it to a person instead',
  health_removed: 'I’ve taken that message out of our chat: I don’t need health details to help with your order. Could you write it again without them?',
  health_removed_earlier: 'I’ve taken that message out of our chat: I don’t need health details to help with your order.',
};

// The text for a key in a language: {helper} is the helper's name, and {aim} and {busy} come from the busy flag, so no
// caller can leave the wait out; {days} in the aim is the plug-in's busy.aim, the working days a reply takes. app: the
// app whose own words go first ('<slug>' or '<slug>@preview'), found like its knowledge (kb.ts folderOf()).
// t('sent', 'nl', { to, ref })
const text = (key: string, l: Lang, app = ''): string | undefined => {
  const own = app ? settings.appWords[folderOf(app)] : undefined, first = settings.langs[0];
  return own?.[l]?.[key] ?? settings.texts[l]?.[key] ?? own?.[first]?.[key] ?? settings.texts[first]?.[key] ?? EN[key];
};
export function t(key: string, l: Lang, vars: Record<string, string | number> = {}, busy = false, app = '') {
  const s = text(key, l, app);
  if (s == null) throw new Error(`No text called ${key}`);
  const v: Record<string, string> = { helper: settings.helper, aim: text('aim', l, app)!.replaceAll('{days}', String(settings.busy.aim)), busy: busy ? text('busy', l, app)! : '',
    ...Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, String(x)])) };
  return s.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
}
export const mask = (email: string) => email.replace(/^(.)[^@]*/, '$1•••');
// what the code box stores as the customer's message once their code checks out: dots on screen, and to the model what
// it was (helper.ts history()), or it reads them as a code it can't see and asks for the digits again
export const CODE_TYPED = '••• •••';
// a language's English name, for a prompt ('nl': 'Dutch'), and the locale its dates are written in (company.ts `locales`)
const names = new Intl.DisplayNames(['en'], { type: 'language' });
export const languageName = (l: Lang) => { try { return names.of(l) ?? 'English'; } catch { return 'English'; } };
// The board's language (HQ's state `board`, hq.ts), which what care writes for the board is in: a card's summary, and the
// customer's words and the draft translated. Kept, so a restart writes in it before HQ's state comes again; English until
// HQ says.
export const boardLang = (): Lang =>
  (db.prepare("select value from hq_said where key = 'board'").get() as { value: string } | undefined)?.value ?? 'en';
export function heardBoardLang(l: unknown) {
  if (typeof l === 'string' && /^[a-z]{2}$/.test(l) && l !== boardLang())
    db.prepare("insert or replace into hq_said (key, value) values ('board', ?)").run(l);
}
export const locale = (l: Lang) => settings.locales[l] ?? l;
