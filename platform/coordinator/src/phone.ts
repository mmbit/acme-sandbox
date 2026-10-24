// The phone line: the board calls a Twilio number and talks with the CEO. Twilio asks HQ what to do with each call
// (a webhook); HQ answers only a call that Twilio signed, from the board's own number, after the board types its
// PIN. Then it hands Twilio a one-time ticket for the voice line (platform/voice), which streams the call.
// Everyone else reaches one of the company's lines (brand.yaml's phoneLines, below), picked by the number they dialled
// and who they are: a customer who found the number on a shop's imprint, say. When the line names the agent who answers
// it (a care deployment's phone conversation, platform/care), the call goes to that agent through the voice line, three
// calls a day per number unless the line says otherwise. Otherwise, or past that, they hear the line's short message in
// each of its languages, pointing them to a way we can answer (email, the website), and the call ends. Never a person,
// never the board, nothing recorded: we couldn't check who a caller is or call them back (the board, 2026-10-15).
// Twilio's record of each call, with the caller's number, is deleted within the hour (calls.ts).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DATA_DIR, ORIGIN } from './config.ts';
import { columnsOf, db, lacks, once } from './db.ts';
import { secret } from './secrets.ts';
import { rememberAccount } from './calls.ts';
import { ceo, brand, names, respellings, yamlFile, voiceOf } from './company.ts';
import { publish } from './events.ts';
import { boardLanguage } from './language.ts';
import { allowed, callerKeys, callsADay, engineOf, international, lineAt, lineFor, sameNumber, withheld, type Line } from './phonelines.ts';

// kind 'care': a caller who isn't the board, for the agent who answers them, with the languages of its opening (langs;
// the care deployment that answers (engine) and the line it came in on (lineIndex, its place in the list)
type Ticket = { agent: string; lang: string; expires: number; kind?: 'care'; langs?: Lang[]; engine?: string; lineIndex?: number };
const tickets = new Map<string, Ticket>();
const xml = (res: ServerResponse, body: string) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`); };
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Twilio's signature: HMAC-SHA1 over the full URL plus every form field, sorted by name, keyed with the auth token.
// Returns why a request isn't Twilio's, or '' when its signature is right.
function refusalReason(req: IncomingMessage, form: URLSearchParams) {
  const key = secret('TWILIO_AUTH_TOKEN'), sig = String(req.headers['x-twilio-signature'] ?? '');
  if (!key) return 'no auth token saved';
  if (!sig) return 'not signed';
  const data = `${ORIGIN}${req.url}` + [...form.keys()].sort().map(k => k + form.get(k)).join('');
  return same(createHmac('sha1', key).update(data).digest('base64'), sig) ? '' : 'signed with another token or URL';
}

// Every request Twilio makes and HQ's answer, never the caller's number: kept 7 days, the latest 200, and apart from
// them the latest 20 refusals, so anyone posting to the public webhook can't push Twilio's own rows out. The status
// report shows them (infra/report.sh), so "Twilio never asked" differs from "HQ answered wrong", even after a recreate.
const KEPT_ASKS = 200, KEPT_REFUSALS = 20, KEPT_MS = 7 * 86_400_000, REFUSAL = "answer like '403, %'";
db.exec('create table if not exists phone_asks (ts integer not null, step text not null, answer text not null)');
const keepLatest = (which: string, n: number) =>
  db.prepare(`delete from phone_asks where ${which} and rowid not in (select rowid from phone_asks where ${which} order by rowid desc limit ${n})`).run();
export const answered = (step: string, answer: string) => {   // (callouts.ts: Twilio's word on a call out)
  db.prepare('insert into phone_asks (ts, step, answer) values (?, ?, ?)').run(Date.now(), step, answer);
  db.prepare('delete from phone_asks where ts < ?').run(Date.now() - KEPT_MS);
  keepLatest(REFUSAL, KEPT_REFUSALS);
  keepLatest(`not ${REFUSAL}`, KEPT_ASKS);
  console.log(`phone: Twilio asked /api/twilio/${step}, HQ answered: ${answer}`);
};

async function readForm(req: IncomingMessage) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 20_000) break; }
  return new URLSearchParams(body);
}

// A form from Twilio for another of HQ's webhooks (callouts.ts status), or null once refused (logged as the line's own are)
export async function signedForm(req: IncomingMessage, step: string) {
  const form = await readForm(req), refused = refusalReason(req, form);
  if (refused) { answered(step, `403, ${refused}`); return null; }
  rememberAccount(form.get('AccountSid'));
  return form;
}

// The message for callers who aren't the board: their line's hello, one word in each language it gives (so a caller
// hears theirs is coming), then its greeting in each, in its order, with no menu. Without the company's own words,
// these, with its name.
const GREETING = (name: string) => ({
  en: `Hello, you've reached ${name}. We're run by AI agents and can't help you by phone. ` +
    'Please reach us through the Help page on our website.',
  nl: `Hallo, u spreekt met ${name}. Wij worden gerund door AI-agents en kunnen u telefonisch niet helpen. ` +
    'U bereikt ons via de Help-pagina op onze website.',
  de: `Hallo, Sie sind bei ${name}. Wir werden von KI-Agenten betrieben und können Ihnen am Telefon nicht helfen. ` +
    'Sie erreichen uns über die Hilfe-Seite auf unserer Website.',
});
const xmlText = (s: string) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
const languages = (line: Line) => {
  const own = Object.keys(line.greeting ?? {}).filter((l): l is Lang => l in SAY);
  return own.length ? own : (Object.keys(SAY) as Lang[]);
};
const hello = (line: Line) => (l: Lang) => {
  const word = line.hello?.[l];
  return typeof word === 'string' && word.trim() ? say(l, xmlText(word)) : '';
};
const message = (line: Line) =>
  `<Play>${ORIGIN}/phone/chime.mp3</Play>` +
  languages(line).map(hello(line)).join('') +
  languages(line)
    .map(l => say(l, greeting(line, l)))
    .join('') +
  '<Hangup/>';
function greeting(line: Line, lang: Lang) {
  const own = line.greeting?.[lang];
  return xmlText(typeof own === 'string' && own.trim() ? own : GREETING(names().name)[lang]);
}

// Amazon Polly's neural voices through Twilio: about 2 cents a call (Twilio's and Polly's list prices).
// Twilio's free voices have no Dutch and it advises against them.
const SAY = { en: ['en-GB', 'Polly.Amy-Neural'], nl: ['nl-NL', 'Polly.Laura-Neural'], de: ['de-DE', 'Polly.Vicki-Neural'] };
type Lang = keyof ReturnType<typeof GREETING>;
const say = (lang: Lang, text: string) => `<Say language="${SAY[lang][0]}" voice="${SAY[lang][1]}">${text}</Say>`;
// The PIN gate's words (pinGate, below), in its language like the call after them
const PIN_WORDS: Record<Lang, { pin: string; wrong: string; closed: string; bye: string }> = {
  en: { pin: 'Your PIN, please.', wrong: 'That PIN is not right.', closed: 'The line is closed for now.', bye: 'Goodbye.' },
  nl: { pin: 'Je pincode, graag.', wrong: 'Die pincode klopt niet.', closed: 'De lijn is voorlopig dicht.', bye: 'Tot ziens.' },
  de: { pin: 'Deine PIN, bitte.', wrong: 'Diese PIN stimmt nicht.', closed: 'Die Leitung ist vorerst geschlossen.', bye: 'Auf Wiedersehen.' },
};

const fromBoard = (from: string) => sameNumber(secret('BOARD_PHONE_NUMBER'), from);
// Why a call isn't the board's, without the number
const whyNotBoard = (from: string) => !international(secret('BOARD_PHONE_NUMBER')) ? 'no board number saved'
  : withheld(from) ? 'no caller ID' : 'another number';

// ---- the agent who answers a line
// The line's agent: one on org.yaml's desks. None, or one that isn't there: the message only.
type Agent = { id: string; name?: string; voice?: string; pronouns?: string };
const nameOf = (agent: Agent | null) => agent?.name ?? agent?.id ?? 'the agent';
function agentOf(line: Line): Agent | null {
  const named = line.agent;
  if (typeof named !== 'string' || !named) return null;
  const agents: Agent[] = (yamlFile('company/org.yaml').departments ?? []).flatMap((d: any) => d?.agents ?? []);
  return agents.find(a => a?.id === named) ?? null;
}

// Three calls a day per number reach the agent (a line's callsADay), so one caller can't run up the model's bill or tie
// up the line. The number is kept only as an HMAC under HQ's own key (phone.key in DATA_DIR, made once), for 2 days,
// with the line's agent and deployment, so each line counts its own. Withheld numbers share one key and so one limit.
// A call is counted when it goes to the agent, not when the message plays.
const HOUR_MS = 3_600_000,
  DAY_MS = 24 * HOUR_MS;
const CALLERS_KEPT_MS = 2 * DAY_MS;
db.exec('create table if not exists phone_callers (hash text not null, ts integer not null)');
const KEY_FILE = `${DATA_DIR}/phone.key`;
function phoneKey() {
  if (!existsSync(KEY_FILE))
    try {
      writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch {
      /* made meanwhile */
    }
  return readFileSync(KEY_FILE, 'utf8').trim();
}
const KEY = phoneKey();
// (the line in the hash)
const callerHash = (from: string, line: Line) =>
  createHmac('sha256', KEY)
    .update(`${engineOf(line)}/${String(line.agent)}:` + (withheld(from) ? 'withheld' : `number:${international(from)}`))
    .digest('hex');
const forgetCallers = () => db.prepare('delete from phone_callers where ts < ?').run(Date.now() - CALLERS_KEPT_MS);
setInterval(forgetCallers, HOUR_MS).unref();
const callsToday = (hash: string) => {
  forgetCallers();
  const today = db
    .prepare('select count(*) as n from phone_callers where hash = ? and ts > ?')
    .get(hash, Date.now() - DAY_MS) as { n: number };
  return today.n;
};

// A caller who isn't the board, on their line (its place in the list): the agent, while the number has calls left
// today, else the message. Twilio asks /api/twilio/after once the stream ends, with the line.
function stranger(res: ServerResponse, step: string, from: string, why: string, lineIndex: number) {
  const line = lineAt(lineIndex), agent = agentOf(line);
  if (!agent) {
    answered(step, `the company's message (${why})`);
    return xml(res, message(line));
  }
  const hash = callerHash(from, line), allowance = callsADay(line);
  if (callsToday(hash) >= allowance) {
    answered(step, `the company's message (${allowance} calls today)`);
    return xml(res, message(line));
  }
  db.prepare('insert into phone_callers (hash, ts) values (?, ?)').run(hash, Date.now());
  const langs = openingLanguages(from, line);
  const ticket = issue({ agent: agent.id, lang: langs[0], kind: 'care', langs, engine: engineOf(line), lineIndex });
  answered(step, `${nameOf(agent)} (care ticket)`);
  return xml(res, `<Connect action="/api/twilio/after?line=${lineIndex}">${stream(ticket)}</Connect>`);
}

// The PIN gates, the board's (CALL_PIN) and a guarded line's, one way: the
// caller types the PIN after their number let them in, in the gate's language. Someone guessing PINs from a spoofed
// caller ID: after 5 wrong ones in an hour the gate stays shut for the hour, counted by the PIN's key and kept in the
// db, so a restart or deploy doesn't hand out five new guesses.
const MISSES = 5;
db.exec('create table if not exists phone_misses (ts integer not null, pin_key text not null)');
once('2026-10-24-phone-misses-by-pin', () => {
  if (lacks('phone_misses', 'pin_key'))
    db.exec("alter table phone_misses add column pin_key text not null default 'CALL_PIN'");
  if (columnsOf('phone_line_misses').length)
    db.exec('insert into phone_misses (ts, pin_key) select ts, pin_key from phone_line_misses; drop table phone_line_misses');
});
const misses = (pinKey: string) => {
  db.prepare('delete from phone_misses where ts < ?').run(Date.now() - HOUR_MS);
  return (db.prepare('select count(*) as n from phone_misses where pin_key = ?').get(pinKey) as { n: number }).n;
};
// A gate: its PIN's key, the language it speaks, whose gate it is (for the log), the step Twilio posts the digits to,
// what the board hears of the nth wrong PIN this hour (nothing for undefined) and, where a call goes on without a PIN,
// that way on
type Gate = { pinKey: string; lang: Lang; who: string; action: string; notice: (n: number) => string | undefined; answerWithoutPin?: () => void };
function pinGate(res: ServerResponse, step: 'voice' | 'pin', form: URLSearchParams, gate: Gate, letIn: () => void) {
  const words = (text: (w: (typeof PIN_WORDS)['en']) => string) => say(gate.lang, text(PIN_WORDS[gate.lang]));
  if (misses(gate.pinKey) >= MISSES) {
    answered(step, `${gate.who}: closed (${MISSES} wrong PINs)`);
    return xml(res, `${words(w => `${w.closed} ${w.bye}`)}<Hangup/>`);
  }
  const pin = secret(gate.pinKey);
  if (step === 'voice') {
    answered(step, `${gate.who}: PIN prompt`);
    const empty = gate.answerWithoutPin ? ' actionOnEmptyResult="true"' : '';
    const prompt = words(w => `${xmlText(names().name)}. ${w.pin}`);
    return xml(
      res,
      `<Gather input="dtmf" numDigits="${Math.max(4, pin.length)}" action="${gate.action}" timeout="10"${empty}>${prompt}</Gather>${words(w => w.bye)}`,
    );
  }
  if (!form.get('Digits') && gate.answerWithoutPin) return gate.answerWithoutPin();
  if (!pin || !same(form.get('Digits') ?? '', pin)) {
    db.prepare('insert into phone_misses (ts, pin_key) values (?, ?)').run(Date.now(), gate.pinKey);
    const notice = gate.notice(misses(gate.pinKey));
    if (notice) publish({ type: 'log', agent: ceo(), to: 'board', text: notice });
    answered(step, `${gate.who}: wrong PIN`);
    return xml(res, `${words(w => `${w.wrong} ${w.bye}`)}<Hangup/>`);
  }
  return letIn();
}

// A guarded line's gate, in the opening's first language: the board hears it
// shut, its keys may be in the wrong hands
function guardedLine(res: ServerResponse, step: 'voice' | 'pin', form: URLSearchParams, lineIndex: number) {
  const line = lineAt(lineIndex), from = form.get('From') ?? '', who = nameOf(agentOf(line));
  const gate = {
    pinKey: callerKeys(line)!.pin,
    lang: openingLanguages(from, line)[0] ?? 'en',
    who: `${who}'s line`,
    action: `/api/twilio/pin?line=${lineIndex}`,
    notice: (n: number) => n === MISSES
      ? `${who}'s phone line is shut for an hour: ${MISSES} wrong PINs from numbers allowed on it. If that wasn't them, someone is guessing its PIN with their caller ID: change it.`
      : undefined,
  };
  return pinGate(res, step, form, gate, () => stranger(res, step, from, 'the right PIN', lineIndex));
}

// The calls the agent ended itself (the voice line's phone-done), for /after: kept 15 minutes
const DONE_KEPT_MS = 15 * 60_000;
const hungUp = new Map<string, number>();
export function phoneDone(call: string) {
  if (!/^CA[0-9a-f]{32}$/.test(call)) return 400;
  const now = Date.now();
  for (const [sid, at] of hungUp) if (at < now - DONE_KEPT_MS) hungUp.delete(sid);
  hungUp.set(call, now);
  return {};
}
// After the agent's stream: a hang-up when the agent ended the call, else (the line full, care down, 10 minutes, a
// crash) the line's message, which points to the email address and the website
function afterAgent(res: ServerResponse, call: string, lineIndex: number) {
  const ended = (hungUp.get(call) ?? 0) > Date.now() - DONE_KEPT_MS, line = lineAt(lineIndex);
  hungUp.delete(call);
  answered('after', `after ${nameOf(agentOf(line))}: ${ended ? 'hung up' : "the company's message"}`);
  return xml(res, ended ? '<Hangup/>' : message(line));
}


// POST /api/twilio/voice (a call comes in), /api/twilio/pin (the digits the board, or a guarded line's caller, typed)
// and /api/twilio/after (the agent's stream ended) (after, callers to their line's agent, the board's empty PIN). The
// line a call came in on travels in the query (?line=) from one step to the next, under Twilio's signature.
export async function webhook(req: IncomingMessage, res: ServerResponse, step: 'voice' | 'pin' | 'after') {
  const form = await readForm(req), from = form.get('From') ?? '', refused = refusalReason(req, form);
  if (refused) { answered(step, `403, ${refused}`); res.writeHead(403); return res.end(); }
  rememberAccount(form.get('AccountSid'));
  const asked = new URL(req.url ?? '/', 'http://x').searchParams.get('line'), named = asked !== null && /^\d{1,3}$/.test(asked) ? Number(asked) : -1;
  // the line this call is for: the one named, while it still lets the caller in, else by the number dialled
  const lineOf = () => (named >= 0 && allowed(lineAt(named), from) ? named : lineFor(form.get('To') ?? '', from));
  if (step === 'after') return afterAgent(res, form.get('CallSid') ?? '', lineOf());
  if (!fromBoard(from)) {
    const lineIndex = lineOf();
    if (callerKeys(lineAt(lineIndex)) && (step === 'voice' || named === lineIndex)) return guardedLine(res, step, form, lineIndex);
    if (step === 'voice') return stranger(res, step, from, whyNotBoard(from), lineIndex);
    answered(step, `the company's message (${whyNotBoard(from)})`);
    return xml(res, message(lineAt(lineIndex)));
  }
  // No PIN within the timeout: the board calls the agent of the line it rang, as any caller (an open line: a guarded
  // one wants its own PIN)
  const lineIndex = boardsLine(lineOf);
  const open = lineIndex >= 0 && !callerKeys(lineAt(lineIndex)) && agentOf(lineAt(lineIndex));
  const gate = {
    pinKey: 'CALL_PIN',
    lang: boardLanguage(),
    who: 'the board',
    action: `/api/twilio/pin${open ? `?line=${lineIndex}` : ''}`,
    // every wrong PIN reaches the board's feed: a spoofed caller ID that shuts the line must not go unnoticed
    notice: (n: number) => n >= MISSES
      ? `The phone line is shut for an hour: ${MISSES} wrong PINs from your number. If that wasn't you, someone is guessing it with your caller ID: change the PIN.`
      : `A wrong PIN on the phone line from your number (${n} of ${MISSES} this hour). If that wasn't you, someone is guessing it with your caller ID.`,
    ...(open ? { answerWithoutPin: () => stranger(res, step, from, 'the board, no PIN', lineIndex) } : {}),
  };
  return pinGate(res, step, form, gate, () => {
    answered(step, 'the board: the voice line');
    return xml(res, `<Connect>${stream(issue({ agent: ceo(), lang: boardLanguage() }))}</Connect>`);
  });
}

// The line the board's number rang, for its way on to that line's agent. The board's own line isn't on the list: a list
// that can't be read leaves the board its PIN and its call, without that way on, and says why
function boardsLine(lineOf: () => number) {
  try {
    return lineOf();
  } catch (err) {
    console.error(`phone: the board's call, without a line's agent: ${(err as Error).message}`);
    return -1;
  }
}

const issue = (t: Omit<Ticket, 'expires'>) => {
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { ...t, expires: Date.now() + 60_000 });
  return ticket;
};
const stream = (ticket: string) =>
  `<Stream url="wss://${new URL(ORIGIN).host}/voice/twilio"><Parameter name="ticket" value="${ticket}"/></Stream>`;

// The voice line trades a ticket (once) for who the caller wants to talk to. A care ticket also brings the care
// deployment that answers (engine), the languages of the opening (openingLanguages), the agent's voice and its voice
// per language where the line's voices names one (the line's own voices for a language), the seed per language its
// fixed words are made from where its seeds names one (a take the company has heard read back right), and the
// company's respellings (langs and voices for the hellos).
export function redeem(ticket: string) {
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  if (!t || t.expires <= Date.now()) return 404;
  if (t.kind !== 'care') return { agent: t.agent, lang: t.lang };
  const line = lineAt(t.lineIndex ?? -1), care = agentOf(line), voice = care?.id === t.agent ? voiceOf(care) : undefined;
  const voices = Object.entries(line.voices ?? {}).filter(
    ([l, v]) => l in SAY && typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v),
  );
  const seeds = Object.entries(line.seeds ?? {}).filter(
    ([l, s]) => l in SAY && Number.isSafeInteger(s) && (s as number) >= 0,
  );
  return {
    agent: t.agent,
    lang: t.lang,
    kind: t.kind,
    engine: t.engine ?? 'care',
    langs: t.langs ?? [t.lang],
    ...(typeof voice === 'string' && voice ? { voice } : {}),
    ...(voices.length ? { voices: Object.fromEntries(voices) } : {}),
    ...(seeds.length ? { seeds: Object.fromEntries(seeds) } : {}),
    respell: respellings(),
  };
}

// The languages a caller's opening is said in, in order: the line's languages for the country code their number starts
// with (the longest that fits), else its default; a withheld number gets the default. Without either, the line's
// message's languages. The number itself goes no further than this.
export function openingLanguages(from: string, line: Line = lineAt(lineFor('', from))): Lang[] {
  const by: Record<string, unknown> = line.languages ?? {};
  const n = withheld(from) ? '' : international(from);
  const code = Object.keys(by)
    .filter(k => /^[1-9][0-9]{0,2}$/.test(k) && n.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const listed = (key: string | undefined) =>
    (Array.isArray(by[key ?? '']) ? (by[key!] as unknown[]) : []).filter((l): l is Lang => typeof l === 'string' && l in SAY);
  const langs = listed(code).length ? listed(code) : listed('default');
  return langs.length ? [...new Set(langs)] : languages(line);
}
