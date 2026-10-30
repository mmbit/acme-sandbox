// HQ-OS › Care: the customers waiting on the board. The list (oldest first, each with its reply-by day), the claims to
// send to the supplier (the one brand.yaml's care.claims names), the remedies waiting for a tap, the money owed, and a
// card per customer: their own words, the facts, the conversation, and the draft reply to edit in place (translated into
// the board's language when it's in another), then Not now · Ask for changes · Send by email. Ask for changes has the team redraft it; a
// claim's card sends its email to the supplier with its photos, and notes their answer. Nothing goes out without the
// board's Send, there's an Undo for 10 seconds after it, and there's no "approve all" anywhere: every reply is read.
// HQ's own cards too (job #3318): a customer's email to the company (E-7), which can go back to Mail if it isn't a
// customer's.
// Every string from the coordinator is customer- or partner-controlled: it goes through esc() as text, is never turned
// into a link (but an email's web addresses, as Mail shows them: emailtext.js), and a
// bug report's picture and a claim's photos are only ever an <img>.
// Everything with a customer's details (a card, the list's rows, the remedies' and held orders' words) is marked
// data-private: a walk-through call's recording keeps it out (shared/watchalong).
// A card is deleted at the customer's request from its More (with a confirm step): only its reference is kept, and the care
// service deletes its copy. Find a case opens a card by its reference (the one a customer asking for that names).
// Care › Numbers: the support chat's own numbers per app, counts only (nothing in it leads to a conversation, a customer or
// an order).
// A health case (the customer sent a health detail to a person from the chat's health card) has no AI draft and no Ask for
// changes: the board writes its reply alone, as that card promised.
// An HQ app on the interface a company's own apps use (template/kits/README.md): desk.js loads it once this module ran,
// when the company runs the care service (GET /api/brand's care), and calls the exports under "what HQ calls".
import { esc, grow, jobName, stylesheet } from '../util.js';   // (jobName)
import { emailHtml } from './emailtext.js';
import { icon } from './icons.js';
import { covered, jobNameLink, prose } from './prose.js';   // (covered, jobNameLink)
import { loadCare, loadCareCount, loadCareCard, loadCareDone, loadCareRemedies, findCareCase, careAction, careAnswer, carePicture, carePhoto, loadCareNumbers } from './data.js';
import { sfx } from './audio.js';
import { toast } from './hud.js';
import * as world from '../world/world.js';
import { ago, companyFormats, dayTime, timeOf } from '../world/clock.js';

// What the computer is showing: the list, a card, or Care › Numbers ({ screen: 'numbers', app, mode }: app null is the
// first app, mode null the app's own: live once it's launched, else preview)
let view = { screen: 'list', id: null };
// Care › Numbers opened from elsewhere in HQ-OS (an app's dashboard in Numbers), and the way back there
let asked = null, away = null, wanted = null;
let shownEl = null, shown = '', seq = 0, go = {}, listTop = 0, last = null;
let ui = {};                                   // the open card's own state: { asking, naming, msg, undoEnd, big, more, erasing, eraseMsg, actionMsg }
const notes = new Map();                       // a line under a remedy or money owed (an error), kept across redraws
const folds = { sent: { open: false, list: null, more: false, busy: false }, remedies: { open: false, list: null, more: false, busy: false } };
let tick = null;

// ---------------------------------------------------------------- what HQ calls
// Its icon on the computer's home screen
export const app = { name: 'Care', what: 'Customers waiting on you', icon: 'app-care', group: 'business' };
// Each time the computer (re)draws Care: on opening it and every 15 s (desk.js skips that while a field has text, so a
// draft being written is never redrawn). A new screen element is a fresh opening. "Open in Mail" opens Mail at a message.
export async function draw(el, hq) {
  go = { mail: id => hq.open('mail', { mail: id, force: true }) };
  if (el !== shownEl) {
    shownEl = el; shown = ''; away = asked?.back ?? null;
    view = asked ? { screen: 'numbers', id: null, app: asked.slug, mode: asked.mode ?? null } : wanted ? { screen: 'card', id: wanted } : { screen: 'list', id: null };
    asked = null; wanted = null;
    ui = {}; for (const f of Object.values(folds)) Object.assign(f, { open: false, list: null, more: false });
  }
  await stylesheet('shell/care.css');
  await paint(el);
}
// The header's back button: from a card or Care › Numbers back to the list (true), else it's the computer's (false).
// Care › Numbers opened from elsewhere goes back there.
export function back() {
  if (view.screen === 'list' || !shownEl?.isConnected) return false;
  if (view.screen === 'numbers' && away) { const back = away; away = null; sfx.blip(); back(); return true; }
  toList(shownEl);
  return true;
}
// HQ's search (finder.js, template/kits/README.md): the tickets on Care's list, by what their row shows, each opening at
// its card. Every one is still open, so none is old.
export const finds = {
  name: 'Tickets',
  prefix: 't',
  async list(hq) {
    const { cards = [] } = await loadCare(hq.dev);
    return cards.map(c => ({ key: String(c.id), title: kindOf(c), codes: [c.case], sub: [c.case, c.appName ?? c.app, c.preview].filter(Boolean).join(' · '),
      open: () => { wanted = c.id; hq.open('care', { force: true }); } }));
  },
};
// Open Care on one app's numbers ({ slug, mode }): the next time the computer draws Care, it shows them, and the header's
// back button calls `back` (desk.js, for the chat line on an app's dashboard in Numbers)
export function careFor(app, back) { asked = { slug: app.slug, mode: app.mode === 'live' || app.mode === 'preview' ? app.mode : null, back }; }
// Everyone and everything waiting on the board here: the number on Care's icon
export const count = async dev => { const c = await loadCareCount(dev); return ['replies', 'claims', 'bugs', 'remedies', 'owed', 'held'].reduce((s, k) => s + (Number(c?.[k]) || 0), 0); };

// The desk phone's line: "Care: 3 replies to check, 1 remedy to approve" above the cards (and on the quiet screen), opening
// Computer › Care. It follows GET /api/care/count, read with every requests poll (fresh); a change repaints only the line.
let careCount = null;
export async function phone(el, hq, { fresh, past }) {
  if (fresh) {
    const c = await loadCareCount(world.dev).catch(() => null);
    if (!c || JSON.stringify(c) === JSON.stringify(careCount)) return;
    careCount = c; el = document.querySelector('#phone-screen');   // (the screen may have been redrawn meanwhile)
    if (!el) return;
  }
  const words = past ? '' : careWords(careCount), line = el.querySelector(':scope > .care-line');
  if (!words) { line?.remove(); return; }
  const html = `<button class="care-line app-line" data-care>${PIN_CARE}<span><b>Care:</b> ${esc(words)}</span><i aria-hidden="true">›</i></button>`;
  if (line) line.outerHTML = html; else el.insertAdjacentHTML('afterbegin', html);   // (app-line: style.css)
  el.querySelector(':scope > .care-line').onclick = () => { sfx.blip(); hq.open('care'); };
}
const PIN_CARE = icon('heart');

// The desk phone's line, in words: "3 replies to check, 1 remedy to approve" ('' when nothing waits)
function careWords(c) {
  if (!c) return '';
  const n = (k, one, many) => c[k] > 0 ? `${c[k]} ${c[k] === 1 ? one : many}` : '';
  return [n('replies', 'reply to check', 'replies to check'), n('claims', 'claim to send', 'claims to send'), n('bugs', 'bug report', 'bug reports'),
    n('remedies', 'remedy to approve', 'remedies to approve'), n('owed', 'refund we owe', 'refunds we owe'),
    n('held', 'held order to look at', 'held orders to look at')].filter(Boolean).join(', ');
}
// Settings › Care: the board's name on replies (it signs every reply sent from Care), and the senders it marked "Not a
// customer: back to Mail" on a card, each with Back to Care (shown only when there are some)
export async function settings(el) {
  await stylesheet('shell/care.css');
  el.closest('.device')?.classList.toggle('cr-px', /pixelify/i.test(getComputedStyle(el).fontFamily));
  let name = null, kept = [];
  try { ({ name, mailOnly: kept = [] } = await loadCare(world.dev)); } catch { el.innerHTML = '<p class="cap"><i class="prompt">&gt; </i>CARE</p><p class="dim">No signal from the coordinator: try again in a moment.</p>'; return; }
  el.innerHTML = `<p class="cap"><i class="prompt">&gt; </i>YOUR NAME ON REPLIES</p>
    <div class="cr-name"><input id="care-name" maxlength="60" autocomplete="name" aria-label="Your name on replies" placeholder="Your name" value="${esc(name ?? '')}"><button data-save-name>Save</button></div>
    ${name ? '' : '<p class="dim"><b>Not set yet:</b> Care can’t send a reply until it is.</p>'}<p class="msg" role="status"></p>
    ${kept.length ? `<p class="cap"><i class="prompt">&gt; </i>NOT CUSTOMERS</p><p class="dim">You marked these senders as not customers: their email stays in Mail.</p>
      <ul class="cr-kept" data-private>${kept.map(a => `<li><span>${esc(a)}</span><button data-tocare="${esc(a)}">Back to Care</button></li>`).join('')}</ul>` : ''}
    <p class="msg" data-kept-msg role="status"></p>`;
  const f = el.querySelector('#care-name'), msg = el.querySelector('.msg'), save = el.querySelector('[data-save-name]');
  const saveName = async () => {
    save.disabled = true; msg.textContent = 'Saving…';
    try { await careAction(world.dev, 'name', { name: f.value.trim() }); sfx.blip(); f.blur(); settings(el).then(() => { el.querySelector('.msg').textContent = 'Saved.'; }); }
    catch (e) { msg.textContent = e.message; save.disabled = false; }
  };
  save.onclick = saveName;
  f.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } };
  // Back to Care: that sender's next email is a card again (what came meanwhile stays in Mail)
  el.querySelectorAll('[data-tocare]').forEach(b => b.onclick = async () => {
    el.querySelectorAll('[data-tocare]').forEach(x => { x.disabled = true; });
    try { await careAction(world.dev, 'tocare', { address: b.dataset.tocare }); sfx.blip(); await settings(el); el.querySelector('[data-kept-msg]').textContent = `Back in Care: the next email from ${b.dataset.tocare} is a card.`; }
    catch (e) { el.querySelector('[data-kept-msg]').textContent = e.message; el.querySelectorAll('[data-tocare]').forEach(x => { x.disabled = false; }); }
  });
}

async function paint(el, force = false) {
  const me = ++seq, v = { ...view };
  let data;
  try {
    data = v.screen === 'numbers' ? await numbersData(v) : v.id ? await Promise.all([loadCareCard(world.dev, v.id), loadCare(world.dev)]) : await loadCare(world.dev);
  } catch (e) {
    if (me !== seq) return;
    if (v.id && e.status === 404) { toast(`<b>Care</b><br>${esc(e.message)}`); view = { screen: 'list', id: null }; return paint(el, true); }
    if (shown) { el.querySelector('[data-cr-signal]')?.removeAttribute('hidden'); return; } // keep what's shown
    throw e;
  }
  if (me !== seq || !el.isConnected || v.id !== view.id || v.screen !== view.screen) return;
  const key = JSON.stringify([v, data, folds, ui, [...notes], dayFold]);
  if (key === shown && !force) { el.querySelector('[data-cr-signal]')?.setAttribute('hidden', ''); return; }
  shown = key;
  const dev = el.closest('.device');
  dev?.classList.add('care-wide');
  dev?.classList.toggle('cr-px', /pixelify/i.test(getComputedStyle(el).fontFamily)); // (care.css: the digits a pixel font blurs)
  if (v.screen === 'numbers') {
    crumb(el, `Numbers${data.d ? ` › ${data.d.name}` : ''}`, 'Numbers'); // (the app's name only where it fits: it's on the screen too)
    el.innerHTML = numbersHtml(data);
    wireNumbers(el);
  } else if (v.id) {
    const [card, list] = data;
    last = list;
    crumb(el, card.case);
    el.innerHTML = cardHtml(card, list);
    wireCard(el, card, list);
  } else {
    last = data;
    crumb(el, '');
    el.innerHTML = listHtml(data);
    wireList(el, data);
  }
}
// Paints again now and, given `top`, scrolls there once painted (a failure shows the lost signal instead)
const repaint = (el, top) => paint(el, true).then(() => { if (top != null) el.scrollTop = top; }, () => el.querySelector('[data-cr-signal]')?.removeAttribute('hidden'));
function crumb(el, cs, short) {
  const s = el.closest('.device')?.querySelector('header b span');
  if (s) s.textContent = ` › Care${cs ? ` › ${cs}` : ''}`;
  if (s && short && s.parentElement.scrollWidth > s.parentElement.clientWidth) s.textContent = ` › Care › ${short}`;
}
function openCard(el, id) {
  sfx.blip(); listTop = el.scrollTop;
  view = { screen: 'card', id }; ui = {};
  repaint(el, 0);
}
function toList(el) {
  sfx.blip(); clearInterval(tick); tick = null;
  view = { screen: 'list', id: null }; ui = {};
  repaint(el, listTop);
}

// ---------------------------------------------------------------- words and small pieces
const KIND = { person: 'Asked for a person', question: 'A question', rights: 'A data request', claim: 'A claim', outage: 'Wrote during an outage', bug: 'Bug report', email: 'An email', feedback: 'Feedback' };
// general feedback the chat's or the phone's helper passed on, in its own words: a note to read, nobody to reply to
const feedbackNote = c => c.kind === 'feedback';
const ours = c => c.kind === 'email';
const claimTo = c => c?.claim?.name ? ` to ${c.claim.name}` : '';
// a claim's facts as care names them, in words
// (a data request's)
const FACT = { subject: 'Subject', person_case: 'Their email to a person', right: 'Rights asked for', received: 'Received in the chat', answer_by: 'Answer by', other_cases: 'Other cases to look at', handling: 'How to handle it', case: 'What happened', who_pays: 'Who pays', deadline: 'Claim deadline', report: 'The customer’s report', photos: 'Photos taken', shipped_at: 'Shipped', value: 'Order value (cents)' };
const CHECK = { checked: ['ok', 'checked'], order: ['mid', 'order and email match, no code'], none: ['no', 'not checked'] };
const WHO = { customer: 'Customer', ai: 'The chat’s AI', email: 'Email', board: 'You', note: 'Note' };
const DONE = { sent: 'Sent', closed: 'Closed: no reply needed', answered: 'Answered', fixed: 'Fixed' };
const dayOf = s => companyFormats().day(s, 'en', { weekday: true, short: true });
// (a moment on the company's clock)
const when = ts => dayTime(ts, { weekday: false });
const kindOf = c => KIND[c.kind] ?? 'A customer';
const toPartner = c => c.sendTo === 'partner';
const dueBy = c => `${toPartner(c) && !c.claim?.sent ? 'send by' : 'reply by'} ${dayOf(c.replyBy)}`;
const due = c => c.replyBy ? `<span class="cr-due${c.late ? ' late' : ''}">${c.late ? '<b>Late</b> · ' : ''}${esc(dueBy(c))}</span>` : '';
const mark = c => { const [k, t] = CHECK[c.check] ?? CHECK.none; return `<span class="cr-check ${k}">${esc(t)}</span>`; };
const tag = (t, cls = '') => `<span class="cr-tag ${cls}">${t}</span>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// a list row's kind at a glance
const KIND_IC = {
  person: icon('person', 'small'),
  question: icon('question', 'small'),
  claim: icon('claim', 'small'),
  outage: icon('outage', 'small'),
  bug: icon('bug', 'small'),
  email: icon('mail', 'small'),
};
// a data request's row shows an email
const kindIcon = c => KIND_IC[c.kind === 'rights' ? 'email' : c.kind] ?? KIND_IC.question;
const signal = '<span class="cr-signal" data-cr-signal hidden>no signal · retrying</span>';
const msgOf = k => notes.get(k) ? `<p class="cr-msg" role="status">${esc(notes.get(k))}</p>` : '';

// ---------------------------------------------------------------- the list
// The list: what waits, counted at the top (a tap goes to its section), the busy notice, a section per kind of work,
// then the past folded away. Find a case and Numbers sit in the bar above it all. (The bar, the counts, the calmer busy
// notice and the rows' kind icons)
function listHtml(d) {
  const cards = d.cards ?? [], open = c => ['waiting', 'unsure', 'sending', 'mailing'].includes(c.status);
  const replies = cards.filter(c => c.kind !== 'bug' && !feedbackNote(c) && open(c) && !toPartner(c)), claims = cards.filter(c => open(c) && toPartner(c));
  const notes = cards.filter(c => feedbackNote(c) && c.status === 'waiting');
  const bugs = cards.filter(c => c.kind === 'bug' && c.status !== 'team'), team = cards.filter(c => c.kind !== 'bug' && c.status === 'team');
  const owed = d.slots?.remedies ? d.owed ?? [] : [], remedies = d.remedies ?? [], held = d.held ?? [];
  const q = d.queue ?? {};
  const sec = (k, title, n, body) => `<section class="cr-sec ${k}" data-sec="${k}"><h3>${esc(title)} · ${n}</h3>${body}</section>`;
  const glance = [['replies', 'to check', replies.length, replies.filter(c => c.late).length], ['claims', claims.length === 1 ? 'claim' : 'claims', claims.length],
    ['bugs', bugs.length === 1 ? 'bug' : 'bugs', bugs.length], ['remedies', 'to approve', remedies.length], ['owed', 'owed', owed.length],
    ['held', 'held', held.filter(h => !h.answer).length]]
    .filter(([k, , n]) => n || k === 'replies')
    .map(([k, words, n, late]) => `<button class="cr-count${late ? ' late' : ''}" data-jump="${k}"${n ? '' : ' disabled'}><b>${n}</b><span>${words}${late ? ` · ${late} late` : ''}</span></button>`).join('');
  return `<div class="cr">
    <p class="cap"><i class="prompt">&gt; </i>CARE · ${Number(q.waiting ?? replies.length)} WAITING${q.oldest ? ` · OLDEST SINCE ${esc(ago(q.oldest).toUpperCase())}` : ''} ${signal}</p>
    <div class="cr-top"><form class="cr-find" data-find role="search"><label for="cr-find">${icon('find', 'small')}<span>Find a case</span></label><input id="cr-find" maxlength="14" autocomplete="off" spellcheck="false" placeholder="H-1042"><button>Open</button></form>${msgOf('find')}
      <button class="cr-go" data-cr-numbers>Numbers ›</button></div>
    <div class="cr-glance">${glance}</div>
    ${busyHtml(d.busy)}
    ${sec('replies', 'Replies to check', replies.length, replies.length ? `<ul class="cr-list">${replies.map(rowHtml).join('')}</ul>` : '<p class="cr-none">Nobody is waiting on a reply.</p>')}
    ${claims.length ? sec('claims', `Claims to send${claimTo(claims[0])}`, claims.length, `<p class="cr-none">Drafted for you, with the customer’s photos: read it, then send it to ${esc(claims[0].claim?.name ?? 'the supplier')} yourself.</p><ul class="cr-list">${claims.map(rowHtml).join('')}</ul>`) : ''}
    ${bugs.length ? sec('bugs', 'Bug reports', bugs.length, `<ul class="cr-list">${bugs.map(rowHtml).join('')}</ul>`) : ''}
    ${notes.length ? sec('feedback', 'Feedback passed on', notes.length, `<p class="cr-none">What customers asked the helper to pass on, in its words. Nobody waits on a reply: read it, then close it.</p><ul class="cr-list soft">${notes.map(rowHtml).join('')}</ul>`) : ''}
    ${remedies.length ? sec('remedies', 'Remedies waiting for your tap', remedies.length, remedies.map(remedyHtml).join('')) : ''}
    ${owed.length ? sec('owed', 'Money we owe', owed.length, `<p class="cr-none">A refund that didn’t go through: pay it another way, or try the refund again.</p>${owed.map(owedHtml).join('')}`) : ''}
    ${held.length ? sec('held', 'Held orders to look at', held.length, `<p class="cr-none">Paid, and kept from the printer until you’ve looked at what’s printed on them. The rest of each basket waits with it. The buyer can still cancel meanwhile.</p>${held.map(heldHtml).join('')}`) : ''}
    ${team.length ? sec('team', 'With the team', team.length, `<p class="cr-none">Nothing for you to do: the answer comes back here as a draft.</p><ul class="cr-list soft">${team.map(rowHtml).join('')}</ul>`) : ''}
    <div class="cr-past">${foldHtml('sent', 'Sent', 'Every reply you sent, and the cards closed, newest first')}
    ${d.slots?.remedies ? foldHtml('remedies', 'Every remedy', 'Reprints, vouchers and refunds, newest first') : ''}</div>
    <p class="cr-foot">EVERY REPLY IS READ AND SENT BY YOU · NOTHING GOES OUT BY ITSELF</p></div>`;
}
// A list row, with its tap target named by the row's whole text, as the toast's is
function rowHtml(c) {
  const job = c.job && [jobName(c.job, c.job_code), jobNameLink(c.job, c.job_code)];   // (in words, and as its link)
  const state = c.status === 'team' ? ['With the team', 'team', job] : c.status === 'unsure' ? ['May not have gone', 'warn']
    : c.status === 'sending' ? ['Sending: Undo on the card', 'ok'] : c.status === 'mailing' ? ['Sending', 'ok'] : c.kind === 'bug' && c.job ? ['Handed on', 'team', job] : null;
  const tags = [c.newReply && ['New reply', 'new'], c.asking && ['Redrafting as you asked', 'team'], c.health && ['Health detail: no AI', 'health'],
    c.error && c.status !== 'unsure' && ['Last send failed', 'warn'], state].filter(Boolean);
  const dated = !feedbackNote(c) && c.replyBy, checked = !(c.kind === 'bug' || feedbackNote(c) || toPartner(c));
  const quote = c.kind === 'claim' ? c.preview : c.preview ? `“${c.preview}”` : '';
  const meta = `${c.appName ?? c.app ?? ''} · ${ago(c.since ?? c.created)} · ${String(c.lang ?? '').toUpperCase()}`;
  const name = [kindOf(c), c.case, quote, meta, dated && `${c.late ? 'Late, ' : ''}${dueBy(c)}`, checked && (CHECK[c.check] ?? CHECK.none)[1],
    ...tags.map(([t, , j]) => (j ? `${t} (job ${j[0]})` : t))].filter(Boolean).join(', ');
  return `<li data-private>${covered('cr-row', `data-card="${Number(c.id)}"`, name, `<span class="ic">${kindIcon(c)}</span>
    <span class="t"><b>${esc(kindOf(c))}</b><span class="cs">${esc(c.case)}</span></span>
    <span class="q">${esc(quote)}</span>
    <span class="m">${esc(meta)}</span>
    <span class="r">${dated ? due(c) : ''}${checked ? mark(c) : ''}${tags.map(([t, cls, j]) => tag(`${esc(t)}${j ? ` (job ${j[1]})` : ''}`, cls)).join('')}</span>`)}</li>`;
}
// The busy notice: Auto · On · Off, what it does in a line under its name, why it's on now, and when it stays on whatever
// the switch says
function busyHtml(b) {
  if (!b) return '';
  const seg = [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']].map(([k, t]) => `<button role="radio" data-busy="${k}" aria-checked="${b.switch === k}">${t}</button>`).join('');
  return `<section class="cr-busy${b.on ? ' on' : ''}"><div class="hd"><b id="cr-busy-label">Busy notice</b><span class="seg" role="radiogroup" aria-labelledby="cr-busy-label">${seg}</span></div>
    <p class="sm">While it’s on, customers read that it’s a busy time, so a reply may take longer.</p>
    <p class="state"><i aria-hidden="true"></i><b>${b.on ? 'On now' : 'Off now'}</b>${b.on && b.why ? `<span>: ${esc(b.why)}</span>` : ''}</p>
    ${b.held ? `<p class="held">On anyway: someone has waited over ${esc(b.aim)} working days, so “we aim for ${esc(b.aim)}” would mislead. It goes off by itself once they have their reply.</p>` : ''}${msgOf('busy')}</section>`;
}
// (its details as prose)
const remedyHtml = r => `<div class="cr-remedy" data-remedy="${Number(r.request)}">
    <p class="t" data-private><b>${esc(r.title)}</b>${r.case ? `<span class="cs">${esc(r.case)}</span>` : ''}</p>
    <p class="grant" data-private>${esc(r.grant)}</p>
    ${r.body ? `<details data-private><summary>The details</summary><div class="txt prose">${prose(r.body)}</div></details>` : ''}
    <div class="cr-two"><button class="cta" data-approve>${icon('tick', 'small')}Approve</button><button data-decline>Not now</button></div>${msgOf(`r${r.request}`)}</div>`;
const owedHtml = o => `<div class="cr-owed" data-voucher="${Number(o.voucher)}" data-request="${o.request == null ? '' : Number(o.request)}">
    <p class="t" data-private><b>${esc(o.amount)}</b><span>${esc(o.appName ?? o.app)} · order ${esc(o.order)}</span>${o.mode === 'test' ? tag('test mode') : ''}</p>
    <p class="why" data-private>${esc(o.reason)}</p><p class="sm">Owed since ${esc(ago(o.since))}</p>
    <div class="cr-two">${o.request != null ? '<button data-paid>Paid another way</button>' : ''}<button data-again>Refund again</button></div>${msgOf(`o${o.voucher}`)}</div>`;
// A held order: what its word check read (or what's printed on it), then Release
// or Refuse, for those words (their revision goes with the tap); once tapped, the answer
// with Undo until its app has read it (at its next check), and a line when its app hasn't checked in for a while
const heldHtml = h => {
  const app = esc(h.appName ?? h.app), done = h.answer === 'release' ? 'Released: it goes on to the printer' : 'Refused: it’s to be cancelled and refunded in full';
  const state = !h.answer ? `<div class="cr-two"><button class="cta" data-release>${icon('tick', 'small')}Release: print it</button><button data-refuse>Refuse: refund it</button></div>`
    : h.taken ? `<p class="grant">${h.answer === 'release' ? done : `Refused: ${app} is cancelling it and refunding it in full`}.</p>` : `<p class="grant">${done} at ${app}’s next check, usually within a minute.</p><div class="cr-two"><button data-undo>Undo</button></div>`;
  return `<div class="cr-held" data-line="${esc(h.line)}" data-revision="${esc(h.revision ?? '')}">
    <p class="t" data-private><b${h.words?.length > 120 ? ' class="long"' : ''}>${h.words ? `“${esc(h.words)}”` : 'No words given'}</b><span>${app} · ${esc(h.description)} · order ${esc(h.order)}</span>${h.mode === 'test' ? tag('test mode') : ''}</p>
    <p class="sm">${h.why ? `Held: ${esc(h.why)} · ` : ''}Paid ${esc(ago(h.paidAt))}${h.answer ? ` · you answered ${esc(ago(h.answeredAt))}` : ''}</p>${state}
    ${h.quiet ? `<p class="why">${app} hasn’t checked in for over 10 minutes, so ${h.answer ? 'your answer waits for it' : 'it won’t hear an answer until it’s back'}.</p>` : ''}${msgOf(`h${h.line}`)}</div>`;
};
function foldHtml(k, title, sub) {
  const f = folds[k];
  const body = !f.list ? `<p class="cr-none">${f.busy ? 'Opening…' : f.failed ? 'Didn’t open. Close and open it again.' : ''}</p>`
    : !f.list.length ? `<p class="cr-none">${k === 'sent' ? 'Nothing sent yet.' : 'No remedies yet.'}</p>`
    : k === 'sent' ? `<ul class="cr-list soft">${f.list.map(doneRowHtml).join('')}</ul>` : `<ul class="cr-rows">${f.list.map(remedyRowHtml).join('')}</ul>`;
  return `<details class="cr-fold" data-fold="${k}"${f.open ? ' open' : ''}><summary><b>${esc(title)}</b><span>${esc(sub)}</span></summary>${body}
    ${f.list && f.more ? `<button class="cr-older" data-older="${k}"${f.busy ? ' disabled' : ''}>${f.busy ? 'Opening…' : 'Older ›'}</button>` : ''}</details>`;
}
const doneRowHtml = c => `<li data-private><button class="cr-row" data-card="${Number(c.id)}"><span class="t"><b>${esc(kindOf(c))}</b><span class="cs">${esc(c.case)}</span></span>
    <span class="q">“${esc(c.preview)}”</span><span class="m">${esc(c.appName ?? c.app)} · ${esc(DONE[c.status] ?? c.status)}${c.sentAt ? ` ${esc(when(c.sentAt))}` : ''}</span></button></li>`;
const remedyRowHtml = r => `<li data-private><span class="st st-${esc(r.status)}">${esc(r.statusWords ?? r.status)}</span>
    <b>${esc(r.kind)} · ${esc(r.appName ?? r.app)} · order ${esc(r.order)}${r.value ? ` · ${esc(r.value)}` : ''}${r.mode === 'test' ? ' · test mode' : ''}</b>
    <span class="dim">${esc(r.reason)}${r.case ? ` · ${esc(r.case)}` : ''} · ${esc(when(r.created))}</span>
    ${(r.waits ?? []).length ? `<small>Waits for ${r.waits.map(esc).join(', ')}</small>` : ''}${r.result ? `<small>${esc(r.result)}</small>` : ''}</li>`;

function wireList(el, d) {
  el.querySelectorAll('[data-card]').forEach(b => b.onclick = () => openCard(el, Number(b.dataset.card)));
  el.querySelector('[data-cr-numbers]').onclick = () => openNumbers(el);
  el.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => { sfx.blip(); el.querySelector(`[data-sec="${b.dataset.jump}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  wireBusy(el, d.busy);
  wireRemedies(el);
  el.querySelectorAll('.cr-owed').forEach(box => {
    const voucher = Number(box.dataset.voucher), request = box.dataset.request ? Number(box.dataset.request) : null, key = `o${voucher}`;
    const doing = async (fn, done) => {
      box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { done(await fn()); notes.delete(key); } catch (e) { notes.set(key, e.message); }
      repaint(el);
    };
    box.querySelector('[data-paid]')?.addEventListener('click', () => doing(() => careAnswer(world.dev, request, true), () => { sfx.ding(0.6); toast('<b>Marked as paid another way</b>'); }));
    box.querySelector('[data-again]').onclick = () => doing(() => careAction(world.dev, 'refund-again', { voucher }), r => { sfx.blip(); toast(`<b>Refund tried again</b>${r?.status ? `<br>${esc(r.status)}` : ''}`); });
  });
  // a held order's Release, Refuse and Undo
  el.querySelectorAll('.cr-held').forEach(box => {
    const line = box.dataset.line, key = `h${line}`;
    const answer = (to, words) => async () => {
      box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { await careAction(world.dev, 'held', { line, revision: box.dataset.revision, answer: to }); notes.delete(key); sfx.blip(); if (words) toast(`<b>${words}</b>`); }
      catch (e) { notes.set(key, e.message); }
      repaint(el);
    };
    box.querySelector('[data-release]')?.addEventListener('click', answer('release', 'Released'));
    box.querySelector('[data-refuse]')?.addEventListener('click', answer('refuse', 'Refused: refund to follow'));
    box.querySelector('[data-undo]')?.addEventListener('click', answer(null, null));
  });
  el.querySelectorAll('details[data-fold]').forEach(dt => dt.ontoggle = () => {
    const f = folds[dt.dataset.fold];
    if (dt.open === f.open) return;
    f.open = dt.open;
    if (f.open && !f.list && !f.busy) more(el, dt.dataset.fold);
  });
  el.querySelectorAll('[data-older]').forEach(b => b.onclick = () => more(el, b.dataset.older));
  // Find a case: its card, or why not in the coordinator's words (deleted at the customer's request, not in Care)
  const find = el.querySelector('[data-find]');
  find.onsubmit = async e => {
    e.preventDefault();
    const f = find.querySelector('input'), ref = f.value.trim();
    if (!ref) { f.focus(); return; }
    find.querySelector('button').disabled = true;
    try { const c = await findCareCase(world.dev, ref); notes.delete('find'); f.value = ''; openCard(el, Number(c.id)); }
    catch (err) { notes.set('find', err.message); await repaint(el, el.scrollTop); }
  };
}
// the next page of Sent or Every remedy, after the last one loaded
async function more(el, k) {
  const f = folds[k], before = f.list?.at(-1)?.id;
  f.busy = true; f.failed = false; repaint(el);
  try {
    const p = k === 'sent' ? await loadCareDone(world.dev, before) : await loadCareRemedies(world.dev, before);
    f.list = (f.list ?? []).concat(k === 'sent' ? p.cards : p.remedies); f.more = !!p.more;
  } catch { f.failed = !f.list; }
  f.busy = false;
  if (el.isConnected && view.screen === 'list') await repaint(el, el.scrollTop);
}
function wireBusy(el, b) {
  el.querySelectorAll('[data-busy]').forEach(btn => btn.onclick = async () => {
    if (btn.dataset.busy === b?.switch) return;
    el.querySelectorAll('[data-busy]').forEach(x => { x.disabled = true; });
    try { await careAction(world.dev, 'busy', { busy: btn.dataset.busy }); sfx.blip(); notes.delete('busy'); } catch (e) { notes.set('busy', e.message); }
    await repaint(el, el.scrollTop);
  });
}
// Approve / Not now on a remedy, in one tap, wherever it shows (the list, or the card it belongs to)
function wireRemedies(el) {
  el.querySelectorAll('.cr-remedy').forEach(box => {
    const request = Number(box.dataset.remedy), key = `r${request}`;
    const answer = async approve => {
      box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await careAnswer(world.dev, request, approve); notes.delete(key);
        if (approve) { sfx.ding(0.6); toast(`<b>Approved</b><br>${esc(box.querySelector('.t b')?.textContent ?? '')}`); } else sfx.blip();
      } catch (e) { notes.set(key, e.message); }
      await repaint(el, el.scrollTop);
    };
    box.querySelector('[data-approve]').onclick = () => answer(true);
    box.querySelector('[data-decline]').onclick = () => answer(false);
  });
}

// ---------------------------------------------------------------- a card
function cardHtml(c, d) {
  const bug = c.kind === 'bug', open = ['waiting', 'unsure', 'sending', 'mailing'].includes(c.status);
  const facts = Object.entries(c.facts && typeof c.facts === 'object' ? c.facts : {});
  // an object in the facts (the customer's report) reads as its parts, not as code; a claim's deadline as days
  const json = v => Array.isArray(v) ? v.map(json).join(', ') : v !== null && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${json(x)}`).join(' · ') : String(v ?? '');
  const deadline = d => [d.safe && `safe by ${dayOf(d.safe)}`, d.likely && `likely ${dayOf(d.likely)}`, d.passed === 'safe' ? 'the safe one has passed' : d.passed === 'both' ? 'both have passed' : ''].filter(Boolean).join(' · ');
  const fact = (k, v) => k === 'deadline' && v && typeof v === 'object' ? deadline(v) : json(v);
  // (the summary as prose)
  return `<div class="cr cr-card" data-private>
    <div class="cr-h"><div><b>${esc(kindOf(c))}</b><span>${esc(c.case)} · ${esc(c.appName ?? c.app)} · ${esc(String(c.lang ?? '').toUpperCase())} · since ${esc(when(c.since ?? c.created))} (${esc(ago(c.since ?? c.created))})</span></div><div class="rt">${open && !bug && !feedbackNote(c) ? due(c) : ''}${signal}</div></div>
    ${banner(c)}
    ${c.words && !ours(c) ? `<section class="cr-words"><h4>${feedbackNote(c) ? 'In the helper’s words' : 'In their own words'}</h4><blockquote class="txt">${esc(c.words)}</blockquote></section>` : ''}
    <section class="cr-facts"><h4>The facts</h4><dl>
      ${bug || feedbackNote(c) || c.kind === 'claim' ? '' : `<dt>Who</dt><dd>${mark(c)}</dd>`}${c.to && !bug ? `<dt>${c.kind === 'claim' ? 'The customer' : 'Reply to'}</dt><dd>${esc(c.to)}</dd>` : ''}
      ${bug ? '<dt>Reply to</dt><dd>None: a bug report carries only the picture and the log</dd>' : ''}
      ${feedbackNote(c) ? '<dt>Reply to</dt><dd>None: written in general words, refused with an email address or a phone or order number in it</dd>' : ''}
      ${facts.map(([k, v]) => `<dt>${esc(FACT[k] ?? k.replace(/_/g, ' '))}</dt><dd>${k === 'person_case' && bug ? personCase(c, v) : esc(fact(k, v))}</dd>`).join('')}</dl></section>
    ${c.summary ? `<section class="cr-sum"><h4>Summary</h4><div class="txt prose">${prose(c.summary)}</div></section>` : ''}
    ${bug ? bundleHtml(c) : ''}
    ${(c.photos ?? []).length ? photosHtml(c) : ''}
    ${(c.lines ?? []).length ? `<section class="cr-lines"><h4>The conversation</h4><ol>${c.lines.map(l => lineHtml(l, c)).join('')}</ol></section>` : ''}
    ${c.canAnswer ? answerHtml(c) : ''}
    ${(c.remedies ?? []).length ? `<section class="cr-sec remedies"><h4>Waiting for your tap</h4>${c.remedies.map(remedyHtml).join('')}</section>` : ''}
    ${bug ? bugActs(c) : feedbackNote(c) ? noteActs(c) : replyHtml(c, d)}
    ${(c.actions ?? []).length ? actionsHtml(c) : ''}
    ${moreHtml(c)}
  </div>`;
}
// a feedback note's one action, where a reply would be: Close, once read
const noteActs = c => c.status === 'waiting' ? '<div class="cr-acts one"><button class="cta" data-close-card>Close: no reply needed</button></div>' : '';
// a bug's conversation with a person: its card is where a reply to the customer goes
const personCase = (c, ref) => c.personCard ? `<button class="cr-link" data-open-card="${Number(c.personCard)}">${esc(ref)} · open it to reply</button>`
  : `${esc(ref)} <span class="dim">(not in Care: deleted, or not here yet)</span>`;
// More: Close (an open card), an email's "Not a customer: back to Mail", and Delete at the customer's request, with a
// confirm step that says what goes. Not while a reply is on its way (the coordinator refuses it then too). The buttons
// say it all.
function moreHtml(c) {
  if (['sending', 'mailing'].includes(c.status)) return '';
  // what's on this card, in words (whatever it holds goes: this is so the board knows what it's deleting)
  const lines = c.lines ?? [], what = [c.words && 'their words', c.summary && 'the summary', lines.some(l => l.who !== 'note') && 'the conversation',
    c.draft && 'the draft', c.bundle && 'the picture and the log', (c.photos ?? []).length && 'the photos', lines.some(l => l.mail) && 'the emails on it (in Mail too)'].filter(Boolean);
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0] ?? 'everything on it';
  const close = !feedbackNote(c) && ['waiting', 'unsure', 'team'].includes(c.status) ? '<button data-close-card>Close: no reply needed</button>' : '';
  const tomail = c.kind === 'email' && c.status === 'waiting' ? '<button data-tomail>Not a customer: back to Mail</button>' : '';
  const erase = ui.erasing ? `<div class="cr-erase" role="group" aria-label="Delete this case"><p><b>Delete ${esc(c.case)} for good?</b> ${esc(list[0].toUpperCase() + list.slice(1))} go from HQ now, and the care service deletes its copy. Only the reference ${esc(c.case)} is kept. This can’t be undone.</p>
      <div class="cr-two"><button class="danger" data-erase-go>Delete it</button><button data-erase-cancel>Keep it</button></div>${ui.eraseMsg ? `<p class="cr-msg" role="status">${esc(ui.eraseMsg)}</p>` : ''}</div>`
    : '<button data-erase>Delete: the customer asked</button>';
  return `<details class="cr-more"${ui.erasing || ui.more ? ' open' : ''}><summary>More</summary>${close}${tomail}${erase}</details>`;
}
function banner(c) {
  if (c.status === 'team') return `<p class="cr-banner team">With the team${c.job ? ` (job ${jobNameLink(c.job, c.job_code)})` : ''}: nothing for you to do yet. The answer comes back here as a draft.${c.newReply ? ' <b>The customer wrote again since</b>: it’s in the conversation below.' : ''}</p>`;
  if (c.status === 'unsure') return `<div class="cr-banner warn"><p><b>This reply may or may not have gone.</b> ${esc(c.error || 'The email service didn’t answer.')} Send it again, or leave it if it went.</p>
    <div class="cr-two"><button data-unsure="0">Send again</button><button data-unsure="1">Leave it: it went</button></div>${ui.msg ? `<p class="cr-msg" role="status">${esc(ui.msg)}</p>` : ''}</div>`;
  // to whom the last send went (a claim's: the partner), as its line in the conversation says
  const to = (c.lines ?? []).filter(l => l.who === 'board' && l.to).at(-1)?.to ?? c.to;
  if (DONE[c.status]) return `<p class="cr-banner done">${esc(DONE[c.status])}${c.sentAt && c.status === 'sent' ? ` ${esc(when(c.sentAt))}` : ''}${to && c.status === 'sent' ? ` to ${esc(to)}` : ''}.</p>`;
  return [c.newReply ? '<p class="cr-banner new"><b>New reply</b>: the customer’s email came in since your last reply. It’s in the conversation below.</p>' : '',
    c.error && c.status === 'waiting' ? `<p class="cr-banner warn"><b>The last send didn’t go:</b> ${esc(c.error)}</p>` : ''].join('');
}
function lineHtml(l, c) {
  const email = l.who === 'email';
  // the partner's domain, not a checked sender (nothing reaches HQ to prove who sent it): the card says only that much
  const who = email && l.from ? `Email from ${l.from}${l.partner && c.claim ? `, at ${c.claim.name}’s address` : ''}` : l.who === 'board' && l.to ? `You, to ${l.to}` : WHO[l.who] ?? 'The chat’s AI';
  return `<li class="ln ${esc(l.who)}"><p class="meta"><b>${esc(who)}</b> · ${esc(when(l.at))}${email && l.matches === false ? ' <span class="warn">from another address than this card’s</span>' : ''}${l.health ? ' <span class="health">sent to a person from the health card: for you only, no AI reads it</span>' : ''}</p>
    <p class="txt">${email ? emailHtml(l.text) : esc(l.text)}</p>${email && c.kind === 'email' && l === firstOf(c, 'email') ? translated(c) : ''}${email && l.mail ? `<button class="cr-mail" data-mail="${Number(l.mail)}">${icon('mail', 'small')}Open in Mail</button>` : ''}</li>`;   // an email's text as Mail shows it
}
// ---------------------------------------------------------------- an email to the company (job #3318)
// The customer's words in the board's language (care's machine translation, of the first email: card.words) folded under
// that email; HQ leaves it out of a card in the board's own language
const firstOf = (c, who) => (c.lines ?? []).find(l => l.who === who);
const translated = c => c.boardWords ? `<details class="cr-tr"><summary>Translated</summary><p class="txt">${emailHtml(c.boardWords)}</p>
    <p class="sm">Machine-made, of the email as it came.</p></details>` : '';
// a bug report: what the customer's page showed and logged. The picture is an <img> from Care's own address only.
function bundleHtml(c) {
  const b = c.bundle;
  if (!b) return '<p class="cr-none">The page’s report is gone: its picture, log and summary are deleted once the bug is fixed, or after 90 days.</p>';
  const secs = ms => `+${(Number(ms) / 1000).toFixed(1)} s`;
  return `<section class="cr-bundle"><h4>The page</h4><p>${esc(b.page?.path ?? '')}${b.page?.w ? ` · ${Number(b.page.w)} × ${Number(b.page.h)}` : ''}${b.at ? ` · ${esc(when(b.at))}` : ''}</p>
    ${b.picture ? `<figure class="cr-pic"><img src="${esc(carePicture(world.dev, c.id))}" alt="What the customer’s screen showed" loading="lazy"></figure>` : ''}
    ${(b.events ?? []).length ? `<h4>What the page logged</h4><ol class="cr-log">${b.events.map(e => `<li class="k-${esc(e.kind)}"><span class="at">${esc(secs(e.at))}</span><span class="k">${esc(e.kind)}</span><span class="txt">${esc(e.text)}</span></li>`).join('')}</ol>` : ''}</section>`;
}
// a claim's photos, as the customer took them: images from Care's own address only; a tap shows one full width. Each goes
// with the first email to the partner after it came, so one that came after the claim says it hasn't gone yet.
function photosHtml(c) {
  const name = esc(c.claim?.name ?? ''), waiting = c.photos.filter(p => !p.sent).length;
  const note = !c.claim ? 'for you only' : !waiting ? `went to ${name}` : c.claim.sent ? `the ones marked “not sent yet” go with your next email to ${name}` : `attached to the email to ${name}`;
  return `<section class="cr-photos"><h4>The customer’s photos<em>${note}</em></h4>
    <ul>${c.photos.map(p => `<li${ui.big === p.name ? ' class="big"' : ''}><button data-photo="${esc(p.name)}" aria-label="${ui.big === p.name ? 'Smaller' : 'Bigger'}: ${esc(p.name)}"><img src="${esc(carePhoto(world.dev, c.id, p.name))}" alt="The customer’s photo ${esc(p.name)}" loading="lazy"></button><small>${esc(p.name)}${c.claim?.sent && !p.sent ? ' · not sent yet' : ''}</small></li>`).join('')}</ul></section>`;
}
// A claim: the supplier's answer, noted by the board once it has read their reply (the note then stands in the
// conversation). "They make a new one" only once the claim went; "We make it ourselves" any time: for a no, or when it
// can't wait
function answerHtml(c) {
  const name = esc(c.supplier ?? 'the supplier');
  return `<section class="cr-answer"><h4>${name}’s answer<em>once you’ve read their reply</em></h4>
    <div class="cr-two">${c.claim?.sent ? `<button data-claim-answer="supplier">${icon('tick', 'small')}${name} makes a new one</button>` : ''}<button data-claim-answer="ours">We make it ourselves</button></div>
    <p class="sm">The customer’s new one waits on their answer. “We make it ourselves” places it as our own order, if they said no or it can’t wait${c.claim?.sent ? `: tell ${name} to stop, or they may make one too` : ''}.</p></section>`;
}
// The company's own buttons on the case (its kits', each on the address the case replies to, named in the heading, open card
// or closed: a rematch moves them to the new one): rarely needed, so
// low on the card and quiet. Each its button with its hint under it; once done, its label with a tick, no button. A
// refusal shows here, in its own words
function actionsHtml(c) {
  return `<section class="cr-actions"><h4>For ${esc(c.to ?? 'this customer')}<em>when they ask</em></h4>
    ${c.actions.map(a => a.done ? `<p class="done">${icon('tick', 'small')}<span>${esc(a.label)}</span><span class="sm">done</span></p>`
      : `<div class="act"><div class="cr-two"><button data-case-action="${esc(a.id)}">${esc(a.label)}</button></div><p class="sm">${esc(a.hint)}</p></div>`).join('')}
    ${ui.actionMsg ? `<p class="cr-msg" role="status">${esc(ui.actionMsg)}</p>` : ''}</section>`;
}
function bugActs(c) {
  if (c.status !== 'waiting' && c.status !== 'team') return '';
  return `<div class="cr-acts bug"><button class="cta" data-fixed>${icon('tick', 'small')}Fixed</button>${c.owner ? `<button data-handoff>Hand to ${esc(c.owner)}</button>` : ''}</div>
    <p class="sm">Fixed deletes the page’s picture and log.${c.owner ? ` Hand to ${esc(c.owner)} makes it a job for the app’s owner.` : ''}</p>${ui.msg ? `<p class="cr-msg" role="status">${esc(ui.msg)}</p>` : ''}`;
}
// The reply: the draft to edit in place (or, once sent, what went), the sign-off under it, and the three buttons. A claim's
// card writes to the partner (or, once someone wrote back, to whoever did): a To switch, and Send names where it goes.
// While the team redrafts as the board asked, the draft is shown as it stands, not as a field (so the screen still
// refreshes and shows the redraft when it comes), with Take it back.
function replyHtml(c, d) {
  if (c.status === 'team') return '';
  // (the board's own text only over the draft it was typed on: one the team put on the card since shows instead, and
  // the board's is under Back to the text before)
  const editing = c.status === 'waiting' && !c.asking, partner = toPartner(c), text = (ui.over === (c.draft ?? '') ? ui.text : undefined) ?? c.draft ?? '';
  // the photos this email takes (those that haven't gone yet), and those the claim lists that haven't reached HQ yet
  const attach = partner ? (c.photos ?? []).filter(p => !p.sent).length : 0, due = partner && !c.claim?.sent ? c.photosDue ?? [] : [];
  const shots = due.map(s => String(s).replace(/_/g, ' ')).join(', ');
  const where = partner ? c.claim?.to : c.to, name = partner ? c.claim?.name ?? 'the supplier' : 'the customer';
  const by = c.health && !c.asking ? healthBy(c)
    : c.kind === 'rights' ? '<b>A data request: written by you, no AI draft.</b> Handle it, then write the reply here. Nothing goes out until you send it.'
    : c.asking ? `<b>The team is redrafting it</b> as you asked (${esc(ago(c.asking.at))}): it comes back here, and nothing is sent.`
    : partner && !c.claim?.sent ? `<b>Drafted for you</b> from the claim’s facts. Nothing goes out until you send it${attach ? `, with ${attach === 1 ? 'its photo' : `its ${attach} photos`} attached` : ''}.`
      + (due.length ? ` <b>${due.length === 1 ? 'A photo' : `${due.length} photos`} still on ${due.length === 1 ? 'its' : 'their'} way</b> (${esc(shots)}): Send waits for ${due.length === 1 ? 'it' : 'them'}, usually a few minutes.` : '')
    : partner && attach ? `Nothing goes out until you send it. ${attach === 1 ? 'A photo that came after the claim goes' : `${attach} photos that came after the claim go`} with it.`
    // a plain draft needs no line
    : c.teamDraft ? '<b>Drafted by the AI team.</b>' : c.draft || partner || c.kind === 'claim' ? ''
    : c.drafting ? '<b>Care is writing a draft</b>: it comes here in a minute or so.'
    : 'No draft yet.';
  const toSwitch = c.claim && c.to && ['waiting', 'unsure'].includes(c.status) && !c.asking
    ? `<p class="cr-to" role="radiogroup" aria-label="Who it goes to"><span>To</span>${[['partner', c.claim.name], ['customer', 'The customer']].map(([k, t]) => `<button role="radio" data-to="${k}" aria-checked="${c.sendTo === k}">${esc(t)}</button>`).join('')}</p>` : '';
  const draft = `<section class="cr-draft"><h4>${editing || c.asking ? (partner ? `Email to ${esc(name)}` : 'Draft reply') : 'The reply'}${where ? `<em>by email to ${esc(where)}</em>` : ''}</h4>
    ${toSwitch}${(editing || c.asking) && by ? `<p class="cr-by">${by}</p>` : ''}
    <div class="paper">${editing ? `<label class="sr" for="cr-draft">${partner ? 'The email' : 'The reply'}</label><textarea id="cr-draft" rows="8" spellcheck="true">${esc(text)}</textarea>` : `<p class="txt">${esc(c.draft ?? '')}</p>`}
      <p class="sign">${esc(c.signoff ?? '')}</p></div>${editing ? '<p class="cr-saved" data-saved role="status"></p>' : ''}
    ${editing && c.canGoBack ? '<p class="cr-back"><button data-back>Back to the text before the redraft</button></p>' : ''}
    ${c.translation && !partner && (editing || c.asking) ? `<details class="cr-tr"><summary>Translated</summary><p class="txt">${esc(c.translation)}</p>
      <p class="sm">Machine-made, of the draft as the team wrote it${c.edited ? ': your edits aren’t in it' : ''}. Only the ${esc(String(c.lang).toUpperCase())} text above goes out.</p></details>` : ''}</section>`;
  if (c.status === 'sending' || c.status === 'mailing') return draft + sentHtml(c); // (mailing: past its Undo, with the email service now)
  if (c.asking) return draft + `<p class="cr-asked">${icon('redo', 'small')}<span>You asked for: <q>${esc(c.asking.ask)}</q></span><button data-unask>Take it back</button></p>
    <div class="cr-acts one"><button data-later>Not now</button></div>${ui.msg ? `<p class="cr-msg" role="status">${esc(ui.msg)}</p>` : ''}`;
  if (!editing) return draft;
  const ask = ui.asking ? `<div class="cr-ask"><h4>Ask for changes<em>the team redrafts it, then it’s back here · nothing is sent</em></h4>
      <label class="sr" for="cr-ask">What to change</label><textarea id="cr-ask" rows="3" placeholder="What to change, or what to find out first">${esc(ui.ask ?? '')}</textarea>
      <div class="cr-two"><button class="cta" data-ask-go>${icon('redo', 'small')}Ask the team</button><button data-ask-cancel>Cancel</button></div></div>` : '';
  const naming = ui.naming ? `<div class="cr-naming"><p><b>Your name for the sign-off is missing.</b> Every reply ends with it. Set it here (or in Settings), then it sends.</p>
      <div class="cr-name"><label class="sr" for="cr-name">Your name on replies</label><input id="cr-name" maxlength="60" autocomplete="name" placeholder="Your name"><button class="cta" data-name-send>Save and send</button></div></div>` : '';
  // the team redrafts person and question cards; a claim card's emails (to the partner or the customer) and an email's
  // reply are the board's own to edit (and no AI writes a health case's or a data request's)
  const own = c.kind === 'claim' || c.kind === 'rights' || ours(c) || !!c.health;
  const acts = `<div class="cr-acts${own ? ' two' : ''}"><button data-later>Not now</button>${own ? '' : `<button data-ask${ui.asking ? ' aria-pressed="true"' : ''}>${icon('redo', 'small')}Ask for changes</button>`}<button class="send" data-send>${icon('mail', 'small')}${partner ? `Send to ${esc(name)}` : 'Send by email'}</button></div>`;
  const without = editing && due.length ? `<p class="cr-without"><button data-send-without>Send without the missing ${due.length === 1 ? 'photo' : 'photos'}</button> <span class="sm">If ${due.length === 1 ? 'it comes' : 'they come'} later, ${due.length === 1 ? 'it goes' : 'they go'} with your next email to ${esc(name)}.</span></p>` : '';
  return draft + ask + naming + acts + without + (ui.msg ? `<p class="cr-msg" role="status">${esc(ui.msg)}</p>` : '') + (d.email === false ? '<p class="sm">The email key isn’t on the server yet, so Send can’t send anything.</p>' : '');
}
// A health case's line over its draft. A claim's draft (the supplier's email) came from a template, but HQ can't tell it
// from a model's text on the card: the sign-off still says AI helped, the safe side, and the card says why. An email's:
// HQ's own check found a term in it; a chat's: the customer sent it to a person
const healthBy = c => c.aiDrafted && c.claim
  ? '<b>Health detail: no AI redrafts this.</b> A draft was on this claim before the customer sent a health detail to a person, so your reply’s sign-off says our AI team helped. Edit it yourself; nothing goes out until you send it.'
  : c.aiDrafted
    ? `<b>Health detail: no AI redrafts this.</b> The AI team drafted it before ${ours(c) ? 'a message came that may mention a health detail' : 'the customer sent a health detail to a person'}. Edit it yourself; nothing goes out until you send it.`
    : `<b>Health detail: written by a person, no AI draft.</b> ${ours(c) ? 'It may mention a health detail, so no AI read it or writes its reply' : 'The customer sent it to a person, so no AI reads this case or writes its reply'}. Write it here; nothing goes out until you send it.`;
// "Sent" with Undo for 10 seconds, counting down (by this device's clock from the moment it was sent here, so a clock
// that's off doesn't shorten it; one opened later counts from the server's undoUntil)
function sentHtml(c) {
  const left = undoLeft(c);
  const to = toPartner(c) ? c.claim?.to : c.to;
  return `<div class="cr-sent">${icon('tick', 'small')}<span><b>Sent</b>${to ? ` to ${esc(to)}` : ''}</span>${left > 0 ? `<button data-undo>Undo (<i data-undo-n>${Math.ceil(left / 1000)}</i> s)</button>` : '<span class="sm">On its way.</span>'}</div>${ui.msg ? `<p class="cr-msg" role="status">${esc(ui.msg)}</p>` : ''}`;
}
const undoLeft = c => c.status !== 'sending' ? 0 : ui.undoEnd ? ui.undoEnd - Date.now() : Math.min(10_000, Date.parse(c.undoUntil) - Date.now()) || 0;

function wireCard(el, c, d) {
  const id = c.id, $ = s => el.querySelector(s);
  wireRemedies(el);
  el.querySelectorAll('[data-mail]').forEach(b => b.onclick = async () => { await saveDraft(el, c); go.mail?.(Number(b.dataset.mail)); });
  // the draft: grows with its text, saved when the field loses focus
  const ta = $('#cr-draft');
  if (ta) {
    requestAnimationFrame(() => grow(ta)); ta.oninput = () => { ui.text = ta.value; ui.over = c.draft ?? ''; grow(ta); };
    ta.onblur = () => saveDraft(el, c);
  }
  // A draft save under way first (one at a time, saveDraft), so a `was` sent after it is the draft that save leaves on the
  // card; false once the board has left this card meanwhile, and nothing is posted
  const settled = async () => { while (c.saving) await c.saving; return view.id === id && el.isConnected; };
  const act = async (what, body, done) => {
    el.querySelectorAll('.cr-card button').forEach(b => { b.disabled = true; });
    try { const r = await careAction(world.dev, what, body); ui.msg = ''; await done?.(r); }
    catch (e) { ui.msg = e.message; }
    if (view.id === id && el.isConnected) await repaint(el);
  };
  $('[data-later]')?.addEventListener('click', () => toList(el));
  $('[data-ask]')?.addEventListener('click', () => { ui.asking = !ui.asking; sfx.blip(); repaint(el).then(() => $('#cr-ask')?.focus()); });
  $('[data-ask-cancel]')?.addEventListener('click', () => { ui.asking = false; ui.ask = ''; repaint(el); });
  const askField = $('#cr-ask');
  if (askField) askField.oninput = () => { ui.ask = askField.value; };
  // Ask the team: the words, and the draft as it stands now (the board's edits in it), which the team redrafts from
  $('[data-ask-go]')?.addEventListener('click', async () => {
    const text = askField.value.trim(), field = $('#cr-draft');
    if (!text) { askField.focus(); return; }
    const draft = field?.value ?? c.draft ?? '';
    if (!await settled()) return;
    act('ask', { id, text, draft, was: c.draft ?? '' }, () => { ui.asking = false; ui.ask = ''; ui.text = undefined; askField.value = ''; if (field) field.value = ''; sfx.ding(0.6); });
  });
  $('[data-unask]')?.addEventListener('click', () => act('unask', { id }, () => sfx.blip()));
  // `seen`, as Send has it: a reply that came in since this card was drawn is refused, and the repaint shows it
  el.querySelectorAll('[data-claim-answer]').forEach(b => b.onclick = () =>
    act('claim-answer', { id, answer: b.dataset.claimAnswer, seen: Math.max(0, ...(c.lines ?? []).map(l => Number(l.id) || 0)) }, () => sfx.blip()));
  // a company's own button: what it did stands in the conversation, a refusal under the buttons; `to`, the address its
  // heading named, so a card rematched since isn't acted on
  el.querySelectorAll('[data-case-action]').forEach(b => b.onclick = async () => {
    el.querySelectorAll('.cr-card button').forEach(x => { x.disabled = true; });
    try { await careAction(world.dev, 'action', { id, action: b.dataset.caseAction, to: c.to }); ui.actionMsg = ''; sfx.blip(); }
    catch (e) { ui.actionMsg = e.message; }
    if (view.id === id && el.isConnected) await repaint(el);
  });
  $('[data-back]')?.addEventListener('click', async () => { if (await settled()) act('back', { id, was: c.draft ?? '' }, () => { ui.text = undefined; sfx.blip(); }); });
  // a claim's To: the text in the box stays (saved first), only where it goes changes
  el.querySelectorAll('[data-to]').forEach(b => b.onclick = async () => {
    if (b.getAttribute('aria-checked') === 'true') return;
    await saveDraft(el, c);
    act('to', { id, to: b.dataset.to }, () => sfx.blip());
  });
  $('[data-tomail]')?.addEventListener('click', () => act('tomail', { id }, () => { toast(`<b>Back to Mail</b><br>${esc(c.case)}: later mail from this address stays in Mail.`); toList(el); }));
  el.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => { ui.big = ui.big === b.dataset.photo ? null : b.dataset.photo; repaint(el); });
  const send = async (without = false) => {
    const field = $('#cr-draft'), reply = field?.value ?? '', text = reply.trim();
    if (!text) { ui.msg = 'Write the reply first: it’s empty.'; await repaint(el); $('#cr-draft')?.focus(); return; }
    if (d.email === false) { ui.msg = 'The email key isn’t on the server yet, so nothing was sent.'; return repaint(el); }
    if (!d.name) { ui.naming = true; ui.msg = ''; await repaint(el); $('#cr-name')?.focus(); return; }
    // the save the tap on Send started goes first (its `was` is the draft it leaves); the reply is the text read above
    if (!await settled()) return;
    // `seen`: the last line this card showed. One that came in since (the card isn't redrawn while the reply is edited) is
    // refused by the server, and the repaint below shows it, the reply as edited kept
    const seen = Math.max(0, ...(c.lines ?? []).map(l => Number(l.id) || 0));
    // `to`: whom this card showed it going to. If the card writes to someone else since (another tab, a reply that came in),
    // the server refuses it and the repaint shows where it goes now
    // `was`: the draft this card was drawn with. One the team put on it since is refused and shown
    await act('send', { id, text: reply, seen, to: c.sendTo, was: c.draft ?? '', ...(without ? { without: true } : {}) }, r => {
      sfx.jingle(); ui.text = undefined; ui.naming = false;
      const left = Date.parse(r?.undoUntil) - Date.now();
      ui.undoEnd = Date.now() + (left > 0 && left <= 10_500 ? left : 10_000);
      field.value = ''; field.blur(); // sent: nobody is typing here any more
    });
  };
  $('[data-send]')?.addEventListener('click', () => send());
  $('[data-send-without]')?.addEventListener('click', () => send(true));
  $('[data-name-send]')?.addEventListener('click', async () => {
    const f = $('#cr-name'), name = f.value.trim();
    if (!name) { f.focus(); return; }
    try { await careAction(world.dev, 'name', { name }); d.name = name; f.value = ''; ui.naming = false; await send(); }
    catch (e) { ui.msg = e.message; repaint(el); }
  });
  $('[data-undo]')?.addEventListener('click', () => act('undo', { id }, () => { ui.undoEnd = 0; ui.text = undefined; sfx.blip(); toast('<b>Not sent</b><br>The reply is back on the card.'); }));
  el.querySelectorAll('[data-unsure]').forEach(b => b.onclick = () => act('unsure', { id, went: b.dataset.unsure === '1' }, () => { sfx.blip(); if (b.dataset.unsure === '1') toList(el); }));
  el.querySelectorAll('[data-close-card]').forEach(b => b.addEventListener('click', () => act('close', { id }, () => { toast(`<b>Closed</b><br>${esc(c.case)}: no reply needed.`); toList(el); })));
  $('[data-fixed]')?.addEventListener('click', () => act('fixed', { id }, () => { sfx.ding(0.6); toast(`<b>Fixed</b><br>${esc(c.case)}: its picture, log and summary are deleted.`); toList(el); }));
  $('[data-open-card]')?.addEventListener('click', e => openCard(el, Number(e.currentTarget.dataset.openCard)));
  // Delete at the customer's request: the confirm step first; once done, it's gone from the lists here too
  // (the step in view once the draft has grown to its text, a frame after the redraw)
  $('[data-erase]')?.addEventListener('click', () => { ui.erasing = true; sfx.blip();
    repaint(el).then(() => requestAnimationFrame(() => { $('.cr-erase')?.scrollIntoView({ block: 'end' }); $('[data-erase-cancel]')?.focus({ preventScroll: true }); })); });
  const moreBox = $('.cr-more');
  if (moreBox) moreBox.ontoggle = () => { ui.more = moreBox.open; };   // a redraw keeps More as the board left it
  $('[data-erase-cancel]')?.addEventListener('click', () => { ui.erasing = false; ui.eraseMsg = ''; repaint(el); });
  $('[data-erase-go]')?.addEventListener('click', async () => {
    el.querySelectorAll('.cr-card button').forEach(b => { b.disabled = true; });
    try {
      await careAction(world.dev, 'erase', { id });
      if (folds.sent.list) folds.sent.list = folds.sent.list.filter(x => x.id !== id);
      sfx.blip(); toast(`<b>Deleted</b><br>${esc(c.case)}: only its reference is kept.`); toList(el);
    } catch (e) { ui.eraseMsg = e.message; if (view.id === id && el.isConnected) await repaint(el); }
  });
  $('[data-handoff]')?.addEventListener('click', () => act('handoff', { id }, r => { sfx.blip(); toast(`<b>Handed to ${esc(c.owner)}</b>${r?.job ? `<br>job ${jobNameLink(r.job, r.job_code)}` : ''}`); }));
  // the Undo countdown; when it runs out, the card is read again
  clearInterval(tick); tick = null;
  if (c.status === 'sending' && $('[data-undo-n]')) tick = setInterval(() => {
    const n = el.querySelector('[data-undo-n]'), left = undoLeft(c);
    if (!n || !el.isConnected || view.id !== id) { clearInterval(tick); tick = null; return; }
    if (left > 0) { n.textContent = Math.ceil(left / 1000); return; }
    clearInterval(tick); tick = null; ui.undoEnd = 0; repaint(el);
  }, 250);
}
// The draft as edited goes to the server when its field is left, so Not now, Mail or a closed computer keep it
// (one save at a time, and Send waits for it: its `was` is the draft this save leaves on the card). The field and its text
// are this card's, taken before the wait: a card left meanwhile saves its own text to its own id, never the next card's
async function saveDraft(el, c) {
  const ta = el.querySelector('#cr-draft'), said = el.querySelector('[data-saved]');
  if (!ta) return;
  let text = ta.value;
  while (c.saving) await c.saving;
  if (ta.isConnected) text = ta.value;
  if (text === (c.draft ?? '')) return;
  c.saving = careAction(world.dev, 'draft', { id: c.id, text, was: c.draft ?? '' })
    .then(() => { c.draft = text; if (said) said.textContent = 'Draft saved.'; },
      e => { if (said) said.textContent = `The draft wasn’t saved: ${e.message}`; })
    .finally(() => { c.saving = null; });
  await c.saving;
}

// ---------------------------------------------------------------- Care › Numbers
// The support chat's own numbers for one app (coordinator care-numbers.ts, whose comments say
// what each one means): the last 28 finished days, today so far apart (never added in), and HQ's own: reply times, the busy notice,
// open questions, the knowledge base. A count care doesn't send yet is null: it shows as "—" or "not counted yet", never 0.
// Counts only: nothing here leads to a conversation, a customer or an order.
let dayFold = false;                           // the day-by-day table, open or not, kept across redraws
async function numbersData(v) {
  const apps = (await loadCareNumbers(world.dev)).apps ?? [], app = v.app ?? apps[0]?.slug;
  if (!app) return { apps, d: null };
  try { return { apps, d: await loadCareNumbers(world.dev, app, v.mode) }; }
  catch (e) { if (/ 40[04]$/.test(e.message)) return { apps, d: null, gone: true }; throw e; }
}
function openNumbers(el) {
  sfx.blip(); listTop = el.scrollTop; clearInterval(tick); tick = null;
  view = { screen: 'numbers', id: null, app: null, mode: null }; ui = {};
  repaint(el, 0);
}

const NOT_YET = '<span class="cn-na">not counted yet</span>';
// (numbers and euros in the company's formats)
const fmt = (v, dec = 0) => companyFormats().number(Number(v), 'en', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const cnt = v => v == null ? '—' : fmt(v);
const per = v => v == null ? '—' : fmt(v, Number(v) % 1 ? 1 : 0);   // per 100 conversations, already rounded to 0.1
const euro = (v, dec = 2) => v == null ? '—' : companyFormats('EUR').money(Number(v), 'en', { unit: 'major', minimumFractionDigits: Math.min(2, dec), maximumFractionDigits: dec });
const secs = ms => ms == null ? '—' : `${fmt(Number(ms) / 1000, Number(ms) % 1000 ? 1 : 0)} s`;
const wdays = n => n == null ? '—' : Number(n) === 0 ? 'the same day' : plural(Number(n), 'working day', 'working days');
const pctOf = (n, of) => of > 0 ? Math.round(Number(n) / of * 100) : null;
const shortDay = s => companyFormats().day(s, 'en', { short: true });
const span = (a, b) => a && b ? `${shortDay(a)} – ${shortDay(b)} ${String(b).slice(0, 4)}` : '';
const monthName = s => companyFormats().month(s, 'en', { year: true });
const fig = (label, value, small = '', cls = '') => `<div class="cn-fig ${cls}"><span class="l">${label}</span><b class="v">${value}</b>${small ? `<span class="s">${small}</span>` : ''}</div>`;
const SWITCH = { auto: 'Auto', on: 'On', off: 'Off' };
const BANDS = ['≤ 1.5 s', '1.5–3 s', '3–5 s', '> 5 s'];
const WORDS_KIND = { plain: 'Plain answers', lookup: 'Answers that looked something up' };

function numbersHtml({ apps, d, gone }) {
  const head = name => `<p class="cap"><i class="prompt">&gt; </i>CARE · NUMBERS${name ? ` · ${esc(String(name).toUpperCase())}` : ''} ${signal}</p>`;
  const foot = '<p class="cr-foot">COUNTS ONLY · NOTHING HERE LEADS TO A CONVERSATION, A CUSTOMER OR AN ORDER</p>';
  if (!d) return `<div class="cr cn">${head('')}${appSwitch(apps, null)}<p class="cn-banner">${gone ? 'These numbers can’t be had right now: try again in a moment.'
    : 'The support chat hasn’t counted anything yet, for any app. Care sends each day’s numbers once the day is over.'}</p>${foot}</div>`;
  const app = apps.find(a => a.slug === d.slug) ?? { slug: d.slug, name: d.name, status: d.mode, live: d.mode === 'live', preview: d.mode === 'preview' };
  const t = d.totals ?? {}, launched = app.status === 'live';
  const modes = launched || app.live ? `<p class="cn-mode"><span class="cn-seg" role="radiogroup" aria-label="Whose conversations">${[['live', 'Live'], ['preview', 'Preview']]
    .map(([k, w]) => `<button role="radio" data-cn-mode="${k}" aria-checked="${d.mode === k}">${w}</button>`).join('')}</span><span class="sm">${d.mode === 'live' ? 'the customers’ conversations' : 'your and the team’s own tries'}</span></p>` : '';
  // (an app not launched gets no notice: its zeros say it.)
  const banner = d.mode === 'preview' && launched ? '<p class="cn-banner">Preview: the board’s and the team’s own tries, never mixed with the customers’ live numbers.</p>' : '';
  const empty = !t.days ? `<p class="cn-banner">No numbers yet for ${esc(d.name)}${d.mode === 'preview' ? '’s preview' : ''}: care sends a day’s numbers once the day is over.${d.now ? ' Today so far is below.' : ''}</p>` : '';
  return `<div class="cr cn">${head(d.name)}
    ${appSwitch(apps, d.slug)}${modes}${banner}
    <p class="cr-lede">Last ${Number(d.days)} finished days · ${esc(span(d.from, d.to))} · ${d.updated ? `numbers from care ${esc(ago(d.updated))}` : 'nothing from care yet'}</p>
    ${empty}${headline(t)}${todayHtml(d.now)}
    <div class="cn-grid">${replyPart(d.reply, d.busy)}${questionsPart(d, t)}${helpedPart(t)}${outagePart(t)}</div>
    ${wordsPart(d, t)}${costPart(d, t)}
    <section class="cr-sec"><h3>Top questions</h3><p class="cr-none">The questions customers ask most show here once care’s question log reaches HQ.</p></section>
    ${daysPart(d)}${foot}</div>`;
}
function appSwitch(apps, slug) {
  if (apps.length < 2) return '';
  return `<p class="cn-switch cn-apps" role="radiogroup" aria-label="App"><span aria-hidden="true">App</span>${apps.map(a => `<button role="radio" data-cn-app="${esc(a.slug)}" aria-checked="${a.slug === slug}">${esc(a.name)}</button>`).join('')}</p>`;
}
// Conversations, and "resolved without a person" always beside "emails to a person": read together, one can't rise by
// hiding the other
function headline(t) {
  const split = t.resolvedHelped == null && t.resolvedRemedy == null ? '' : `${cnt(t.resolvedHelped)} said it helped · ${cnt(t.resolvedRemedy)} by a remedy`;
  return `<section class="cn-head">
    ${fig('Conversations', cnt(t.conversations), t.conversations == null ? 'not counted yet' : `over ${plural(Number(t.days), 'day', 'days')} with numbers`, 'conv')}
    <div class="cn-pair">
      ${fig('Resolved without a person', cnt(t.resolved), `<em>${per(t.resolvedRate)}</em> per 100 conversations${split ? `<small>${split}</small>` : ''}`)}
      ${fig('Emails to a person', cnt(t.person), `<em>${per(t.personRate)}</em> per 100 conversations<small>each one answered by you, by email</small>`)}
      <p class="cn-rule">Read these two together: if resolved rises while emails fall, check that the way to a person wasn’t made harder.</p>
    </div></section>`;
}
function todayHtml(n) {
  if (!n) return '<p class="cn-today none"><b>Today so far:</b> nothing in yet. Care is asked for it while this screen is open.</p>';
  return `<p class="cn-today"><b>Today so far</b><span class="sm">${n.at ? `as of ${esc(timeOf(n.at))} · ` : ''}not in the numbers above</span><br>
    ${cnt(n.conversations)} conversations · ${cnt(n.resolved)} resolved without a person · ${cnt(n.person)} emails to a person · ${cnt(n.questions)} new questions · ${euro(n.cost)}</p>`;
}
function replyPart(r, b) {
  r ??= {};
  const decided = Number(r.answered ?? 0) + Number(r.late ?? 0), aim = Number(r.aim ?? 3);
  const busy = b ? `<div class="cr-busy cn-busy${b.on ? ' on' : ''}"><p class="state"><i aria-hidden="true"></i><b>Busy notice: ${b.on ? 'on now' : 'off now'}</b>${b.on && b.why ? `<span>: ${esc(b.why)}</span>` : ''}</p>
    ${b.held ? `<p class="held">On anyway: someone has waited over ${aim} working days. It goes off by itself once they have their reply.</p>` : ''}
    <p class="sm">Its switch says ${esc(SWITCH[b.switch] ?? 'Auto')}: change it on Care’s list.</p></div>` : '';
  return `<section class="cr-sec cn-reply"><h3>Reply time</h3>
    <p class="cn-aim">The chat tells customers we aim to reply within ${plural(aim, 'working day', 'working days')}.</p>
    <p class="cn-big"><b>${r.share == null ? '—' : `${fmt(r.share, Number(r.share) % 1 ? 1 : 0)}%`}</b><span>within ${aim} working days${decided ? `<small>${cnt(r.within)} of ${cnt(decided)}: those answered, and those still waiting past ${aim}</small>` : '<small>nothing to measure yet in these days</small>'}</span></p>
    <dl class="cn-dl"><dt>Answered</dt><dd>${cnt(r.answered)}${r.answered ? ` · median ${esc(wdays(r.median))} · longest ${esc(wdays(r.longest))}` : ''}</dd>
      <dt>Waiting now</dt><dd>${cnt(r.waiting)}${r.oldest ? ` · the oldest for ${esc(wdays(r.oldest.days))}` : ''}</dd>
      <dt>Closed, no reply</dt><dd>${cnt(r.closed)}</dd></dl>${busy}</section>`;
}
function questionsPart(d, t) {
  const q = d.questions ?? {}, kb = d.kb ?? {}, team = (q.team ?? []).map(j => `job ${jobNameLink(j.job, j.job_code)} (${esc(j.status ?? 'unknown')})`);
  const open = [...team, q.board ? `${cnt(q.board)} waiting for you here in Care` : ''].filter(Boolean).join(', ');
  return `<section class="cr-sec cn-questions"><h3>Questions and knowledge</h3><dl class="cn-dl">
    <dt>New questions</dt><dd>${t.questions == null ? NOT_YET : `${cnt(t.questions)} · ${per(t.questionRate)} per 100 conversations`}<small>should fall as the knowledge base fills</small></dd>
    <dt>Open now</dt><dd>${cnt(q.open)}${open ? `: ${open}` : ''}</dd>
    <dt>Knowledge base</dt><dd>${plural(Number(kb.entries ?? 0), 'entry', 'entries')}<small>${cnt(kb.shared)} shared · ${cnt(kb.own)} ${esc(d.name)}’s own</small></dd></dl></section>`;
}
function helpedPart(t) {
  const h = t.helped ?? {};
  return `<section class="cr-sec cn-helped"><h3>Did this help?</h3>${h.asked == null ? `<p class="cr-none">Not counted yet: the chat doesn’t ask it yet.</p>`
    : `<div class="cn-figs">${fig('Asked', cnt(h.asked))}${fig('Yes', cnt(h.yes), h.asked ? `${pctOf(h.yes, h.asked)}%` : '')}${fig('Not really', cnt(h.no), h.asked ? `${pctOf(h.no, h.asked)}%` : '')}</div>`}
    <p class="sm">Asked once per conversation, only after an outcome, never in the middle of one.</p></section>`;
}
function outagePart(t) {
  return `<section class="cr-sec cn-outage"><h3>When the chat was down</h3><div class="cn-figs two">
    ${fig('The provider was down', t.outage == null ? NOT_YET : `${cnt(t.outage)} min`, 'The AI provider’s outage: not ours to fix.')}
    ${fig('Past our cap', t.cap == null ? NOT_YET : `${cnt(t.cap)} min`, 'Our own spending cap stopped it: our choice, not the provider’s fault.')}</div></section>`;
}
// First words: each kind's replies by band, as shares of one bar (bands add up across days; p50/p95 don't, so they're
// only ever read per day), and each target read both ways
function wordsPart(d, t) {
  const kinds = ['plain', 'lookup'].map(kind => {
    const b = t.bands?.[kind] ?? [], n = b.reduce((s, x) => s + Number(x ?? 0), 0), counted = b.some(x => x != null);
    const replies = t.replies?.[kind];
    const bar = !counted ? '<p class="cr-none">Not counted yet.</p>' : !n ? '<p class="cr-none">No replies of this kind in these days.</p>'
      : `<div class="cn-bar" role="img" aria-label="${esc(WORDS_KIND[kind])}: ${BANDS.map((w, i) => `${w} ${pctOf(b[i] ?? 0, n)}%`).join(', ')}">${b.map((x, i) => Number(x) > 0
        ? `<i class="b${i}" style="flex-grow:${Number(x)}" title="${BANDS[i]}: ${fmt(x)} of ${fmt(n)} replies"></i>` : '').join('')}</div>
      <ul class="cn-legend">${b.map((x, i) => `<li><i class="b${i}" aria-hidden="true"></i>${BANDS[i]} <b>${pctOf(x ?? 0, n)}%</b></li>`).join('')}</ul>`;
    const goals = (d.targets ?? []).filter(g => g.kind === kind).map(g => {
      const [cls, words] = g.met === true ? ['ok', `${icon('tick', 'small')}met`] : g.met === false ? ['no', 'missed'] : g.replies ? ['mid', 'the bands can’t tell'] : ['mid', 'no replies yet'];
      return `<li><span class="g">${esc(g.p)} ≤ ${esc(secs(g.ms))}</span><span class="m ${cls}">${words}</span><span class="sm">${Number(g.days) ? `met on ${cnt(g.daysMet)} of ${plural(Number(g.days), 'day', 'days')}` : 'no day’s own figure yet'}</span></li>`;
    }).join('');
    return `<div class="cn-kind"><p class="hd"><b>${esc(WORDS_KIND[kind])}</b><span>${replies == null ? 'not counted yet' : plural(Number(replies), 'reply', 'replies')}</span></p>${bar}${goals ? `<ul class="cn-goals">${goals}</ul>` : ''}</div>`;
  }).join('');
  return `<section class="cr-sec cn-words"><h3>First words</h3>
    <p class="sm">From the customer’s last message to the chat’s first bubble. A target is read from all the replies’ bands (where a target falls inside a band, the bands can’t tell), and as the days whose own p50 or p95 met it: those are per day only, never averaged.</p>
    <div class="cn-kinds">${kinds}</div></section>`;
}
// Cost: the period's, and the month (every app together) against care's cap as a meter, with this app's part and HQ's own
// email drafts' part (job #4184: the hq part), each only when there's some
function costPart(d, t) {
  const m = d.month ?? {}, cap = m.cap == null ? null : Number(m.cap), top = Math.max(Number(m.console ?? 0), cap ?? 0, Number(m.eur ?? 0));
  const w = v => `${(100 * Math.min(Number(v ?? 0), top) / (top || 1)).toFixed(2)}%`;
  const level = m.eur == null || cap == null ? '' : m.eur >= cap ? ' over' : m.eur >= 0.8 * cap ? ' near' : '';
  const hq = Number(m.hq) > 0 ? `email drafts ${euro(m.hq)}` : '';   // job #4184
  const meter = m.eur == null ? `<p class="cr-none">${esc(monthName(m.month))}: nothing counted yet.</p>` : `<div class="cn-meter${level}">
      <p class="hd"><b>${esc(monthName(m.month))} so far</b><span>${euro(m.eur)}${cap != null ? ` of the ${euro(cap, 0)} cap` : ''} · every app${hq ? ' and the drafts' : ''} together</span></p>
      ${cap != null && top ? `<div class="track" role="img" aria-label="${euro(m.eur)} of the ${euro(cap, 0)} cap"><i class="all" style="width:${w(m.eur)}"></i>${m.app ? `<i class="app" style="width:${w(m.app)}"></i>` : ''}${hq ? `<i class="hq" style="left:${w(m.app)};width:${w(m.hq)}"></i>` : ''}<span class="tick" style="left:${w(cap)}"></span></div>
      <p class="keys"><span><i class="app" aria-hidden="true"></i>${esc(d.name)} ${euro(m.app)}</span>${hq ? `<span><i class="hq" aria-hidden="true"></i>${hq}</span>` : ''}<span><i class="all" aria-hidden="true"></i>every app</span><span><i class="tick" aria-hidden="true"></i>the cap, in code: ${euro(cap, 0)}</span></p>` : hq ? `<p class="keys"><span>Of it, ${hq}</span></p>` : ''}
      ${m.console != null ? `<p class="sm">At the cap, care stops calling the AI model; the provider’s console would stop everything at ${euro(m.console, 0)}.</p>` : ''}</div>`;
  return `<section class="cr-sec cn-cost"><h3>Cost</h3><div class="cn-figs">
    ${fig('These days', t.cost == null ? NOT_YET : euro(t.cost))}${fig('Per conversation', euro(t.perConversation, 3), 'the mean')}${fig('Highest day’s p95', euro(t.costP95, 3), 'per conversation')}</div>
    ${meter}<p class="sm">Model in use: ${d.model ? `<b>${esc(d.model)}</b>` : 'not counted yet'}</p></section>`;
}
// Day by day, newest first, folded: a day care sent nothing for is a dash
function daysPart(d) {
  const s = ms => ms == null ? '—' : fmt(Number(ms) / 1000, 1), w = x => x ? `${s(x.p50)} / ${s(x.p95)}` : '—';
  const rows = (d.daily ?? []).slice().reverse().map(x => x.none ? `<tr class="none"><td>${esc(dayOf(x.day))}</td><td colspan="9">—</td></tr>`
    : `<tr><td>${esc(dayOf(x.day))}</td><td data-l="Conversations">${cnt(x.conversations)}</td><td data-l="Resolved">${cnt(x.resolved)}</td><td data-l="Emails to a person">${cnt(x.person)}</td>
      <td data-l="New questions">${cnt(x.questions)}</td><td data-l="Helped: yes / asked">${x.helped?.asked == null ? '—' : `${cnt(x.helped.yes)} / ${cnt(x.helped.asked)}`}</td>
      <td data-l="Plain p50 / p95, s">${w(x.words?.plain)}</td><td data-l="Looked up p50 / p95, s">${w(x.words?.lookup)}</td>
      <td data-l="Down / past cap, min">${x.outage == null && x.cap == null ? '—' : `${cnt(x.outage)} / ${cnt(x.cap)}`}</td><td data-l="Cost">${euro(x.cost)}</td></tr>`).join('');
  return `<details class="cr-fold cn-days" data-cn-days${dayFold ? ' open' : ''}><summary><b>Day by day</b><span>Each of the ${Number(d.days)} days, newest first. A dash: nothing counted that day.</span></summary>
    <table class="cn-table"><thead><tr><th>Day</th><th>Conver&shy;sations</th><th>Resolved</th><th>Emails to a person</th><th>New questions</th><th>Helped yes / asked</th><th>Plain p50 / p95, s</th><th>Looked up p50 / p95, s</th><th>Down / past cap, min</th><th>Cost</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
}
function wireNumbers(el) {
  const move = change => { sfx.blip(); view = { ...view, ...change }; repaint(el, el.scrollTop); };
  el.querySelectorAll('[data-cn-app]').forEach(b => b.onclick = () => { if (b.getAttribute('aria-checked') !== 'true') move({ app: b.dataset.cnApp, mode: null }); });
  el.querySelectorAll('[data-cn-mode]').forEach(b => b.onclick = () => { if (b.getAttribute('aria-checked') !== 'true') move({ mode: b.dataset.cnMode }); });
  const days = el.querySelector('[data-cn-days]');
  if (days) days.ontoggle = () => { dayFold = days.open; };
}
