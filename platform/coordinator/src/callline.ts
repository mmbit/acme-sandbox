// The call itself, for a call out (callouts.ts): Twilio's word on a call it placed, the voice line's routes (its ticket,
// a join link's room, the briefing, the hand-over) and the join link's page.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { brand, names, respellings, timeZone } from './company.ts';
import { callModel, callSeat, findAgent } from './jobs.ts';
import { answered, signedForm } from './phone.ts';
import { agentName, byId, finish, now, sha256, type Callout } from './callouts.ts';
import * as words from './callwords.ts';
import * as joinpage from './joinpage.ts';
import * as shares from './shares.ts';
import * as watchalong from './watchalong.ts';
import { ownerOf } from './owedproducts.ts';

// POST /api/twilio/status?callout=<id>: Twilio's word that a call it placed has ended (signed, phone.ts). Busy, no answer
// and a failure end it here; a call the voice line took ends with its hand-over (handOver).
export async function status(req: IncomingMessage, res: ServerResponse) {
  const form = await signedForm(req, 'status');
  if (!form) {
    res.writeHead(403);
    return res.end();
  }
  const c = byId(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('callout')));
  const state = form.get('CallStatus') ?? '';
  answered('status', c && c.sid === form.get('CallSid') ? `call #${c.id}: ${state}` : 'not a call out of ours');
  res.writeHead(204);
  res.end();
  if (!c || c.sid !== form.get('CallSid')) return;
  if (c.status === 'dialling') {
    if (state === 'busy') return finish(c, 'missed', 'the line was busy');
    if (state === 'no-answer' || state === 'canceled') return finish(c, 'missed', 'nobody answered');
    if (state === 'failed') return finish(c, 'failed', "Twilio couldn't place it");
    if (state === 'completed') return finish(c, 'failed', "it was answered, but the voice line didn't take the call");
  }
  if (c.status === 'live' && state === 'completed')
    db.prepare('update callouts set twilio_ended = ? where id = ?').run(now(), c.id);
}

// call-ticket: an outbound call's one stream (null: not one of ours, the board's line may know it)
export function redeem(ticket: string) {
  const c = ticket
    ? (db.prepare("select * from callouts where ticket_hash = ? and status = 'dialling'").get(sha256(ticket)) as
        Callout | undefined)
    : undefined;
  if (!c) return null;
  db.prepare('update callouts set ticket_hash = null where id = ?').run(c.id);
  if ((c.ticket_expires ?? 0) < Date.now()) return 404;
  db.prepare("update callouts set status = 'live', started = ? where id = ?").run(now(), c.id);
  return { agent: c.agent, lang: c.lang, callout: c.id };
}
// join-ticket: who a link's room is with, while it's open (410: closed, or its one call has ended)
export function joinTicket(token: string) {
  const c = openLink(token);
  if (!c) return 404;
  if (
    !['approved', 'live'].includes(c.status) ||
    Date.now() < Date.parse(c.opens!) ||
    Date.now() > Date.parse(c.closes!)
  )
    return 410;
  return { agent: c.agent, lang: c.lang, callout: c.id, name: agentName(c.agent) };
}
// call-context: the agent's briefing, the fixed words, and the call's token (it opens no HQ route: server.ts). A restart
// sends its token back and goes on with it; one for a call that has ended is refused.
export function context(b: any) {
  const c = byId(Number(b.callout));
  if (!c || c.agent !== String(b.agent ?? '') || !findAgent(c.agent)) return 404;
  const given = String(b.token ?? '');
  if (given && c.token_hash !== sha256(given)) return 409;
  const linkOpen = c.kind === 'link' && ['approved', 'live'].includes(c.status) && Date.now() <= Date.parse(c.closes!);
  if (c.status !== 'live' && !linkOpen) return 409;
  const token = given || randomBytes(32).toString('base64url');
  db.prepare("update callouts set token_hash = ?, status = 'live', started = coalesce(started, ?) where id = ?").run(
    sha256(token),
    now(),
    c.id,
  );
  const said = words.opening(c.lang, agentName(c.agent), c.about);
  return {
    prompt: words.briefing(c, said),
    token,
    voice: findAgent(c.agent)!.voice,
    ...callModel(),
    seat: callSeat(),
    timeZone: timeZone(),
    respell: respellings(),
    opening: said,
    objected: words.objected(c.lang),
    tools: 'partner',
    callout: c.id,
    call: null,
    pins: [],
    who: c.who,
    lang: c.lang,
    kind: c.kind,
  };
}
// The agent on a call out, by its token, which reaches no route (server.ts PARTNER_ROUTES)
export const tokenAgent = (token: string) =>
  token
    ? (db.prepare("select id, agent from callouts where token_hash = ? and status = 'live'").get(sha256(token)) as
        { id: number; agent: string } | undefined)
    : undefined;
// call-end: the transcript (none when they objected) and the notes, once; then the filer's follow-up
export function handOver(b: any) {
  const c = byId(Number(b.callout));
  if (!c || c.agent !== String(b.agent ?? '')) return 404;
  if (c.status !== 'live') return { ok: true, ignored: true };
  const objected = b.objected === true,
    strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const lines = objected ? [] : strings(b.lines),
    notes = strings(b.notes);
  db.prepare('update callouts set transcript = ?, notes = ?, objected = ? where id = ?').run(
    JSON.stringify(lines),
    JSON.stringify(notes),
    objected ? 1 : 0,
    c.id,
  );
  const said = lines.length || notes.length;
  finish(
    { ...c, transcript: JSON.stringify(lines), notes: JSON.stringify(notes), objected: objected ? 1 : 0 },
    'done',
    objected
      ? "the call was held; they'd rather we kept no transcript, so only the notes were kept"
      : said
        ? 'the call was held'
        : 'the call connected, but nothing was said',
  );
  return { ok: true };
}

// ---- the link's page (GET /join/<token>, public): Tympan's page for an open link, else one closed page for every
// other token, unknown or not, with the same status
export function joinRoute(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const asset = /^\/join\/assets\/((?:vendor\/)?[\w.-]+)$/.exec(path);
  if (asset) {
    const found = joinpage.joinAsset(asset[1]);
    if (!found) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': found.type, 'cache-control': 'no-cache' });
    return res.end(found.body);
  }
  const token = /^\/join\/([A-Za-z0-9_-]{43})$/.exec(path)?.[1],
    c = token ? openLink(token) : undefined;
  const page = {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-type': 'text/html; charset=utf-8',
  };
  if (!c || !['approved', 'live'].includes(c.status) || Date.now() > Date.parse(c.closes!)) {
    res.writeHead(404, { ...page, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    return res.end(CLOSED_PAGE);
  }
  const who = findAgent(c.agent);
  const shown = joinpage.joinPage({
    token: token!,
    lang: c.lang,
    agent: { id: c.agent, name: agentName(c.agent), ...(who?.pronouns ? { pronouns: String(who.pronouns) } : {}) },
    company: names().name,
    words: brand().callsOut?.join?.[c.lang],
    privacy: brand().callsOut?.privacy?.[c.lang] ?? null,
    until: c.closes!,
    opens: c.opens!,
    walk: walkOf(c),
  });
  res.writeHead(200, { ...page, 'content-security-policy': shown.csp });
  res.end(shown.html);
}
const CLOSED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>This link has closed</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1.5em;color:#222}p{margin:0 0 1em}</style></head>
<body><p lang="en">This link has closed.</p><p lang="nl">Deze link is gesloten.</p><p lang="de">Dieser Link ist geschlossen.</p></body></html>`;
// A walk-through's shared preview, while the share is open: where its frame starts, the hosts it may reach, and its name
function walkOf(c: Callout) {
  const s = c.share ? shares.byId(c.share) : undefined;
  if (!s || !shares.isOpen(s)) return undefined;
  const hosts = [...new Set(shares.reaches(s).map(r => `https://${r.host}`))];
  return { url: `https://${s.host}${s.start}`, hosts, what: String(ownerOf(s.about).name) };
}
// POST /api/watchalong/join {token}: the guest's page starts recording what it shows, on the join link's own token,
// only while its walk-through call is on (the voice line made it live). A guest's typing stays hidden. Its mirror shows
// only the previews the share reaches
export function startWatching(token: string) {
  const c = token ? openLink(token) : undefined;
  const walk = c && walkOf(c);
  if (!c || c.status !== 'live' || !walk || Date.now() > Date.parse(c.closes!)) return 409;
  return watchalong.startOnCallout(c.id, walk.hosts);
}
const openLink = (token: string) =>
  db.prepare('select * from callouts where link_hash = ?').get(sha256(token)) as Callout | undefined;
