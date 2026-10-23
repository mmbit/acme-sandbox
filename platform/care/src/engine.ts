// One conversation's timing: answer the burst, not the first message. A draft starts at send or when the
// customer pauses typing; it's held while they type; a new message aborts it (the stream is cut, so it stops being
// billed) and a new draft answers everything together. A draft changes nothing until it's delivered: its widgets get
// their action ids and its effects (a grant, a code email) run only then, so a discarded draft leaves no trace. When the
// model is down or a cap is reached, the outage message comes from templates and the way to a person keeps working. The
// answer to what was written meanwhile comes in the chat.
import { db, now } from './db.ts';
import { aboutOf, withOrders } from './config.ts';
import * as hq from './hq.ts';
import * as actions from './actions.ts';
import * as ledger from './ledger.ts';
import { ProviderError } from './model.ts';
import { t, lang as toLang, type Lang } from './texts.ts';
import { busy } from './busy.ts';
import { settings, base, type Outage } from './company.ts';
import * as person from './person.ts';
import * as helper from './helper.ts';
import * as numbers from './numbers.ts';
import * as sessions from './session.ts';
import type { Session } from './session.ts';
import { linkHost } from '../public/catalogue.js';
import { healthTerm } from '../public/health.js';

// no first words within this: the provider isn't answering, so the outage card at once (the outage's own tries take
// over). Slower first words are only slow and keep the typing line: the API's first token can take over 8 s on a cold
// cache, and a call cut before it writes none of the cache, so a retry would wait as long again.
const SILENT_MS = Number(process.env.CARE_SILENT_MS ?? 30_000);
const DRAFT_GAP_MS = 1500;       // at most one draft started per this long, per conversation
const TYPING_BACKSTOP_MS = 10_000; // a widget that said "typing" and then went quiet is taken as paused
const RETRY_MS = Number(process.env.CARE_RETRY_MS ?? 30_000); // while down, how often to try again (the breaker allows one probe at a time)
const HELPED_MS = Number(process.env.CARE_HELPED_MS ?? 6000); // after an outcome, this long quiet before "Did this help?"

// Every web address in an emailed answer must be on a host the widget would link (catalogue.js linkHost: https, our hosts
// and the carriers'; not the app's own origin, which only the widget knows): a mail client links whatever it finds, and a
// visitor can steer the model's words. Bare domains count too, since mail clients link those as well, in
// any script and with the full stops other scripts write (none of which is ours). A bare domain is judged by the whole
// word it stands in (between spaces, without the brackets, quotes and punctuation around it), as a browser would read it
// as a host: "x_shop.example" or "e\u0301shop.example" isn't ours just because it ends in it, and a word that doesn't
// read as a host at all fails. Each run of host characters in the word (letters, marks, digits, hyphens and the full
// stops) is judged too, as written, before any normalisation: a linkifier stops at the first character that isn't one,
// so "evil.com…shop.example" links evil.com, although NFKC makes the whole word "evil.com...shop.example". A name with
// an empty label (a ".." run) fails. The recipient's own address isn't a web address ("we sent a code to
// ines@example.com"): it's taken out first, where it stands on its own. A web address ends where the next scheme starts,
// so "(https://shop.example/)(https://evil.com/)" is two addresses, each judged; and what follows the first bracket,
// comma or quote in one stays in the text as words, since a mail client may end the link there and link a domain after it.
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/(?:(?![a-z][a-z0-9+.-]*:\/\/)[^\s<>"])+/gi, URL_END = /[()[\]{},;'`]/, NAMED = /[^.]\.\p{L}\p{M}*\p{L}/u; // NAMED: a word with a name after a full stop
const EDGE = /^[\p{Ps}\p{Pi}\p{Pf}"'`*<¿¡]+|[\p{Pe}\p{Pi}\p{Pf}"'`*>.,;:!?…、]+$/gu;
// to: the recipient's address, when the writer knows it (the phone's answer
// goes to an address care never learns)
export function linksOk(text: string, to?: string) {
  if (to) text = text.replace(new RegExp(`(?<![^\\s<>"'(])${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}@-]|[.\u3002\uFF0E\uFF61][\\p{L}\\p{N}])`, 'giu'), ' ');
  let ok = true;
  text = text.replace(URL_RE, m => { // checked, then taken out: what's left is words
    let u: URL | null = null; try { u = new URL(m); } catch { /* fails below */ }
    // the host as written must be the host the parser reads: "evil.example\u3002shop.example" (or its %-encoded dot) reads as
    // a host under ours, but a linkifier that stops at the other script's full stop links evil.example
    const a = AUTHORITY.exec(m)?.[1] ?? '', written = a.slice(a.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
    if (!u || u.protocol !== 'https:' || u.username || u.password || written !== u.hostname || !linkHost(u.hostname)) ok = false;
    const end = m.search(URL_END);
    return end < 0 ? ' ' : ` ${m.slice(end)} `;
  });
  // a full stop of another script inside a name (before NFKC, which makes U+FF0E a "."): never how ours are written, and a
  // linkifier may stop there ("evil.example\uFF0Eshop.example" links evil.example). One with no Latin letter or digit on
  // either side ends a sentence in Chinese or Japanese, which has no spaces: it parts words there, never joins them into a
  // host
  return ok && text.replace(SENTENCE_STOP, ' ').split(/\s+/).every(w => !OTHER_STOP.test(w) && host(w.normalize('NFKC').replace(EDGE, '')) && (w.match(RUN) ?? []).every(r => host(r.normalize('NFKC'))));
}
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i, OTHER_STOP = /[\p{L}\p{M}\p{N}][\u3002\uFF0E\uFF61]+[\p{L}\p{M}\p{N}]/u,
  SENTENCE_STOP = /(?<![\p{Script=Latin}\p{M}\p{Nd}])[\u3002\uFF0E\uFF61]+(?![\p{Script=Latin}\p{M}\p{Nd}])/gu;
const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/; // a bare IPv4 address (a word, or the run of host characters in "192.168.0.1/login")
const RUN = /[\p{L}\p{M}\p{Nd}.\u3002\uFF0E\uFF61-]+/gu; // host characters as written (none of them becomes a full stop under NFKC)
function host(word: string) {
  word = word.replace(/[\u3002\uFF0E\uFF61]/g, '.').replace(/^\.+|\.+$/g, '');
  if (DOTTED_QUAD.test(word)) return false; // "192.168.0.1": a mail client may link a bare address, and it's never ours
  if (!NAMED.test(word)) return true; // "e.g.", "14.8cm", "€12.50": nothing a mail client takes for a domain
  if (word.includes('..')) return false;
  try { return linkHost(new URL(`https://${word}`).hostname); } catch { return false; }
}

export type Option = { kind: string; label: string; primary?: boolean; args?: any; echo?: string };
export type Widget = { type: string; options?: Option[]; [k: string]: any };
// aiGenerated: the model wrote the text, not a template (AI Act art. 50(2)).
export type Bubble = { text: string; widget?: Widget; source?: string; aiGenerated?: true };
// shop: whose conversation it is (a session's shop: every stall on one origin)
export type Conv = { id: number; shop: string; email: string | null; state: any };

// What a draft (or a template step) says. Bubbles queue here and go out one by one while the customer isn't typing.
// lookup: the model called a tool that looks something up (first words are counted apart for those); outcome: the
// answer gave the customer what they came for (helper.ts `answered`)
export class Out {
  bubbles: Bubble[] = []; effects: (() => unknown)[] = []; line: string | null = null; live: Live; lookup = false; outcome = false;
  round = 0; held = false; ran = Infinity;
  calls = 0; roundsOut = false; // the draft's model calls, and whether it reached TURN_ROUNDS with results unread (Numbers)
  constructor(live: Live) { this.live = live; }
  say(text: string, widget?: Widget, source?: string) { this.bubbles.push({ text, widget, source }); this.live.flush(); }
  // the model's own words, marked as AI-generated wherever they go
  modelSays(text: string) { this.bubbles.push({ text, aiGenerated: true }); this.live.flush(); }
  status(line: string | null) { this.line = line; if (!this.live.typing) this.live.send({ t: 'line', text: line }); }
  effect(f: () => unknown) { this.effects.push(f); }
  // One model round of a draft (helper.ts): its bubbles start at `round`, and from its first tool call they wait (held)
  // until its tools have run. A round the model goes on from after the results takes back the words it wrote that
  // haven't gone out: they were about getting the answer, and the status line covers the wait. So does a round a tool
  // speaks for (its words are all the server's). What the round's tools wrote stays: the server's lines, and the model's
  // words it gave a tool to say (from `ran` on). release() returns the round's model words that stay: the model's next
  // call sees its turn as the customer did.
  nextRound() { this.round = this.bubbles.length; this.ran = Infinity; this.held = false; this.calls++; }
  hold() { this.held = true; }
  running() { this.ran = this.bubbles.length; }
  release(takeBack: boolean) {
    this.held = false;
    const d = this.live.draft, sent = d?.out === this ? d.shown : 0, from = Math.max(this.round, sent);
    if (takeBack) this.bubbles = this.bubbles.filter((b, i) => i < from || i >= this.ran || !b.aiGenerated);
    this.live.flush();
    return this.bubbles.slice(this.round).filter(b => b.aiGenerated).map(b => b.text).join('\n\n');
  }
  // the model wrote words in this round: what a closing tool (answered) counts, never words from before a result
  spoke() { return this.bubbles.slice(this.round).some(b => b.aiGenerated && b.text.trim()); }
}

type Draft = { abort: AbortController; out: Out; shown: number; done: boolean; t0: number; answer: string; attempt: number; first: boolean; silent?: true; session: Session; visitor: Record<string, string>; state: any; upTo: number; timed: boolean };
type Sub = (m: any) => void;

// ---- the live conversations (in memory; the database keeps everything that has to survive a restart)
const lives = new Map<number, Live>();
export function live(conv: number) {
  let l = lives.get(conv);
  if (!l) {
    const row = db.prepare('select * from conversations where id = ?').get(conv) as any;
    if (!row) return null;
    l = new Live({ id: row.id, shop: row.shop, email: row.email, state: JSON.parse(row.state || '{}') });
    lives.set(conv, l);
    // back from the database (a restart, or pruned while idle): the device last in it until a request says which one,
    // and what was waiting carries on: an outage keeps trying, messages nobody answered yet get their answer
    l.session = sessions.of(conv, row.shop);
    if (l.waits) l.retrying(); // a stop doesn't retry
    else if (!l.down && l.unanswered) l.schedule(0);
  }
  return l;
}
export function create(shop: string, lang: Lang, stall = shop) {
  const t0 = now();
  const id = Number(db.prepare('insert into conversations (shop, created, last, state) values (?, ?, ?, ?)').run(shop, t0, t0, JSON.stringify({ lang, stall })).lastInsertRowid);
  return live(id)!;
}

type Resync = { resync: true; text: string };

export class Live {
  subs = new Set<Sub>(); session: Session | null = null; ip = '';
  // what the plug-in read of the latest request (company.ts `visitor`), the device `session` is: in memory only, so after a
  // restart nothing until a request comes
  visitor: Record<string, string> = {};
  typing = false; typingTimer: any = null; pending: any = null; retry: any = null;
  draft: Draft | null = null; delivering = false; helpedTimer: any = null;
  lastStart = 0; seen = now();
  quiet = 0; // when the customer last stopped: their newest message, or the end of their typing (first words count from it)
  gone = false; // forgotten ("Forget this chat"): its timers may still fire, and must find nothing to do
  conv: Conv;
  constructor(conv: Conv) { this.conv = conv; }
  // kept in the conversation's state, so a restart loses neither: how many of the customer's messages wait for an
  // answer (template steps answer theirs at once and don't count), and an outage
  get unanswered(): number { return this.conv.state.unanswered ?? 0; }
  set unanswered(n: number) { if (n !== this.unanswered) { this.conv.state.unanswered = n; this.save(); } }
  // a stop is over at its `until`, the company's next midnight (one stored without one is from before they had it): the
  // next message is answered
  get down(): null | Outage { const st = this.conv.state; return st.down === 'stop' && !(st.until > now()) ? null : st.down ?? null; }
  set down(v: null | Outage) { if (v !== this.down) { Object.assign(this.conv.state, { down: v, until: null, stop: null }); this.save(); } }
  // that stop over, the customer's next message or tap clears it, and the header hears so
  lift() { const st = this.conv.state; if (st.down && !this.down) { Object.assign(st, { down: null, until: null, stop: null }); this.save(); this.send(this.status()); } }
  // An outage or the company's cap is down for a while. What's written waits for the helper, who answers it once back.
  // A stop lasts the rest of the day. That's this conversation's or this visitor's own budget for the day (ledger.ts), or
  // a bad request. What's written goes to a person with "Email a person", so nothing is marked waiting and nothing retries.
  get waits() { return this.down === 'service' || this.down === 'cap'; }
  get lang(): Lang { return toLang(this.conv.state.lang); }
  // The stall the customer is in now (the X-Care-App of their latest request): the helper wears its look and name and reads
  // its knowledge, and never decides by it what she may show (that's the session's grants). Kept in the state, so a
  // restart still knows it.
  get stall(): string { return this.conv.state.stall ?? this.conv.shop; }
  setStall(stall: string) { if (stall !== this.stall) { this.conv.state.stall = stall; this.save(); } }
  // the app it's about, for its spend, its counts and a person's card (config.ts aboutOf())
  about(): string { return aboutOf(this.conv.shop, this.conv.state); }
  get busy() { return busy(); }
  save() { db.prepare('update conversations set state = ?, last = ?, email = ? where id = ?').run(JSON.stringify(this.conv.state), now(), this.conv.email, this.conv.id); }
  send(m: any) { for (const s of this.subs) { try { s(m); } catch { /* a closed stream: its own close handler removes it */ } } }
  subscribe(s: Sub) { this.subs.add(s); return () => this.subs.delete(s); }

  // ---- the transcript, as the widget draws it (hello's items)
  items() {
    const rows = db.prepare('select * from messages where conversation = ? order by id').all(this.conv.id) as any[];
    const earlier = this.earlier();
    // (aiGenerated)
    return [...(earlier.length ? [{ k: 'earlier', id: 'earlier', items: earlier }] : []), ...rows.map(r => ({ k: r.who, id: r.client || (r.who === 'ai' ? 'r' : 'm') + r.id, text: r.text, ...(r.widget ? { w: JSON.parse(r.widget) } : {}),
      ...(r.ai_generated ? { aiGenerated: true } : {}),
      ...(r.answer ? { answer: r.answer } : {}), ...(r.health === 'held' ? { held: true } : r.health === 'removed' ? { removed: true } : {}),
      ...(r.who === 'me' && !r.health && this.waits && r.id > (this.conv.state.answeredTo ?? 0) ? { waiting: true } : {}) }))];
  }
  // the thread's earlier conversations, for "Earlier, on another device" (level 2 only: the conversation has an email)
  earlier() {
    if (!this.conv.email) return [];
    // (aiGenerated)
    return (db.prepare(`select m.who, m.text, m.ai_generated from messages m join conversations c on c.id = m.conversation
      where c.shop = ? and c.email = ? and c.id != ? and m.text != '' and (m.health is null or m.health = 'person') order by m.id desc limit 12`).all(this.conv.shop, this.conv.email, this.conv.id) as any[])
      .reverse().map(m => ({ k: m.who, text: m.text, ...(m.ai_generated ? { aiGenerated: true } : {}) }));
  }
  // level 2 joins this conversation to the thread for (shop, email), and the earlier ones show collapsed
  join(email: string, s: Session) {
    if (this.conv.email === email) return true;
    // another email's thread on this device (a family tablet): this conversation stays theirs, and this device starts a
    // new one at its next hello (the grant rotated the session, which ends its stream; the widget says hello again).
    // A draft running for this device goes: its session now holds the other email's grant, and nothing it found may land here.
    if (this.conv.email) {
      const me = sessions.current(s) ?? s;
      sessions.attach(me, null as any);
      const mine = (x: Session | null | undefined) => !!x && (sessions.current(x) ?? x).id === me.id;
      if (mine(this.draft?.session)) this.discard();
      if (mine(this.session)) { this.session = sessions.of(this.conv.id, this.conv.shop); this.visitor = {}; } // another device still in it, or nobody (and none of its request)
      this.send({ t: 'line', text: null }); // the send ends that device's stream
      return false;
    }
    this.conv.email = email; this.save();
    const items = this.earlier();
    if (items.length) this.send({ t: 'earlier', items });
    return true;
  }
  // after something that wasn't a message (the code box): the helper carries on from where it was
  answerNext() { if (this.down) return; this.quiet = now(); this.unanswered++; this.schedule(300); }
  // cause 'stop' of its own, so the header doesn't say paused
  status() { return { t: 'status', online: !this.down, ...(this.down === 'cap' || this.down === 'stop' ? { cause: this.down } : {}), busy: this.busy }; }
  // page: the page a customer's message came from (session.ts pageOf()), so a grant what it typed proves is held for it
  // (aiGenerated)
  store(who: 'me' | 'ai', text: string, extra: { widget?: any; answer?: string; client?: string; page?: string | null; health?: 'held' | 'person'; aiGenerated?: boolean } = {}) {
    // a customer's message keeps the stall it came from: Numbers counts a shop's conversations per app by it
    const id = Number(db.prepare('insert into messages (conversation, at, who, text, widget, answer, client, tab, health, app, ai_generated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.conv.id, now(), who, text, extra.widget ? JSON.stringify(extra.widget) : null, extra.answer ?? null, extra.client ?? null, extra.page ?? null, extra.health ?? null,
        who === 'me' ? this.stall : null, extra.aiGenerated ? 1 : null).lastInsertRowid);
    this.save();
    if (who === 'me') this.quiet = now();
    if (who === 'me' && this.conv.state.handed) hq.nudge(); // their email to a person has gone: what they add goes with it (hq.ts)
    return id;
  }
  // a widget answered or replaced: the widget sees `close`, and the stored copy keeps the same state for a reload
  closeWidget(wid: string, ws: any) {
    const row = db.prepare("select id, widget from messages where conversation = ? and json_extract(widget, '$.id') = ? order by id desc limit 1").get(this.conv.id, wid) as any;
    if (row) { const w = JSON.parse(row.widget); w.ws = { ...w.ws, ...ws }; db.prepare('update messages set widget = ? where id = ?').run(JSON.stringify(w), row.id); }
    this.send({ t: 'close', widget: wid, ...ws });
  }
  openWidget() { return this.conv.state.open as { id: string; type: string; kind?: string } | undefined; }

  // The page's language (hello's): the conversation speaks it from then on, its fixed texts, the widget's words and the
  // model's setting, so a chat opened again from a page in another language follows that page. What was said stays as it

  followPage(lang: Lang) {
    if (lang === this.lang) return;
    this.conv.state.lang = lang;
    if (!db.prepare("select 1 from messages where conversation = ? and who = 'me' limit 1").get(this.conv.id)) {
      db.prepare('delete from messages where conversation = ?').run(this.conv.id);
      this.conv.state.greeted = false;
    }
    this.save();
  }

  // ---- the greeting: instant, from templates, before the customer types (AI Act art. 50)
  greet() {
    if (this.conv.state.greeted) return;
    this.conv.state.greeted = true;
    const out = new Out(this);
    person.greeting(this.ctx(out));
    this.play(out, 'greet');
  }

  ctx(out: Out, session = this.session!, visitor = this.visitor) { return { live: this, conv: this.conv, session, lang: this.lang, busy: this.busy, out, down: !!this.down, visitor }; }

  // ---- the customer's side
  setTyping(on: boolean) {
    if (this.typing && !on) this.quiet = now();
    this.typing = on; clearTimeout(this.typingTimer);
    if (on) clearTimeout(this.helpedTimer); // they're writing more: not a pause
    if (on) { this.typingTimer = setTimeout(() => this.setTyping(false), TYPING_BACKSTOP_MS); this.send({ t: 'typing', on: false }); this.send({ t: 'line', text: null }); return; }
    if (this.draft?.out.bubbles.length || this.delivering) this.flush();
    else if (this.draft && !this.draft.done) this.send({ t: 'typing', on: true });
    else if (!this.draft && this.unanswered && !this.down) this.schedule(0);
  }

  // a message: typed text, or a tap (answer: { widget, action }), or the menu's "Email a person"; page: the page it came from
  say(m: { id: string; text: string; answer?: any; page?: string | null }) {
    const text = String(m.text ?? ''); // never cut: the request's body cap bounds it (server.ts)
    const a = m.answer;
    this.lift();
    this.typing = false; clearTimeout(this.typingTimer); clearTimeout(this.helpedTimer);
    // "Did this help?" is a count, not a message: nothing is stored, and a draft running meanwhile carries on
    const helped = a?.action ? actions.take(String(a.action), this.session!.id, this.conv.shop, 'helped') : null;
    // a card from a conversation this device has left (a lapsed email grant): that card's buttons go, nothing is counted
    if (helped && helped.conversation !== this.conv.id) return this.helpedElsewhere(helped.conversation);
    if (helped) return this.helped(a.widget, !!helped.args?.yes);
    if (this.draft) this.discard(); // whatever this message is, the running draft didn't see it
    if (a?.menu === 'person') { // the ⋯ menu: the one case for trying here, or the email card (person.ts menu())
      this.dropHeld(); // as for a tap on another card (tap())
      // stored as the menu's own label: the widget sends only that, and any other text here would skip the health check
      this.store('me', t('email_person', this.lang), { client: m.id, page: m.page });
      return this.template(o => person.menu(this.ctx(o)));
    }
    if (a?.action) return this.tap(m.id, a, m.page);
    // the widget's own health-detail card (it held the message on the device): "Send it to a person instead"
    // (the draft this message discarded answered what came before it: that still gets its answer, `again()`)
    if (a?.health === 'person' && text.trim()) { this.toPerson(this.store('me', text, { client: m.id, page: m.page, health: 'person' })); return this.again(); }
    // A held message nobody chose for yet: a new message instead of a choice is the edit, so it goes, with its card
    this.dropHeld();
    // The health-detail check, here on the server, since the widget's own can be skipped by a script or
    // an outdated page: a message with a health term is stored for its card only, never seen by the model (helper.ts
    // history(), chat.ts chat()), and isn't waiting for an answer. Up or down, the card is a template.
    if (healthTerm(text)) {
      const held = this.store('me', text, { client: m.id, page: m.page, health: 'held' });
      this.template(o => this.healthCard(o, held));
      return this.again(); // the draft this message discarded answered what came before it: that still gets its answer
    }
    // the order picker sends the order's id and its app: they go into the words, so the model knows which one was
    // picked, even when two stalls of the shop have that number
    const stall = typeof a?.app === 'string' && withOrders(this.conv.shop).some(x => base(x) === a.app) ? `, ${a.app}` : '';
    const picked = typeof a?.order === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(a.order) && !text.includes(a.order) ? ` (${a.order}${stall})` : '';
    const mid = this.store('me', text + picked, { client: m.id, page: m.page });
    // a step waiting for an address, answered with just an address: no model needed, up or down
    if (person.offline(this.ctx(new Out(this)), text, (f) => this.template(f))) return;
    if (this.down) return this.whileDown(mid, m.id, text);
    this.unanswered++;
    this.schedule(150); // a breath, in case another keystroke follows
  }

  // A tap sends only the action's id; the server looks up what it does and writes the echo.
  tap(client: string, a: any, page?: string | null) {
    const act = actions.take(String(a.action), this.session!.id, this.conv.shop);
    // a card of a conversation this device has left (another email's code on a shared tablet, a lapsed grant, or the
    // other tab of two that opened a brand-new chat at once) runs nothing here: its args belong to that conversation.
    // The rejection goes back on this tap's own response, since a broadcast reaches only this cookie's conversation,
    // which another tab's tap may be running on
    if (!act || act.conversation !== this.conv.id) return this.expired();
    const args = act.args ?? {};
    if (a.widget) this.closeWidget(String(a.widget), { picked: act.id, done: true });
    if (act.kind === 'health_edit' || act.kind === 'health_person') return this.healthTap(client, act.kind, Number(args.message), page);
    // another card instead of the health card's choice is the edit, as a typed message is (say()): a held row left under a
    // newer one would be skipped by HQ's `more` cursor once "Send it to a person instead" marked it (hq.ts chat_to)
    this.dropHeld();
    this.store('me', args.label ?? '', { client, page });
    if (this.draft) this.discard();
    // a button of the company's own (its plug-in's taps): what it does is the company's, with this action's id
    const own = settings.taps[act.kind];
    if (own) return own(this.ctx(new Out(this)), act.id, args, (f) => this.template(f));
    const handled = person.tap(this.ctx(new Out(this)), act.kind, args, a, (f) => this.template(f));
    if (handled) return;
    // a tap that's a message (a starting chip, "Let's try here"): the helper answers it like typed text
    if (this.down) return this.template(o => person.outageCard(this.ctx(o)));
    this.unanswered++;
    this.schedule(0);
  }

  // the health-detail card (two buttons of equal weight) for a held message: typed, or the email card's note
  healthCard(o: Out, held: number) {
    o.say(t('health_card', this.lang), { type: 'health', options: (['health_edit', 'health_person'] as const)
      .map(kind => ({ kind, label: t(kind, this.lang), args: { message: held } })) });
  }
  // ---- the health-detail card's buttons (server's card). "Edit my message" drops the held message: its bubble goes and
  // the words go back to the widget's input (a note held from the email card, person.ts send(), goes back into that
  // card). "Send it to a person instead" is explicit consent (art. 9(2)(a)) for that route only: the card said, before
  // the tap, that a person reads it and no AI does.
  healthTap(client: string, kind: string, mid: number, page?: string | null) {
    const row = db.prepare("select id, client, text from messages where id = ? and conversation = ? and health = 'held'").get(mid, this.conv.id) as any;
    const note = !!row && this.conv.state.healthNote === row.id;
    if (this.conv.state.healthNote === mid) this.conv.state.healthNote = null;
    this.conv.state.open = null; this.save();
    if (kind === 'health_edit') {
      if (row) { db.prepare('delete from messages where id = ?').run(row.id); this.send({ t: 'drop', ids: [row.client || 'm' + row.id], ...(note ? {} : { text: row.text }) }); }
      if (note) this.template(o => person.editNote(this.ctx(o), row.text));
      return this.again(); // the tap discarded a running draft (say()): what it was answering still gets its answer
    }
    this.store('me', t('health_person', this.lang), { client, page });
    if (!row) this.template(o => o.say(t('expired', this.lang))); // edited or dropped meanwhile: nothing to send
    else { db.prepare("update messages set health = 'person' where id = ?").run(row.id); this.toPerson(row.id); }
    this.again();
  }
  again() { if (this.unanswered && !this.down) this.schedule(0); }
  toPerson(mid: number) { this.template(o => person.health(this.ctx(o), mid)); }
  dropHeld() {
    const rows = db.prepare("select id, client from messages where conversation = ? and health = 'held'").all(this.conv.id) as any[];
    if (!rows.length) return;
    db.prepare("delete from messages where conversation = ? and health = 'held'").run(this.conv.id);
    this.send({ t: 'drop', ids: rows.map(r => r.client || 'm' + r.id) });
    this.conv.state.healthNote = null; this.save(); // its id may be reused by the next row (no AUTOINCREMENT)
    const open = this.openWidget();
    if (open?.type === 'health') { this.closeWidget(open.id, { gone: true }); this.conv.state.open = null; this.save(); }
  }
  // The helper found a health detail the check missed (helper.ts remove_health_detail): the text of the customer's messages it
  // names (named: their numbers in its history, any earlier turn) or else of those it was answering goes from care's store,
  // so from every later turn, summary and the question log; the bubbles say so. The helper's own words go too: in this answer
  // (out: the draft's, shown or not) and in the answer that followed each named message, since either may repeat it.
  // Only the customer's rows of this conversation the draft saw count; latest: one of them was in the unanswered burst.
  removeHealth(out?: Out, named: number[] = []) {
    const d = this.draft && this.draft.out === out ? this.draft : null;
    const upTo = this.draft?.upTo ?? Number.MAX_SAFE_INTEGER, answeredTo = this.conv.state.answeredTo ?? 0;
    const mine = "conversation = ? and who = 'me' and id <= ? and text != '' and health is null";
    const rows = (named.length
      ? db.prepare(`select id, client from messages where ${mine} and id in (${named.map(() => '?').join(',')})`).all(this.conv.id, upTo, ...named)
      : db.prepare(`select id, client from messages where ${mine} and id > ?`).all(this.conv.id, upTo, answeredTo)) as any[];
    if (!rows.length) return { removed: 0, latest: false };
    const del = db.prepare("update messages set text = '', health = 'removed' where id = ?");
    for (const r of rows) del.run(r.id);
    const ids = rows.map(r => r.client || 'm' + r.id);
    // the answer that followed an earlier message: the helper's rows of the first model answer after it
    const answers = new Set(d ? [d.answer] : []);
    const next = db.prepare("select answer from messages where conversation = ? and who = 'ai' and id > ? and answer like 'a%' order by id limit 1");
    for (const r of rows) if (r.id <= answeredTo) { const a = (next.get(this.conv.id, r.id) as any)?.answer; if (a) answers.add(a); }
    for (const a of answers) for (const r of db.prepare("select id from messages where conversation = ? and who = 'ai' and answer = ? and text != ''").all(this.conv.id, a) as any[]) { del.run(r.id); ids.push('r' + r.id); }
    if (d) {
      d.out.bubbles.splice(d.shown);
    }
    const notes = this.dropNotes();
    this.send({ t: 'redact', ids, notes });
    return { removed: rows.length, latest: rows.some(r => r.id > answeredTo) };
  }
  // What a draft wrote from the chat goes with a removal too, whichever answer wrote it: the check missed this detail, so
  // nothing can tell which of them repeats it. The email card's note (ask_for_person), in the state and on every card that
  // showed it (a card from the ⋯ menu shows a note an earlier answer set), whose buttons go with it (the note would come
  // back from the page); a question waiting for its address; the snapshot's problem. The draft's copy of the state too, or
  // a dropped draft would put them back (restore()). A person case already filed from this chat may carry it in its
  // words: no model drafts for it now (drafts.ts), as for a health detail sent to a person (person.ts health()), and
  // HQ's card, if it has one, hears so (hq.ts).
  dropNotes() {
    for (const st of [this.conv.state, this.draft?.state]) {
      if (!st) continue;
      st.note = null; st.modelNote = null; st.snapProblem = null; // (modelNote)
      if (st.question) { st.question = null; if (st.step === 'team-email') st.step = null; }
    }
    if (db.prepare("update cases set health = 1 where conversation = ? and kind = 'person' and health is null").run(this.conv.id).changes) hq.nudge();
    const cards = db.prepare(`select id, widget from messages where conversation = ? and who = 'ai' and json_extract(widget, '$.type') = 'summary'
      and json_extract(widget, '$.kind') = 'handover' and json_extract(widget, '$.note') is not null`).all(this.conv.id) as any[];
    const open = this.openWidget();
    for (const r of cards) {
      const w = JSON.parse(r.widget);
      delete w.note; delete w.noteAiGenerated; // (noteAiGenerated)
      actions.revoke((w.options ?? []).map((o: any) => o.action));
      if (!w.ws?.done) w.ws = { ...w.ws, gone: true };
      db.prepare('update messages set widget = ? where id = ?').run(JSON.stringify(w), r.id);
      if (!w.ws.done) this.send({ t: 'close', widget: w.id, gone: true });
      if (open?.id === w.id) for (const st of [this.conv.state, this.draft?.state]) if (st?.open?.id === w.id) st.open = null;
    }
    this.save();
    return cards.map(r => 'r' + r.id);
  }

  // while the model is down only templates run: the way to a person, and the outage steps; the rest waits for the helper.
  // After a stop it's kept for the person instead. person.ts sends it with "Email a person".
  whileDown(mid: number, client: string, text: string) {
    this.unanswered++;
    if (this.waits) this.send({ t: 'wait', ids: [client], on: true });
    else { this.conv.state.afterCap = [...(this.conv.state.afterCap ?? []), text].slice(-20); this.save(); }
  }

  // a template answer: instant, no model, works in an outage
  template(f: (o: Out) => unknown) { const o = new Out(this); f(o); this.play(o, 't' + now()); }

  // ---- drafts
  // A new draft only 1.5 s after the last one started, whatever the client says about typing (a script
  // sending a message every 200 ms would otherwise buy a draft each time)
  schedule(ms: number) {
    clearTimeout(this.pending);
    ms = Math.max(ms, this.lastStart + DRAFT_GAP_MS - now());
    this.pending = setTimeout(() => { if (!this.typing && !this.draft && !this.delivering && this.unanswered && !this.down) this.run(); }, ms);
  }

  run() { if (this.gone) return; this.start().catch(err => console.error(`care: conversation ${this.conv.id}: draft failed:`, err?.message)); }
  // a cap this conversation has reached (ledger.ts): checked before each draft, and by helper.ts before each further round
  blocked() {
    const s = this.session && (sessions.current(this.session) ?? this.session);
    return ledger.blocked({ app: this.about(), conversation: this.conv.id, session: s?.id ?? '', ip: this.ip, verified: !!s && (s.orders.length > 0 || !!s.email) });
  }
  capped(block: ledger.Cap) { return this.goDown(['credit', 'month', 'app'].includes(block) ? 'cap' : 'stop', block); }   // 'credit':
  async start(attempt = 0) {
    if (!this.session) { clearInterval(this.retry); this.retry = null; return; } // every device forgot it: nobody to answer as
    const block = this.blocked();
    if (block) return this.capped(block);
    if (attempt === 0 && ledger.breaker.state() === 'down' && !ledger.breaker.probe()) return this.goDown('service');
    // the device that sent the burst: its grants are the ones the draft may use and raise (two devices can share a thread)
    // state is restored if the draft is dropped (its tools may count an ask or open a step); upTo is the last message it
    // can have seen, so one typed while it ran is still answered
    const upTo = (db.prepare('select max(id) as n from messages where conversation = ?').get(this.conv.id) as any).n ?? 0;
    // timed: first words are counted for an answer to what the customer just said; not for one while down (the outage
    // minutes count that wait) or one carrying on after a restart (nobody knows since when)
    const d: Draft = { abort: new AbortController(), out: new Out(this), shown: 0, done: false, t0: now(), answer: 'a' + now(), attempt, first: false,
      session: this.session!, visitor: this.visitor, state: structuredClone(this.conv.state), upTo, timed: !this.down && this.quiet > 0 };
    this.lastStart = now();
    this.draft = d;
    const working = setTimeout(() => { if (this.draft === d && !this.typing && !d.first) this.send({ t: 'typing', on: true }); }, 280);
    const silent = setTimeout(() => { if (this.draft === d && !d.first) { d.silent = true; d.abort.abort(new Error('silent')); } }, SILENT_MS);
    try {
      await helper.answer(this.ctx(d.out, d.session, d.visitor), d.abort.signal, () => { d.first = true; });
      clearTimeout(silent); clearTimeout(working);
      this.timed(d, d.abort.signal.aborted ? 'cut' : 'done');
      if (this.draft !== d) return; // discarded while it ran
      ledger.breaker.ok();
      d.done = true;
      if (this.down) this.back(d);
      this.flush();
    } catch (err: any) {
      clearTimeout(silent); clearTimeout(working);
      this.timed(d, numbers.outcomeOf(d.abort.signal, err instanceof helper.Capped));
      if (this.draft !== d) return; // a follow-up aborted it: discard() already moved on
      this.draft = null;
      this.send({ t: 'typing', on: false }); this.send({ t: 'line', text: null });
      this.restore(d);
      if (err instanceof helper.Capped) return this.capped(err.cap); // a cap reached between two rounds: no retry
      const provider = err instanceof ProviderError ? err.retryable : err?.name === 'AbortError'; // a provider failure, or silent
      if (!provider) console.error(`care: conversation ${this.conv.id}: draft failed:`, err?.status ?? '', err?.message);
      // only the provider's own failures count toward the breaker: one conversation's bad request mustn't take every
      // app down, or make the card blame a service that's fine; that conversation stops, and leads with the person
      if (provider) ledger.breaker.failed();
      if (attempt === 0 && d.shown === 0 && !d.silent) return this.start(1); // one retry
      this.goDown(provider ? 'service' : 'stop', 'error');
    }
  }

  // a draft's turn for Numbers, from its start to its last round's end, before the bubbles' beats (numbers.ts took())
  timed(d: Draft, outcome: numbers.Outcome) {
    if (!d.out.calls) return;
    numbers.took(this.about(), 'chat', 'turn', outcome, now() - d.t0);
    if (outcome === 'done') numbers.rounds(this.about(), 'chat', d.out.calls, d.out.roundsOut);
  }
  // a dropped draft leaves the conversation's state as it found it (its effects and widgets never ran); "Did this
  // help?" tapped while it ran isn't the draft's, and stays
  restore(d: Draft) { if (d.shown === 0) { this.conv.state = { ...d.state, unanswered: this.unanswered, down: this.down, helped: this.conv.state.helped, stall: this.conv.state.stall }; this.save(); } }
  discard() {
    const d = this.draft; if (!d) return;
    this.draft = null; d.abort.abort(); this.restore(d);
    // what was already shown stays shown (and stored); the rest of the draft, its widgets and its effects are dropped
    this.send({ t: 'typing', on: false }); this.send({ t: 'line', text: null });
  }

  // Send what's ready, one bubble at a time, never while the customer types. The draft's widgets and effects go with
  // its last bubble, once the model has finished: before that, a follow-up could still discard them.
  flush() {
    const d = this.draft; if (!d || this.typing || this.delivering) return;
    if (this.down && !d.done) return; // a probe while down: nothing shows until it worked and "I'm back" leads
    if (d.shown >= d.out.bubbles.length) { if (d.done) this.finish(d); return; }
    // the newest bubble waits for the end of the draft: a tool may still put a card under it
    if (!d.done && d.shown >= d.out.bubbles.length - 1) return;
    if (!d.done && d.out.held && d.shown >= d.out.round) return; // a round's words while its tools run (Out.hold)
    const b = d.out.bubbles[d.shown];
    const last = d.done && d.shown === d.out.bubbles.length - 1;
    this.delivering = true;
    if (d.shown === 0 && d.timed) numbers.firstWords(this.about(), d.out.lookup ? 'lookup' : 'plain', now() - this.quiet);
    if (last) this.runEffects(d.out);
    this.deliver(b, d.answer, d.session);
    d.shown++;
    const gap = Math.min(1300, Math.max(450, 300 + b.text.length * 9)); // a beat between bubbles, like a person texting
    // after the beat: the rest of this draft, or the one a follow-up started meanwhile, or the follow-up's own draft (its
    // schedule() couldn't start one while a bubble was going out)
    setTimeout(() => { this.delivering = false; if (this.draft) this.flush(); else if (this.unanswered && !this.down) this.schedule(0); }, d.shown < d.out.bubbles.length ? gap : 0);
  }
  finish(d: Draft) {
    if (this.draft !== d) return;
    if (d.shown === 0 && d.out.effects.length) this.runEffects(d.out); // effects without a bubble (rare)
    this.draft = null;
    this.conv.state.answeredTo = d.upTo;
    this.save();
    // anything typed while it ran (an outage's probe, a code box) wasn't seen: it gets its own answer
    this.unanswered = (db.prepare("select count(*) as n from messages where conversation = ? and who = 'me' and id > ? and health is null").get(this.conv.id, d.upTo) as any).n;
    if (this.unanswered) this.schedule(0);
    this.send({ t: 'typing', on: false }); this.send({ t: 'line', text: null });
    if (d.out.outcome) this.outcome();
    this.seen = now();
  }

  // ---- "Did this help?" (the helper's measures, numbers.ts): once per conversation, only after an outcome (an answer from the
  // knowledge or how an order stands, helper.ts `answered`; or a company's own tool says so, `outcome()`), once the customer has
  // been quiet for a moment, with nothing waiting for their answer and no person asked for (a complaint is one). The
  // answer is a count per app and day: the conversation keeps only that it was asked and answered, never which way.
  outcome() {
    if (this.conv.state.helped || this.gone) return;
    clearTimeout(this.helpedTimer);
    this.helpedTimer = setTimeout(() => this.askHelped(), HELPED_MS);
  }
  askHelped() {
    const st = this.conv.state;
    if (this.gone || !this.session || st.helped || st.caseMade || st.handed || st.step || this.down || this.typing || this.draft || this.delivering || this.unanswered || this.waiting()) return;
    st.helped = 'asked'; this.save();
    numbers.count(this.about(), 'helped_asked');
    this.template(o => o.say(t('helped_q', this.lang), { type: 'helped', options: [{ kind: 'helped', label: t('helped_yes', this.lang), args: { yes: true } },
      { kind: 'helped', label: t('helped_not', this.lang), args: { yes: false } }] }));
  }
  // a card still waiting for the customer (one of the company's own tools', the code box, the email card): the conversation isn't at a pause.
  // The greeting's starting chips don't count: a customer who typed instead leaves them open.
  waiting() {
    const open = this.openWidget();
    if (!open) return false;
    const row = db.prepare("select widget from messages where conversation = ? and json_extract(widget, '$.id') = ? order by id desc limit 1").get(this.conv.id, open.id) as any;
    const w = row ? JSON.parse(row.widget) : null;
    return !!w && !w.start && !w.ws?.done && !w.ws?.gone;
  }
  // the tap: counted, and the card closed without saying which; both buttons' actions go, so nothing kept says it either.
  // "Not really" gets one line, never a form, shown and not stored.
  helped(widget: unknown, yes: boolean) {
    db.prepare("delete from actions where conversation = ? and kind = 'helped'").run(this.conv.id);
    if (widget) this.closeWidget(String(widget), { done: true });
    this.conv.state.helped = 'answered'; this.save();
    numbers.count(this.about(), yes ? 'helped_yes' : 'helped_no');
    if (!yes) this.send({ t: 'reply', id: 'h' + now().toString(36), text: t('helped_no', this.lang), answer: 'h' + now() });
  }
  helpedElsewhere(conv: number) {
    db.prepare("delete from actions where conversation = ? and kind = 'helped'").run(conv);
    return this.expired();
  }
  // what say() returns for a tap of another conversation's action: the widget that tapped runs hello() again
  expired(): Resync { return { resync: true, text: t('expired', this.lang) }; }

  runEffects(out: Out) { for (const f of out.effects.splice(0)) { try { const r: any = f(); r?.catch?.((e: any) => console.error(`care: conversation ${this.conv.id}: effect failed:`, e?.message)); } catch (e: any) { console.error(`care: conversation ${this.conv.id}: effect failed:`, e?.message); } } }

  // one bubble out: its widget gets an id and each option an action id now, never in a draft that might be dropped.
  // With no device in the chat (every one forgot it; it's kept for its checked email) a line is still stored for whoever
  // opens it with that email, but a card's options aren't: an action belongs to a device.
  deliver(b: Bubble, answer: string, session: Session | null = this.session) {
    let widget: any;
    const s = session && (sessions.current(session) ?? session); // its id may have rotated since the draft began
    if (b.widget) {
      const { options, ...rest } = b.widget;
      widget = { id: 'w' + now().toString(36) + Math.random().toString(36).slice(2, 6), ...rest };
      if (options && s) widget.options = options.map(o => ({ action: actions.propose({ conversation: this.conv.id, session: s.id, shop: this.conv.shop,
        kind: o.kind, args: { ...(o.args ?? {}), label: o.echo ?? o.label }, ttlMs: 24 * 3600_000 }).id, label: o.label, ...(o.primary ? { primary: true } : {}) }));
      const open = this.openWidget();
      if (open && widget.options && open.id !== widget.id) this.closeWidget(open.id, { gone: true }); // a newer card supersedes the older one
      if (widget.options || widget.type === 'code_entry') this.conv.state.open = { id: widget.id, type: widget.type, kind: widget.kind };
    }
    // (aiGenerated)
    const id = 'r' + this.store('ai', b.text, { widget, answer, aiGenerated: b.aiGenerated });
    this.send({ t: 'line', text: null });
    this.send({ t: 'reply', id, text: b.text, ...(widget ? { widget } : {}), ...(b.source ? { source: b.source } : {}), answer, ...(b.aiGenerated ? { aiGenerated: true } : {}) });
  }

  // template steps (the greeting, the way to a person, the outage card): no model, so they go out at once, in one go,
  // unless the customer is typing (then they wait like any answer)
  play(out: Out, answer: string) {
    if (this.gone) return;
    this.runEffects(out);
    if (this.typing) return void setTimeout(() => this.play(out, answer), 300);
    for (const b of out.bubbles.splice(0)) this.deliver(b, answer);
  }

  // ---- the outage state: from templates, with "Email a person" in the message
  // why: the cap that stopped it (ledger.ts), or 'error' for a request that failed for a reason that isn't the provider's
  goDown(cause: Outage, why: ledger.Cap | 'error' | null = null) {
    this.draft = null;
    const was = this.down; this.down = cause;
    if (cause === 'stop') { Object.assign(this.conv.state, { until: ledger.dayEnd(), stop: why }); this.save(); }
    this.send(this.status());
    this.send({ t: 'typing', on: false }); this.send({ t: 'line', text: null });
    const waiting = (db.prepare('select client, id from messages where conversation = ? and who = ? and id > ? and health is null').all(this.conv.id, 'me', this.conv.state.answeredTo ?? 0) as any[]);
    // After an outage, a stop takes the waiting marks off. Nothing is lost. A person's case carries the whole chat (hq.ts).
    if (waiting.length) this.send({ t: 'wait', ids: waiting.map(w => w.client || 'm' + w.id), on: this.waits });
    if (was !== cause) this.template(o => person.outageCard(this.ctx(o)));
    clearInterval(this.retry); this.retry = null;
    if (this.waits) this.retrying();
  }
  // while down (not stopped), try again now and then: answer what's waiting, or see whether the service is back
  retrying() {
    clearInterval(this.retry);
    this.retry = setInterval(() => { if (this.gone) return clearInterval(this.retry); if (!this.draft && this.unanswered) this.run(); else if (!this.unanswered) this.tryBack(); }, RETRY_MS);
  }
  // nothing waiting, but the service may be back: say so when it is, so the header turns green again
  tryBack() {
    if (this.down === 'cap' && !ledger.blocked({ app: this.about(), conversation: this.conv.id, session: this.session?.id ?? '', ip: this.ip, verified: true })) this.back();
    else if (this.down === 'service' && ledger.breaker.state() === 'up') this.back();
  }
  back(d?: Draft) {
    clearInterval(this.retry); this.retry = null;
    this.down = null;
    this.send(this.status());
    const ids = (db.prepare('select client, id from messages where conversation = ? and who = ? and id > ? and health is null').all(this.conv.id, 'me', this.conv.state.answeredTo ?? 0) as any[]);
    if (ids.length) this.send({ t: 'wait', ids: ids.map(w => w.client || 'm' + w.id), on: false });
    if (d) d.out.bubbles.unshift({ text: t('back', this.lang) });
    else if (this.unanswered) this.schedule(0);
  }
}

// Drop live conversations nobody has touched for half an hour (the database keeps them), so memory doesn't grow and a
// conversation the sweep deleted is never served from here
export function prune(t = now()) {
  for (const [id, l] of lives) if (!l.subs.size && !l.draft && !l.retry && t - l.seen > 30 * 60_000) { clearTimeout(l.pending); clearTimeout(l.typingTimer); lives.delete(id); }
}
export const forget = (conv: number) => { const l = lives.get(conv); if (l) { l.gone = true; clearTimeout(l.pending); clearTimeout(l.typingTimer); clearInterval(l.retry); clearTimeout(l.helpedTimer); l.discard(); l.send({ t: 'forget' }); lives.delete(conv); } };
