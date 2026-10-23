// A phone call's record: its conversation in the chat's tables (kind 'phone'), its
// messages, and the fault notes a caller gives. phone.ts runs the call; phonecode.ts and phonetools.ts change
// the record through these.
import { db, now } from './db.ts';
import { aboutOf } from './config.ts';
import { settings } from './company.ts';
import type { PhoneCall } from './company.ts';

// ---- the call's conversation: the chat's tables, kind 'phone', the shop the phone answers for
export type Phone = {
  round?: number;
  asked?: string;
  // at: when the check opened it, for order_status's newest
  granted?: { app: string; order: string; at?: number };
  checks?: { at: number; result: string }[];
  // the order whose number and postcode the caller gave: its status only (phonepostcode.ts), and the postcodes tried
  status?: { app: string; order: string; at?: number };
  postcodes?: number;
  // the order numbers an email answer was asked for (phoneanswer.ts)
  emailed?: string[];
  objected?: boolean;
  // the languages the caller has been informed in: their AI and transcript lines heard played whole, as the line says
  informed?: string[];
  // locked: the language the call is held to, the one it settled in or the one the caller asked for. settled: a second
  // reply has come in a language they heard the notice in, as the line's `settled`. replies: the caller's turns answered
  // in each language until then (phonelang.ts).
  locked?: string;
  settled?: boolean;
  replies?: Record<string, number>;
  faults?: string[];
  ended?: { why: string; at: number };
};
export type Conv = {
  id: number;
  shop: string;
  state: { lang?: string; stall?: string; orderApps?: string[]; phone: Phone };
};

export function load(id: unknown): Conv | null {
  if (!Number.isInteger(id)) return null;
  const r = db
    .prepare("select id, shop, state from conversations where id = ? and kind = 'phone'")
    .get(id as number) as any;
  if (!r) return null;
  const state = JSON.parse(r.state || '{}');
  return { id: r.id, shop: r.shop, state: { ...state, phone: state.phone ?? {} } };
}
export const save = (c: Conv) =>
  db.prepare('update conversations set state = ?, last = ? where id = ?').run(JSON.stringify(c.state), now(), c.id);
// the app the call is about, for its spend: the stall of the order a code opened, else the shop (config.ts aboutOf())
export const about = (c: Conv) => aboutOf(c.shop, c.state);
export const lang = (l: unknown, c?: Conv) =>
  settings.langs.includes(String(l))
    ? String(l)
    : c?.state.lang && settings.langs.includes(c.state.lang)
      ? c.state.lang
      : settings.langs[0];
// lang: the language a reply was spoken in, the model's tag (phone.ts); while
// words are held back (below), they wait with them, in order
type Kept = { who: 'me' | 'ai'; text: string; o: { ai?: boolean; health?: 'removed'; lang?: string } };
export function store(c: Conv, who: Kept['who'], text: string, o: Kept['o'] = {}) {
  const said = { who, text, o };
  keep(c, (c, at) => insert(c, at, said), said);
  save(c);
}
function insert(c: Conv, at: number, { who, text, o }: Kept) {
  db.prepare(
    'insert into messages (conversation, at, who, text, app, ai_generated, health, lang) values (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(c.id, at, who, text, who === 'me' ? c.shop : null, o.ai ? 1 : null, o.health ?? null, o.lang ?? null);
}

// ---- the caller's words held back: nothing they say is kept (the call's
// messages, a fault note, an email answer's question) before they've heard the AI line and the transcript line played
// whole in the language they speak, which only the reply's tag tells (the number doesn't: a German speaker on a Belgian
// one). Until then their words, and all written after them, wait here (the words for the model meanwhile); once the
// line says it has played that language's lines whole (`informed`, with each turn and the call's end), they're kept as
// they came, in order. A call that ends first keeps none of them; an objection, only what a case needs.
// write: the record's own (c: the call as it is then); said: the words, for the model; needs: the caller's words'
// language, once a reply's tag says it
type Held = { at: number; write: (c: Conv, at: number) => void; said?: Kept; needs?: string };
const held = new Map<number, Held[]>();
const caller = (h: Held) => h.said?.who === 'me';
// a write of the call's record: at once, or after the caller's words held before it
export function keep(c: Conv, write: Held['write'], said?: Kept) {
  const waiting = held.get(c.id);
  if (waiting?.length) waiting.push({ at: now(), write, said });
  else if (said && c.state.phone.objected) forget(c, said);
  else write(c, now());
}
// after an objection their words are never kept, but the model still has the call so far (until the call's end)
const unkept = new Map<number, Kept[]>();
const forget = (c: Conv, said: Kept) => unkept.set(c.id, [...(unkept.get(c.id) ?? []), said]);
// the caller's words: held until a reply's tag says their language (lang: known already, with one language and no tag)
export function hold(c: Conv, text: string, o: Kept['o'], lang?: string) {
  const said: Kept = { who: 'me', text, o };
  held.set(c.id, [...(held.get(c.id) ?? []), { at: now(), write: (c, at) => insert(c, at, said), said, needs: lang }]);
  release(c);
}
// a reply's tag: the language of the caller's words that had none yet
export function spokenIn(c: Conv, lang: string) {
  for (const h of held.get(c.id) ?? []) if (caller(h)) h.needs ??= lang;
  release(c);
}
// the languages the line says the caller has been informed in (a language once informed stays so), and what that lets
// be kept
export function informedIn(c: Conv, langs: unknown) {
  const got = Array.isArray(langs) ? langs.filter(l => settings.langs.includes(l)) : [];
  if (got.some(l => !c.state.phone.informed?.includes(l))) {
    c.state.phone.informed = [...new Set([...(c.state.phone.informed ?? []), ...got])];
    save(c);
  }
  release(c);
}
// kept, from the first held, for as long as each of the caller's words has had its language's lines heard; once they
// objected, the words never (the call's end deletes them anyway), what a case needs (a fault note) still
function release(c: Conv) {
  const waiting = held.get(c.id) ?? [];
  while (waiting[0] && (!caller(waiting[0]) || c.state.phone.informed?.includes(waiting[0].needs!))) {
    const h = waiting.shift()!;
    if (h.said && c.state.phone.objected) forget(c, h.said);
    else h.write(c, h.at);
  }
  if (!waiting.length) held.delete(c.id);
}
// the call's words not kept, for the model after what's kept; and at its end, gone
export const heldFor = (c: Conv): Kept[] => [
  ...(unkept.get(c.id) ?? []),
  ...(held.get(c.id) ?? []).flatMap(h => (h.said ? [h.said] : [])),
];
export const drop = (c: Conv) => (held.delete(c.id), unkept.delete(c.id));
export const call = (c: Conv, l: string): PhoneCall => ({
  conversation: c.id,
  shop: c.shop,
  lang: l,
  granted: c.state.phone.granted ?? null,
});

// an order number as said, its letters and digits only (speech-to-text writes its dashes as spaces, or not at all), as the
// fault notes and the code limit key it and the stalls are asked for it (each finds its order whatever the separators)
export const normOrder = (s: unknown) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 40);

// ---- a fault reported by phone: a dated note with the order number and what's wrong, code or not, kept as the
// chat's case records (12 months: db.ts sweep). It stays in care, where the chat's order tools and HQ's cards about that
// order show it (faultsFor()): the fix itself comes by email or the chat, with photos.
export function fault(c: Conv, order: string, what: string, l: string) {
  const o = normOrder(order),
    g = c.state.phone.granted,
    checked = g && g.order === o ? 'checked' : 'none';
  // (written once the caller's words before it are: keep())
  keep(c, (c, at) => {
    const id = Number(
      db
        .prepare(
          "insert into cases (app, conversation, kind, email, checked, words, facts, lang, created) values (?, ?, 'fault', null, ?, ?, ?, ?, ?)",
        )
        .run(
          checked === 'checked' ? g!.app : c.shop,
          c.id,
          checked,
          String(what).slice(0, 500),
          JSON.stringify({ order: o, reported: new Date(at).toISOString().slice(0, 10), by: 'phone' }),
          l,
          at,
        ).lastInsertRowid,
    );
    c.state.phone.faults = [...(c.state.phone.faults ?? []), o];
    save(c);
    console.log(`care: phone conversation ${c.id}: a fault note is case H-${1000 + id}`);
  });
}
// ---- general feedback from a call (pass_on_feedback): a note for the team, as the chat's (person.ts feedback()), with no
// number, order or reply address. Written as every record of the call is (keep(): only once the caller's words before it
// are kept), and held from HQ (`held` 'call') until the call's end: an objection then deletes it, else it goes
// (released()); after one, none is taken (phonetools.ts passOn())
export function feedback(c: Conv, words: string, l: string) {
  keep(c, (c, at) => {
    db.prepare(
      "insert into cases (app, conversation, kind, email, checked, words, facts, lang, created, held) values (?, ?, 'feedback', null, 'none', ?, '{}', ?, ?, 'call')",
    ).run(c.shop, c.id, String(words).slice(0, 500), l, at);
  });
}
// at the call's end: its feedback notes go to HQ, or, after an objection, are deleted; how many went
export function released(c: Conv) {
  if (c.state.phone.objected)
    return void db
      .prepare("delete from cases where conversation = ? and kind = 'feedback' and held = 'call'")
      .run(c.id);
  return Number(
    db.prepare("update cases set held = null where conversation = ? and kind = 'feedback' and held = 'call'").run(c.id)
      .changes,
  );
}

// The fault notes for an order, by any of its numbers (its id, its reference), as lines ("2026-10-17, by phone, code
// checked: the print is smudged"): beside the order in the chat's order tools (helper.ts) and on HQ's card about it (hq.ts)
export function faultsFor(...numbers: unknown[]): string[] {
  const o = [...new Set(numbers.map(normOrder).filter(Boolean))];
  if (!o.length) return [];
  return (
    db
      .prepare(
        `select words, checked, facts from cases where kind = 'fault' and json_extract(facts, '$.order') in (${o.map(() => '?').join(', ')}) order by id`,
      )
      .all(...o) as any[]
  ).map(
    r =>
      `${JSON.parse(r.facts).reported}, by phone${r.checked === 'checked' ? ", the caller read back the order's code" : ', not checked who called'}: ${r.words}`,
  );
}
