// The local harness's invented shop and what the widget's check types and draws:
// the engine's own, for a plug-in without a demo/demo.mjs. A company's plug-in may give any of these in its own
// demo/demo.mjs (and its own shop.html and order.html next to it), so the harness looks like its apps and the check's
// screenshots show its words. Everything here is invented (no real customer's data).
import { fileURLToPath } from 'node:url';

const DAY_MS = 864e5;

// ---- the shop (shop.mjs)
// the harness's app: its name, its knowledge folder (the plug-in's kb/<kb>) and what it makes
export const app = { name: 'Example Shop', kb: 'shared', thing: 'mug' };
// a folder served at /img/* and /fonts/* (the pages' pictures and fonts)
export const assets = fileURLToPath(new URL('./assets', import.meta.url));
// the one customer the order endpoint knows, and their orders: the View the care-service note defines, newest first
export const customer = { email: 'sam@example.com' };
const iso = (t) => (t == null ? null : new Date(t).toISOString());
export function orders(now = Date.now()) {
  const d = (n) => now + n * DAY_MS;
  const view = (o) => ({ id: o.id, ref: o.ref, placed_at: iso(o.placed), title: o.title, status: o.status, shipped_at: iso(o.shipped),
    delivered_at: iso(o.delivered), carrier: o.carrier ?? null, tracking_url: o.shipped ? `https://www.ups.com/track?tracknum=1Z${o.ref}` : null,
    country: 'US', total_cents: 2400, address_masked: '1•• M••• St, Springfield' });
  return [
    { id: 'EX-1001', ref: '41001', title: 'The blue mug', placed: now, status: 'paid' },
    { id: 'EX-0987', ref: '40987', title: 'The striped mug', placed: d(-6), shipped: d(-4), carrier: 'UPS', status: 'shipped' },
    { id: 'EX-0950', ref: '40950', title: 'Two espresso cups', placed: d(-19), shipped: d(-16), delivered: d(-14), carrier: 'UPS', status: 'delivered' },
  ].map(view);
}

// ---- the check (widget-check.mjs)
// the theme's custom properties (<prefix>-accent, -ink, -paper, -font, -serif), and the default theme's colours: none
// may show under the check's blue theme
export const theme = { prefix: '--care', colours: ['#2f5c9e', '#1f2430', '#f6f7f9'] };
// what the customer types: a question that needs the model, a note to a person, and a message with a health detail
// (the plug-in's list must hold one of its words)
export const typed = {
  question: 'where is my mug?',
  note: 'The mug came with a chip in it.',
  health: 'I was in hospital last week. Can the mug still come before Friday?',
};
// per language besides English (the plug-in's langs): the browser's locale, a health detail the widget holds, words
// About must have and words nothing may say
export const languages = {};
// the values order.html holds in its form: none may reach the bug report
export const secrets = ['Juniper Lane', 'quiet-ish'];

// every catalogue widget at once, as the server would send them: for the looks, not the conversation
export function gallery(day) {
  const reply = (id, text, widget, extra = {}) => ({ t: 'reply', id, text, answer: id, widget: widget && { keep: true, ...widget }, ...extra });
  return [
    { t: 'earlier', items: [{ k: 'me', text: 'Is the striped mug on its way?' }, { k: 'ai', text: 'Yes: UPS has it since Monday.' }] },
    reply('g1', 'These are the orders on that email:', { type: 'order_picker', id: 'g1', orders: [
      { id: 'EX-1001', title: 'The blue mug', date: day(0), status: 'paid', action: 'o1' },
      { id: 'EX-0987', title: 'The striped mug', date: day(6), status: 'shipped', action: 'o2' },
      { id: 'EX-0950', title: 'Two espresso cups', date: day(19), status: 'delivered', action: 'o3' }] }),
    reply('g2', 'I’ve sent a 6-digit code to s•••@example.com. Type it here or in the boxes.', { type: 'code_entry', id: 'g2', length: 6, to: 's•••@example.com' }),
    reply('g3', 'It’s with UPS:', { type: 'tracking', id: 'g3', carrier: 'UPS', status: 'On its way', since: day(4), code: '1Z40987',
      url: 'https://www.ups.com/track?tracknum=1Z40987' }, { source: 'UPS tracking' }),
    reply('g4', 'Two photos, and the team can look at it:', { type: 'photo_request', id: 'g4', slots: [{ id: 'box', label: 'The box, outside', fine: 'All sides, if it’s dented' }, { id: 'print', label: 'The mug, close up' }], fine: 'The photos stay with this case.' }),
    reply('g5', 'Which would you like?', { type: 'choice', id: 'g5', equal: true, options: [{ label: 'A new one', action: 'v' }, { label: 'Your money back', action: 'm' }] }),
    reply('g6', 'Here’s what the person will see.', { type: 'summary', id: 'g6', kind: 'handover', title: 'By email, to a person', rows: [['Reply goes to', 'sam@example.com'], ['This chat', 'the whole conversation']],
      note: 'The mug came with a chip in it.', options: [{ action: 's', label: 'Email it to a person', primary: true }, { action: 'n', label: 'Not now' }] }),
    reply('g7', 'Our AI helper can’t answer right now. What you write here is kept and answered as soon as it’s back.', { type: 'outage', id: 'g7', cause: 'cap',
      options: [{ action: 'p', label: 'Email a person' }] }),
    reply('g8', 'Sorry, that page shouldn’t do that.', { type: 'consent', id: 'g8', title: 'Send the team a snapshot?', text: 'It helps us find the bug: a picture of this page and a short technical log.',
      fine: 'We keep it until the bug is fixed, at most 90 days.', see: 'See what we’d send', options: [{ action: 'c1', label: 'Send it' }, { action: 'c2', label: 'No thanks' }] }),
    // a file of the plug-in's own, as a download
    reply('g9', 'Here’s your card. Print the page on A4 and fold it, or send the picture.', { type: 'files', id: 'g9', title: 'Your card',
      files: [{ label: 'The card to print (PDF)', url: '/__care/api/file/demo.pdf', name: 'card.pdf' }, { label: 'The picture to send (PNG)', url: '/__care/api/file/demo.png', name: 'card.png' }] }),
    { t: 'line', text: 'Checking your order…' },
  ];
}
