// Keys the board hands over on the desk phone. They live only on the server, one file per key, readable by the
// coordinator alone: never in the database, the repo, a request's answer or a log. Product containers get the
// keys their product.yaml declares (infra/products.py); agents get test-environment keys only.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';

export const DIR = process.env.SECRETS_DIR ?? `${DATA_DIR}/secrets`;
// Partner keys only (<PARTNER>_<TEST|LIVE>_<FIELD>). Agents choose the names and a test key reaches every job as an
// environment variable, so a name must never be able to set anything else (ANTHROPIC_BASE_URL, NODE_OPTIONS, ...).
// A new partner is added here, and to the worker's KEY (safety.ts).
// The third partner is Anthropic, for a model evaluation an agent runs in a job: one name, test only,
// ANTHROPICEVAL_TEST_API_KEY, a key made in its own console workspace under a small spend limit. It reaches jobs as
// ANTHROPICEVAL_API_KEY, never ANTHROPIC_API_KEY (the agents' own CLI would take it for its session), and so does a
// product on test partners that names anthropiceval in needs.secrets.
const NAME = /^((PRINTAPI|STRIPE)_(TEST|LIVE)_[A-Z0-9_]{2,40}|ANTHROPICEVAL_TEST_API_KEY)$/;
// Keys for the server's own use, never partner keys, so testSecrets() never hands one to a job: the server's GitHub
// token (C1: the board hands over a fine-grained token here; the server's deploy reads it from this directory) and
// the phone line's (phone.ts, calls.ts) and the nightly off-site backup's (infra/backup.py reads them on the host,
// with the same shapes; the age key is the board's public one, made in its browser). A new one is added here, or a
// company's own tool registers its own (registerKeys, below).
// And the support chat service's (infra/products.py puts them in its container's env alone): the model provider's key
// and the email service's token, whose shape isn't documented (one line, no spaces).
// An Anthropic API key: any sk-ant- key but the kinds known not to be one, a seat's sign-in or refresh token (sk-ant-oat…,
// sk-ant-ort…), a browser session key (sk-ant-sid…) and an Admin key (sk-ant-admin…). The console's own keys have changed
// prefix (sk-ant-api03-, now also sk-ant-usr…), so nothing more is guessed from the prefix.
const ANTHROPIC = /^sk-ant-(?!oat|ort|sid|admin)[A-Za-z0-9_-]{20,300}$/;
// The address reader shared by the desk phone and mailout.ts.
// (an internationalised top-level domain as mail carries it: xn--…) The part before the @ as the email service takes it:
// RFC 5322's dot-atom, ASCII letters, digits and !#$%&'*+/=?^_`{|}~- with dots only between them. What a copy and paste
// brings along unseen (Unicode's format characters: a zero-width space, a direction mark) is dropped first.
const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const ADDRESS = new RegExp(`^(?=.{1,254}$)(?=[^@]{1,64}@)${ATOM}(\\.${ATOM})*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$`, 'i');
const addressText = (v: string) => v.replace(/\p{Cf}/gu, '').trim();
export const address = (v: unknown) => {
  const a = typeof v === 'string' ? addressText(v) : '';
  return ADDRESS.test(a) ? a : null;
};
const OWN: Record<string, RegExp> = { SERVER_GITHUB_TOKEN: /^github_pat_[A-Za-z0-9_]+$/, TWILIO_AUTH_TOKEN: /^\S+$/,
  // the account the phone line's number is on, asked in place of the one a signed call named (calls.ts)
  TWILIO_ACCOUNT_SID: /^AC[0-9a-f]{32}$/,
  TWILIO_PHONE_NUMBER: /^[+0-9 ().\/-]{6,30}$/, BOARD_PHONE_NUMBER: /^[+0-9 ().\/-]{6,30}$/, CALL_PIN: /^[0-9]{4,12}$/,
  BACKUP_R2_ENDPOINT: /^https:\/\/[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com(\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9])?\/?$/,
  BACKUP_R2_ACCESS_KEY_ID: /^[0-9a-f]{32}$/, BACKUP_R2_SECRET_ACCESS_KEY: /^[0-9a-f]{64}$/, BACKUP_AGE_RECIPIENT: /^age1[02-9ac-hj-np-z]{58}$/,
  CARE_ANTHROPIC_API_KEY: ANTHROPIC, CARE_EMAIL_API_KEY: /^[^\s'\p{Cc}]{20,200}$/u,   // (no ': products.py can't quote it)
  // the email service's webhook secret, for the leaves through its own link and the emails it couldn't deliver (mailout.ts
  // readNotice).
  EMAIL_WEBHOOK_SECRET: /^[^\s'\p{Cc}]{20,200}$/u,
  // the shop's test code, which the board picks: 12 characters or more, so redact() masks it (payments.ts isTestCode).
  // Not process-only: the platform team asks for it, and a code steered by a card makes only test orders, a few a day
  SHOP_TEST_CODE: /^[A-Za-z0-9]{12,24}$/,
  // the Overseer's key to HQ's read-only route, which HQ makes on the board's Settings › Overseer (oversight.ts)
  OVERSEER_READ_KEY: /^overseer_[A-Za-z0-9_-]{43}$/,
  // the photo studio's image model key (imagemodel.ts): a Gemini API key, standard or auth (Google documents no format for
  // the auth keys it makes since May 2026), one token.
  STUDIO_GEMINI_API_KEY: /^[A-Za-z0-9._-]{30,200}$/,
  // a lent machine's sign-in to pull a kind's private image from GitHub's registry (runs.ts pullAuth): a classic token
  // with read:packages alone, the only kind ghcr.io takes. It goes to the machine for one pull, never kept there.
  REGISTRY_GHCR_TOKEN: /^ghp_[A-Za-z0-9]{36}$/,
  // the address the company's bookkeeping mail is copied to (mailforward.ts): one email address.
  MAIL_FORWARD_TO: ADDRESS };
// The server's own keys only the process team asks the board for (server.ts): a card from anyone else could point them
// elsewhere, the backups at a bucket or an age key of its own, the board's calls and their PIN at its own line, the
// deletion of callers' call records at another account, the bookkeeping copies at its own inbox (audit P17).
const PROCESS_ONLY = new Set(['SERVER_GITHUB_TOKEN', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'TWILIO_PHONE_NUMBER', 'BOARD_PHONE_NUMBER', 'CALL_PIN',
  'BACKUP_R2_ENDPOINT', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY', 'BACKUP_AGE_RECIPIENT',
  'EMAIL_WEBHOOK_SECRET', 'OVERSEER_READ_KEY', 'REGISTRY_GHCR_TOKEN', 'MAIL_FORWARD_TO']);
export const processOnly = (names: string) => names.split(',').some(n => PROCESS_ONLY.has(n));
export const validNames = (names: unknown) => typeof names === 'string' && names.split(',').every(n => NAME.test(n) || Object.hasOwn(OWN, n));
// Partner keys with a shape of their own, and pairs of keys that may never hold the same value: the eval key and the
// support chat's model key sit on one card, and a paste into the wrong field must never hand the server's uncapped key
// to every job. The eval key must be an API key, so a seat's sign-in token or an admin key is refused (ANTHROPIC); an
// uncapped API key from another workspace can't be told apart, so the cap rests on the board making the key in a
// workspace of its own.
const SHAPE: Record<string, RegExp> = { ...OWN, ANTHROPICEVAL_TEST_API_KEY: ANTHROPIC };
// Each pair with why its keys differ, for the desk phone's words
const APART: [string[], string][] = [[['CARE_ANTHROPIC_API_KEY', 'ANTHROPICEVAL_TEST_API_KEY'],
  'the test key needs a key of its own, made in a separate workspace with its own spend limit']];
// What the desk phone says under a field whose value doesn't fit its shape
const MISFIT = new Map<RegExp, (v: string) => string>([[ANTHROPIC, v => /^sk-ant-(oat|ort|sid)/.test(v)
  ? 'This is a Claude sign-in token, not an API key: make one under API keys in the Anthropic console.'
  : v.startsWith('sk-ant-admin') ? 'This is an Admin key: this field needs an ordinary API key, from API keys in the Anthropic console.'
  : "This doesn't look like an Anthropic API key (it should start sk-ant-): copy the whole key, and nothing else."],
  [ADDRESS, () => "This doesn't look like an email address: type the whole address, and nothing else."]]);
// a card whose keys are one delivery address (hq ask/request --address) asks for
// four of a company tool's own keys (name, street, postcode, city): never a partner key, which would hand the board's saved
// address to every job, nor one of the server's own.
const TOOLS = new Set<string>();
export const addressKeys = (names: string[]) => names.length === 4 && new Set(names).size === 4 && names.every(n => TOOLS.has(n));
// A company's own tool adds its own server keys and their shapes, at import: never a
// partner key's name (a test one would reach every job) or one already here, always a plain upper-case name.
export function registerKeys(shapes: Record<string, RegExp>) {
  for (const [n, re] of Object.entries(shapes)) {
    if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(n) || NAME.test(n) || Object.hasOwn(OWN, n)) throw new Error(`secrets: ${n} can't be a company's own key`);
    OWN[n] = re; SHAPE[n] = re; TOOLS.add(n);
  }
}
const fits = (n: string, v: string) => !Object.hasOwn(SHAPE, n) || SHAPE[n].test(v);
// the pair key n holding v would equal a key of, or undefined (holding: what each other key holds then)
const clash = (n: string, v: string, holding: (m: string) => string) => APART.find(([p]) => p.includes(n) && p.some(m => m !== n && holding(m) === v));
mkdirSync(DIR, { recursive: true, mode: 0o700 });

// The board may save some of a request's keys now and the rest later (a live account still being checked): only the
// filled-in ones are saved, each that's refused is left out with the reason in plain words for the desk phone (never its
// value), and the others are saved all the same. A card that can't be saved at all gets one reason, as a string.
export function saveSecrets(names: string[], values: Record<string, unknown>): { saved: string[]; refused: Record<string, string> } | string {
  if (!validNames(names.join(','))) return "This card asks for a key the server can't keep: the agent who sent it needs to send it again.";
  const filled = names.map(n => {
    const v = unquoted(String(values[n] ?? '').trim());
    return [n, SHAPE[n] === ADDRESS ? addressText(v) : v];
  }).filter(([, v]) => v);
  if (!filled.length) return 'Fill in at least one key.';
  const refused: Record<string, string> = {};
  for (const [n, v] of filled) {
    if (v.length > 4096) refused[n] = 'This is too long to be a key: copy the key alone, nothing around it.';
    else if (!fits(n, v)) refused[n] = MISFIT.get(SHAPE[n])?.(v) ?? "This doesn't look like the key this field asks for: copy the whole key, and nothing else.";
  }
  // Kept apart from what the other key holds after the save and from what it holds now: a service reads its key once at
  // start, so the key being replaced is still live until it restarts. Two fields holding the same key are both refused:
  // which of them the key was meant for can't be told. And a key refused for being the one the other field holds now
  // keeps that field's replacement out too: saved, it would let a retry of this field alone pass while the service is
  // still live on the old key.
  const fine = filled.filter(([n]) => !refused[n]), after = (m: string) => fine.find(([n]) => n === m)?.[1] ?? secret(m);
  for (const [n, v] of fine) {
    const typed = clash(n, v, m => fine.find(([o]) => o === m)?.[1] ?? ''), now = clash(n, v, secret), other = clash(n, v, after) ?? now;
    if (typed) refused[n] = `This is the same key as in the other field: ${typed[1]}.`;
    else if (other) refused[n] = `The server already holds this key for the other field: ${other[1]}.`;
    if (!typed && now) for (const [m] of fine.filter(([o]) => o !== n && now[0].includes(o) && secret(o) === v))
      refused[m] ??= 'Not saved: the other field was given the key this one replaces. Give the other field a key of its own, then save this one again.';
  }
  // A pair is saved together or not at all: with one field refused (for any reason), the other's new key saved alone would
  // let a retry of the refused field be checked against it while the service is still live on the key it replaced.
  for (const [p] of APART) if (p.some(n => refused[n]))
    for (const [m] of fine.filter(([o]) => p.includes(o) && !refused[o]))
      refused[m] = 'Not saved: the other field was refused. Put that right, then save both together.';
  const saved = fine.filter(([n]) => !refused[n]);
  for (const [n, v] of saved) writeFileSync(`${DIR}/${n}`, v, { mode: 0o600 });
  held = null;
  return { saved: saved.map(([n]) => n), refused };
}

// A key pasted with the double quotes around it (a value copied from a .env line) is saved without one pair of them: they're
// no part of the key, and a key kept with them would hand them to the service that reads it. A quote at one end only is
// the key's own (forms() unquotes a stored key the same way).
const unquoted = (v: string) => (v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).trim() : v);

// which of these keys the server already holds (names only, never values)
export const stored = (names: string[]) => names.filter(n => validNames(n) && existsSync(`${DIR}/${n}`));

// a key for the coordinator's own use (the phone line's), or '' when the board hasn't entered it
export const secret = (name: string) => { try { return readFileSync(`${DIR}/${name}`, 'utf8').trim(); } catch { return ''; } };

// a server key HQ makes itself rather than the board (the Overseer's): written like a saved one, and masked from then on
export const keepMadeKey = (name: string, value: string) => {
  if (!Object.hasOwn(OWN, name) || !fits(name, value)) throw new Error(`secrets: ${name} can't hold this key`);
  writeFileSync(`${DIR}/${name}`, value, { mode: 0o600 });
  held = null;
};

// a key the server makes itself on first use (32 random bytes, hex) and keeps in DATA_DIR as <name>.key, beside the key
// store and outside it, so no card can overwrite it: what it signs, HQ alone can sign.
export function serverKey(name: string) {
  const file = `${DATA_DIR}/${name}.key`;
  if (!existsSync(file)) try { writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch { /* made meanwhile */ }
  return readFileSync(file, 'utf8').trim();
}

// delete keys whose job is done (a one-off delivery address once its parcel has shipped)
export const forget = (names: string[]) => { for (const n of names) if (validNames(n)) rmSync(`${DIR}/${n}`, { force: true }); held = null; };

// the board's saved delivery addresses (addresses.ts), one file each, its four
// parts on four lines, kept like a key: never a name a card can ask for (validNames), never handed to a job (testSecrets),
// masked in text by redact() like a key, line by line.
const saved = (id: number) => `SAVED_ADDRESS_${id}`;
export const keepAddress = (id: number, parts: string[]) => { writeFileSync(`${DIR}/${saved(id)}`, parts.join('\n'), { mode: 0o600 }); held = null; };
export const savedAddress = (id: number) => { const parts = secret(saved(id)).split('\n'); return parts.length === 4 ? parts : null; };
export const dropAddress = (id: number) => { rmSync(`${DIR}/${saved(id)}`, { force: true }); held = null; };

// A key's value is never kept in text an agent can read, whatever the text is about (the board, 2026-10-06): the
// coordinator's free-text columns go through redact() as they're written (db.ts redacted()), which puts the key's name
// where its value was, and saving a key scrubs it out of what's already there (db.ts scrub()), so a key the board said on
// a call or pasted in the intercom before saving it goes too; so does each long line of a key on several lines (a PEM
// key), and the worker's own text sent back to the company (POST /api/worker/redact). Values of 12 characters or more
// only: a short one (a PIN) would turn up in ordinary words, and masking it would tell whoever wrote every 4-digit string
// which one it is. Each also as JSON writes it inside a string (a call's lines are a JSON array), so a
// key holding a quote or a backslash goes too.
const LONG = 12;
// Every value in the key store is masked, the phone numbers too: the board's own is private, so the company's public line
// goes with it. The store is written only through saveSecrets, keepMadeKey and forget (and the saved addresses'), which reset `held`.
let held: [string, string][] | null = null;   // [value, name], longest first; null: read the key store again
export function redact<T>(text: T): T {
  if (typeof text !== 'string' || text.length < LONG) return text;
  held ??= readdirSync(DIR).flatMap(n => forms(secret(n)).map(x => [x, n] as [string, string]))
    .filter(([v]) => v.length >= LONG).sort((a, b) => b[0].length - a[0].length);
  let out: string = text;
  for (const [v, n] of held) if (out.includes(v)) out = out.split(v).join(`[${n}]`);
  return out as T;
}
// What redact() masks as of now, without a value: each key's name, size and time, and the rules' own source below (db.ts
// scrub() keeps a hash of both), so a deploy that changes LONG, forms() or redact() goes over old text again with no
// version to bump.
export function keysStamp() {
  const lines = readdirSync(DIR).sort().map(keyStamp);
  return lines.join('\n');
}
function keyStamp(name: string) {
  const { size, mtimeMs } = statSync(`${DIR}/${name}`);
  return `${name} ${size} ${mtimeMs}`;
}
// a value, each of its lines if it has several, and the JSON-escaped form of each, all unquoted() as saveSecrets() saves
// them: a key kept in its .env quotes is masked inside them, so a JSON string around it keeps its own quotes (calls.lines,
// chat.card), and a quote that is part of a key stays in it.
function forms(value: string) {
  const lines = value.split('\n').map(l => l.trim()),
    plain = [value, ...(lines.length > 1 ? lines : [])].map(unquoted);
  return [...new Set(plain.flatMap(v => [v, JSON.stringify(v).slice(1, -1)]))];
}
// JSON kept as text (a call's lines, a card's questions or switches): each string in it, a property's name too, is redacted
// as it reads and the JSON written again, so a key's form ending in a quote never takes a string's own quote with it. Text
// with nothing to mask stays as it was written.
export function redactJson<T>(text: T): T {
  if (typeof text !== 'string' || text.length < LONG) return text;
  let masked = false;
  const string = (v: string) => { const r = redact(v); masked ||= r !== v; return r; };
  const walk = (v: unknown): unknown => typeof v === 'string' ? string(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [string(k), walk(x)])) : v;
  const out = JSON.stringify(walk(JSON.parse(text)));
  return (masked ? out : text) as T;
}
export const REDACT_RULES = [LONG, secret, forms, redact, redactJson].join('\n');

// PRINTAPI_TEST_CLIENT_ID reaches a job as PRINTAPI_CLIENT_ID. A Stripe key goes only if it really is a test key, so a
// live key pasted into a test field never reaches an agent. A key with a shape of its own goes only in that shape, and
// never while it equals a key it's kept apart from; each goes trimmed, as saveSecrets() writes it.
export const testSecrets = () => Object.fromEntries(readdirSync(DIR).filter(n => NAME.test(n) && n.split('_')[1] === 'TEST')
  .map(n => [n, readFileSync(`${DIR}/${n}`, 'utf8').trim()]).filter(([n, v]) => fits(n, v) && !clash(n, v, secret))
  .map(([n, v]) => [n.replace('_TEST_', '_'), v])
  .filter(([n, v]) => !n.startsWith('STRIPE_') || /^(rk|sk)_test_/.test(v)));
