// The line to HQ's Care app: cases out as cards, each day's counts out, HQ's switches and asks back (docs/api.md)
import { db, now, byRef, caseRef } from './db.ts';
import { HQ_URL, HQ_TOKEN } from './config.ts';
import * as busy from './busy.ts';
import * as drafts from './drafts.ts';
import * as photos from './photos.ts';
import * as diagnostics from './diagnostics.ts';
import * as numbers from './numbers.ts';
import * as inbox from './inbox.ts';
import * as summaries from './summaries.ts';
import * as rights from './rights.ts';
import { chat } from './chat.ts';
import * as ledger from './ledger.ts';
import { settings } from './company.ts';
import { faultsFor } from './phonecall.ts';
import { heardBoardLang } from './texts.ts';

const EVERY_MS = 60_000;
const DAY_MS = 864e5;
let timer: any = null,
  running = false,
  again = false;
// HQ away for a moment: no answer, a 5xx from its gateway while a deploy restarts it, or its own 500 while its
// database stays locked. Nothing is lost: each step is tried again next run, so one failing that way is logged only
// once it has failed for longer than a deploy takes. Each step counts on its own, by its log line, so HQ's state
// answering doesn't hide a card that keeps failing.
const AWAY_MS = 10 * 60_000;
// A failed call to HQ. away: HQ didn't answer or answered a 5xx, so the next run tries again
class HqError extends Error {
  status: number | null;
  away: boolean;
  constructor(message: string, status: number | null, away: boolean) {
    super(message);
    this.name = 'HqError';
    this.status = status;
    this.away = away;
  }
}
// log line → when that step first failed with HQ away, in this run (awayNow) and up to the last one (awayBefore)
let awayNow = new Map<string, number>(),
  awayBefore = new Map<string, number>();
function logSyncFailure(t: number, err: any, line: string) {
  if (err instanceof HqError && err.away) {
    const since = awayNow.get(line) ?? awayBefore.get(line) ?? t;
    awayNow.set(line, since);
    if (t - since < AWAY_MS) return;
  }
  console.error(line, err?.message);
}

// HQ refused the card itself: a 4xx about this case won't change by asking again, so it stops after a day. Not 401, 403
// or 404: those are the line (the token, HQ's route not deployed yet), hit every case alike and heal with a fix, and
// stopping would lose emails to a person. Nor 408 or 429, HQ's own "later".
const refused = (status: unknown) =>
  typeof status === 'number' && status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);
// the draft's fields on a card: its text, its summary, and the draft in the board's language if it's in another
const draftFields = (c: any) => {
  const d = drafts.of(c);
  return {
    draft: d.draft ?? null,
    summary: d.summary ?? c.summary ?? null,
    ...(d.translation ? { translation: d.translation } : {}),
  };
};

// what a failed fetch says: the network's code (ECONNREFUSED) in its cause, else the error's name (TimeoutError)
const why = (err: any) => err?.cause?.code ?? err?.cause?.message ?? err?.name ?? 'error';
async function call(path: string, body?: any) {
  const res = await fetch(HQ_URL + path, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${HQ_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err: any) => {
    throw new HqError(`HQ didn't answer on ${path} (${why(err)})`, null, true);
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HqError(`HQ answered ${res.status} on ${path}`, res.status, res.status >= 500);
  }
  // any 2xx is taken: an empty one (204) too, which is null here; only HQ's state must have a body (below)
  const text = await res.text().catch((err: any) => {
    throw new HqError(`HQ's answer on ${path} broke off (${why(err)})`, null, true);
  });
  return (text ? JSON.parse(text) : null) as any;
}

// t: the time it runs at (the tests move it on; the timers leave it)
export async function sync(t = now()) {
  if (!HQ_URL || !HQ_TOKEN) return;
  // a case or a message that came in meanwhile goes in a run straight after
  if (running) {
    again = true;
    return;
  }
  running = true;
  awayBefore = awayNow;
  awayNow = new Map(); // a step that didn't fail away in a run starts counting afresh
  try {
    drafts.due(t); // a person case's draft is written as it's filed, and its card waits for it (drafts.ts ready())
    rights.due(t); // a data request still waiting for its reply address
    await sendCases(t);
    await photos.push(); // a claim's photos, once HQ has its card (photos.ts)
    await sendMore(t);
    await sendFollowUps(t);
    await sendNumbers(t);
    await sendInboxCards(t);
    await sendCreditWarning(t);
    await readState(t);
  } catch (err: any) {
    logSyncFailure(t, err, 'care: HQ sync:');
  } finally {
    running = false;
    if (again) {
      again = false;
      nudge();
    }
  }
}

// Each case on its own: one HQ refuses mustn't hold back every "Email a person" after it, and one refused for good is
// said once and kept here for a person to look up by its id. A fault noted on a call (phone.ts) stays beside its order
async function sendCases(t: number) {
  const cases = db
    .prepare(
      `select * from cases where sent_hq is null and held is null and kind != 'fault'
      and (failed is null or failed > ?) order by id limit 20`,
    )
    .all(t - DAY_MS) as any[];
  for (const c of cases) {
    if (!drafts.ready(c, t)) continue;
    try {
      // a question or a data request carries only its words, a claim its facts, a bug report its bundle (the picture
      // and the log, shown in HQ as text and a data: image): one whose conversation was deleted has nothing to send
      const lines = c.kind === 'person' ? chat(c.conversation, 0, true) : [];
      const bundle = c.kind === 'bug' ? diagnostics.of(c.id) : undefined;
      if (bundle === null) {
        db.prepare('delete from cases where id = ?').run(c.id);
        continue;
      }
      const d = draftFields(c);
      const r = await call('/api/care/cards', {
        kind: c.kind,
        app: c.app,
        case: caseRef(c.id),
        check: c.checked,
        to: c.email,
        lang: c.lang,
        words: c.words,
        facts: withFaults(JSON.parse(c.facts || '{}')),
        chat: lines,
        ...d,
        ...(bundle ? { bundle } : {}),
        ...(c.health ? { health: true } : {}),
      });
      // health_hq: what this card said, so a case marked while it went is told in a `more`. A data request's address
      // that came while it went (rights.ts release()) leaves it unsent, to go again with it
      db.prepare(
        `update cases set sent_hq = ?, hq_id = ?, chat_to = ?, draft_sent = ?, health_hq = ?, failed = null
        where id = ? and email is ?`,
      ).run(t, String(r?.id ?? ''), lines.at(-1)?.id ?? null, d.draft ? t : null, c.health ? t : null, c.id, c.email);
    } catch (err: any) {
      if (!refused(err?.status)) logSyncFailure(t, err, `care: HQ didn't take case ${caseRef(c.id)}:`);
      else if (c.failed == null) {
        db.prepare('update cases set failed = ? where id = ?').run(t, c.id);
        console.error(
          `care: HQ refused case ${caseRef(c.id)} (${err.status}): trying again for a day, then it stays here unsent`,
        );
      }
    }
  }
}

// What the customer wrote after their email to a person reached HQ, with the helper's answers between, as more on the
// same card: person: true once the helper handed them to a person again (person.ts again()), else lines it answered
// itself, which put no settled card back on the board's list. And a case that became a health case after HQ had it (a
// detail the helper took out, engine.ts dropNotes(); a new term, drafts.ts write()): HQ hears it once, `health: true`
// on a `more`, so its card drops an open ask and no AI redrafts it
async function sendMore(t: number) {
  const more = db
    .prepare(
      `select c.id, c.app, c.kind, c.conversation, c.chat_to, c.health, c.health_hq, c.asked
      from cases c where c.sent_hq is not null and ((c.health = 1 and c.health_hq is null)
      or (c.kind = 'person' and c.asked is not null) or (c.kind = 'person' and exists (select 1 from messages m
      where m.conversation = c.conversation and m.who = 'me' and m.text != ''
      and (m.health is null or m.health = 'person') and m.id > coalesce(c.chat_to, 0))))
      order by c.id limit 20`,
    )
    .all() as any[];
  const newest = db.prepare(`select max(id) as id from messages where conversation = ? and id > ?
    and text != '' and (health is null or health = 'person')`);
  for (const c of more) {
    try {
      const health = c.health === 1 && c.health_hq == null,
        person = c.kind === 'person'; // a question carries no chat
      // chat() leaves out a message nobody consented to send (an unmarked one that holds a term now): `upto` is the
      // newest row it read, so chat_to moves past those too, and a `more` with nothing left in it isn't posted
      const lines = person ? chat(c.conversation, c.chat_to ?? 0, true) : [];
      const upto = person ? (newest.get(c.conversation, c.chat_to ?? 0) as any).id : null;
      const asked = person && c.asked != null;
      const card = {
        kind: 'more',
        app: c.app,
        case: caseRef(c.id),
        chat: lines,
        ...(health ? { health: true } : {}),
        ...(person ? { person: asked } : {}),
      };
      if (lines.length || health || asked) await call('/api/care/cards', card);
      // (an ask that came while it went stays, for the next run)
      const chatTo = person ? Math.max(c.chat_to ?? 0, upto ?? 0, lines.at(-1)?.id ?? 0) : c.chat_to;
      db.prepare(
        `update cases set chat_to = ?, health_hq = coalesce(health_hq, ?),
        asked = case when asked is ? then null else asked end where id = ?`,
      ).run(chatTo, health ? t : null, c.asked, c.id);
    } catch (err: any) {
      logSyncFailure(t, err, `care: HQ didn't take more for case ${caseRef(c.id)}:`);
    }
  }
}

async function sendFollowUps(t: number) {
  // a draft that came after its card (the model was slow or down when the case was filed)
  const late = db
    .prepare(
      `select id, app, draft, summary from cases where sent_hq is not null and draft is not null
      and draft_sent is null order by id limit 20`,
    )
    .all() as any[];
  for (const c of late) {
    const card = { kind: 'draft', app: c.app, case: caseRef(c.id), ...draftFields(c) };
    await sendCard(t, `care: HQ didn't take the draft for case ${caseRef(c.id)}:`, card, () =>
      db.prepare('update cases set draft_sent = ? where id = ?').run(t, c.id),
    );
  }
  // a question answered by email from a knowledge entry (answers.ts): its card closes. 404 is also HQ's route not
  // deployed yet, so that one is asked again
  const answered = db
    .prepare(
      `select id from cases where answered is not null and answered_hq is null
      and sent_hq is not null order by id limit 20`,
    )
    .all() as any[];
  for (const c of answered) {
    const card = { kind: 'answered', case: caseRef(c.id) };
    await sendCard(t, `care: HQ didn't take the answer for case ${caseRef(c.id)}:`, card, () =>
      db.prepare('update cases set answered_hq = ? where id = ?').run(t, c.id),
    );
  }
  for (const x of drafts.finished()) {
    const card = { kind: 'draft', ...x }; // the board's "Ask for changes", redrafted
    await sendCard(t, `care: HQ didn't take redraft ${x.ask} for case ${x.case}:`, card, () => drafts.done(x.ask, t));
  }
}
// A card that follows its case's: done once HQ has it, or once HQ refuses it for good (the board takes it from there)
async function sendCard(t: number, line: string, card: any, done: () => void) {
  try {
    await call('/api/care/cards', card);
    done();
  } catch (err: any) {
    logSyncFailure(t, err, line);
    if (refused(err?.status)) done();
  }
}

// Each finished day's counts per app (the helper's measures), until HQ has them: one failure stops the rest till then
async function sendNumbers(t: number) {
  try {
    numbers.close(t);
  } catch (err: any) {
    console.error("care: closing the day's numbers:", err?.message);
  }
  for (const n of numbers.unsent()) {
    try {
      await call('/api/care/numbers', n);
      numbers.sent(n.app, n.day, t);
    } catch (err: any) {
      logSyncFailure(t, err, `care: HQ didn't take the numbers for ${n.app} on ${n.day}:`);
      if (!refused(err?.status)) break; // HQ down or its route not there yet: the days wait, in order
      // refused for good: it mustn't hold back the days after it (kept here; HQ can ask again)
      numbers.sent(n.app, n.day, t);
    }
  }
}

// HQ's own cards (inbox.ts): an email's draft, each want answered once
async function sendInboxCards(t: number) {
  for (const a of inbox.answers(t)) {
    await sendCard(t, `care: HQ didn't take the ${a.body.kind} for ${a.body.case}:`, a.body, () =>
      inbox.sent(a.want, t),
    );
  }
}

// The prepaid credit running low (ledger.ts creditWarning()): HQ files the board's card, once per step, in dollars
async function sendCreditWarning(t: number) {
  const warning = ledger.creditWarning(t);
  if (!warning) return;
  try {
    const { left, perDay, stopAt, renews } = warning; // renews: the plan's monthly credit's next one, or null
    await call('/api/care/credit', { helper: settings.helper, left, perDay, stopAt, renews });
    ledger.creditWarned(warning.steps, t);
  } catch (err: any) {
    logSyncFailure(t, err, "care: HQ didn't take the credit warning:");
  }
}

async function readState(t: number) {
  const s = await call('/api/care/state');
  if (!s) throw new Error('HQ sent an empty state'); // never read as "auto, nobody waiting"
  // the bugs HQ marked fixed: their cases go now, with the summary and the bundle (kept till then, 90 days at most)
  const gone = diagnostics.fixed(s?.fixed);
  if (gone) console.log(`care: ${gone} bug report(s) deleted: fixed`);
  // the cases the board deleted in HQ because the customer asked (the delete dialog's "email a person and ask", the
  // consent card's "ask us to delete it"): care's copy goes too, a bug report's bundle with it (ON DELETE CASCADE)
  const erased = erase(s?.erased);
  if (erased) console.log(`care: ${erased} case(s) deleted: the customer asked`);
  // whether a person's reply went, for the helper's facts (helper.ts) and its words (person.ts again())
  replies(s?.replies);
  heardBoardLang(s?.board); // before the drafts below, so they're written in it
  const queue = { waiting: Number(s?.queue?.waiting) || 0, oldest: s?.queue?.oldest ?? null };
  busy.set({ busy: ['on', 'off'].includes(s?.busy) ? s.busy : 'auto', queue });
  drafts.redraft(s?.redraft, t); // the board's "Ask for changes": each id once, posted above when it's written
  inbox.wanted(s?.drafts, t); // posted above in the next run, once written
  // the days Numbers asks for again: a finished one goes in the next run, today's as it stands now (partial)
  for (const n of numbers.again(s?.numbers, t))
    await call('/api/care/numbers', n).catch((err: any) =>
      logSyncFailure(t, err, `care: HQ didn't take today's numbers for ${n.app}:`),
    );
}

// The faults callers reported by phone for the orders a card is about (its `order`, or its `orders` as the chat checked
// them, and the numbers their customer was told for them), as one more fact: the
// person answering it sees that the customer told us in time
function withFaults(facts: any) {
  const orders = [
    facts?.order,
    ...(Array.isArray(facts?.orders) ? facts.orders : []),
    ...(Array.isArray(facts?.numbers) ? facts.numbers : []),
  ]
    .map(o => String(o ?? '').split(' ')[0])
    .filter(Boolean);
  const lines = [...new Set(orders)].flatMap(o => faultsFor(o).map(l => `${o}: ${l}`));
  return lines.length ? { ...facts, reported_by_phone: lines } : facts;
}

export function erase(refs: unknown) {
  const del = db.prepare('delete from cases where id = ?');
  return byRef(refs, id => del.run(id).changes);
}

// HQ's `replies`: when the board's last reply to each case went, and whether its card is done. HQ lists the cards
// changed in its last 30 days, and a case keeps what it heard last after that
export function replies(list: unknown) {
  if (!Array.isArray(list)) return 0;
  const put = db.prepare(
    'update cases set replied = ?, settled = ? where id = ? and (replied is not ? or settled is not ?)',
  );
  const of = new Map(list.map(r => [String(r?.case), r]));
  return byRef([...of.keys()], id => {
    const r = of.get(caseRef(id)),
      sent = Date.parse(r?.sent),
      replied = Number.isFinite(sent) ? sent : null,
      settled = r?.settled === true ? 1 : null;
    return put.run(replied, settled, id, replied, settled).changes;
  });
}

export const nudge = () => {
  sync().catch(() => {
    /* logged in sync */
  });
};
export function start() {
  if (!timer && HQ_URL) timer = setInterval(nudge, EVERY_MS);
  drafts.start(nudge);
  inbox.start(nudge);
  summaries.start();
  nudge();
}
