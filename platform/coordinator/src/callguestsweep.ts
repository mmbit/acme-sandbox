// A guest's part of the board's call (callguests.ts: whoever scanned its code) goes 12 months after the call ended, as
// the door tells them (the note: knowledge/notes/compliance/walk-through-calls.md, "How long a guest's part of the
// board's call is kept"). Once a day, for each call over that long ago:
//   - each line of theirs in the transcript (their words, their screen's lines, their marks' lines) keeps its place but
//     says only that it went (GONE), so the lines' times and the ranges the call's items name still fit; their name
//     anywhere else in it becomes 'Guest'. The search index reads the transcript again on its next pass (memory.ts).
//   - the call's items (ledger.ts) alike: their verbatim quote line by line (a guest's words in it go, labelled or
//     not, numbered or not), their name in its what, goal, why and said. An item is the call's own record, kept with it
//     and quoted again into each new brief, review and follow-through check that carries it
//   - their marks on the call's notes page stay, drawn on the board's page, their pen in its colour named 'Guest'.
//   - their scan and its place among the call's guests go.
// Not swept: a job's report or brief that quotes them, nor the call's notes sent to the board (the note). The board's
// calls themselves are kept for good.
import { db } from './db.ts';
import { findAgent } from './jobs.ts';
import { HOUR } from './callouts.ts';
import { KEPT_MS } from './callsweep.ts';

const GUEST = 'Guest',
  WENT = '(deleted 12 months after the call)',
  GONE = `${GUEST}: ${WENT}`;

type Scan = { id: number; call: number; name: string; pen: number };
type Item = { id: number; what: string; goal: string | null; quote: string; why: string | null; said: string | null };

// The guests of calls that ended more than KEPT_MS ago (a call that was forgotten, its row gone, by when they joined).
// → the calls swept.
export function sweep(at = Date.now()) {
  const before = new Date(at - KEPT_MS).toISOString();
  const scans = db
    .prepare(
      `select s.id, s.call, s.name, s.pen from call_scans s left join calls c on c.id = s.call
        where s.added < ? and (c.id is null or (c.status != 'live' and c.ts < ?))`,
    )
    .all(before, before) as Scan[];
  const calls = Map.groupBy(scans, s => s.call);
  for (const [call, theirs] of calls) forget(call, theirs);
  return [...calls.keys()];
}
export function startSweep() {
  const run = () => {
    try {
      sweep();
    } catch (err) {
      console.error("Could not sweep the board's calls' guests:", err);
    }
  };
  run();
  return setInterval(run, 24 * HOUR).unref();
}

// One call's guests, all at once
function forget(call: number, scans: Scan[]) {
  const row = db.prepare('select agent, lines from calls where id = ?').get(call) as
    { agent: string; lines: string } | undefined;
  // (who speaks on the call and stays: the board, and the agent by the name its lines carry, as callguests.ts shows it)
  const staying = ['Board', ...(row ? [findAgent(row.agent)?.name ?? row.agent] : [])];
  const shown = scans.map(s => s.name),
    named = mentions(shown, staying);
  const lines = row ? (JSON.parse(row.lines) as string[]) : [];
  // What they said (each line of theirs after its name) and what the others said, for the items' quotes
  const said = { theirs: [] as string[], others: [] as string[] };
  for (const l of lines) {
    const who = speakerOf(l, shown);
    if (who) said.theirs.push(plain(l.slice(who.length + 2)));
    else said.others.push(plain(l));
  }
  db.exec('begin');
  try {
    if (row) {
      const scrubbedLines = lines.map(l => (speakerOf(l, shown) ? GONE : scrubbed(l, named)));
      db.prepare('update calls set lines = ? where id = ?').run(JSON.stringify(scrubbedLines), call);
    }
    const items = db
      .prepare('select id, what, goal, quote, why, said from call_items where call = ?')
      .all(call) as Item[];
    for (const i of items)
      db.prepare('update call_items set what = ?, goal = ?, quote = ?, why = ?, said = ? where id = ?').run(
        scrubbed(i.what, named),
        i.goal && scrubbed(i.goal, named),
        i.quote
          .split('\n')
          .map(l => quoteLine(l, shown, named, said))
          .join('\n'),
        i.why && scrubbed(i.why, named),
        i.said && scrubbed(i.said, named),
        i.id,
      );
    for (const s of scans) {
      db.prepare('update sketch_guests set guest = ? where id = ?').run(GUEST, s.pen);
      db.prepare('delete from call_guests where call = ? and guest = ?').run(call, `scan:${s.id}`);
      db.prepare('delete from call_scans where id = ?').run(s.id);
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}
// The guest a line is by: it starts with the name the page showed them by ('Board 2' for one who typed 'Board': never
// the board's own 'Board: ' lines, nor the agent's)
const speakerOf = (line: string, shown: string[]) => shown.find(n => line.startsWith(`${n}: `));
// The forms of their names that stand for them in another's line, longest first across all of them: as the page showed
// it ('Esmee 2'), as they typed it ('Esmee'), and of a name in parts its first and last with what joins them to the rest
// ('Esmee', 'Vries', 'de Vries' of 'Esmee de Vries'). A part between stays when alone ('de', 'Maria' of 'Anna Maria
// Smit'): on its own it isn't them, and as 'de' or 'van' it would rewrite the board's every sentence. A form someone who
// stays goes by is not theirs (the board's 'Board', the agent's name: a guest who typed it was shown as 'Board 2'), so
// the board's and the agent's names stay where they're said; another guest's go too, as the call's guests go together.
function mentions(shown: string[], staying: string[]) {
  const others = new Set(staying.map(n => n.toLowerCase()));
  const forms = shown.flatMap(n => {
    const parts = n.replace(/ \d+$/, '').split(' ');
    return [n, ...parts.flatMap((_, i) => [parts.slice(0, i + 1).join(' '), parts.slice(i).join(' ')])];
  });
  return [...new Set(forms)].filter(f => !others.has(f.toLowerCase())).sort((a, b) => b.length - a.length);
}
// Another's line without their name
const scrubbed = (line: string, names: string[]) => names.reduce((l, n) => l.replace(wordOf(n), GUEST), line);
// (a name as a whole word in any case, 'ESMEE' or 'esmee' for 'Esmee': a letter or digit either side makes it part of
// another word. A name that is also a word ('Will', 'Rose', or 'will' as typed) goes wherever it stands, the word too:
// 'I will send it' becomes 'I Guest send it'. Their privacy outweighs the line's wording, and a name can't be told from
// the word by its case, as a name typed in lower case shows.)
const wordOf = (name: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
// A line of an item's quote without them. Theirs (it starts with their name) says only that it went, as in the
// transcript. So does each sentence of it, or the whole line, that is their words: with their label, unless the
// others said that very sentence (the board asking 'Esmee: wil jij tekenen?'); without it, found in what they said and
// in nothing the others said (a quote the agent took from a line of theirs, all or part of it). The board's and the
// agent's words stay, also where a guest said the same; their name elsewhere becomes 'Guest'. A line copied with its
// number from the transcript as the agent reads it (ledger.ts transcript: '[3] esmee: …') keeps the number.
const NUMBER = /^\[\d+\] /;
function quoteLine(line: string, shown: string[], named: string[], said: { theirs: string[]; others: string[] }) {
  const numberPrefix = NUMBER.exec(line)?.[0] ?? '',
    rest = line.slice(numberPrefix.length);
  // (a number is the transcript's, unless it's part of a guest's name: '[1] Esmee'; not when the others said the line
  // under it: the board's '[1] Board: …' is theirs only for a guest named '[1] Board', and then it isn't the board's)
  if (speakerOf(line, shown) && !(numberPrefix && said.others.some(w => w.includes(plain(rest))))) return GONE;
  if (speakerOf(rest, shown)) return numberPrefix + GONE;
  const theirs = (sentence: string) => {
    const unnumbered = speakerOf(sentence, shown) ? sentence : sentence.replace(NUMBER, ''),
      who = speakerOf(unnumbered, shown);
    if (who) return !said.others.some(w => w.includes(plain(unnumbered)));
    const words = plain(unnumbered);
    return !!words && said.theirs.some(w => w.includes(words)) && !said.others.some(w => w.includes(words));
  };
  // (sentences at even places, the spaces between them at odd)
  const parts = rest.split(/(?<=[.!?…])(\s+)/);
  const went = parts.map((p, i) => i % 2 === 0 && theirs(p));
  if (parts.every((_, i) => i % 2 || went[i])) return numberPrefix + GONE;
  return numberPrefix + parts.map((p, i) => (went[i] ? WENT : i % 2 ? p : scrubbed(p, named))).join('');
}
// Words as compared: in lower case, single spaces, without the punctuation around them ('"…ik teken.' is 'ik teken')
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
