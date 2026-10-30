// The voices the board's calls recognise by name: each person's voiceprint (a speaker model's numbers, never a
// recording), saved on a call with their own words agreeing, refined when a later call hears them, and deleted when
// they say so on a call or the board taps it away. Biometric data: it stays in HQ's database, reaches only the voice
// line and never a log, and the board's list shows names and dates only.
import { columnsOf, db, inOneStep, once } from './db.ts';
import { brand, companyFormats } from './company.ts';
import { createRequest, endRequest } from './jobs.ts';

// id: the voice line names a voice by it when a later call hears it, never reused (autoincrement), so a refinement
// for a voice deleted or enrolled again meanwhile lands on no one's. name: as the call said it, one per name in any
// case. print: JSON numbers, normalised. pieces: the speech pieces it's made of. consent: the person's own words
// agreeing, asked: the agent's question as it said it (the proof of consent, art. 7(1), kept with the print and deleted
// with it, not left to the call's transcript). call: the calls row it was enrolled on. enrolled_at, heard_at: ms.
// kept_at: ms, when the board last kept it on its yearly card; card, asked_at: that card while it's on the desk phone, and
// when it was filed (yearly()).
db.exec(`create table if not exists voiceprints (id integer primary key autoincrement, name text not null unique collate nocase,
  print text not null, pieces integer not null, consent text not null, asked text not null, call integer, enrolled_at integer,
  heard_at integer, kept_at integer, card integer, asked_at integer)`);
once('voiceprints-yearly-card', () => {
  const columns = columnsOf('voiceprints');
  for (const column of ['kept_at integer', 'card integer', 'asked_at integer'])
    if (!columns.includes(column.split(' ')[0])) db.exec(`alter table voiceprints add column ${column}`);
});

// TitaNet-Large's embedding size, the voice line's speaker model
const PRINT_SIZE = 192;
const NAME_MAX = 40,
  CONSENT_MAX = 600,
  ASKED_MAX = 1500;

type Row = {
  id: number;
  name: string;
  print: string;
  pieces: number;
  call: number | null;
  enrolled_at: number;
  heard_at: number | null;
};

// GET /api/voice/voiceprints: every saved voice for the voice line to match (pieces: its weight in a refinement), and
// what to tell a person before enrolling: the company's own words (brand.yaml voiceprints.consent), or null, and the
// line saves no voice
export function listForVoice() {
  const rows = db.prepare('select id, name, print, pieces from voiceprints order by id').all() as Row[];
  const consent = brand().voiceprints?.consent;
  return {
    voices: rows.map(r => ({ id: r.id, name: r.name, print: JSON.parse(r.print) as number[], pieces: r.pieces })),
    consent: typeof consent === 'string' && consent.trim() ? consent : null,
  };
}

// POST /api/voice/voiceprint {name, print, pieces, consent, asked, call}: a voice enrolled on a call. A name already saved is
// enrolled again, under a new id, so a refinement of the old print still on its way is dropped (heard).
export function saveVoiceprint(b: Record<string, unknown>) {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > NAME_MAX || /[\r\n]/.test(name)) return `name: one line of 1 to ${NAME_MAX} characters`;
  const wrong = printProblem(b.print) ?? piecesProblem(b.pieces);
  if (wrong) return wrong;
  const consent = typeof b.consent === 'string' ? b.consent.trim() : '';
  if (!consent || consent.length > CONSENT_MAX)
    return `consent: the person's own words agreeing, 1 to ${CONSENT_MAX} characters`;
  const asked = typeof b.asked === 'string' ? b.asked.trim() : '';
  if (!asked || asked.length > ASKED_MAX)
    return `asked: the agent's question as it said it, 1 to ${ASKED_MAX} characters`;
  const call = Number(b.call) > 0 && Number.isInteger(Number(b.call)) ? Number(b.call) : null;
  const id = inOneStep(() => {
    settle(
      db.prepare('delete from voiceprints where name = ? returning card').get(name),
      'it was saved again on a call',
    );
    return Number(
      db
        .prepare(
          'insert into voiceprints (name, print, pieces, consent, asked, call, enrolled_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(name, JSON.stringify(b.print), b.pieces as number, consent, asked, call, Date.now()).lastInsertRowid,
    );
  });
  console.log(`voiceprint ${id}: enrolled on a call`);
  return { id };
}

// POST /api/voice/voiceprints-heard {heard: [{id, print, pieces}]}: voices a later call heard surely, refined. A voice
// deleted meanwhile stays deleted.
export function heardVoiceprints(b: Record<string, unknown>) {
  if (!Array.isArray(b.heard)) return 'heard: a list of { id, print, pieces }';
  for (const h of b.heard) {
    const wrong = !Number.isInteger(h?.id)
      ? 'heard: each with its voice id'
      : (printProblem(h.print) ?? piecesProblem(h.pieces));
    if (wrong) return wrong;
  }
  const now = Date.now(),
    refine = db.prepare('update voiceprints set print = ?, pieces = ?, heard_at = ?, card = null where id = ?');
  inOneStep(() => {
    for (const h of b.heard as { id: number; print: number[]; pieces: number }[]) {
      settle(
        db.prepare('select card from voiceprints where id = ?').get(h.id),
        'a call heard this voice since: it stays',
      );
      refine.run(JSON.stringify(h.print), h.pieces, now, h.id);
    }
  });
  return { ok: true };
}

// POST /api/voice/voiceprint-forget {name}: someone said "forget my voice" on a call
export function forgetVoiceprint(name: unknown) {
  const gone = db
    .prepare('delete from voiceprints where name = ? returning id, card')
    .get(String(name ?? '').trim()) as { id: number; card: number | null } | undefined;
  settle(gone, 'it was deleted on a call');
  if (gone) console.log(`voiceprint ${gone.id}: forgotten on a call`);
  return { forgot: !!gone };
}

// GET /api/voiceprints: the board's list in Settings › Voices, newest first: names and dates, never a print or consent
export const listVoiceprints = () =>
  (
    db
      .prepare('select id, name, call, enrolled_at, heard_at from voiceprints order by enrolled_at desc, id desc')
      .all() as Row[]
  ).map(r => ({ id: r.id, name: r.name, enrolledAt: r.enrolled_at, heardAt: r.heard_at, call: r.call }));

// POST /api/voiceprints/delete {id}: the board's tap
export function deleteVoiceprint(id: number) {
  const gone = db.prepare('delete from voiceprints where id = ? returning card').get(id);
  if (!gone) return 404;
  settle(gone, 'it was deleted in Settings');
  console.log(`voiceprint ${id}: deleted by the board`);
  return { ok: true };
}

// The yearly card (Vera's rule, art. 5(1)(e), which brand.yaml's consent words promise): a voice no call has heard for a
// YEAR_MS, since it was saved or last kept, brings the board a card to keep it another year or delete it, one card for
// each such voice. Unanswered LAPSE_MS, it's deleted, as the card says from the start. Never deleted without that card.
// The coordinator runs this daily (server.ts).
const DAY_MS = 24 * 3600_000,
  YEAR_MS = 365 * DAY_MS,
  LAPSE_MS = 30 * DAY_MS;
const KEEP = 'Keep it another year',
  DELETE = 'Delete it';
export function yearly(now = Date.now()) {
  const due = db
    .prepare(
      `select id, name, enrolled_at, heard_at from voiceprints
      where card is null and max(coalesce(enrolled_at, 0), coalesce(heard_at, 0), coalesce(kept_at, 0)) <= ?`,
    )
    .all(now - YEAR_MS) as Row[];
  for (const v of due) {
    const card = createRequest({
      kind: 'decision',
      urgency: 'whenever',
      title: `Keep ${v.name}'s saved voice?`,
      body: cardText(v, now),
      questions: [{ title: `${v.name}'s voiceprint`, options: [KEEP, DELETE] }],
    });
    if (typeof card === 'number') console.error(`voiceprint ${v.id}: its yearly card was refused (${card})`);
    else db.prepare('update voiceprints set card = ?, asked_at = ? where id = ?').run(card.id, now, v.id);
  }
  const lapsed = db
    .prepare(`select id, card from voiceprints where card is not null and asked_at <= ?`)
    .all(now - LAPSE_MS) as { id: number; card: number }[];
  for (const v of lapsed) {
    db.prepare('delete from voiceprints where id = ?').run(v.id);
    settle(v, 'unanswered for 30 days, it was deleted, as the card said');
    console.log(`voiceprint ${v.id}: deleted, its yearly card unanswered`);
  }
}

function cardText(v: Row, now: number) {
  const f = companyFormats(),
    day = (ms: number) => f.day(f.dayAt(ms), 'en', { year: true });
  const last = v.heard_at
    ? `no call has heard it since ${day(v.heard_at)}`
    : `no call has heard it since it was saved on ${day(v.enrolled_at)}`;
  return `A voiceprint the calls recognise ${v.name} by: ${last}. Unanswered, it's deleted on ${day(now + LAPSE_MS)}.`;
}

// The board's answer on a yearly card (jobs.ts answerRequest): keep it another year, or delete it. False: not such a card.
export function settleYearlyCard(card: number) {
  const v = db.prepare('select id from voiceprints where card = ?').get(card) as { id: number } | undefined;
  if (!v) return false;
  const asked = db.prepare('select questions from requests where id = ?').get(card) as { questions: string | null };
  if ((JSON.parse(asked.questions ?? '[]') as { answer?: string }[])[0]?.answer === DELETE) {
    db.prepare('delete from voiceprints where id = ?').run(v.id);
    console.log(`voiceprint ${v.id}: deleted on its yearly card`);
  } else db.prepare('update voiceprints set kept_at = ?, card = null where id = ?').run(Date.now(), v.id);
  return true;
}

// A voice gone or heard while its yearly card is on the desk phone: the card leaves it, saying why
function settle(v: unknown, why: string) {
  const card = (v as { card?: number | null } | undefined)?.card;
  if (card) endRequest(card, `No longer asked: ${why}.`);
}

const printProblem = (print: unknown) =>
  Array.isArray(print) && print.length === PRINT_SIZE && print.every(x => typeof x === 'number' && Number.isFinite(x))
    ? undefined
    : `print: ${PRINT_SIZE} finite numbers`;
const piecesProblem = (pieces: unknown) =>
  Number.isInteger(pieces) && (pieces as number) > 0 ? undefined : 'pieces: a positive whole number';
