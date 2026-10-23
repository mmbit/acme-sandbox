// The phone: the helper on the company's phone number. The platform's voice line
// (platform/voice) does the speech and calls three routes here, on a port of their own that only it reaches, with its own
// token: a call starts a conversation of kind 'phone' in the shop's chat tables, each thing the caller says is a turn
// whose reply streams back as the model writes it (the line speaks it as it comes), and the call's end says how it ended.
// What a code unlocks is decided here, in code: while a code waits, the caller's turn is read for six digits before any
// model sees it, they're compared with the codes' hashes and taken out of what's kept and what the model reads, and the
// model hears only how it went (a turn: phoneturn.ts). Nothing on the phone changes an order. The routes are in
// README.md, "The phone".
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { routes, type RouteRequest } from '../../../shared/routes/routes.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PHONE, HOST } from './config.ts';
import { db, now } from './db.ts';
import { t } from './texts.ts';
import { settings } from './company.ts';
import { load, save, lang, informedIn, drop, released, type Conv } from './phonecall.ts';
// (one turn, and what stops the phone: phoneturn.ts)
import { turn, warm, stopped } from './phoneturn.ts';
import * as hq from './hq.ts';

const MINUTE_MS = 60_000;
const BODY_MAX = 16 * 1024;
const ORPHAN_MS = 15 * MINUTE_MS; // a call the line never ended (a crash): an objection is carried out after this
export const ENDED = ['hung_up', 'caller', 'limit', 'error'] as const;

// ---- the routes, on their own port (PHONE.port), for the voice line only: its bearer token, compared in constant time
const table = routes({
  'POST /phone/start': forLine(start),
  'POST /phone/turn': forLine(takeTurn),
  'POST /phone/end': forLine(endCall),
});
export const handle = (req: IncomingMessage, res: ServerResponse) => table(req, res);

function forLine(handle: (res: ServerResponse, b: any) => unknown) {
  return async ({ req, res, jsonBody }: RouteRequest) => {
    if (!authed(req)) return void res.writeHead(401).end();
    const b = await jsonBody(BODY_MAX);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'JSON body only' });
    return handle(res, b);
  };
}
const digest = (s: string) => createHash('sha256').update(s).digest();
const authed = (req: IncomingMessage) =>
  !!PHONE.token && timingSafeEqual(digest(String(req.headers.authorization ?? '')), digest(`Bearer ${PHONE.token}`));
const send = (res: ServerResponse, status: number, body: any) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

// /phone/start: a new call's conversation, and the plug-in's words the line says itself
function start(res: ServerResponse, b: any) {
  if (!PHONE.shop) return send(res, 503, { why: 'off' });
  const why = stopped(PHONE.shop, false);
  if (why) return send(res, 503, { why });
  const t0 = now(),
    sid = /^[A-Za-z0-9]{1,64}$/.test(String(b.call ?? '')) ? String(b.call) : '?';
  const id = Number(
    db
      .prepare("insert into conversations (shop, created, last, state, kind) values (?, ?, ?, ?, 'phone')")
      .run(PHONE.shop, t0, t0, JSON.stringify({ lang: settings.langs[0], stall: PHONE.shop, phone: {} }))
      .lastInsertRowid,
  );
  console.log(`care: phone call ${sid} is conversation ${id}`); // the CallSid only here, to tell calls apart in the log
  const words = Object.fromEntries(
    settings.langs.map(l => [
      l,
      {
        ai: t('phone_ai', l),
        // (the AI line at the start of a reply in a language the opening didn't have, before its answer)
        reply_ai: t('phone_reply_ai', l),
        transcript: t('phone_transcript', l),
        ask: t('phone_ask', l),
        objected: t('phone_objected', l),
        // said after the AI line where the language isn't the opening's first ("English is fine too."), in a language
        // whose plug-in texts have it
        ...(settings.texts[l]?.phone_fine ? { fine: t('phone_fine', l) } : {}),
      },
    ]),
  );
  send(res, 200, { conversation: id, helper: settings.helper, langs: settings.langs, words });
  const c = load(id);
  if (c) void warm(c, lang(b.lang)); // (the opening's first language: the first turn's, most often)
}

// /phone/turn: the caller's words, once the call's turn before has stopped
async function takeTurn(res: ServerResponse, b: any) {
  const id = callId(b);
  if (id == null) return send(res, 404, NO_CALL);
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return send(res, 400, { error: 'text: what the caller said' });
  const c = await settled(id);
  if (!c) return send(res, 404, NO_CALL);
  informedIn(c, b.informed); // (the languages the caller has heard the notice in)
  return answer(res, c, text, lang(b.lang, c));
}

// /phone/end, once the call's last turn has stopped
async function endCall(res: ServerResponse, b: any) {
  const id = callId(b);
  const c = id == null ? null : await settled(id);
  if (!c) return send(res, 404, NO_CALL);
  informedIn(c, b.informed);
  end(c, ENDED.includes(b.ended) ? b.ended : 'error');
  send(res, 200, {});
}

const NO_CALL = { error: 'no such call' };
const callId = (b: any) =>
  Number.isInteger(b.conversation) && load(b.conversation) ? (b.conversation as number) : null;

// a turn per call: a newer one, or the call's end, stops the one before and waits for it to have kept what it wrote, so
// the words stay in the order they were said and an objection deletes them all. The call as that turn left it, or null
// once it has ended
const running = new Map<number, { ctl: AbortController; done: Promise<void> }>();
async function settled(id: number) {
  const r = running.get(id);
  if (r) {
    r.ctl.abort();
    await r.done;
  }
  const c = load(id);
  return c && !c.state.phone.ended ? c : null;
}

// A turn's lines as NDJSON. The line closing the request (barge-in) stops the model's stream
async function answer(res: ServerResponse, c: Conv, text: string, l: string) {
  const ctl = new AbortController();
  let finished!: () => void;
  running.set(c.id, { ctl, done: new Promise<void>(r => (finished = r)) });
  res.on('close', () => {
    if (!res.writableFinished) ctl.abort();
  });
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  try {
    // once the line has gone, the turn runs on to its stop (the model's stream ends at the signal) and keeps what it wrote
    const t0 = Date.now();
    let first: number | undefined;
    for await (const line of turn(c, text, l, ctl.signal)) {
      if ('text' in line && line.text.trim()) first ??= (Date.now() - t0) / 1000;
      if ('end' in line && line.model) line.model.first = first;
      if (!ctl.signal.aborted) res.write(`${JSON.stringify(line)}\n`);
    }
  } catch (err: any) {
    console.error(`care: phone conversation ${c.id}: the turn failed:`, err?.message);
    if (!ctl.signal.aborted) res.write(`${JSON.stringify({ unanswered: 'error' })}\n`);
  } finally {
    if (running.get(c.id)?.ctl === ctl) running.delete(c.id);
    finished();
    res.end();
  }
}

// The call is over: its codes are spent, and if the caller objected, its words go (GDPR art. 21). What a case needs
// stays: the code check's result (the state's checks, the link to the order) and a fault note (cases)
function end(c: Conv, why: string) {
  drop(c); // (what's still held is never kept)
  c.state.phone.ended = { why, at: now() };
  db.prepare('update phone_codes set used = ? where conversation = ? and used is null').run(now(), c.id);
  if (c.state.phone.objected) {
    db.prepare('delete from messages where conversation = ?').run(c.id);
    db.prepare('update conversations set summary = null where id = ?').run(c.id);
  }
  // the call's feedback notes: to the team, or gone with an objection
  if (released(c)) hq.nudge();
  save(c);
  console.log(
    `care: phone conversation ${c.id} ended (${why})${c.state.phone.objected ? ': its words deleted, as the caller asked' : ''}`,
  );
}

// hourly, with the engine's retention: a call the line never ended (it crashed) is ended now, so an objection is still
// carried out
export function sweep(t = now()) {
  const rows = db
    .prepare(
      "select id from conversations where kind = 'phone' and last < ? and json_extract(state, '$.phone.ended') is null",
    )
    .all(t - ORPHAN_MS) as any[];
  for (const r of rows) {
    const c = load(r.id);
    if (c) end(c, 'error');
  }
}

export function listen() {
  if (!PHONE.token) return null;
  const server = createServer((req, res) => {
    handle(req, res).catch((err: any) => {
      console.error('care: phone request failed:', err?.message);
      if (!res.headersSent) send(res, 500, { error: 'something went wrong' });
      else res.end();
    });
  });
  server.listen(PHONE.port, HOST, () => console.log(`care: phone routes on ${HOST ? `${HOST}:` : ''}${PHONE.port}`));
  return server;
}
