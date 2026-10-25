// The care service's chat widget, as an app loads it: <script type="module" src="./__care/widget.js"></script>.
// It defines <care-chat> (a shadow root, so the app's CSS and the widget's never
// mix), adds a Help launcher unless the page has its own [data-care] link, and opens on any click on [data-care]. It
// renders the conversation and the widget catalogue, and talks to the care service on the same origin; the conversation
// lives on the server, never in the browser's storage.
//
// What's the company's comes from its plug-in's public/ folder, served at /__care/company/ (platform/care/README.md).
// Its plugin.js says, each optional:
//   helper      the helper's name
//   names       { tag, opener, link }: the element, its [data-<opener>] links and the emails' #<link>=<token>, for
//               pages that already call them otherwise
//   langs, words  its languages and the widget's words in them (i18n.js)
//   health      the health check's term lists (health.js)
//   links, art  the hosts the chat may link to, and its drawings (catalogue.js)
//   avatar      ({ title }) → the helper's mark, SVG markup
//   stylesheet  a file in its public/ folder, loaded over chat.css (chat.css says what it can set); the element carries
//               data-stall, the stall it's in (one chat for a shop of several apps), so it can dress each one
//   launcher    false: no launcher on any page, for apps whose Help link is built on demand
//
// The transport (platform/care/docs/api.md, "The widget's API"): JSON POSTs to /__care/api/<what>, and
// one EventSource on /__care/api/stream carrying the server's messages, one JSON object per event.
//   widget → server  hello { lang }                          on open, and after a dropped stream: { level, items, online, busy, name?, stall? }
//                    typing { on }                           only on changes: typing started, paused 1.5 s, or cleared
//                    say { id, text, answer?, photo? }       a message; answer = { widget, action | order, note? } from a tap
//                                                            (ids only: the server renders every label), or { menu: 'person' }.
//                                                            Its response may carry { resync: true, text }: the action was
//                                                            another conversation's (a lapsed grant, or the other tab of two
//                                                            that opened a brand-new chat at once), so this tab's own
//                                                            hello() draws whichever conversation its cookie carries now
//                    code { code, widget, id }               the code box (never through the model)
//                    link { token }                          a signed link from the service's emails (#care=<token>)
//                    copy, forget, renew                     the menu's copy and the delete step's "this device only"; renew when the server asks
//   server → widget  { t: 'status', online, cause?, busy? }  header state (amber when offline). Cause 'cap' is the company's spending cap. Cause 'stop' means a person carries on
//                    { t: 'typing', on }                     the helper is working (a neutral line, never typing dots)
//                    { t: 'line', text }                     a status line ("Checking your order…"); null clears
//                    { t: 'reply', id, text, widget?, source?, answer, aiGenerated? }  one bubble; answer groups the bubbles of one
//                                                            answer; aiGenerated: the model wrote it (hello's and earlier's
//                                                            items say so too), and its bubble carries data-ai-generated;
//                                                            a summary widget's noteAiGenerated: the model wrote its note
//                    { t: 'close', widget, answer?, note?, keep?, done?, reopen? }  a widget answered (or updated)
//                    { t: 'note', widget, slot, text }       a photo checked
//                    { t: 'wait', ids, on }                  messages waiting for the helper (outage)
//                    { t: 'earlier', items }                 the thread's earlier messages, from another device
//                    { t: 'toast', text }                    a short confirmation ("a copy is on its way")
//                    { t: 'renew' }                          a grant rose: POST renew at once (a new session id)
//                    { t: 'level', level }                   the session's check level, after a check
//                    { t: 'drop', ids, text? }               held messages gone ("Edit my message": text goes back to the input)
//                    { t: 'redact', ids, notes? }            messages whose text care removed (a health detail it found), cards whose note went
//                    { t: 'changed', what }                  the helper changed something the host page shows ('basket'): the page
//                                                            hears window's 'chat-changed' { what } and draws it again
import * as company from './company/plugin.js';
import * as catalogue from './catalogue.js';
import * as i18n from './i18n.js';
import './telemetry.js'; // the page's event log, from as early as the widget loads (an app may load it earlier itself)
import { bundle as snapshot } from './snapshot.js'; // static: a lazy import would be a request before the tap on "Send it"
import * as health from './health.js';

const { render: renderWidget, INTERACTIVE, INLINE, safeLink } = catalogue, { words, pick } = i18n, { healthTerm } = health;
const HELPER = company.helper ?? 'Helper';
const NAMES = { tag: 'care-chat', opener: 'care', link: 'care', ...company.names };
i18n.use({ langs: company.langs, words: company.words, helper: HELPER });
health.use(company.health);
catalogue.use({ links: company.links, art: company.art });
// the helper's mark (bubbles, the header, the launcher): the company's, else a plain one in the theme's colours
const mark = company.avatar ?? (({ title = '' } = {}) => `<svg class="mark" viewBox="0 0 64 64" ${title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'}>
  <rect width="64" height="64" style="fill: var(--c-me)"/><text x="32" y="42" text-anchor="middle" font-size="26" font-weight="700" style="fill: var(--c-me-ink)">AI</text></svg>`);
const OPENER = `[data-${NAMES.opener}]`;

const IDLE_MS = 1500; // no keystroke for this long = paused
// the page's language (its <html lang>: a shop's /nl/ page is Dutch whatever the browser says), else the browser's
const pageLang = () => document.documentElement.lang || navigator.language;
const RETRY_MS = [1000, 3000, 10_000, 30_000]; // reconnecting a stream the server closed
const OFFLINE_STATUS = { cap: 'status_cap', stop: 'status_stop' }; // the header's words per cause, else status_off
const FOLLOW_SLACK_PX = 40; // this close to the end of the conversation counts as at the end
const API = new URL('./api/', import.meta.url); // same origin: /__care/api/ on the app's own host
const LINK = new RegExp(`^#${NAMES.link}=([\\w.~-]+)`); // the signed link's fragment (fragments stay out of logs, Referer and mail scanners' GETs)
const uid = () => crypto.randomUUID().slice(0, 13);
const SUPERSEDE = new Set(['choice', 'order_picker', 'summary', 'consent', 'code_entry', 'helped', 'health']);
// this page's own id, in memory only: when a check the model ran raises a grant, only the page whose message it answered
// can take the session's new id, never someone else holding the same cookie
const TAB = crypto.randomUUID();

// One POST to the service: the answer, or null when it failed (offline, a refusal) so the caller can say so.
// A 401 { retry: true } can mean another POST of this page is giving the session a new id right now (a renew, or the
// first POST after a check): its answer carries the new cookie, so wait for what's in flight and try once more.
const inflight = new Set();
// The stream on the old id hears nothing more once the session has a new id, and ends: open it again at once with the
// new cookie (rather than after the server's `retry: 300`), and its hello catches up on what was said in between
let reopen = null;
// a tap's own response said its action was another conversation's: draw whichever conversation this tab's cookie carries
// now, and follow it with the stream
let resynced = null;
async function post(what, body) {
  const p = fetch(new URL(what, API), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-care-tab': TAB }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})), fresh: r.headers.get('x-care-new-id') === '1' }), () => null); // null: offline
  inflight.add(p); p.finally(() => inflight.delete(p));
  return p;
}
async function call(what, body = {}) {
  let r = await post(what, body);
  if (r?.status === 401 && r.json?.retry) { await Promise.allSettled([...inflight]); r = await post(what, body); }
  if (r?.fresh) reopen?.(); // the session has a new id (its cookie came with this answer): the stream follows it now
  if (r?.json?.resync) resynced?.(r.json.text);
  return r && r.status >= 200 && r.status < 300 ? r.json : null; // offline: the caller marks the message, the stream's retry brings the rest back
}
// what goes into innerHTML next to the widget's own markup (an app's name, from the server) is text
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

class ChatWidget {
  constructor(root) {
    this.root = root;
    this.store = { items: [] }; // what's on screen, as the server last told it
    this.name = 'our';
    this.lang = pick(pageLang()); this.w = words(this.lang); // the page's until hello says the conversation's
    this.online = true; this.cause = null;
    this.may = {}; // hello's: what the delete step may offer
    this.tries = 0; // stream retries since it last opened
    this.following = false; // an automatic scroll to the end is under way (scroll())
    this.build();
  }

  build() {
    // the words come from i18n.js by key (data-t: text, data-t-html: the words' own markup, data-t-label / -title / -ph:
    // attributes), so a conversation in another language redraws them in place (lang())
    this.root.innerHTML = `
      <header class="ch-head">
        <span class="ch-av">${mark()}</span>
        <div class="ch-who"><b>${esc(HELPER)} <abbr class="ai" data-t-title="ai_title">AI</abbr></b><span class="ch-status" aria-live="polite"></span></div>
        <button class="ch-menu" type="button" data-t-label="more" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg></button>
        <button class="ch-close" type="button" data-t-label="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
        <div class="ch-pop" role="menu" hidden>
          <button type="button" role="menuitem" data-m="about" data-t="m_about"></button>
          <button type="button" role="menuitem" data-m="person" data-t="m_person"></button>
          <button type="button" role="menuitem" data-m="copy" data-t="m_copy"></button>
          <button type="button" role="menuitem" data-m="delete" data-t="m_delete"></button>
        </div>
      </header>
      <section class="ch-about" hidden data-t-label="about">
        <div class="ab-in">
          <span class="ch-av lg">${mark()}</span>
          <h3 data-t="about"></h3>
          <p class="ab-who"></p>
          <p data-t="ab_2"></p>
          <p data-t="ab_3"></p>
          <p><span data-t-html="ab_4"></span><span class="ab-busy" data-t="ab_busy" hidden></span><span data-t="ab_5"></span></p>
          <button type="button" class="chip primary ab-close" data-t="back"></button>
        </div>
      </section>
      <section class="ch-about ch-del" hidden role="alertdialog" aria-modal="false" aria-labelledby="del-q" aria-describedby="del-text">
        <div class="ab-in">
          <h3 id="del-q" data-t="del_q"></h3>
          <p id="del-text" data-t="del_text"></p>
          <div class="del-box" hidden><label><input type="checkbox" aria-describedby="del-hint"><span data-t="del_server"></span></label><small id="del-hint" class="fine" data-t="del_server_hint"></small></div>
          <div class="chips equal"><button type="button" class="chip del-yes" data-t="del_yes"></button><button type="button" class="chip del-no" data-t="del_no"></button></div>
        </div>
      </section>
      <div class="ch-toast" role="status"></div>
      <div class="ch-log" role="log" aria-live="polite" aria-relevant="additions" tabindex="-1">
        <div class="ch-items"></div>
        <div class="ch-line" role="status"></div>
      </div>
      <form class="ch-input" autocomplete="off">
        <textarea rows="1" data-t-ph="placeholder" data-t-label="input" enterkeyhint="send"></textarea>
        <button class="ch-send" type="submit" data-t-label="send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>
      </form>
      `;
    const $ = (s) => this.root.querySelector(s);
    this.items = $('.ch-items'); this.log = $('.ch-log'); this.lineEl = $('.ch-line'); this.toastEl = $('.ch-toast');
    this.input = $('textarea'); this.status = $('.ch-status'); this.form = $('form');
    // an automatic scroll to the end is under way until it gets there, or the reader takes over
    this.log.addEventListener('scroll', () => { if (this.atEnd()) this.following = false; }, { passive: true });
    this.log.addEventListener('scrollend', () => (this.following = false));
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) this.log.addEventListener(type, () => (this.following = false), { passive: true });
    this.words();
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.sendText(); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendText(); } });
    this.input.addEventListener('input', () => this.typed());
    // a draft re-wraps when the input's width changes (a phone turned, the sheet becoming a side panel): it grows again
    let inputWidth = 0;
    new ResizeObserver(([entry]) => { if (entry.contentRect.width === inputWidth) return; inputWidth = entry.contentRect.width; this.grow(); }).observe(this.input);
    this.input.addEventListener('blur', () => { if (!this.input.value.trim()) this.typing(false); });
    $('.ch-close').addEventListener('click', () => this.root.dispatchEvent(new CustomEvent('chat-close')));
    const menu = $('.ch-menu'), pop = $('.ch-pop'), about = $('.ch-about:not(.ch-del)'), del = $('.ch-del');
    const delText = $('#del-text'), delBox = $('.del-box'), server = delBox.querySelector('input');
    const show = (on) => { pop.hidden = !on; menu.setAttribute('aria-expanded', String(on)); if (on) pop.querySelector('button').focus(); };
    menu.addEventListener('click', () => show(pop.hidden));
    // a menu by keyboard, as screen readers expect of role=menu: arrows move (and wrap), Home/End, Tab leaves and closes it
    menu.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); show(true); } });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') return show(false);
      const items = [...pop.querySelectorAll('[role="menuitem"]:not([hidden])')], i = items.indexOf(e.target.closest('[role="menuitem"]'));
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); items[(to + items.length) % items.length].focus();
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!pop.hidden) { show(false); menu.focus(); } else if (!about.hidden || !del.hidden) { about.hidden = del.hidden = true; menu.focus(); }
      else this.root.dispatchEvent(new CustomEvent('chat-close')); // a panel over someone's page: Escape puts it away
    });
    // composedPath: a click inside the shadow root reaches the document retargeted to the widget's element
    document.addEventListener('pointerdown', (e) => { const path = e.composedPath(); if (!pop.hidden && !path.includes(pop) && !path.includes(menu)) show(false); });
    pop.addEventListener('click', (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return; show(false);
      if (m !== 'about') about.hidden = true;
      if (m !== 'delete') del.hidden = true;
      // the quiet, findable way to a person (in view, not first): the email card, no "are you sure", or with the company's
      // `chatFirst` the chat's one case for trying here first (person.ts menu())
      if (m === 'person') this.emailPerson();
      if (m === 'copy') call('copy').then((r) => { if (!r) this.toast(this.w('failed')); });
      if (m === 'about') { about.hidden = false; about.querySelector('.ab-close').focus(); }
      // deleting can't be undone, so it asks once; "Keep it" is the same size and comes second (no nudge either way). One
      // item for this device and the server's copy: a chat never linked to an email has no other
      // copy, so it goes from both; one linked to an email asks, ticked, whether the server's copy goes too, and where this
      // device may not delete it (its email check lapsed) it says the copy stays
      if (m === 'delete') {
        const key = !this.may.kept ? 'del_text' : this.may.delete ? 'del_here' : 'del_kept';
        delText.dataset.t = key; delText.textContent = this.w(key);
        delBox.hidden = !(this.may.kept && this.may.delete); server.checked = true;
        about.hidden = true; del.hidden = false; del.querySelector('.del-no').focus();
      }
    });
    about.querySelector('.ab-close').addEventListener('click', () => { about.hidden = true; this.focus(); });
    del.querySelector('.del-no').addEventListener('click', () => { del.hidden = true; this.focus(); });
    del.querySelector('.del-yes').addEventListener('click', () => {
      del.hidden = true;
      if (this.may.delete && (!this.may.kept || server.checked)) this.remove(); else this.forget({ done: 'del_here_done' });
    });
  }
  setName(name) { this.name = name; this.words(); }
  // the conversation's language (hello's), for the widget's own words; the server's texts are already in it
  setLang(lang) { if (pick(lang) === this.lang) return; this.lang = pick(lang); this.w = words(this.lang); this.words(); this.restore(); }
  // the page's language changed (its script set <html lang>): followed until hello says the conversation's
  followPage() { if (!this.spoken) this.setLang(pageLang()); }
  words() {
    const w = this.w, r = this.root;
    for (const el of r.querySelectorAll('[data-t]')) el.textContent = w(el.dataset.t);
    for (const el of r.querySelectorAll('[data-t-html]')) el.innerHTML = w(el.dataset.tHtml);
    for (const [attr, key] of [['aria-label', 'label'], ['title', 'title'], ['placeholder', 'ph']]) for (const el of r.querySelectorAll(`[data-t-${key}]`)) el.setAttribute(attr, w(el.getAttribute(`data-t-${key}`)));
    r.querySelector('.ab-who').innerHTML = w('ab_1', { role: esc(this.name === 'our' ? w('helper') : w('helper_of', { app: this.name })) });
    for (const line of r.querySelectorAll('.ab-in p')) line.hidden = !line.textContent.trim(); // a line the company left empty
    this.showStatus();
    r.dispatchEvent(new CustomEvent('chat-lang', { detail: { w } })); // the launcher outside the panel follows
  }
  // The company's own cap makes no promise of when. A stop makes no promise at all. The way on is a person.
  showStatus() {
    const offline = OFFLINE_STATUS[this.cause] ?? 'status_off';
    this.status.textContent = this.w(this.online ? 'status_on' : offline);
  }

  emailPerson(widget) { this.say('Email a person', { answer: { menu: 'person', ...(widget ? { widget } : {}) } }); }

  // ---- the bug report: the bundle is built here, in the browser, at the preview or at the tap, and frozen
  // per card, so what's sent is exactly what was shown. Nothing leaves before "Send it", and then only through this.
  preview(item) {
    const id = item.w.id, bundles = (this.bundles ??= new Map()), made = (this.made ??= new Map());
    if (!bundles.has(id)) bundles.set(id, snapshot().then((b) => { made.set(id, b); return b; }));
    return bundles.get(id);
  }
  async sendSnapshot(item, o) {
    item.ws = { ...(item.ws || {}), done: true, picked: o.action };
    this.refresh(item);
    const id = uid(), echo = { k: 'me', id, text: o.label };
    this.add(echo);
    this.send(echo, 'diagnostics', { id, widget: item.w.id, action: o.action, bundle: await this.preview(item) });
  }

  // ---- the connection: hello, then the stream; after a drop, hello again and redraw from what the server has
  async open({ link } = {}) {
    await (this.ready ??= this.hello()); // once: a link opened before the first hello waits for its cookie
    // a link that's spent or expired is the server's to say, in the chat; null here only means it didn't arrive
    if (link && !(await call('link', { token: link }))) this.toast(this.w('link_failed'));
    // the stream only after the link's answer: the link gives the session a new id, and a stream opened with the old
    // cookie meanwhile would be refused (a 401 in the console, and a retry a second later)
    if (!this.stream) this.listen();
  }
  async hello() {
    const r = await call('hello', { lang: pageLang() });
    if (!r) { this.receive({ t: 'status', online: false }); return false; }
    if (r.name) this.setName(r.name);
    const host = this.root.getRootNode().host; // the company's stylesheet dresses the helper per stall
    // a page's own data-stall stays: a stall on its shop's chat without a chat of its own (the server answers with the
    // shop) still wears its own look
    if (r.stall && host && !host.dataset.stall) host.dataset.stall = r.stall;
    if (r.lang) { this.spoken = true; this.setLang(r.lang); }
    this.may = r.may ?? {}; // what the delete step offers: only what the server would allow
    this.level = r.level;
    this.bodyMax = r.bodyMax; // the largest request the server takes, in bytes
    // the server keeps a widget's state inside it; a message held on this device (and its card) was never sent, so it stays
    const cards = this.store.items.filter((it) => it.local && !it.ws?.done);
    const held = this.store.items.filter((it) => cards.includes(it) || cards.some((c) => c.local.message === it.id));
    this.store.items = (Array.isArray(r.items) ? r.items : []).map((it) => (it.w?.ws && !it.ws ? { ...it, ws: it.w.ws } : it)).concat(held);
    this.restore();
    this.receive({ t: 'status', online: r.online !== false, busy: !!r.busy, cause: r.cause });
    return true;
  }
  listen() {
    this.stream?.close();
    reopen = () => { this.dropped = true; this.listen(); };
    resynced = (text) => { this.toast(text); this.hello(); this.listen(); };
    const es = this.stream = new EventSource(new URL('stream', API));
    es.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.receive(m); };
    es.onopen = () => { this.tries = 0; if (this.dropped) { this.dropped = false; this.hello(); } };
    es.onerror = () => {
      this.dropped = true;
      // the browser retries a dropped stream itself; a refused one (CLOSED) is ours to retry, more slowly each time
      if (es.readyState === EventSource.CLOSED && this.stream === es) {
        clearTimeout(this.retry);
        this.retry = setTimeout(async () => { if (await this.hello()) this.dropped = false; this.listen(); }, RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
      }
    };
  }
  async forget({ asked = false, done } = {}) {
    this.forgetting = true;
    try {
      if (!asked && !(await call('forget'))) return this.toast(this.w('failed'));
      this.store.items = []; this.restore(); this.lookup = null; this.working = false; this.showLine();
      await this.hello(); this.listen(); // a new session: a fresh greeting, and a stream for it
      if (!asked) this.focus();
      if (done) this.toast(this.w(done));
    } finally { this.forgetting = false; }
  }
  // "Delete this conversation": gone from the server too; this device keeps its session (and any check) and starts afresh
  async remove() {
    this.forgetting = true; // the stream's `forget` for this deletion is ours: no second reset
    try {
      if (!(await call('delete'))?.ok) return this.toast(this.w('failed'));
      await this.forget({ asked: true });
      this.toast(this.w('del_done')); this.focus();
    } finally { this.forgetting = false; }
  }

  // ---- typing signals, only on changes: on when typing starts, off after a 1.5 s pause or when the input is cleared
  typed() {
    this.grow();
    if (!this.input.value.trim()) return this.typing(false);
    if (!this.typingOn) { this.typingOn = true; call('typing', { on: true }); }
    clearTimeout(this.idle); this.idle = setTimeout(() => this.typing(false), IDLE_MS);
  }
  typing(on) { clearTimeout(this.idle); if (this.typingOn && !on) { this.typingOn = false; call('typing', { on: false }); } }
  // the input's height is border-box: its borders count too, or it always overflows a pixel and Windows draws a tiny
  // scrollbar in it; the scrollbar only once it's at its 120 px cap
  grow() {
    const input = this.input, computedStyle = getComputedStyle(input);
    input.style.overflowY = 'hidden'; input.style.height = 'auto';
    const full = Math.ceil(input.scrollHeight + parseFloat(computedStyle.borderTopWidth) + parseFloat(computedStyle.borderBottomWidth));
    input.style.height = Math.min(full, 120) + 'px'; input.style.overflowY = full > 120 ? 'auto' : 'hidden';
  }

  // ---- sending: the input never locks
  sendText() {
    const text = this.input.value.trim(); if (!text) return;
    // a message past what the server takes in one request (as typed, or sent to a person from the health card) stays in
    // the box, whole, to send in parts
    if (new TextEncoder().encode(JSON.stringify({ id: uid(), text, answer: { health: 'person' } })).length > this.bodyMax) return this.toast(this.w('too_long'));
    this.input.value = ''; this.grow();
    this.dropHeld(); // a new message instead of a choice on the health card is the edit
    if (healthTerm(text)) return this.hold(text);
    clearTimeout(this.idle); this.typingOn = false; // the message itself tells the server typing stopped
    this.say(text);
  }

  // ---- the health-detail check: a message with a health term stays on this device, unsent, under a card
  // with two buttons of equal weight. "Edit my message" puts it back in the input; "Send it to a person instead" (the
  // consent, art. 9(2)(a)) sends it marked for a person, and no model ever reads it. Care runs the same check
  // (public/health.js) on whatever reaches it, and holds it under the same card with its own action ids.
  hold(text) {
    this.typing(false);
    const id = uid(), card = uid();
    this.add({ k: 'me', id, text, held: true });
    this.add({ k: 'ai', id: card, text: this.w('health_card'), local: { message: id },
      w: { id: card, type: 'health', options: [{ local: 'edit', label: this.w('health_edit') }, { local: 'person', label: this.w('health_person') }] } });
  }
  healthTap(item, o) {
    const edit = o.local ? o.local === 'edit' : o === item.w.options[0];
    item.ws = { ...(item.ws || {}), done: true, picked: o.action ?? o.local };
    if (item.local) { // held here: nothing has left the device yet
      const msg = this.find(item.local.message, 'id');
      if (edit) { this.unadd(item.id); this.unadd(msg?.id); return this.refill(msg?.text); }
      this.refresh(item);
      if (msg) { msg.held = false; this.refresh(msg); this.send(msg, 'say', { id: msg.id, text: msg.text, answer: { health: 'person' } }); }
      return;
    }
    this.refresh(item); // held by care: it drops the message and sends its words back (`drop`), or files it for a person
    if (edit) call('say', { id: uid(), text: '', answer: { widget: item.w.id, action: o.action } });
    else this.say(o.label, { answer: { widget: item.w.id, action: o.action } });
  }
  dropHeld() { for (const it of [...this.store.items]) if (it.local && !it.ws?.done) { this.unadd(it.id); this.unadd(it.local.message); } }
  refill(text) { if (!text || this.input.value.trim()) return; this.input.value = text; this.grow(); this.focus(); }
  unadd(id) {
    const i = this.store.items.findIndex((it) => it.id === id); if (i < 0) return;
    this.store.items.splice(i, 1);
    this.items.querySelector(`[data-id="${CSS.escape(String(id))}"]`)?.remove();
  }
  say(text, extra = {}) { const id = uid(); this.send({ k: 'me', id, text }, 'say', { id, text, ...extra }); return id; }
  // the bubble shows at once; if the POST fails it says so and offers to try again (never a silent loss)
  async send(item, what, body) {
    if (!this.find(item.id, 'id')) this.add(item);
    const ok = await call(what, body);
    if (!ok) { item.failed = { what, body }; this.refresh(item); }
  }
  // a tap on a widget: written into the transcript as words, sent as ids. done: false keeps the card's other buttons.
  // quiet: no words in the transcript
  // ("Did this help?" is a count); if it doesn't go through, the card is back to tap again
  answer(item, payload, echo, done = true, quiet = false) {
    item.ws = { ...(item.ws || {}), done, picked: payload };
    this.refresh(item);
    if (quiet) call('say', { id: uid(), text: '', answer: { widget: item.w.id, ...payload } }).then((r) => { if (!r) { item.ws = { ...item.ws, done: false, picked: null }; this.refresh(item); this.toast(this.w('failed')); } });
    else if (payload.code) { const id = uid(); this.send({ k: 'me', id, text: echo }, 'code', { code: payload.code, widget: item.w.id, id }); }
    else this.say(echo, { answer: { widget: item.w.id, ...payload } });
    this.input.focus({ preventScroll: true });
  }

  // ---- what the server says
  receive(m) {
    switch (m.t) {
      case 'status':
        // A stop isn't an outage. There is nothing to wait out.
        this.root.classList.toggle('offline', !m.online && m.cause !== 'stop');
        this.root.classList.toggle('stopped', !m.online && m.cause === 'stop');
        if ('busy' in m) this.root.querySelector('.ab-busy').hidden = !m.busy; // the busy notice, beside the reply time
        this.online = !!m.online; this.cause = m.cause ?? null; this.showStatus();
        break;
      // No typing dots: they make it look like a person is typing (regulators read them so). A neutral line instead.
      case 'typing': this.working = !!m.on; this.showLine(); break;
      case 'line': this.lookup = m.text || null; this.showLine(); break;
      case 'toast': this.toast(m.text); break;
      case 'reply': {
        this.lookup = null; this.working = false; this.showLine();
        if (m.widget && INTERACTIVE.has(m.widget.type) && !m.widget.keep) for (const it of this.store.items) if (it.w && !it.local && !it.ws?.done && SUPERSEDE.has(it.w.type)) { it.ws = { ...(it.ws || {}), gone: true }; this.refresh(it); }
        this.add({ k: 'ai', id: m.id, text: m.text, w: m.widget, source: m.source, answer: m.answer, aiGenerated: m.aiGenerated });
        break;
      }
      case 'close': { // the server's view of a widget's state, merged: { picked, done, note, notice… }, or reopen (a wrong code)
        const it = this.find(m.widget); if (!it) break;
        const { t, widget, reopen, keep, answer, ...patch } = m;
        if (reopen) it.ws = { ...(it.ws || {}), done: false, picked: null, shake: Date.now() };
        else {
          if (answer !== undefined) Object.assign(patch, { done: true, picked: answer }); // the prototype's spelling
          if (typeof patch.done === 'string') Object.assign(patch, { notice: patch.done, done: true });
          it.ws = { ...(it.ws || {}), ...patch };
        }
        this.refresh(it);
        break;
      }
      case 'note': {
        const it = this.find(m.widget); if (!it) break;
        const ph = (it.ws ||= {}).photos ||= {}; (ph[m.slot] ||= {}).note = m.text;
        this.refresh(it);
        break;
      }
      case 'wait':
        // An outage re-sends its marks with each retry. Only a change is drawn again.
        for (const it of this.store.items) {
          const changed = Boolean(it.waiting) !== Boolean(m.on);
          if (m.ids?.includes(it.id) && changed) { it.waiting = m.on; this.refresh(it); }
        }
        break;
      case 'earlier': if (m.items?.length) this.add({ k: 'earlier', id: uid(), items: m.items }, { at: this.store.items.findIndex((i) => i.k !== 'earlier') }); break;
      case 'forget': if (!this.forgetting) this.forget({ asked: true }); break; // forgotten on another tab of this device
      case 'renew': call('renew'); break; // a grant rose: the server swaps the session id (its Set-Cookie answers this POST)
      case 'level': this.level = m.level; break;
      case 'changed': dispatchEvent(new CustomEvent('chat-changed', { detail: { what: m.what } })); break;
      case 'drop': for (const id of m.ids ?? []) this.unadd(id); this.refill(m.text); break;
      case 'redact':
        for (const it of this.store.items) {
          if (m.ids?.includes(it.id)) { it.text = ''; it.removed = true; }
          if (m.notes?.includes(it.id) && it.w) { it.w = { ...it.w }; delete it.w.note; delete it.w.noteAiGenerated; if (it.ws) delete it.ws.note; } // the email card's note, and any edit of it (its AI mark)
          if (m.ids?.includes(it.id) || m.notes?.includes(it.id)) this.refresh(it);
        }
        break;
    }
  }
  showLine() {
    const text = this.lookup || (this.working ? this.w('working') : '');
    this.lineEl.textContent = text; // the line stays in the page, empty, so a screen reader hears it when it fills
    this.lineEl.classList.toggle('on', !!text); if (text) this.scroll();
  }
  // the toast is always in the page (a live region that appears together with its words is often not read), empty when away
  toast(text) { const t = this.toastEl; t.textContent = text; t.classList.add('on'); clearTimeout(this.tt); this.tt = setTimeout(() => { t.classList.remove('on'); this.tt = setTimeout(() => (t.textContent = ''), 300); }, 5000); }
  find(id, by = 'widget') { return this.store.items.find((i) => (by === 'id' ? i.id === id : i.w?.id === id)); }

  // ---- the transcript
  add(item, { at = -1 } = {}) {
    if (this.find(item.id, 'id')) return; // already drawn (a reply that landed while hello was answering)
    if (at >= 0) this.store.items.splice(at, 0, item); else this.store.items.push(item);
    const el = this.draw(item, true);
    if (at >= 0 && this.items.children[at]) this.items.insertBefore(el, this.items.children[at]); else this.items.append(el);
    this.scroll();
  }
  restore() { this.items.textContent = ''; for (const it of this.store.items) this.items.append(this.draw(it, false)); requestAnimationFrame(() => this.scroll(true)); }
  // The last item can grow (a waiting mark under it, a card's state). It stays in view if the reader was at the end, or
  // the scroll to a new bubble is still under way. A reader who scrolled up stays put.
  refresh(item) {
    const old = this.items.querySelector(`[data-id="${CSS.escape(String(item.id))}"]`);
    if (!old) return;
    const follow = old === this.items.lastElementChild && (this.following || this.atEnd());
    old.replaceWith(this.draw(item, false));
    if (follow) this.scroll();
  }
  draw(item, fresh) {
    const el = document.createElement('div');
    el.dataset.id = item.id; el.className = `msg ${item.k === 'me' || item.k === 'earlier' ? item.k : 'helper'}${fresh ? ' new' : ''}`;
    if (item.answer) el.dataset.answer = item.answer;
    if (item.k === 'earlier') {
      const d = document.createElement('details'); d.className = 'earlier';
      const s = document.createElement('summary'); s.textContent = this.w('earlier', { n: item.items.length });
      const box = document.createElement('div');
      for (const x of item.items) {
        const p = document.createElement('p'); p.className = x.k === 'me' ? 'me' : 'helper'; p.textContent = x.text;
        if (x.aiGenerated) p.dataset.aiGenerated = 'true';
        box.append(p);
      }
      d.append(s, box); el.append(d);
      return el;
    }
    const prev = this.store.items[this.store.items.indexOf(item) - 1];
    if (item.k !== 'me' && prev?.k !== item.k) el.classList.add('first');
    if (item.k !== 'me') { const av = document.createElement('span'); av.className = 'ch-av sm'; av.innerHTML = mark(); el.append(av); }
    const col = document.createElement('div'); col.className = 'col'; el.append(col);
    let b = null;
    if (item.text) {
      b = document.createElement('p'); b.className = 'bubble'; rich(b, item.text); col.append(b);
      // the machine-readable AI mark on what the model wrote (README.md, "The AI mark").
      if (item.aiGenerated) b.dataset.aiGenerated = 'true';
      if (item.k === 'me') b.setAttribute('aria-label', this.w('you', { text: item.text }));
    } else if (item.removed) { b = document.createElement('p'); b.className = 'bubble removed'; b.textContent = this.w('removed'); col.append(b); }
    if (item.held) { const s = document.createElement('span'); s.className = 'held'; s.textContent = this.w('held'); col.append(s); }
    if (item.source) { const s = document.createElement('span'); s.className = 'source'; s.textContent = this.w('from', { source: item.source }); col.append(s); }
    if (item.waiting) { const w = document.createElement('span'); w.className = 'waiting'; w.textContent = this.w('waiting'); col.append(w); }
    if (item.failed) {
      const r = document.createElement('button'); r.type = 'button'; r.className = 'link'; r.textContent = this.w('not_sent');
      r.addEventListener('click', () => { const { what, body } = item.failed; item.failed = null; this.refresh(item); this.send(item, what, body); });
      col.append(r);
    }
    // an INLINE widget ends its own bubble (the outage message's link); the others are a card under it
    if (item.w) (INLINE.has(item.w.type) && item.text ? b : col).append(renderWidget(item.w, item.ws || {}, {
      answer: (payload, echo, done, quiet) => this.answer(item, payload, echo, done, quiet),
      update: (patch) => { item.ws = { ...(item.ws || {}), ...patch }; },
      upload: (shot, encoded) => upload(this, item, shot, encoded), // a claim photo (the photos card): its bytes, not JSON
      // photo uploads aren't built yet: the thumbnail stays on this page, the server hears the slot was filled
      photo: (slot, info) => { const ph = ((item.ws ||= {}).photos ||= {}); ph[slot] = { src: info.thumb }; this.refresh(item);
        const id = uid(); call('say', { id, text: '', photo: { widget: item.w.id, slot, w: info.w, h: info.h } }); },
      person: () => this.emailPerson(item.w.id),
      health: (o) => this.healthTap(item, o),
      diagnostics: { preview: () => this.preview(item), shown: () => this.made?.get(item.w.id), send: (o) => this.sendSnapshot(item, o) },
      w: this.w, lang: this.lang,
      fresh,
    }));
    return el;
  }
  atEnd() { const log = this.log; return log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_SLACK_PX; }
  // following: the scroll is on its way to the end (cleared when it gets there, ends, or the reader takes over)
  scroll(now) {
    const l = this.log;
    this.following = true;
    const go = () => {
      const instant = now || matchMedia('(prefers-reduced-motion: reduce)').matches;
      l.scrollTo({ top: l.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
      if (this.atEnd()) this.following = false;
    };
    if (now) go();
    else requestAnimationFrame(go);
  }
  focus() { this.input.focus({ preventScroll: true }); }
}

// **bold**, and links to the company's hosts and its carriers' tracking pages; everything else is text (the server
// never sends HTML)
const URLS = /(https?:\/\/[^\s<>"]*[^\s<>".,;:!?'’)\]])/;
function rich(el, text) {
  String(text).split(/\*\*(.+?)\*\*/).forEach((part, i) => {
    const into = i % 2 ? el.appendChild(document.createElement('strong')) : el;
    part.split(URLS).forEach((bit, j) => {
      const href = j % 2 ? safeLink(bit) : null;
      into.append(href ? Object.assign(document.createElement('a'), { href, textContent: bit, target: '_blank', rel: 'noopener noreferrer' }) : bit);
    });
  });
}

// ---- <care-chat>: the launcher, the panel, the app's Help links, the signed link and the phone keyboard
const STYLES = [new URL('chat.css', import.meta.url), ...(company.stylesheet ? [new URL(`company/${company.stylesheet}`, import.meta.url)] : [])];
class CareChat extends HTMLElement {
  connectedCallback() {
    this.langs?.observe(document.documentElement, { attributeFilter: ['lang'] }); // put back on the page again
    if (this.shadowRoot) return;
    this.dataset.noSnapshot = ''; // the bug report's picture leaves the chat out (snapshot.js)
    // the conversation is a person's own (an order, an address): a watch-along keeps it out, inside the shadow root
    // where its mark is seen (shared/watchalong).
    const root = this.attachShadow({ mode: 'open' }), w = words(pick(pageLang()));
    root.innerHTML = `${STYLES.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}
      <button class="launcher" type="button" aria-label="${esc(w('launcher'))}" aria-expanded="false" hidden><span class="l-face">${mark()}</span><span class="l-label">${esc(w('help'))}</span></button>
      <section class="chat" aria-label="${esc(w('panel'))}" data-private hidden></section>`;
    this.panel = root.querySelector('.chat'); this.launcher = root.querySelector('.launcher');
    const label = (w) => { this.launcher.setAttribute('aria-label', w('launcher')); this.launcher.querySelector('.l-label').textContent = w('help'); this.panel.setAttribute('aria-label', w('panel')); };
    this.panel.addEventListener('chat-lang', (e) => label(e.detail.w));
    this.widget = new ChatWidget(this.panel);
    // a page whose script sets <html lang> after the widget loaded: the launcher and the panel follow it
    this.langs = new MutationObserver(() => this.widget.followPage());
    this.langs.observe(document.documentElement, { attributeFilter: ['lang'] });
    // the launcher waits for the styles (no flash of an unstyled button), and stays away if the app has its own Help
    const loaded = [...root.querySelectorAll('link')].map((link) => new Promise((ok) => { link.addEventListener('load', ok); link.addEventListener('error', ok); }));
    Promise.all(loaded).then(() => { this.launcher.hidden = company.launcher === false || !!document.querySelector(OPENER); });
    this.launcher.addEventListener('click', () => { this.opener = this.launcher; this.open(); });
    this.panel.addEventListener('chat-close', () => this.close());
    document.addEventListener('click', (e) => {
      const help = e.target.closest?.(OPENER); if (!help) return;
      e.preventDefault(); this.opener = help; this.open();
    });
    // the phone keyboard: keep the input above it (the visual viewport shrinks, the layout may not)
    const vv = window.visualViewport;
    if (vv) { const fit = () => { this.style.setProperty('--vvh', `${vv.height}px`); this.style.setProperty('--vvt', `${vv.offsetTop}px`); };
      vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
    // on a phone the sheet covers the page, so it's a modal dialog there and Tab goes round inside it; the panel beside
    // the page on a larger screen isn't (the page stays usable)
    const sheet = matchMedia('(max-width: 699px)');
    const modal = () => { for (const [k, v] of [['role', 'dialog'], ['aria-modal', 'true']]) if (sheet.matches) this.panel.setAttribute(k, v); else this.panel.removeAttribute(k); };
    sheet.addEventListener('change', modal); modal();
    this.panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !sheet.matches) return;
      const stops = [...this.panel.querySelectorAll('button, [href], input, textarea, summary')].filter((el) => !el.disabled && el.checkVisibility());
      const at = root.activeElement, end = e.shiftKey ? stops[0] : stops.at(-1);
      if (at === end || !stops.includes(at) && e.shiftKey) { e.preventDefault(); (e.shiftKey ? stops.at(-1) : stops[0])?.focus(); }
    });
    const redeem = () => {
      const m = LINK.exec(location.hash); if (!m) return;
      history.replaceState(history.state, '', location.pathname + location.search); // the token leaves the address bar before anything else
      this.open({ link: m[1] });
    };
    addEventListener('hashchange', redeem); redeem();
  }
  disconnectedCallback() { this.langs?.disconnect(); }
  open(opts = {}) {
    const was = !this.panel.hidden;
    this.panel.hidden = false; this.launcher.classList.add('away'); this.launcher.setAttribute('aria-expanded', 'true');
    if (!was) this.panel.classList.remove('closing');
    this.widget.open(opts);
    // on a phone, focusing the input would throw the keyboard over the greeting: the log takes focus instead
    if (matchMedia('(pointer: coarse)').matches) this.widget.log.focus({ preventScroll: true }); else this.widget.focus();
  }
  close() {
    this.panel.classList.add('closing'); this.launcher.classList.remove('away'); this.launcher.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (this.panel.classList.contains('closing')) { this.panel.hidden = true; this.panel.classList.remove('closing'); } }, 260);
    (this.opener?.isConnected ? this.opener : this.launcher).focus({ preventScroll: true });
  }
}

if (!customElements.get(NAMES.tag)) customElements.define(NAMES.tag, CareChat);
if (!document.querySelector(NAMES.tag)) document.body.append(document.createElement(NAMES.tag));

// A claim photo to the server (POST /__care/api/photo, the JPEG itself as the body). The slot shows it's sending, then
// the server's tick, or its words for why not. The customer's line ("📷 The shipping label") is the server's text, stored
// under this id, so a reload shows the same bubble.
async function upload(chat, item, shot, encoded) {
  const set = (p) => { const ph = ((item.ws ||= {}).photos ||= {}); ph[shot] = { ...ph[shot], ...p }; chat.refresh(item); };
  set({ sending: true, failed: null });
  let r = null;
  try {
    const { blob, thumb } = await encoded;
    const id = uid(), url = new URL(`photo?shot=${encodeURIComponent(shot)}&widget=${encodeURIComponent(item.w.id)}&id=${id}`, API);
    const post = () => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg', 'x-care-tab': TAB }, body: blob });
    let res = await post();
    if (res.status === 401) { await call('renew'); res = await post(); } // the session had a new id waiting for this page
    r = await res.json().catch(() => null);
    if (r?.ok) { item.ws.filled = r.filled; set({ sending: false, thumb }); chat.add({ k: 'me', id, text: r.text }); return; }
  } catch { /* offline, or a photo the browser can't read: the slot says so */ }
  set({ sending: false, failed: r?.text || item.w.words?.failed || '' });
}
