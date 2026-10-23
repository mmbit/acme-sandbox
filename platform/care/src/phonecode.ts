// The phone's code, in code: one random code per stall of the shop for an
// order number as said, each kept as a hash with its stall (phone_codes), and the caller's words read for it before any
// model sees them: a code read out is compared, taken out of what's kept and what the model reads, and the model hears
// only how it went. Numbers in the caller's words are read as the voice line's speech-to-text wrote them: digits
// ("482 917", "4, 8, 2"), or number words in Dutch, German and English, one digit at a time or in pairs ("forty-eight",
// "achtenveertig", "achtundvierzig"). A run is the numbers said one after another, with nothing but spaces, punctuation or
// a filler ("uh", "ehm") between.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { phoneStalls } from './config.ts';
import { db, now, limit, linkKey } from './db.ts';
import * as apps from './apps.ts';
import { save, normOrder, type Conv } from './phonecall.ts';
import { settings } from './company.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const CODE_MS = 10 * MINUTE_MS;
export const CODE_TRIES = 5;
const CODES_A_DAY = 3; // per order number, across calls: a new call doesn't reset it

// what's kept of a code read out, and what the model reads in its place
export const CODE_SAID = '(read out the code)';
const NUMBER_SAID = '(read out a number)';

const codeHash = (conv: number, round: number, app: string, order: string, code: string) =>
  createHmac('sha256', linkKey).update(`phone:${conv}:${round}:${app}:${order}:${code}`).digest();

// Asks every stall to email its own code to the order's address, if the order is one of its paid ones; each answers the
// same either way (kits/payments `code`). A new ask replaces the call's last; 3 an order number a day, across calls.
// The preview's stalls too, for a tester's order
export async function sendCode(c: Conv, order: string, l: string): Promise<'sent' | 'limited' | 'none'> {
  const o = normOrder(order),
    stalls = phoneStalls(c.shop);
  if (o.length < 3 || !stalls.length) return 'none';
  if (!limit(`phone-code:${c.shop}:${o}`, CODES_A_DAY, DAY_MS)) return 'limited';
  const t0 = now(),
    round = (c.state.phone.round ?? 0) + 1,
    codes = new Map<string, string>();
  db.prepare('update phone_codes set used = ? where conversation = ? and used is null').run(t0, c.id);
  const add = db.prepare(
    'insert into phone_codes (conversation, round, app, order_id, hash, created) values (?, ?, ?, ?, ?, ?)',
  );
  for (const app of stalls) {
    let code: string;
    // never one that, said after "one", "een" or "ein" (an article numberRuns keeps on an order number), would read as
    // an order's reference and so not as the code
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while ([...codes.values()].includes(code) || settings.orderRef(`1${code}`));
    codes.set(app, code);
    add.run(c.id, round, app, o, codeHash(c.id, round, app, o, code).toString('hex'), t0);
  }
  c.state.phone.round = round;
  c.state.phone.asked = o;
  save(c);
  // the answer doesn't wait for the stalls (each takes the same minimum time): the caller hears the same either way
  for (const [app, code] of codes)
    apps.call(app, 'code', { order: o, code, lang: l }).catch(() => {
      /* logged in apps.ts, unless the app is only briefly away */
    });
  return 'sent';
}

// One code read out: the try counted on the round first (parallel turns can't share one), then compared with each
// stall's hash. Right: that stall's order is open to this call, the call is linked to it (kept 12 months), the code spent.
export type Check = 'right' | 'wrong' | 'spent';
function checkCode(c: Conv, code: string): { result: Check; left: number } {
  const round = c.state.phone.round ?? 0,
    t0 = now();
  const tried = db
    .prepare(
      'update phone_codes set tries = tries + 1 where conversation = ? and round = ? and used is null and tries < ? and created > ? returning id, app, order_id, hash, tries',
    )
    .all(c.id, round, CODE_TRIES, t0 - CODE_MS) as any[];
  if (!tried.length) return { result: 'spent', left: 0 };
  const hit = tried.find(r =>
    timingSafeEqual(codeHash(c.id, round, r.app, r.order_id, code), Buffer.from(r.hash, 'hex')),
  );
  const tries = tried[0].tries as number;
  if (!hit) {
    if (tries >= CODE_TRIES)
      db.prepare('update phone_codes set used = ? where conversation = ? and round = ?').run(t0, c.id, round);
    return { result: tries >= CODE_TRIES ? 'spent' : 'wrong', left: CODE_TRIES - tries };
  }
  db.prepare('update phone_codes set used = ? where conversation = ? and round = ?').run(t0, c.id, round);
  c.state.phone.granted = { app: hit.app, order: hit.order_id, at: t0 }; // (at)
  c.state.orderApps = [hit.app];
  db.prepare('update conversations set linked = ? where id = ?').run(t0, c.id);
  return { result: 'right', left: 0 };
}

// The caller's words while a code was asked for in this call: every run of five digits or more, but an order's
// reference (the plug-in's `orderRef`: said on this line too, and kept as said), is taken out of the words before
// they're kept or read. A run of six, or of a multiple of six (the code read twice in a breath), is codes read out, each
// checked in order until one is right; any other run is a code misheard. Returns the words as kept, and how the check
// went for the model. Before any code, the words as said.
export function readCode(c: Conv, text: string): { text: string; result: Check | 'misheard' | null; left: number } {
  if (!c.state.phone.round) return { text, result: null, left: 0 };
  let out = '',
    from = 0,
    result: Check | 'misheard' | null = null,
    left = 0;
  for (const r of numberRuns(text, settings.orderRef)) {
    const n = r.digits.length;
    if (n < 5 || settings.orderRef(r.digits)) continue;
    out += text.slice(from, r.start);
    from = r.end;
    if (n % 6) {
      out += NUMBER_SAID;
      result ??= 'misheard';
      continue;
    }
    out += CODE_SAID;
    for (const code of r.digits.match(/\d{6}/g) ?? []) {
      if (result === 'right') break; // one right code is enough: the rest is only taken out
      const k = checkCode(c, code);
      result = k.result;
      left = k.left;
      c.state.phone.checks = [...(c.state.phone.checks ?? []), { at: now(), result: k.result }].slice(-20);
    }
  }
  if (result) save(c);
  return { text: out + text.slice(from), result, left };
}

// ---- numbers in what the caller said
const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  nul: 0,
  een: 1,
  één: 1,
  twee: 2,
  drie: 3,
  vier: 4,
  vijf: 5,
  zes: 6,
  zeven: 7,
  acht: 8,
  negen: 9,
  null: 0,
  eins: 1,
  zwei: 2,
  zwo: 2,
  drei: 3,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  neun: 9,
};
const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  tien: 10,
  elf: 11,
  twaalf: 12,
  dertien: 13,
  veertien: 14,
  vijftien: 15,
  zestien: 16,
  zeventien: 17,
  achttien: 18,
  negentien: 19,
  zehn: 10,
  zwölf: 12,
  zwoelf: 12,
  dreizehn: 13,
  vierzehn: 14,
  fünfzehn: 15,
  fuenfzehn: 15,
  sechzehn: 16,
  siebzehn: 17,
  achtzehn: 18,
  neunzehn: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  twintig: 20,
  dertig: 30,
  veertig: 40,
  vijftig: 50,
  zestig: 60,
  zeventig: 70,
  tachtig: 80,
  negentig: 90,
  zwanzig: 20,
  dreißig: 30,
  dreissig: 30,
  vierzig: 40,
  fünfzig: 50,
  fuenfzig: 50,
  sechzig: 60,
  siebzig: 70,
  achtzig: 80,
  neunzig: 90,
};
// a unit and a ten in one word: Dutch "achtenveertig", "drieëntwintig", German "achtundvierzig", "einundzwanzig"
const COMPOUND =
  /^(een|één|twee|drie|vier|vijf|zes|zeven|acht|negen|ein|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun)(?:en|ën|und)(\p{L}+)$/u;
const ONE = new Set(['ein', 'een', 'één']);
const FILLER = new Set(['uh', 'um', 'uhm', 'er', 'erm', 'eh', 'ehm', 'euh', 'äh', 'ähm', 'öh', 'hm', 'hmm']);
// what may stand between two numbers of one run
const GAP = /^[\s,.;:\-–—/]*$/;
// words that are also "a"/"an" or "the one": dropped from the front of a run that is too long with them ("een 4 8 2 9 1 7")
const ARTICLE = new Set(['een', 'één', 'ein', 'eine', 'one']);

type Token = { start: number; end: number; word: string; digits: string | null; tens: boolean; unit: boolean };

function valueOf(word: string): { digits: string; tens?: boolean; unit?: boolean } | null {
  if (/^\d+$/.test(word)) return { digits: word };
  if (word in UNITS) return { digits: String(UNITS[word]), unit: true };
  if (word in TEENS) return { digits: String(TEENS[word]) };
  if (word in TENS) return { digits: String(TENS[word]), tens: true };
  const m = COMPOUND.exec(word);
  if (m && m[2] in TENS) return { digits: String(TENS[m[2]] + (ONE.has(m[1]) ? 1 : UNITS[m[1]])) };
  return null;
}

// Every run of numbers in the text, with where it stands and its digits ("forty eight" is 48, "four eight" is 48 too).
// orderRef: the plug-in's order references, a run that is one whole keeping its first word.
export function numberRuns(
  text: string,
  orderRef: (digits: string) => boolean = () => false,
): { start: number; end: number; digits: string }[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0].toLowerCase(),
      v = valueOf(word);
    tokens.push({
      start: m.index!,
      end: m.index! + m[0].length,
      word,
      digits: v?.digits ?? null,
      tens: !!v?.tens,
      unit: !!v?.unit,
    });
  }
  // English "oh" for a zero, only between two numbers ("four oh two"), never an "oh" before or after one
  tokens.forEach((x, i) => {
    if (x.word === 'oh' && tokens[i - 1]?.digits != null && tokens[i + 1]?.digits != null) x.digits = '0';
  });
  const runs: { start: number; end: number; digits: string; first: Token; parts: Token[] }[] = [];
  let cur: (typeof runs)[number] | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const x = tokens[i];
    if (x.digits == null) {
      if (cur && FILLER.has(x.word) && GAP.test(text.slice(cur.end, x.start))) continue; // "four eight, uh, two"
      cur = null;
      continue;
    }
    const prev = cur?.parts.at(-1);
    if (cur && GAP.test(text.slice(tokens[i - 1].end, x.start))) {
      // the token before is the run's last, or a filler in it
      // "forty eight": a ten followed by a unit word is one number
      if (prev?.tens && x.unit && x.digits !== '0') cur.digits = cur.digits.slice(0, -1) + x.digits;
      else cur.digits += x.digits;
      cur.end = x.end;
      cur.parts.push(x);
    } else {
      cur = { start: x.start, end: x.end, digits: x.digits, first: x, parts: [x] };
      runs.push(cur);
    }
  }
  return runs.map(r => withoutArticle(r, orderRef));
}

// "een 4 8 2 9 1 7": the article isn't part of the code, but "one two three four five six six" is an order number
function withoutArticle(
  r: { start: number; end: number; digits: string; first: Token; parts: Token[] },
  orderRef: (digits: string) => boolean,
) {
  if (r.digits.length === 7 && r.parts.length > 1 && ARTICLE.has(r.first.word) && !orderRef(r.digits))
    return { start: r.parts[1].start, end: r.end, digits: r.digits.slice(1) };
  return { start: r.start, end: r.end, digits: r.digits };
}
