// The phone's lines: brand.yaml's phoneLines, which one a call takes, and the
// numbers they compare (phone.ts answers the calls).
import { brand } from './company.ts';
import { registerKeys, secret } from './secrets.ts';

const digits = (s: string) => s.replace(/[^0-9+]/g, '');
const CALLS_A_DAY = 3;

// A number in international form without its plus, as Twilio sends From in E.164. The board may have saved its own
// the way it's written at home: "06 1234 5678", "+31 (0)6 1234 5678", "0031 6 1234 5678".
export const international = (n: string) => {
  const d = digits(n.replace(/\(0\)/g, ''));
  return d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : d;
};
// A national number (one leading 0) is in the country of the line's own number: what From has before it must be 1 to 3
// digits the TWILIO_PHONE_NUMBER starts with (no table of country codes here: the caller ID is the first factor, the
// PIN the second). A saved number with no digits matches nobody, a withheld caller ID included.
export function sameNumber(saved: string, from: string) {
  const own = international(saved),
    caller = international(from);
  if (!own) return false;
  if (!own.startsWith('0')) return caller === own;
  const national = own.slice(1),
    code = caller.slice(0, -national.length);
  return (
    caller.endsWith(national) &&
    /^[1-9][0-9]{0,2}$/.test(code) &&
    international(secret('TWILIO_PHONE_NUMBER')).startsWith(code)
  );
}
// A withheld caller ID comes as no digits or as ANONYMOUS spelled on the keypad (Twilio's "Why am I getting calls from
// these strange numbers?").
export const withheld = (from: string) => digits(from).replace('+', '').length < 6 || digits(from) === '+266696687';

// ---- the lines
// brand.yaml's phoneLines, a list: each line the number it answers (`number`, Twilio's To; a line without one answers
// any number), who may use it (`callers`: anyone, or `{ numbers, pin }`, the names of two keys on the desk phone, the
// numbers allowed and the PIN they type, as the board's own line), the org.yaml agent who answers (`agent`), the care
// deployment it runs on (`engine`, a product with `engine: care`; care when left out), the opening's languages by
// country code (`languages`), voices and seeds per language, its message (`hello`, `greeting`) and the calls a day
// each number has (`callsADay`, 3). A call takes the first line for the number dialled that lets the caller in, else
// the first without a number that does; none: the platform's message. The old single phoneLine is one line, its
// `care` the agent. The board's own line comes before all of them and isn't on the list.
type Words = Record<string, unknown>;
export type Line = {
  number?: unknown;
  callers?: unknown;
  agent?: unknown;
  engine?: unknown;
  callsADay?: unknown;
  languages?: Words;
  voices?: Words;
  seeds?: Words;
  hello?: Words;
  greeting?: Words;
};
const NONE: Line = {};
// The lines as brand.yaml gives them. A line its settings can't be taken from as written stops every call with why,
// naming it: a typo must not open a guarded line to anyone, move it to another deployment or lift its calls a day.
export function lines(): Line[] {
  const { phoneLines, phoneLine } = brand();
  const list: unknown[] = Array.isArray(phoneLines)
    ? phoneLines
    : phoneLine
      ? [{ agent: phoneLine.care, ...phoneLine }]
      : [];
  return list.map((l, i) => {
    const wrong = misfit(l);
    if (wrong) throw new Error(`brand.yaml phoneLines, line ${i + 1}: ${wrong}`);
    return l as Line;
  });
}
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,60}$/;
function misfit(l: unknown) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'not a mapping';
  const line = l as Line,
    c = line.callers as { numbers?: unknown; pin?: unknown } | 'anyone' | undefined;
  if (line.number !== undefined && typeof line.number !== 'string') return 'its number must be quoted, as text';
  if (line.engine !== undefined && typeof line.engine !== 'string') return "its engine must be a deployment's name";
  if (line.callsADay !== undefined && !(Number.isSafeInteger(line.callsADay) && (line.callsADay as number) >= 0))
    return 'its callsADay must be a whole number from 0';
  if (
    c !== undefined &&
    c !== 'anyone' &&
    !(c && typeof c === 'object' && SECRET_NAME.test(String(c.numbers)) && SECRET_NAME.test(String(c.pin)))
  )
    return 'its callers must be anyone, or { numbers, pin } naming two keys';
  return '';
}
export const callerKeys = (line: Line) => {
  const c = line.callers as { numbers: string; pin: string } | undefined;
  return c && typeof c === 'object' ? { numbers: c.numbers, pin: c.pin } : null;
};
// A guarded line's numbers: its key's numbers, one per line or between commas
export const allowed = (line: Line, from: string) => {
  const keys = callerKeys(line);
  if (!keys) return true;
  return secret(keys.numbers)
    .split(/[,;\n]/)
    .some(n => sameNumber(n, from));
};
// The line a call takes (its place in the list), or -1 for none
export function lineFor(to: string, from: string) {
  const all = lines(),
    dialled = international(to);
  const own = (l: Line) => typeof l.number === 'string' && !!dialled && international(l.number) === dialled;
  const order = [...all.keys()].filter(i => own(all[i])).concat([...all.keys()].filter(i => !all[i].number));
  return order.find(i => allowed(all[i], from)) ?? -1;
}
export const lineAt = (i: number) => lines()[i] ?? NONE;
export const engineOf = (line: Line) => (line.engine as string | undefined) ?? 'care';
export const callsADay = (line: Line) => (line.callsADay as number | undefined) ?? CALLS_A_DAY;
// A guarded line's keys are the company's own on the desk phone, with their shapes, so the board can save them there.
// Read once at the start: lines that can't be read leave HQ running, logged here, and each call says why (lines()).
function lineKeys() {
  try {
    return lines().map(callerKeys);
  } catch (err) {
    console.error(`phone: ${(err as Error).message}`);
    return [];
  }
}
const shapes: Record<string, RegExp> = {};
for (const keys of lineKeys())
  if (keys) Object.assign(shapes, { [keys.numbers]: /^[+0-9 ()./,;\n-]{6,500}$/, [keys.pin]: /^[0-9]{4,12}$/ });
for (const [name, shape] of Object.entries(shapes))
  try {
    registerKeys({ [name]: shape });
  } catch (err) {
    console.error(`phone: a line's key: ${(err as Error).message}`); // (one of the server's own)
  }
