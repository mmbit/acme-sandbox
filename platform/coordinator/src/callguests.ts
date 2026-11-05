// The board's guests on its live call: whoever is in the room with it, on a device of their own (an iPad), with their own
// pen. (the QR code in place of a guest's address and emailed code)
//   - The call window shows one QR code for the call (POST /api/calls/guest: joinLink), the same for every device and
//     every scan, signed like the guest desk's links so nobody finds it by guessing, and good while the call is live.
//   - Scanning opens the join page (/guest/scan/<lang>/<token>, server.ts): first, in the call's language, that the
//     call's agent is an AI and the call is written down (the notice in knowledge/notes/compliance/walk-through-calls.md),
//     then a name, typed once and remembered on the device (join.js), and the guest notebook room at the call's page.
//     Muted: the sound is the board's device's.
//   - Each scan is someone new for this call alone: never a guest of the guest desk, the same name or not (their room
//     name is 'scan:<id>', which no guest can have), with a pen of their own (sketchpeople.ts giveAt) and a session
//     cookie that opens only this call's page and ends with the call. The board scanning on its iPad is a pen like any
//     other, never the board (DECISIONS.md, 2026-11-04: a scanned sign-in code never makes someone the board). Two
//     people of one name are told apart: Esmee, Esmee 2.
//   - On that page they draw and write with their pen as the board does, as themselves (their grant's 'guest:<id>', in
//     their colour), and change or delete only their own marks (notebookguestroom.ts). Nothing else of the board's book
//     is open to them, and nothing of HQ.
//   - HQ's call screen hears of each join (the event 'book' 'guest'), and tells the line their name.
//   - Each mark on the call's page, theirs or the board's from any screen, reaches the call's agent as it rests, with who
//     drew it (markForVoice, through HQ's calldraw.js and the voice line).
//   - The call ended, their session and the page close to them: the page goes in with the call, as every call's does.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.ts';
import * as guests from './guests.ts';
import { clientOf } from './auth.ts';
import { ORIGIN } from './config.ts';
import { publish } from './events.ts';
import { cookie } from './preview.ts';
import { serverKey } from './secrets.ts';
import * as people from './ink/sketchpeople.ts';
import { findAgent } from './jobs.ts';
import { boardLanguage } from './language.ts';
import { BOARD } from './ink/book.ts';
import { liveCall, pageFor } from './ink/callnotes.ts';
import { changed, pageOf, pageRow, shut } from './notebook.ts'; // (changed)
import { partsOf, row } from './notebookgroups.ts';
import { heightFor, UNIT_W } from '../../hq/shell/ink/scrapunit.js';
import { boxOf } from '../../hq/shell/ink/notebookstack.js';
import { render } from './ink/bookrender.ts';
import { DIR } from './pagescraps.ts';
import { heard } from './ink/bookheard.ts';
import type { Refused } from './pagechecks.ts';
import * as prototypes from './callprototypes.ts';

type CallGuest = { id: number; call: number; guest: string; link: string; added: string };

// What the join page says before they join, in each language the guest desk has: the walk-through note's notice, word
// for word, then what their pen does on the call
const WORDS = {
  en: {
    title: (agent: string) => `Call with ${agent}`,
    text: (agent: string) =>
      `${agent} is an AI assistant. We keep a written transcript of this call, never its sound. What you draw on the call’s page, ${agent} sees too, and it stays with the call’s notes. Your device stays muted: the call runs through the other device.`,
    name: 'Your name',
    badName: 'Type your name to join: a few letters.',
    button: 'Join the call’s page',
    shut: 'This call has ended.',
  },
  nl: {
    title: (agent: string) => `Gesprek met ${agent}`,
    text: (agent: string) =>
      `${agent} is een AI-assistent. We houden een geschreven verslag van dit gesprek bij, nooit het geluid. Wat je op de pagina van het gesprek tekent, ziet ${agent} ook, en het blijft bij de aantekeningen van het gesprek. Je apparaat blijft stil: het gesprek loopt via het andere apparaat.`,
    name: 'Je naam',
    badName: 'Typ je naam om mee te doen: een paar letters.',
    button: 'Naar de pagina van het gesprek',
    shut: 'Dit gesprek is afgelopen.',
  },
  de: {
    title: (agent: string) => `Gespräch mit ${agent}`,
    text: (agent: string) =>
      `${agent} ist eine KI. Wir führen ein schriftliches Protokoll dieses Gesprächs, nie eine Tonaufnahme. Was du auf die Seite des Gesprächs zeichnest, sieht ${agent} auch, und es bleibt bei den Notizen des Gesprächs. Dein Gerät bleibt stumm: das Gespräch läuft über das andere Gerät.`,
    name: 'Dein Name',
    badName: 'Schreib deinen Namen, um mitzumachen: ein paar Buchstaben.',
    button: 'Zur Seite des Gesprächs',
    shut: 'Dieses Gespräch ist beendet.',
  },
} satisfies Record<guests.Lang, unknown>;

const agentName = (call: number) => {
  const c = db.prepare('select agent from calls where id = ?').get(call) as { agent: string } | undefined;
  return c ? (findAgent(c.agent)?.name ?? c.agent) : '';
};

// Each scan's identity: its call (and when that call began: a call that recorded nothing is forgotten and its number
// comes back, ledger.ts forgetCall), the name as the page shows it, the call's language, its pen (sketch_guests), and
// its session's sha256.
db.exec(`create table if not exists call_scans (id integer primary key autoincrement, call integer not null,
  call_ts text not null, name text not null collate nocase, lang text not null, pen integer not null,
  session text not null unique, added text not null)`);
type Scan = {
  id: number;
  call: number;
  call_ts: string;
  name: string;
  lang: guests.Lang;
  pen: number;
  session: string;
};

const KEY = serverKey('callscan'),
  COOKIE = 'cs',
  MAX_NAME = 40;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// (a call's code: the call, when it began and its language, under a key only the server holds)
const tokenOf = (c: { id: number; ts: string }, lang: guests.Lang) =>
  createHmac('sha256', KEY).update(`scan:${c.id}:${c.ts}:${lang}`).digest('base64url');
const LANGS = Object.keys(WORDS) as guests.Lang[];
const scanName = (s: Pick<Scan, 'id'>) => `scan:${s.id}`;

// POST /api/calls/guest { call, lang? }: the call's join link, for its QR code: the same each time it's asked
export function joinLink(b: any) {
  const c = liveCall(Number(b?.call));
  if (!c) return [404, 'no live call of yours by that number'] as Refused;
  const lang = b.lang ?? boardLanguage();
  if (!Object.hasOwn(WORDS, lang)) return [400, `lang is one of ${LANGS.join(', ')}`] as Refused;
  if (!pageFor(c.id)) return [409, 'this call’s page couldn’t be opened'] as Refused;
  return { link: `${ORIGIN}/guest/scan/${lang}/${tokenOf(c, lang)}` };
}

// The live call a join link is for, or undefined
function callOf(lang: string, token: string) {
  if (!LANGS.includes(lang as guests.Lang)) return undefined;
  const live = db.prepare("select id, agent, ts from calls where status = 'live'").all() as {
    id: number;
    agent: string;
    ts: string;
  }[];
  const given = Buffer.from(token);
  return live.find(c => {
    const own = Buffer.from(tokenOf(c, lang as guests.Lang));
    return own.length === given.length && timingSafeEqual(own, given);
  });
}

// The scan a device's session is, while its call is live
function scanOf(req: IncomingMessage) {
  const t = cookie(req, COOKIE);
  const s = t
    ? (db.prepare('select * from call_scans where session = ?').get(sha256(t)) as Scan | undefined)
    : undefined;
  return s && liveCall(s.call)?.ts === s.call_ts ? s : undefined;
}
// (the room's own: the scan's session, guests.ts addVisitor)
guests.addVisitor(req => {
  const s = scanOf(req);
  return s ? { name: scanName(s), lang: s.lang } : null;
});
const scanByName = (name: string) => {
  const id = /^scan:(\d+)$/.exec(name)?.[1];
  return id ? (db.prepare('select * from call_scans where id = ?').get(Number(id)) as Scan | undefined) : undefined;
};

// GET /guest/scan/<lang>/<token>: the join page (a device whose session is on this call goes straight to its page);
// POST: the name, and a new identity for this call. GET /guest/scan/join.js: the page's script. Any other address, or a
// call that isn't live, opens nothing. (server.ts refuses a POST from any other origin, as for all of /guest/.)
export async function joinPage(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/guest/scan/join.js' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
    return res.end(JOIN_JS);
  }
  const m = /^\/guest\/scan\/([a-z]{2})\/([A-Za-z0-9_-]{43})$/.exec(path);
  const c = m ? callOf(m[1], m[2]) : undefined;
  if (!m || !c || (req.method !== 'GET' && req.method !== 'POST')) return guests.gone(res);
  const lang = m[1] as guests.Lang,
    w = WORDS[lang],
    agent = agentName(c.id);
  const p = pageFor(c.id);
  if (!p || shut(p)) return guests.html(res, 404, lang, `<div class="card"><h1>${guests.esc(w.shut)}</h1></div>`);
  const room = `/guest/notebooks/?notebook=${p.notebook}`;
  const back = scanOf(req);
  if (req.method === 'GET' && back?.call === c.id) return found(res, room);
  const ask = (status: number, error?: string) => askName(res, status, lang, agent, error);
  if (req.method === 'GET') return ask(200);
  if (!guests.allowed('join', await clientOf(req))) return ask(429, guests.COPY[lang].tooMany);
  const name = nameOf(await formName(req));
  if (!name) return ask(400, w.badName);
  // the call as it is now, past the awaits
  if (liveCall(c.id)?.ts !== c.ts)
    return guests.html(res, 404, lang, `<div class="card"><h1>${guests.esc(w.shut)}</h1></div>`);
  const t = newScan(c, name, lang, agent);
  // SameSite=Lax as the guest desk's: a scan opens the page from the camera, a navigation from elsewhere. Its Max-Age is
  // a day at most; the call's end closes it before that (scanOf).
  const secure = ORIGIN.startsWith('https') ? '; Secure' : '';
  return found(res, room, {
    'set-cookie': `${COOKIE}=${t}; Path=/guest/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`,
  });
}
// The join page's question: the notice, then their name (with why it was asked again: error)
function askName(res: ServerResponse, status: number, lang: guests.Lang, agent: string, error?: string) {
  const w = WORDS[lang],
    alert = error ? `<p class="alert" role="alert">${guests.esc(error)}</p>` : '';
  guests.html(
    res,
    status,
    lang,
    `<div class="card"><h1>${guests.esc(w.title(agent))}</h1>${alert}
<div class="intro">${guests.esc(w.text(agent))}</div>
<form method="post" class="join" data-call-join><label>${guests.esc(w.name)}<input name="name" required maxlength="${MAX_NAME}" autocomplete="given-name" autocapitalize="words" spellcheck="false"></label>
<p class="acts"><button type="submit">${guests.esc(w.button)}</button></p></form></div><script src="/guest/scan/join.js" defer></script>`,
  );
}
// Someone new on the call: their scan, its pen, its place among the call's guests, and HQ told (its call screen tells
// the line their name: callguest.js). → their session's token.
function newScan(c: { id: number; ts: string }, name: string, lang: guests.Lang, agent: string) {
  const t = randomBytes(32).toString('base64url');
  let shown: string;
  db.exec('begin');
  try {
    shown = apart(c.id, name, agent);
    const id = Number(
      db
        .prepare('insert into call_scans (call, call_ts, name, lang, pen, session, added) values (?, ?, ?, ?, 0, ?, ?)')
        .run(c.id, c.ts, shown, lang, sha256(t), new Date().toISOString()).lastInsertRowid,
    );
    const pen = people.giveAt(shown, `scan:${id}`);
    db.prepare('update call_scans set pen = ? where id = ?').run(pen.id, id);
    db.prepare('insert into call_guests (call, guest, added) values (?, ?, ?)').run(
      c.id,
      scanName({ id }),
      new Date().toISOString(),
    );
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  publish({ type: 'book', text: 'guest', guest: { call: c.id, name: shown } });
  return t;
}
function found(res: ServerResponse, to: string, headers: Record<string, string> = {}) {
  res.writeHead(303, { location: to, 'cache-control': 'no-store', ...headers });
  res.end();
}
async function formName(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) if ((raw += chunk).length > 4000) return '';
  return new URLSearchParams(raw).get('name') ?? '';
}
// A name as typed, its spaces tidied: some letters, no control characters, up to MAX_NAME long; null otherwise
function nameOf(typed: string) {
  const n = typed.normalize('NFC').replace(/\s+/g, ' ').trim();
  return n.length <= MAX_NAME && /\p{L}/u.test(n) && !/[\p{C}<>]/u.test(n) ? n : null;
}
// The name the page and the agent know them by: as typed, or with a number when someone on the call already has it,
// or it's the board's or the agent's own (the agent hears 'Board' for the board's marks)
function apart(call: number, name: string, agent: string) {
  const taken = new Set(
    (db.prepare('select name from call_scans where call = ?').all(call) as { name: string }[]).map(r =>
      r.name.toLowerCase(),
    ),
  );
  taken.add('board').add(agent.toLowerCase());
  let shown = name;
  for (let n = 2; taken.has(shown.toLowerCase()); n++) shown = `${name} ${n}`;
  return shown;
}
// The join page's script: the name remembered on the device, typed in for them (one tap to join again), and kept as
// they join
const JOIN_JS = `const form = document.querySelector('[data-call-join]');
if (form) {
  const field = form.querySelector('input[name=name]');
  try {
    field.value ||= localStorage.getItem('call-guest-name') ?? '';
  } catch {}
  form.addEventListener('submit', () => {
    try {
      localStorage.setItem('call-guest-name', field.value.trim());
    } catch {}
  });
}
`;

// The pen a name on a call writes with: its scan's own grant
function penOf(name: string) {
  const s = scanByName(name);
  return s ? people.grantBy(`guest:${s.pen}`) : undefined;
}

// The call's notes page while its call is live and open to its guest, or undefined
function openPage(g: CallGuest) {
  if (!liveCall(g.call) || !penOf(g.guest)) return undefined;
  const p = pageFor(g.call);
  return p && !shut(p) ? p : undefined;
}
// The live calls a guest is on, with their pages
const callsOf = (name: string) =>
  (db.prepare('select * from call_guests where guest = ? order by id desc').all(name) as CallGuest[])
    .map(g => ({ g, page: openPage(g) }))
    .filter(on => on.page);

// Whether the guest is on a live call now (the guest notebook room opens for them)
export const onACall = (name: string) => callsOf(name).length > 0;
// ...and on this one (its prototypes' host lets them look: callprototypes.ts guestOn.)
prototypes.guestsBy((call, name) => callsOf(name).some(c => c.g.call === call));

// The guest's way onto a page of the board's: the call's notes page, while they're its guest. who: the page's owner
// (the board), by: the guest as they write there. undefined: not theirs.
export function onCallPage(page: number, name: string) {
  const on = callsOf(name).find(c => c.page!.id === page);
  const grant = on && penOf(name);
  return grant ? { who: BOARD, by: people.whoOf(grant) } : undefined;
}

// The room's list of a notebook (?notebook=), for a guest on a call whose page is in it: that page alone, as the
// guest's shell reads a notebook of theirs. undefined: none.
export function notebookFor(name: string, notebook: number) {
  const on = callsOf(name).find(c => c.page!.notebook === notebook);
  if (!on) return undefined;
  const agent = agentName(on.g.call);
  const page = { ...pageOf(pageRow(on.page!.id, BOARD)!), canSend: false, canUndo: false, readonly: false };
  return {
    id: notebook,
    name: WORDS[scanByName(name)?.lang ?? 'en'].title(agent),
    kind: 'call',
    archived: false,
    state: 'open',
    ends: null,
    pages: [page],
    // (the call's prototypes, newest first: the room's card for each new one.)
    prototypes: prototypes.listFor(on.g.call),
  };
}

// GET /api/voice/drawn?id=&call=: a mark on the live call's notes page, for its agent as it rests: who drew it (the
// board, or its guest by name), its words, and its picture (the mark's unit, as the page has it). 404: not a mark of
// the board's or its guest's on that call's page. The agent has heard it as it is: its seen tick shows
// (ink/bookheard.ts).
export async function markForVoice(id: number, call: number) {
  const c = liveCall(call),
    p = c && pageFor(call),
    g = row(id);
  if (!c || !p || !g || g.page !== p.id || g.deleted !== null || g.parent !== null || g.by === c.agent) return 404;
  const guest = g.by === BOARD ? null : people.guestOf(g.by);
  if (g.by !== BOARD && !guest) return 404;
  const parts = partsOf(g),
    box = boxOf(parts),
    typed = (parts.texts as { text: string }[]).map(t => t.text).join(' ');
  const drawn = {
    w: box ? Math.max(UNIT_W, box.x + box.w) : UNIT_W,
    h: heightFor(parts, g.h!),
    ink: parts.ink,
    scraps: parts.pictures,
    texts: parts.texts,
  };
  const png = await render(drawn as Parameters<typeof render>[0], DIR);
  heard(g, c.agent);
  changed(p.notebook, p.id);
  return {
    n: g.id,
    who: guest ? guest.name : 'Board',
    words: g.words || typed,
    updated: g.updated,
    picture: { type: 'image/png', data: png.toString('base64') },
  };
}
