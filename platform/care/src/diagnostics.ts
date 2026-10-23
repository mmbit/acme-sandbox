// A bug report's bundle: the page's picture and short log, sent by
// the widget only from the consent card's "Send it". Checked strictly here (allowed keys and types only, lengths
// bounded, the picture a real JPEG or PNG), every string redacted again (the browser did it first: defence in depth),
// and stored as data with the conversation and a `bug` case for HQ. Kept until the bug is fixed (fixed() below), 90 days
// at most (db.ts sweep()): the `bug` case goes then too, its one line on what went wrong with it (the card names that
// line as part of what's sent, so its promise covers it).
import { db, now, byRef } from './db.ts';
import { t, type Lang } from './texts.ts';
import type { Widget } from './engine.ts';

export const BODY_MAX = 256 * 1024; // the route's own cap; every other POST keeps 16 KB
const EVENTS_MAX = 100;
const KINDS = new Set(['error', 'rejection', 'request', 'view', 'track']);
const WINDOW_MS = 10 * 60_000; // "the last few minutes": events older than this before the bundle's own time are dropped (telemetry.js too)

// ---- redaction: the same rules as public/telemetry.js (emails, runs of 6+ digits with or without spaces or dashes,
// URLs and paths without their query and fragment, id-like segments masked)
// Any x@y is an email (anna@пример.рф, anna@example。com: a TLD check let those
// through), digits in any script with up to two separators between them (4242  4242  4242  4242), a query or fragment
// on its own (?order=…&t=…, #poppy=…), and a long token (a link's, an order's key) is masked whole.
const EMAIL = /[^\s@<>()[\]{},;:"'`]+@[^\s@<>()[\]{},;:"'`]*[^\s@<>()[\]{},;:"'`.\u3002\uff0e\uff61]/g;
const DIGITS = /\p{Nd}(?:[\s./_,-]{0,2}\p{Nd}){5,}/gu;
const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*|(?<![\w.~-])\/[^\s"'<>()]*|[?#&][\w.~%-]+=[^\s"'<>()]*/gi;
const TOKEN = /[\w-]{20,}(?:\.[\w-]+)*/g;
const token = (w: string) => /\d/.test(w) || w.length >= 32 ? '[token]' : w;
const idLike = (s: string) => (/\d/.test(s) && s.length > 2) || s.length >= 24 || s.includes('@');
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const pattern = (u: string) => {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/is.exec(u.split(/[?#]/)[0])!;
  return (m[1] ?? '').replace(/\/\/[^@/]*@/, '//') + m[2].split('/').map(seg => seg && idLike(decoded(seg)) ? ':id' : seg).join('/');
};
export const redact = (s: string, max = 200) => s.slice(0, 2000).replace(URLISH, pattern).replace(EMAIL, '[email]').replace(TOKEN, token).replace(DIGITS, '[number]').slice(0, max);

// ---- the schema: { v: 1, at, page: { path, w, h }, events: [{ at, kind, text }], picture } and nothing else
export type Bundle = { v: 1; at: string; page: { path: string; w: number; h: number }; events: { at: number; kind: string; text: string }[]; picture: string | null };
const only = (o: any, keys: string[]) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k)) && keys.every(k => k in o);
const str = (x: any, max: number) => typeof x === 'string' && x.length <= max;
const int = (x: any, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
const MAGIC: Record<string, number[]> = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] };

// the bundle as stored, or why not (a refusal the widget can't fix: a script, or a bug of ours)
export function check(b: any): { ok: true; bundle: Bundle } | { ok: false; why: string } {
  if (!only(b, ['v', 'at', 'page', 'events', 'picture']) || b.v !== 1) return { ok: false, why: 'bundle: unknown shape' };
  if (!str(b.at, 40) || Number.isNaN(Date.parse(b.at))) return { ok: false, why: 'bundle: at' };
  if (!only(b.page, ['path', 'w', 'h']) || !str(b.page.path, 300) || !int(b.page.w, 0, 10_000) || !int(b.page.h, 0, 10_000)) return { ok: false, why: 'bundle: page' };
  if (!Array.isArray(b.events) || b.events.length > EVENTS_MAX) return { ok: false, why: `bundle: at most ${EVENTS_MAX} events` };
  for (const e of b.events) if (!only(e, ['at', 'kind', 'text']) || !int(e.at, 0, 1e14) || !KINDS.has(e.kind) || !str(e.text, 300)) return { ok: false, why: 'bundle: an event' };
  if (b.picture !== null && !picture(b.picture)) return { ok: false, why: 'bundle: the picture must be a JPEG or PNG' };
  return { ok: true, bundle: { v: 1, at: new Date(b.at).toISOString(), page: { path: redact(b.page.path, 300), w: b.page.w, h: b.page.h },
    events: b.events.filter((e: any) => e.at >= Date.parse(b.at) - WINDOW_MS).map((e: any) => ({ at: e.at, kind: e.kind, text: redact(e.text) })), picture: b.picture } };
}
// data:image/jpeg|png;base64,… whose bytes start as that format does, decoded within the cap
function picture(p: any) {
  const m = typeof p === 'string' && p.length < BODY_MAX && /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(p);
  if (!m) return false;
  const bytes = Buffer.from(m[2], 'base64');
  return bytes.length > 64 && bytes.length < BODY_MAX && MAGIC[m[1]].every((x, i) => bytes[i] === x);
}

// ---- storage: with the conversation (deleting it deletes this, ON DELETE CASCADE) and with its `bug` case
export function store(conversation: number, caseId: number, bundle: Bundle) {
  db.prepare('insert into diagnostics (conversation, case_id, created, bundle) values (?, ?, ?, ?)').run(conversation, caseId, now(), JSON.stringify(bundle));
}
export const of = (caseId: number) => { const r = db.prepare('select bundle from diagnostics where case_id = ?').get(caseId) as any; return r ? JSON.parse(r.bundle) as Bundle : null; };

// HQ said these bugs are fixed (its state's `fixed: ['H-1234', …]`): their cases go now, the summary with them, and
// their bundles with those (ON DELETE CASCADE)
export function fixed(refs: unknown) {
  const del = db.prepare("delete from cases where id = ? and kind = 'bug'");
  return byRef(refs, id => del.run(id).changes);
}

// "Send it": a `bug` case for HQ's Care app (the problem in the helper's sentence, redacted) and the bundle with it, in one go.
// Only what the consent card names goes: no reply address and no orders (the card speaks of a picture and a log), and
// the conversation's email to a person, if one went, only as its case reference. Returns the case's reference.
export function file(o: { app: string; conversation: number; lang: string; problem: string; handed?: string; bundle: Bundle }) {
  db.exec('begin');
  try {
    const id = Number(db.prepare('insert into cases (app, conversation, kind, email, checked, words, summary, facts, lang, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.app, o.conversation, 'bug', null, 'none', '', redact(o.problem, 300) || null, JSON.stringify(o.handed ? { person_case: o.handed } : {}), o.lang, now()).lastInsertRowid);
    store(o.conversation, id, o.bundle);
    db.exec('commit');
    return `H-${1000 + id}`;
  } catch (err) { db.exec('rollback'); throw err; }
}

// The consent card, from templates: "See what we'd send" happens in the browser and needs no action; "Send
// it" and "No thanks" are actions like every card's, and none of the three is primary (equal weight).
export const card = (lang: Lang): Widget => ({ type: 'consent', title: t('snap_title', lang), text: t('snap_text', lang), fine: t('snap_fine', lang),
  see: t('snap_see', lang), options: [{ kind: 'snap_send', label: t('snap_send', lang) }, { kind: 'snap_no', label: t('snap_no', lang) }] });
