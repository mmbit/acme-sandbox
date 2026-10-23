// Care's HTTP side: the widget's files and API under /__care on every app's own host (Caddy sets X-Care-App from the
// host), and a status page on care's own preview host. The company's plug-in (company.ts) is loaded first, and its
// public files are served under /__care/company/. Every POST is JSON with an Origin equal to the host (CSRF); no
// GET changes anything. Logs carry ids and statuses only, never what anyone wrote.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PORT, HOST, LOCAL, PROVIDER, UPLOAD_MS, appsOf } from './config.ts';
import { db, limit, sweep } from './db.ts';
import { clientOf } from '../../../shared/net/net.ts';
import * as sessions from './session.ts';
import * as gate from './gate.ts';
import * as engine from './engine.ts';
import * as ledger from './ledger.ts';
import * as email from './email.ts';
import * as hq from './hq.ts';
import * as answers from './answers.ts';
import * as phoneanswer from './phoneanswer.ts';
import * as photos from './photos.ts';
import * as apps from './apps.ts';
import * as actions from './actions.ts';
import * as diagnostics from './diagnostics.ts';
import * as toollog from './toollog.ts';
import * as numbers from './numbers.ts';
import * as status from './status.ts';
import * as phone from './phone.ts';
import { t, lang as toLang, mask, CODE_TYPED } from './texts.ts';
import { busy } from './busy.ts';
import * as company from './company.ts';
import { settings, nameOf } from './company.ts';

await company.load();
if (PROVIDER === 'anthropic' && !settings.model) throw new Error('No model for the helper: set `model` in the company\'s care.ts, or CARE_MODEL');

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
// the engine's widget at /__care/<file>, the company's own (its look, words and lists) at /__care/company/<file>: read
// once, each folder's own files only (no test, nothing in a subfolder)
const files = (dir: string, under = '') => { try { return readdirSync(dir).filter(f => TYPES[f.slice(f.lastIndexOf('.'))] && !/\.test\.m?js$/.test(f)).map(f => [under + f, readFileSync(join(dir, f))] as const); } catch { return []; } };
// a company without a public/plugin.js gets an empty one: the widget imports it statically, and gets the engine's defaults
const FILES = new Map([['company/plugin.js', Buffer.from('export {};\n')], ...files(new URL('../public', import.meta.url).pathname), ...files(join(company.DIR, 'public'), 'company/')]);
const APP = /^[a-z0-9][a-z0-9-]{0,40}(@preview)?$/;
const BODY_MAX = 16 * 1024;
const HOUR_MS = 3600_000;

// ---- helpers
const send = (res: ServerResponse, status: number, body: any, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
};
const appOf = (req: IncomingMessage) => { const a = String(req.headers['x-care-app'] ?? ''); return APP.test(a) ? a : null; };
// The shop the session is the shop's (X-Care-Shop, Caddy's own like X-Care-App): its stalls share one origin, so one
// cookie, one session and one chat. Without one, the app is a shop of one. The app must be a stall of it (or the shop's own
// pages), else nothing: a stall is only a costume, but the order endpoints the session may ask are the shop's.
const shopOf = (req: IncomingMessage, app: string) => {
  const h = req.headers['x-care-shop'], s = h === undefined ? app : String(h);
  return APP.test(s) && (s === app || appsOf(s).includes(app)) ? s : null;
};
// CSRF: the browser always sends Origin on a POST; it must be this host (https, or http only on a local run)
const sameOrigin = (req: IncomingMessage) => { const o = req.headers.origin, h = req.headers.host; return !!o && !!h && (o === `https://${h}` || (LOCAL && o === `http://${h}`)); };
async function body(req: IncomingMessage, max = BODY_MAX) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return null;
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) return null; chunks.push(c); }
  try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}

// The conversation a session talks in: its own, or a new one (a forgotten device, a lapsed email grant, a code for
// another email on a shared tablet). A device with a live email grant starts in that email's thread, so what it's shown
// there is level-2 data that leaves the device with the grant (session.ts lapse()).
function conversationOf(s: sessions.Session, lang: string, stall: string) {
  const l = s.conversation != null ? engine.live(s.conversation) : null;
  if (l) return l;
  const n = engine.create(s.shop, toLang(lang), stall);
  sessions.attach(s, n.conv.id);
  s.conversation = n.conv.id;
  if (sessions.level(s) === 2 && s.email) n.join(s.email, s);
  return n;
}

// Who may delete a conversation for good: anyone in a chat never linked to an email (it has no other owner), and at
// level 2 the owner of the email it's linked to. A chat in an email's thread holds that customer's other devices' words.
const mayDelete = (s: sessions.Session, l: engine.Live) => !l.conv.email || (sessions.level(s) === 2 && s.email === l.conv.email);

// A session's grant rose since its last request: it gets a new id now (no session fixation)
function rotated(s: sessions.Session, cookies: string[]) {
  if (!s.rotate) return s;
  const r = sessions.rotate(s);
  if (!r) return null;
  cookies.push(r.cookie);
  return r.session;
}

// ---- the widget's API
async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  const app = appOf(req), shop = app && shopOf(req, app);
  if (!app || !shop) return send(res, 400, { error: 'no app' });
  if (path === 'health') return send(res, 200, { ok: true, model: ledger.breaker.state() === 'down' ? 'down' : ledger.blocked({ app, verified: true }) ? 'cap' : 'up' });

  if (path === 'stream' && req.method === 'GET') {
    const s = sessions.open(req, shop);
    if (!s || s.conversation == null) return send(res, 401, { retry: true });
    const l = engine.live(s.conversation);
    if (!l) return send(res, 401, { retry: true });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    res.write('retry: 300\n\n: hello\n\n'); // a stream ended for a new session id comes back at once
    // Only while the cookie it was opened with lives: once a grant rises, a stream opened with the old cookie, perhaps a
    // planted one, hears only `renew`, and when the session gets its new id (or the device forgets it) it ends (session
    // fixation). The widget's own stream reconnects with the new cookie, and its hello brings back
    // what it missed.
    const sid = s.id;
    const off = l.subscribe(m => {
      const may = sessions.hearing(sid, l.conv.id);
      if (may === 'all' && m.t !== 'moved') return void res.write(`data: ${JSON.stringify(m)}\n\n`);
      if (may !== 'none') return void (m.t === 'renew' && res.write(`data: ${JSON.stringify(m)}\n\n`));
      off(); // nothing more is written to it, so nothing is written after its end
      if (m.t === 'forget') res.write(`data: ${JSON.stringify(m)}\n\n`); // the device's other tabs clear too
      res.end();
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => { clearInterval(ping); off(); });
    return;
  }
  // a file of the company's own for this device (company.ts `files`): a link its tool put in the chat, opened by the
  // browser with the session's cookie. Changes nothing; downloaded, never shown as a page of ours
  if (path.startsWith('file/') && req.method === 'GET') {
    const s = sessions.open(req, shop);
    // not while a grant is held for a page (session.ts held()): whoever holds the cookie then isn't known to be that page
    if (!s || !sessions.mayUse(s, '') || !limit(`file:${s.id}`, 60, HOUR_MS)) return send(res, 404, { error: 'not found' });
    const f = await settings.files(s, path.slice('file/'.length));
    if (!f) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.body.length, 'content-disposition': `attachment; filename="${f.name.replace(/[^\w.-]/g, '')}"`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    return res.end(f.body);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (path === 'photo') return await photo(req, res, app, shop); // a claim photo: raw JPEG bytes, read with their own cut-off
  // a bug report's picture: 256 KB, that route only, and read only for a live session (no cookie, nothing buffered), 20
  // times an hour at most (one Send per card: the rest are refusals a script could repeat)
  if (path === 'diagnostics') {
    const open = sessions.open(req, shop);
    if (!open) return send(res, 401, { retry: true });
    if (!limit(`diag:${open.id}`, 20, HOUR_MS)) return send(res, 429, { ok: false, why: 'slow down' });
  }
  const b = await body(req, path === 'diagnostics' ? diagnostics.BODY_MAX : BODY_MAX);
  if (!b) return send(res, 400, { error: 'JSON body only' });
  const ip = clientOf(req), cookies: string[] = [], tab = String(req.headers['x-care-tab'] ?? '').slice(0, 64);

  let s = sessions.open(req, shop);
  if (s && !sessions.mayUse(s, tab)) return send(res, 401, { retry: true }); // a grant held for another page (session.ts held())
  if (path === 'hello' && !s) {
    if (!limit(`session-ip:${ip}`, 30, HOUR_MS)) return send(res, 429, { error: 'too many new chats from here' });
    const c = sessions.create(shop); s = c.session; cookies.push(c.cookie);
  } else if (!s) return send(res, 401, { retry: true }); // only hello makes a session: anything else would overwrite a rotated cookie
  const moved = !!s.rotate;
  s = rotated(s, cookies);
  if (!s) return send(res, 401, { retry: true });
  if (!cookies.length) { const c = sessions.refresh(req, s); if (c) cookies.push(c); }
  sessions.touch(s);
  const l = conversationOf(s, b.lang, app);
  l.setStall(app); // the stall this request came from: the helper wears its apron from now on
  // the server's own message: streams on the old id end, and the widget's reconnect says hello; once this response (with
  // the new cookie) has gone, or the reconnect would still carry the old one
  if (moved) res.once('finish', () => l.send({ t: 'moved' }));
  l.session = s; l.ip = ip; l.seen = Date.now();
  l.visitor = settings.visitor(req); // what the plug-in's tools need of this request
  // fresh: this response gives the session a new id (a renew, or a code or link checked here), and says so, so the
  // widget opens its stream again at once with the new cookie rather than after the ended stream's retry
  let fresh = moved;
  const headers = () => ({ ...(cookies.length ? { 'set-cookie': cookies } : {}), ...(fresh ? { 'x-care-new-id': '1' } : {}) });
  const done = (x: any = { ok: true }) => send(res, 200, x, headers());
  const slow = () => send(res, 429, { ok: false, why: 'slow down' }, headers());

  switch (path) {
    case 'hello': {
      if (b.lang) l.followPage(toLang(b.lang));
      l.greet();
      // lang: the conversation's, so the widget's own words match the server's fixed texts; may: what the delete step
      // offers (kept: forgetting it on this device leaves the server's copy, a chat linked to an email; one never linked
      // goes with it.)
      // stall: the stall the widget is in, for the company's look of it (its stylesheet, data-stall)
      return done({ level: sessions.level(s), items: l.items(), ...l.status(), t: undefined, name: settings.names[company.base(app)] ?? null,
        stall: company.base(app), lang: l.lang, may: { delete: mayDelete(s, l), kept: !!l.conv.email }, bodyMax: BODY_MAX }); // bodyMax:
    }
    case 'say': {
      const id = String(b.id ?? '').slice(0, 40), text = String(b.text ?? '');
      if (!text.trim() && !b.answer) return done({ ok: false, why: 'empty' });
      // every message is stored, with the model up or down: a script mustn't fill the disk (120 an hour is far past a person)
      if (!limit(`say:${l.conv.id}`, 120, HOUR_MS)) return slow();
      // a tap of another conversation's action is answered on its own response, for the tab that tapped
      const r = l.say({ id, text, answer: b.answer && typeof b.answer === 'object' ? b.answer : undefined, page: sessions.pageOf(tab) });
      return done(r?.resync ? { ok: true, resync: true, text: r.text } : undefined);
    }
    case 'typing': l.setTyping(!!b.on); return done();
    case 'renew': return done();
    // the eval reads the model's tool calls in this conversation, where they're kept (a local run, a preview app: toollog.ts)
    case 'tools': return toollog.kept(shop) ? done({ calls: toollog.list(l.conv.id) }) : send(res, 404, { error: 'no such call' });
    case 'copy': { // "Email me a copy of this chat": only ever to an email checked by code, so a shared tablet can't mail it elsewhere
      if (sessions.level(s) !== 2 || !s.email) { l.send({ t: 'toast', text: t('copy_check', l.lang) }); return done(); }
      if (!limit(`copy:${s.email}`, 3, HOUR_MS)) { l.send({ t: 'toast', text: t('copy_later', l.lang) }); return done(); } // one inbox, not a mail cannon
      const name = nameOf(app);
      // AI-written when a message the model wrote is in it
      const copied = (db.prepare('select who, text, health, ai_generated from messages where conversation = ? order by id').all(l.conv.id) as any[])
        .filter(m => m.text && m.health !== 'held');
      const lines = copied.map(m => `${m.who === 'me' ? '—' : `${settings.helper}:`} ${m.text.replace(/\*\*/g, '')}`);
      const r = await email.send({ to: s.email, kind: 'copy', subject: t('subject_copy', l.lang, { app: name }), text: `${lines.join('\n\n')}\n\n${t('sign', l.lang, { app: name })}`,
        app: l.about(), aiGenerated: copied.some(m => m.ai_generated) });
      l.send({ t: 'toast', text: r.ok ? t('copy_sent', l.lang, { to: mask(s.email) }) : t('copy_check', l.lang) });
      return done();
    }
    case 'forget': { // this device forgets the chat; a chat nobody checked an email for has no other owner, so it goes too
      const conv = l.conv;
      cookies.length = 0; cookies.push(sessions.forget(s));
      engine.forget(conv.id);
      if (!conv.email) db.prepare('delete from conversations where id = ?').run(conv.id);
      return done();
    }
    case 'delete': { // "Delete this conversation": gone from the server, not only from this device
      if (!mayDelete(s, l)) return done({ ok: false, why: 'check' });
      const id = l.conv.id;
      engine.forget(id); // its timers stop, and every tab and device in it clears (the stream's `forget`) and starts afresh
      // its messages, actions and bug reports' bundles go with it (ON DELETE CASCADE), and care's own copy of its bug cases
      // (nothing in them the customer waits on). What went to a person stays with the team, as the confirm step says.
      db.exec('begin');
      try {
        db.prepare('update sessions set conversation = null where conversation = ?').run(id);
        db.prepare("delete from cases where conversation = ? and kind = 'bug'").run(id);
        db.prepare('delete from conversations where id = ?').run(id);
        db.exec('commit');
      } catch (err) { db.exec('rollback'); throw err; }
      return done();
    }
    case 'diagnostics': { // "Send it" on the consent card: the bug report's bundle
      const id = String(b.id ?? '').slice(0, 40) || undefined, wid = String(b.widget ?? '').slice(0, 40), action = String(b.action ?? '').slice(0, 40);
      const refuse = (status: number, why: string) => send(res, status, { ok: false, why }, cookies.length ? { 'set-cookie': cookies } : {});
      // the consent was given on our card, by a tap: a live snap_send action of this session, on a consent card of this
      // conversation; a script holding the cookie but no card gets nothing stored
      const row = wid && db.prepare("select widget from messages where conversation = ? and widget like ? order by id desc limit 1").get(l.conv.id, `%"id":"${wid.replace(/[%_"\\]/g, '')}"%`) as any;
      const card = row ? JSON.parse(row.widget) : null;
      const kind = (db.prepare('select kind from actions where id = ? and conversation = ?').get(action, l.conv.id) as any)?.kind;
      if (card?.id !== wid || card.type !== 'consent' || !card.options?.some((o: any) => o.action === action) || kind !== 'snap_send') return refuse(403, 'no consent');
      const c = diagnostics.check(b.bundle);
      if (!c.ok) return refuse(400, c.why);
      const act = actions.take(action, s.id, shop); // once: a second Send for the same card is refused
      if (!act) return refuse(409, 'already sent');
      const ref = diagnostics.file({ app, conversation: l.conv.id, lang: l.lang, problem: String(l.conv.state.snapProblem ?? ''),
        handed: l.conv.state.handed, bundle: c.bundle });
      hq.nudge();
      console.log(`care: conversation ${l.conv.id}: a bug report is case ${ref}`);
      l.closeWidget(wid, { picked: act.id, done: true });
      l.store('me', act.args?.label ?? '', { client: id });
      l.template(o => o.say(t('snap_sent', l.lang, { ref })));
      return done({ ok: true, ref });
    }
    case 'link': { // the signed link from our emails, sent by POST from the URL fragment
      if (!limit(`link:${l.conv.id}`, 10, HOUR_MS)) return slow(); // each bad link stores a reply too
      const r = gate.redeemLink(s, shop, String(b.token ?? '').slice(0, 2000));
      if (!r.ok) { l.template(o => o.say(t('link_bad', l.lang))); return done({ ok: false }); }
      const n = rotated(r.session, cookies) ?? r.session;
      fresh = n.id !== s.id;
      l.session = n;
      if (!l.join(n.email!, n)) return done({ ok: true, level: 2 }); // another email's chat on this device: a new one starts
      l.send({ t: 'level', level: 2 });
      l.template(o => o.say(t('link_ok', l.lang)));
      return done({ ok: true, level: 2 });
    }
    case 'code': { // the code box: checked here, never through the model
      // each try stores a reply, and with no code issued (or one spent) the gate counts nothing: bounded like 'say'
      if (!limit(`code:${l.conv.id}`, 20, HOUR_MS)) return slow();
      const r = gate.checkCode(s, String(b.code ?? '').slice(0, 20));
      const wid = String(b.widget ?? '');
      if (!r.ok) {
        if (wid) l.closeWidget(wid, { reopen: true });
        l.template(o => o.say(t(r.why === 'wrong' ? 'code_wrong' : 'code_spent', l.lang)));
        return done({ ok: false });
      }
      const n = rotated(r.session, cookies) ?? r.session;
      fresh = n.id !== s.id;
      l.session = n;
      if (wid) l.closeWidget(wid, { done: true });
      l.store('me', CODE_TYPED, { client: String(b.id ?? '').slice(0, 40) || undefined });
      if (!l.join(n.email!, n)) return done({ ok: true, level: 2 }); // another email's chat on this device: a new one starts
      l.send({ t: 'level', level: 2 });
      l.template(o => o.say(t('code_ok', l.lang)));
      if (!settings.afterCheck(l.ctx(new engine.Out(l)))) l.answerNext(); // a tap of the company's that waited for the check goes on; else the helper carries on
      return done({ ok: true, level: 2 });
    }
  }
  return send(res, 404, { error: 'no such call' });
}

// ---- a claim photo (photos.ts): POST /__care/api/photo?shot=<shot>&widget=<id>&id=<client id>, Content-Type
// image/jpeg, the bytes as the body. The order and the case come from the conversation's claim only (a company's own
// tool sets it when it asks for photos), never from the request; the order must be one this session may see, and the shot
// one the claim asks for. Anything refused before the body is read closes the connection, so nothing more is read.
const PHOTO_TEXT: Record<photos.Why, string> = { shot: 'photo_bad', type: 'photo_bad', decode: 'photo_bad', size: 'photo_big', pixels: 'photo_big',
  case: 'photo_case', day: 'photo_day', busy: 'photo_busy' };
// the body, up to the room taken for it: null if it goes past that, 'slow' if it isn't in within UPLOAD_MS, 'gone' if the
// connection ends first (the time limit, and a connection already gone)
function upload(req: IncomingMessage, max: number): Promise<Buffer | null | 'slow' | 'gone'> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0, done = false;
    const end = (b: Buffer | null | 'slow' | 'gone') => { if (!done) { done = true; clearTimeout(timer); if (!Buffer.isBuffer(b)) req.pause(); resolve(b); } };
    const timer = setTimeout(() => end('slow'), UPLOAD_MS);
    if (req.destroyed) return end('gone');
    req.on('data', (c: Buffer) => { if (done) return; size += c.length; if (size > max) end(null); else chunks.push(c); });
    req.on('end', () => end(Buffer.concat(chunks)));
    req.on('error', () => end('gone')); req.on('close', () => end('gone'));
  });
}
async function photo(req: IncomingMessage, res: ServerResponse, app: string, shop: string) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const ip = clientOf(req), cookies: string[] = [], tab = String(req.headers['x-care-tab'] ?? '').slice(0, 64);
  const close = (status: number, x: any) => send(res, status, x, { connection: 'close' });
  if (!String(req.headers['content-type'] ?? '').startsWith('image/jpeg')) return close(415, { ok: false, why: 'type' });
  if (Number(req.headers['content-length'] ?? 0) > photos.MAX_BYTES) return close(413, { ok: false, why: 'size' });
  let s = sessions.open(req, shop);
  if (!s || !sessions.mayUse(s, tab)) return close(401, { retry: true });
  const moved = !!s.rotate;
  s = rotated(s, cookies);
  if (!s) return close(401, { retry: true });
  if (!cookies.length) { const c = sessions.refresh(req, s); if (c) cookies.push(c); }
  sessions.touch(s);
  const l = s.conversation != null ? engine.live(s.conversation) : null;
  if (!l) return close(401, { retry: true });
  if (moved) res.once('finish', () => l.send({ t: 'moved' }));
  l.session = s; l.ip = ip; l.seen = Date.now();
  l.visitor = settings.visitor(req);
  const answer = (status: number, x: any, closing = false) => send(res, status, x, { ...(cookies.length ? { 'set-cookie': cookies } : {}), ...(closing ? { connection: 'close' } : {}) });
  const refuse = (status: number, why: string, key: string, closing = true) =>
    (console.log(`care: conversation ${l.conv.id}: photo refused (${why})`), answer(status, { ok: false, why, text: t(key, l.lang, { done: t('photos_done', l.lang) }) }, closing));
  const claim = l.conv.state.claim;
  if (!claim || typeof claim.order !== 'string' || typeof claim.kind !== 'string' || !Array.isArray(claim.shots)) return refuse(409, 'claim', 'photo_bad');
  // each request here may ask the app for the order list: bounded like 'say', ahead of the photo limits (photos.ts)
  if (!limit(`photo-req:${l.conv.id}`, 60, HOUR_MS)) return refuse(429, 'slow', 'photo_day');
  // the claim's order is in its own app (one of the shop's; a claim from before names none: its shop of one's)
  const orderApp = typeof claim.app === 'string' ? claim.app : shop;
  const may = appsOf(shop).includes(orderApp) && (sessions.holds(s, orderApp, claim.order)
    || (sessions.level(s) === 2 && !!s.email && (await apps.orders(orderApp, s.email)).some(o => o.id === claim.order)));
  if (!may) return refuse(403, 'order', 'photo_bad');
  const shot = String(q.get('shot') ?? '');
  if (!claim.shots.includes(shot)) return refuse(400, 'shot', 'photo_bad');
  // room for the body before a byte of it is read, held until its decode is done or it's refused (photos.ts admit();
  const declared = req.headers['content-length'] == null ? null : Number(req.headers['content-length']);
  const room = photos.admit(ip, declared);
  if (!room) return refuse(503, 'busy', 'photo_busy');
  let r: photos.Result;
  try {
    const bytes = await upload(req, room.bytes);
    if (bytes === 'gone') return refuse(400, 'gone', 'photo_bad'); // nobody to hear it, most likely: nothing more is read
    if (bytes === 'slow') return refuse(408, 'late', 'photo_bad');
    if (!bytes) return refuse(413, 'size', 'photo_big');
    r = await photos.accept({ app: orderApp, conversation: l.conv.id, claim, shot, bytes, ip });
  } finally { room.release(); }
  if (!r.ok) return refuse(r.status, r.why, PHOTO_TEXT[r.why], false);
  console.log(`care: conversation ${l.conv.id}: photo ${r.id} stored`);
  // the conversation shows the slot filled, in words (the model reads them; it never gets the photo)
  const text = t('photo_sent', l.lang, { label: photos.label(orderApp, r.shot, l.lang) }), client = String(q.get('id') ?? '').slice(0, 40);
  l.store('me', text, { client: /^[\w-]+$/.test(client) ? client : undefined });
  const filled = photos.filled(l.conv.id, orderApp, claim.order, claim.kind);
  // the photos card's ticks, kept with it for a reload and sent to the device's other tabs (only a photos card of this chat)
  const wid = String(q.get('widget') ?? '');
  const row = /^[\w-]{1,40}$/.test(wid) && db.prepare('select widget from messages where conversation = ? and widget like ? order by id desc limit 1').get(l.conv.id, `%"id":"${wid}"%`) as any;
  const card = row ? JSON.parse(row.widget) : null;
  if (card?.id === wid && card.type === 'photos') l.closeWidget(wid, { filled });
  return answer(200, { ok: true, shot: r.shot, text, filled });
}

// ---- the server
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x'), p = url.pathname;
    if (p === '/health') return send(res, 200, { ok: true, provider: PROVIDER });
    if (p.startsWith('/__care/api/')) return await api(req, res, p.slice('/__care/api/'.length));
    if (p.startsWith('/__care/') && req.method === 'GET') {
      const f = FILES.get(p.slice('/__care/'.length)); // 'widget.js', 'company/plugin.js'
      if (!f) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[p.slice(p.lastIndexOf('.'))], 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
      return res.end(f);
    }
    // care's own preview host: a status page with review mode, nothing about anyone
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': status.CSP });
      return res.end(status.page({ model: ledger.breaker.state(), busy: busy() }));
    }
    send(res, 404, { error: 'not found' });
  } catch (err: any) {
    console.error('care: request failed:', err?.message);
    if (!res.headersSent) send(res, 500, { error: 'something went wrong' });
  }
});

// background work catches its own errors; this is the net under it, so one conversation can never stop the service
process.on('unhandledRejection', (err: any) => console.error('care: unhandled:', err?.message));

numbers.close(); sweep(); settings.sweep(Date.now()); photos.sweep(); phone.sweep(); // (phone)
// a finished day's counts are closed within the hour, with or without HQ's line (hq.ts sends them, and closes them too)
setInterval(() => { try { numbers.close(); sweep(); settings.sweep(Date.now()); photos.sweep(); phone.sweep(); engine.prune(); } catch (err: any) { console.error('care: sweep failed:', err?.message); } }, HOUR_MS);
hq.start();
answers.start(); // the questions a knowledge entry answers since this deploy: by email, once (the no-answer loop)
phoneanswer.start(); // the phone's answers by email, once a call is over
settings.start(); // the company's own timers, from its plug-in
server.listen(PORT, HOST, () => console.log(`care: listening on ${HOST ? `${HOST}:` : ''}${PORT} (model: ${PROVIDER})`));
// the voice line's routes on their own port, only with its token (phone.ts)
phone.listen();
