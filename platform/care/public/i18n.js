// The widget's own words (the header, the ⋯ menu, About, the input, the cards' fixed labels): the engine's English,
// with the company's words over it. Everything the helper *says* comes from the
// server's fixed texts (src/texts.ts) or the model; these are the frame around it. A company's plug-in gives its
// languages and words (`public/plugin.js`: langs, words); a key it leaves out falls back to its English, then to the
// engine's below. {helper} in any of them is the helper's name (plugin.js `helper`). The language is the conversation's,
// from hello (`lang`), picked like the server's: one of the plug-in's languages, else its first; until hello answers, the
// page's (<html lang>), else the browser's.
let LANGS = ['en'], OWN = {}, HELPER = 'Helper';
export function use({ langs, words, helper } = {}) {
  if (langs) LANGS = langs;
  if (words) OWN = words;
  if (helper) HELPER = helper;
}
export const pick = (s) => { const l = String(s ?? '').slice(0, 2).toLowerCase(); return LANGS.includes(l) ? l : LANGS[0]; };

const EN = {
  helper: 'our AI helper', helper_of: '{app}’s AI helper',
  ai_title: '{helper} is an AI, not a person',
  status_on: 'AI helper · replies in seconds', status_off: 'Offline, back soon', status_cap: 'Paused · messages kept',
  status_stop: 'Email a person',
  more: 'More', close: 'Close the chat',
  m_about: 'About {helper}', m_person: 'Email a person', m_copy: 'Email me a copy of this chat',
  m_delete: 'Delete this conversation',
  // (del_text's request route)
  // the delete step (widget.js): del_text where nothing else keeps it, del_here with the box where our copy may go too,
  // del_kept where it may not
  del_q: 'Delete this conversation?', del_text: 'It goes from this device and from our servers. Anything you already sent to the team (an email to a person, a snapshot) stays with them: to have that deleted as well, ask me and I’ll pass your request to the team. This can’t be undone.',
  del_here: 'It goes from this device.', del_server: 'Also delete it from our servers',
  del_server_hint: 'Then you can’t pick it up again later, and we can’t refer back to it in a later chat. What you already sent to the team stays with them.',
  del_kept: 'It goes from this device. Our copy stays with your email address: to delete that too, tap Keep it and ask {helper} to check it’s you.',
  del_yes: 'Delete it', del_no: 'Keep it', del_done: 'Deleted. The chat is gone from our servers.', del_here_done: 'Deleted from this device.',
  about: 'About {helper}',
  ab_1: '<b>{helper} is an AI</b>, not a person: {role}, here day and night.',
  ab_2: 'It can look up your order and tell you where your parcel is, and a person can always help by email.',
  ab_3: 'What it tells you about your order comes from our own systems, but it can get things wrong. If something doesn’t add up, tell me, or email a person.',
  ab_4: '<b>There’s no live chat with a person</b>, but a person reads and answers every email. That takes longer than this chat.',
  ab_busy: ' It’s a busy time, so it may take longer.',
  ab_5: ' To email one, just ask me, or use the ⋯ menu.',
  back: 'Back to the chat',
  placeholder: 'Write a message…', input: 'Message to {helper}', send: 'Send',
  // (too_long)
  too_long: 'That’s too long for one message. It’s still in the box: send it in two or more parts.',
  failed: 'That didn’t go through. Please try again in a moment.', link_failed: 'That link didn’t go through. Please open it again in a moment.',
  working: '{helper} (AI) is answering…',
  earlier: 'Earlier, on another device · {n} messages',
  from: 'From: {source}', waiting: 'Waiting · will be answered when {helper}’s back', not_sent: 'Not sent. Try again', you: 'You: {text}',
  launcher: 'Help: chat with {helper}, our AI helper', help: 'Help', panel: 'Chat with {helper}, our AI helper',
  // the cards (catalogue.js)
  helped_thanks: 'Thanks for telling us.',
  choose: 'Choose one, or type your answer', orders: 'Your orders', ordered: 'Ordered {date} · {id}', picked_order: 'The {title}, ordered {date}',
  digit: 'Digit {i} of {n}', code_group: 'The {n}-digit code we emailed to {to}', code_ok: 'Code checked.', code_hint: 'Sent to {to}. Paste it or type it here.',
  photo: 'Your photo: {label}', checking: 'Checking…', take: 'Take or choose', track: 'Track parcel', since: 'Since {date}',
  note_label: 'Your note to the person', note_hint: 'Your note (you can change it)',
  st_paid: 'Paid', st_printing: 'Printing', st_shipped: 'Shipped', st_delivered: 'Delivered', st_cancelled: 'Cancelled', st_refunded: 'Refunded',
  // the consent card's preview (its words come from the server)
  snap_alt: 'The picture we’d send: this page as it looks now, with the form fields hidden', snap_log: 'The log we’d send', snap_none: '(nothing logged)',
  // the health-detail card, held here before anything is sent (the server's copy is in src/texts.ts)
  health_card: '**This looks like a health detail.** {helper} doesn’t need health details to help with your order, so we haven’t sent this. If you send it to a person instead, someone on our team reads it (not {helper} or any other AI) and uses it only to answer this message. You can ask us to delete it any time.',
  health_edit: 'Edit my message', health_person: 'Send it to a person instead', held: 'Not sent', removed: 'Taken out: a health detail',
  snap_making: 'Making the picture…', snap_nopic: 'No picture: this page couldn’t be drawn. Only the log would go.',
};

// words('nl') → w('earlier', { n: 3 }); a key missing in a language falls back to English, an unknown key throws
export function words(lang) {
  const own = OWN[pick(lang)] ?? {}, ownEn = OWN.en ?? {};
  return (key, vars = {}) => {
    const s = own[key] ?? ownEn[key] ?? EN[key];
    if (s == null) throw new Error(`No widget text called ${key}`);
    const all = { helper: HELPER, ...vars };
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
  };
}
