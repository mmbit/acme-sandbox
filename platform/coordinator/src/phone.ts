// The phone line: the board calls a Twilio number and talks with the CEO. Twilio asks HQ what to do with each call
// (a webhook); HQ answers only a call that Twilio signed, from the board's own number, after the board types its
// PIN. Then it hands Twilio a one-time ticket for the voice line (platform/voice), which streams the call.
// Everyone else is a customer who found the number on a shop's imprint. When brand.yaml's phoneLine.care names the
// agent who answers them (the care service's phone conversation, platform/care), the call goes to that agent through
// the voice line, three calls a day per number. Otherwise, or past that, they
// hear the company's short message in each
// of its languages, pointing them to a way we can answer (email, the website), and the call ends. Never a person, never
// the board, nothing recorded: we couldn't check who a caller is or call them back (the board, 2026-10-15). Twilio's
// record of each call, with the caller's number, is deleted within the hour (calls.ts).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DATA_DIR, ORIGIN } from './config.ts';
import { db } from './db.ts';
import { secret } from './secrets.ts';
import { rememberAccount, twilioAccount, askTwilio } from './calls.ts';
import { ceo, brand, names, respellings, yamlFile, voiceOf } from './company.ts';
import { publish } from './events.ts';
import { boardLanguage, type BoardLanguage } from './language.ts';

// kind 'care': a caller who isn't the board, for the agent who answers them, with the languages of its opening (langs;
type Ticket = { agent: string; lang: string; expires: number; kind?: 'care'; langs?: Lang[] };
const tickets = new Map<string, Ticket>();
const xml = (res: ServerResponse, body: string) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`); };
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const digits = (s: string) => s.replace(/[^0-9+]/g, '');

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

// The message for callers who aren't the board: brand.yaml's phoneLine.hello, one word in each language it gives (so a
// caller hears theirs is coming), then phoneLine.greeting in each, in its order, with no menu. Without the company's
// own words, these, with its name.
const GREETING = (name: string) => ({
  en: `Hello, you've reached ${name}. We're run by AI agents and can't help you by phone. ` +
    'Please reach us through the Help page on our website.',
  nl: `Hallo, u spreekt met ${name}. Wij worden gerund door AI-agents en kunnen u telefonisch niet helpen. ` +
    'U bereikt ons via de Help-pagina op onze website.',
  de: `Hallo, Sie sind bei ${name}. Wir werden von KI-Agenten betrieben und können Ihnen am Telefon nicht helfen. ` +
    'Sie erreichen uns über die Hilfe-Seite auf unserer Website.',
});
const xmlText = (s: string) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
const languages = () => {
  const own = Object.keys(brand().phoneLine?.greeting ?? {}).filter((l): l is Lang => l in SAY);
  return own.length ? own : (Object.keys(SAY) as Lang[]);
};
const hello = (l: Lang) => {
  const word = brand().phoneLine?.hello?.[l];
  return typeof word === 'string' && word.trim() ? say(l, xmlText(word)) : '';
};
const message = () =>
  `<Play>${ORIGIN}/phone/chime.mp3</Play>` +
  languages().map(hello).join('') +
  languages()
    .map(l => say(l, greeting(l)))
    .join('') +
  '<Hangup/>';
export function greeting(lang: Lang) {
  const own = brand().phoneLine?.greeting?.[lang];
  return xmlText(typeof own === 'string' && own.trim() ? own : GREETING(names().name)[lang]);
}

// Amazon Polly's neural voices through Twilio: about 2 cents a call (Twilio's and Polly's list prices).
// Twilio's free voices have no Dutch and it advises against them.
const SAY = { en: ['en-GB', 'Polly.Amy-Neural'], nl: ['nl-NL', 'Polly.Laura-Neural'], de: ['de-DE', 'Polly.Vicki-Neural'] };
type Lang = keyof ReturnType<typeof GREETING>;
const say = (lang: Lang, text: string) => `<Say language="${SAY[lang][0]}" voice="${SAY[lang][1]}">${text}</Say>`;
// The line's own words to the board, in the board's language like the call after them
const TO_BOARD: Record<BoardLanguage, { pin: string; wrong: string; closed: string; bye: string }> = {
  en: { pin: 'Your PIN, please.', wrong: 'That PIN is not right.', closed: 'The line is closed for now.', bye: 'Goodbye.' },
  nl: { pin: 'Je pincode, graag.', wrong: 'Die pincode klopt niet.', closed: 'De lijn is voorlopig dicht.', bye: 'Tot ziens.' },
  de: { pin: 'Deine PIN, bitte.', wrong: 'Diese PIN stimmt nicht.', closed: 'Die Leitung ist vorerst geschlossen.', bye: 'Auf Wiedersehen.' },
};
const toBoard = (text: (w: (typeof TO_BOARD)['en']) => string) => { const l = boardLanguage(); return say(l, text(TO_BOARD[l])); };

// Someone guessing PINs from a spoofed caller ID: after 5 wrong ones in an hour the team line stays shut for the hour.
// Kept in the db, so a restart or deploy doesn't hand out five new guesses.
db.exec('create table if not exists phone_misses (ts integer not null)');
// Every wrong PIN from the board's number reaches the board's feed: five an hour
// is 120 guesses a day at a 4-digit PIN, and a spoofed caller ID that shuts the line must not go unnoticed.
const misses = () => {
  db.prepare('delete from phone_misses where ts < ?').run(Date.now() - 3_600_000);
  return (db.prepare('select count(*) as n from phone_misses').get() as { n: number }).n;
};
const miss = () => {
  db.prepare('insert into phone_misses (ts) values (?)').run(Date.now());
  const n = misses();
  publish({ type: 'log', agent: ceo(), to: 'board', text: n >= 5
    ? 'The phone line is shut for an hour: 5 wrong PINs from your number. If that wasn\'t you, someone is guessing it with your caller ID: change the PIN.'
    : `A wrong PIN on the phone line from your number (${n} of 5 this hour). If that wasn't you, someone is guessing it with your caller ID.` });
};
const locked = () => misses() >= 5;

// A number in international form without its plus, as Twilio sends From in E.164. The board may have saved its own
// the way it's written at home: "06 1234 5678", "+31 (0)6 1234 5678", "0031 6 1234 5678".
export const international = (n: string) => {   // (callouts.ts dialable)
  const d = digits(n.replace(/\(0\)/g, ''));
  return d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : d;
};
// A national number (one leading 0) is in the country of the line's own number: what From has before it must be 1 to 3
// digits the TWILIO_PHONE_NUMBER starts with (no table of country codes here: the caller ID is the first factor, the
// PIN the second). A board number with no digits matches nobody, a withheld caller ID included.
function fromBoard(from: string) {
  const board = international(secret('BOARD_PHONE_NUMBER')), caller = international(from);
  if (!board) return false;
  if (!board.startsWith('0')) return caller === board;
  const national = board.slice(1), code = caller.slice(0, -national.length);
  return caller.endsWith(national) && /^[1-9][0-9]{0,2}$/.test(code) && international(secret('TWILIO_PHONE_NUMBER')).startsWith(code);
}
// Why a call isn't the board's, without the number. A withheld caller ID comes as no digits or as ANONYMOUS spelled on
// the keypad (Twilio's "Why am I getting calls from these strange numbers?").
const whyNotBoard = (from: string) => !international(secret('BOARD_PHONE_NUMBER')) ? 'no board number saved'
  : withheld(from) ? 'no caller ID' : 'another number';
const withheld = (from: string) => digits(from).replace('+', '').length < 6 || digits(from) === '+266696687';

// ---- the agent who answers callers who aren't the board
// brand.yaml's phoneLine.care: an agent on one of org.yaml's desks. None, or one that isn't there: the message only.
type Agent = { id: string; name?: string; voice?: string; pronouns?: string };
const nameOf = (agent: Agent | null) => agent?.name ?? agent?.id ?? 'the agent';
function careAgent(): Agent | null {
  const named = brand().phoneLine?.care;
  if (typeof named !== 'string' || !named) return null;
  const agents: Agent[] = (yamlFile('company/org.yaml').departments ?? []).flatMap((d: any) => d?.agents ?? []);
  return agents.find(a => a?.id === named) ?? null;
}

// Three calls a day per number reach the agent, so one caller can't run up the model's bill or tie up the line. The
// number is kept only as an HMAC under HQ's own key (phone.key in DATA_DIR, made once), for 2 days. Withheld numbers
// share one key and so one limit. A call is counted when it goes to the agent, not when the message plays.
const HOUR_MS = 3_600_000,
  DAY_MS = 24 * HOUR_MS;
const CALLS_A_DAY = 3,
  CALLERS_KEPT_MS = 2 * DAY_MS;
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
const callerHash = (from: string) =>
  createHmac('sha256', KEY)
    .update(withheld(from) ? 'withheld' : `number:${international(from)}`)
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

// A caller who isn't the board: the agent, while the number has calls left today, else the message. Twilio asks
// /api/twilio/after once the stream ends.
function stranger(res: ServerResponse, step: string, from: string, why: string) {
  const agent = careAgent();
  if (!agent) {
    answered(step, `the company's message (${why})`);
    return xml(res, message());
  }
  const hash = callerHash(from);
  if (callsToday(hash) >= CALLS_A_DAY) {
    answered(step, `the company's message (${CALLS_A_DAY} calls today)`);
    return xml(res, message());
  }
  db.prepare('insert into phone_callers (hash, ts) values (?, ?)').run(hash, Date.now());
  const langs = openingLanguages(from);
  const ticket = issue({ agent: agent.id, lang: langs[0], kind: 'care', langs });
  answered(step, `${nameOf(agent)} (care ticket)`);
  return xml(res, `<Connect action="/api/twilio/after">${stream(ticket)}</Connect>`);
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
// crash) the message, which points to the email address and the website
function afterAgent(res: ServerResponse, call: string) {
  const ended = (hungUp.get(call) ?? 0) > Date.now() - DONE_KEPT_MS;
  hungUp.delete(call);
  answered('after', `after ${nameOf(careAgent())}: ${ended ? 'hung up' : "the company's message"}`);
  return xml(res, ended ? '<Hangup/>' : message());
}


// POST /api/twilio/voice (a call comes in), /api/twilio/pin (the digits the board typed) and /api/twilio/after (the
// agent's stream ended) (after, strangers to the agent, the board's empty PIN)
export async function webhook(req: IncomingMessage, res: ServerResponse, step: 'voice' | 'pin' | 'after') {
  const form = await readForm(req), from = form.get('From') ?? '', refused = refusalReason(req, form);
  if (refused) { answered(step, `403, ${refused}`); res.writeHead(403); return res.end(); }
  rememberAccount(form.get('AccountSid'));
  if (step === 'after') return afterAgent(res, form.get('CallSid') ?? '');
  if (!fromBoard(from)) {
    if (step === 'voice') return stranger(res, step, from, whyNotBoard(from));
    answered(step, `the company's message (${whyNotBoard(from)})`);
    return xml(res, message());
  }
  if (locked()) { answered(step, 'the board: line closed (5 wrong PINs)'); return xml(res, `${toBoard(w => `${w.closed} ${w.bye}`)}<Hangup/>`); }
  if (step === 'voice') {
    answered(step, 'the board: PIN prompt');
    // No PIN within the timeout: the board calls the agent who answers strangers, as any caller
    const empty = careAgent() ? ' actionOnEmptyResult="true"' : '';
    const numDigits = Math.max(4, secret('CALL_PIN').length);
    const prompt = toBoard(w => `${xmlText(names().name)}. ${w.pin}`);
    return xml(
      res,
      `<Gather input="dtmf" numDigits="${numDigits}" action="/api/twilio/pin" timeout="10"${empty}>${prompt}</Gather>${toBoard(w => w.bye)}`,
    );
  }
  if (!form.get('Digits') && careAgent()) return stranger(res, step, from, 'the board, no PIN');
  const pin = secret('CALL_PIN');
  if (!pin || !same(form.get('Digits') ?? '', pin)) { miss(); answered(step, 'the board: wrong PIN'); return xml(res, `${toBoard(w => `${w.wrong} ${w.bye}`)}<Hangup/>`); }
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { agent: ceo(), lang: boardLanguage(), expires: Date.now() + 60_000 });
  const host = new URL(ORIGIN).host;
  answered(step, 'the board: the voice line');
  return xml(res, `<Connect><Stream url="wss://${host}/voice/twilio"><Parameter name="ticket" value="${ticket}"/></Stream></Connect>`);
}

const issue = (t: Omit<Ticket, 'expires'>) => {
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { ...t, expires: Date.now() + 60_000 });
  return ticket;
};
const stream = (ticket: string) =>
  `<Stream url="wss://${new URL(ORIGIN).host}/voice/twilio"><Parameter name="ticket" value="${ticket}"/></Stream>`;

// The voice line trades a ticket (once) for who the caller wants to talk to. A care ticket also brings the languages
// of the opening (openingLanguages), the agent's voice and its voice per language where brand.yaml's phoneLine.voices
// names one (the line's own voices for a language), the seed per language its fixed words are made from where
// phoneLine.seeds names one (a take the company has heard read back right), and
// the company's respellings (langs and voices for the hellos).
export function redeem(ticket: string) {
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  if (!t || t.expires <= Date.now()) return 404;
  if (t.kind !== 'care') return { agent: t.agent, lang: t.lang };
  const care = careAgent(), voice = care?.id === t.agent ? voiceOf(care) : undefined;
  const voices = Object.entries(brand().phoneLine?.voices ?? {}).filter(
    ([l, v]) => l in SAY && typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v),
  );
  const seeds = Object.entries(brand().phoneLine?.seeds ?? {}).filter(
    ([l, s]) => l in SAY && Number.isSafeInteger(s) && (s as number) >= 0,
  );
  return {
    agent: t.agent,
    lang: t.lang,
    kind: t.kind,
    langs: t.langs ?? [t.lang],
    ...(typeof voice === 'string' && voice ? { voice } : {}),
    ...(voices.length ? { voices: Object.fromEntries(voices) } : {}),
    ...(seeds.length ? { seeds: Object.fromEntries(seeds) } : {}),
    respell: respellings(),
  };
}

// The languages a caller's opening is said in, in order: brand.yaml's
// phoneLine.languages for the country code their number starts with (the longest that fits), else its default; a
// withheld number gets the default. Without either, the company's message's languages. The number itself goes no
// further than this.
export function openingLanguages(from: string): Lang[] {
  const by: Record<string, unknown> = brand().phoneLine?.languages ?? {};
  const n = withheld(from) ? '' : international(from);
  const code = Object.keys(by)
    .filter(k => /^[1-9][0-9]{0,2}$/.test(k) && n.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const listed = (key: string | undefined) =>
    (Array.isArray(by[key ?? '']) ? (by[key!] as unknown[]) : []).filter((l): l is Lang => typeof l === 'string' && l in SAY);
  const langs = listed(code).length ? listed(code) : listed('default');
  return langs.length ? [...new Set(langs)] : languages();
}
type IncomingNumber = { phone_number: string; status?: string; capabilities?: { voice?: boolean }; voice_url?: string | null; voice_method?: string; voice_application_sid?: string | null; trunk_sid?: string | null };
// hq phone --check: the line as Twilio has it, asked with the coordinator's own keys. Whether Twilio's API takes the
// keys (a webhook signed with another token is refused above, and a caller hears Twilio's error), the account's state
// and where the number sends a call. It never shows a key, a caller's number or a call.
export async function checkLine() {
  const account = twilioAccount(), hq = `${ORIGIN}/api/twilio/voice`;
  const reached = [`A signed call has reached HQ for this account: ${account?.signed ? 'yes' : 'no'}.`];
  if (account?.signedAccount && !account.signed) reached.push('A signed call named another account than the saved TWILIO_ACCOUNT_SID.');
  if (!account) return [`No account to ask: save Twilio's Account SID as TWILIO_ACCOUNT_SID, or a signed call names it.`, ...reached];
  if (!secret('TWILIO_AUTH_TOKEN')) return ['No TWILIO_AUTH_TOKEN saved.', ...reached];
  const accountName = account.signed ? 'the account a signed call named' : 'the saved TWILIO_ACCOUNT_SID';
  try {
    const accountResponse = await askTwilio(account.sid, '.json');
    if (accountResponse.status === 401) return [`Twilio refused HQ's keys for ${accountName}: the saved auth token isn't that account's (or the SID is another account's).`, ...reached];
    if (!accountResponse.body) return [`Twilio answered ${accountResponse.status} for ${accountName}.`, ...reached];
    const lines = [`Twilio took HQ's keys for ${accountName}: the account is ${accountResponse.body.status} (${accountResponse.body.type}).`];
    const configuredNumber = international(secret('TWILIO_PHONE_NUMBER'));
    if (!configuredNumber) return [...lines, 'No TWILIO_PHONE_NUMBER saved.', ...reached];
    const numbersResponse = await askTwilio(account.sid, '/IncomingPhoneNumbers.json?PageSize=1000');
    if (!numbersResponse.body) return [...lines, `Twilio answered ${numbersResponse.status} for the account's numbers.`, ...reached];
    if (!Array.isArray(numbersResponse.body.incoming_phone_numbers)) return [...lines, "Twilio returned an invalid list of the account's numbers.", ...reached];
    const numbers = numbersResponse.body.incoming_phone_numbers as IncomingNumber[];
    const number = numbers.find(candidate => {
      const listedNumber = international(candidate.phone_number);
      return configuredNumber.startsWith('0') ? listedNumber.endsWith(configuredNumber.slice(1)) : listedNumber === configuredNumber;
    });
    if (!number) return [...lines, `TWILIO_PHONE_NUMBER isn't on this account (it has ${numbers.length} ${numbers.length === 1 ? 'number' : 'numbers'}).`, ...reached];
    lines.push(`The number: on the account (${number.status ?? 'no status'}), ${number.capabilities?.voice ? 'takes' : "doesn't take"} voice calls.`);
    const voiceRoute = describeVoiceRoute(number, hq);
    lines.push(`A call comes in: ${voiceRoute}.`);
    return [...lines, ...reached];
  } catch (err) {
    return [`Couldn't reach Twilio: ${(err as Error).message}`, ...reached];
  }
}

const describeVoiceRoute = (number: IncomingNumber, hq: string) => {
  if (number.trunk_sid) return 'a SIP trunk takes it, not a URL';
  if (number.voice_application_sid) return "a TwiML app takes it (the app's voice URL, not the number's)";
  if (!number.voice_url) return 'no voice URL';
  const method = number.voice_method?.toUpperCase() || 'no method';
  const methodNote = method === 'POST' ? 'POST' : `${method}, but HQ takes only POST`;
  if (number.voice_url === hq) return `HQ's ${hq}, ${methodNote}`;
  return `another URL, ${withoutSecrets(number.voice_url, hq)}, ${methodNote} (HQ's is ${hq}, POST)`;
};

// Another service's path or query can hold its key, so only the host shows and whether the path is HQ's.
const withoutSecrets = (url: string, hq: string) => {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname === new URL(hq).pathname ? "HQ's path" : 'another path';
    return `${parsedUrl.protocol}//${parsedUrl.host} (${path}${parsedUrl.search ? ', with a query' : ''})`;
  } catch {
    return 'not a URL';
  }
};
