// The book's sheets going out (booknotes.ts has the sheets and their notes): Send takes effect SEND_MS later, Undo
// before then takes it back. Then the sheet goes to its owner as one task, the notes in its brief, or, nobody's, to the
// CEO's routing check as review notes do (routing.ts). Each note is kept as a sent note on HQ too (feedback.ts
// fromBook): Reviews lists it, and the job it went to reads it and its snip with hq note. A sent sheet is the board's
// word (jobs.ts BOARD_CALL), so paced seats take it. It stays in the day, sent.
import { db, inOneStep } from '../db.ts';
import { ORIGIN } from '../config.ts';
import { publish } from '../events.ts';
import { ceo } from '../company.ts';
import { createJob, NoSeat } from '../jobs.ts';
import * as feedback from '../feedback.ts';
import * as routing from '../routing.ts';
import { BOARD, row as pageRow } from './book.ts';
import { isRefused, type Anchor, type Refused } from '../pagechecks.ts';
import { SEND_MS, count, note, notesOf, renumber, sheetOf, sheetRow, type Note, type Sheet } from './booknotes.ts';
import * as booksend from './booksend.ts';
import { linksOf, setLink, withLinks } from './booklinks.ts';
import { outsideBrief, outsidersOn } from './bookguests.ts'; // (invited people's notes on the board's sheet)
import { listedOnce } from './bookslips.ts';
import * as writing from './bookwriting.ts';
import { withPicks } from './bookpick.ts';

// GET /api/book/sheets: the open sheets (and those in their seconds to undo), then the latest SENT_LISTED sent, each
// with its notes and their slips (the artifacts their slips name listed once for them all)
const SENT_LISTED = 30;
export function sheets(who = BOARD) {
  deliverDue();
  const open = db
    .prepare("select id from book_sheets where who = ? and status in ('open', 'sending') order by id")
    .all(who) as {
    id: number;
  }[];
  const sent = db
    .prepare("select id from book_sheets where who = ? and status = 'sent' order by id desc limit ?")
    .all(who, SENT_LISTED) as { id: number }[];
  const listed = listedOnce();
  return {
    open: open.map(s => sheetOf(s.id, listed)),
    sent: sent.map(s => sheetOf(s.id, listed)),
  };
}
// GET /api/book/calls?pages=<id,id>: the sheets of these call pages' notes, never sent (bookcalls.ts), for the book to
// show them on the pages it has open, however old the call.
export function callSheets(pages: unknown, who = BOARD) {
  const ids = typeof pages === 'string' ? pages.split(',').map(Number) : [];
  if (!ids.length || !ids.every(id => Number.isInteger(id) && id > 0))
    return [400, 'pages is the call pages, by id, with commas'] as Refused;
  const calls = db
    .prepare(
      `select distinct s.id from book_sheets s join book_notes n on n.sheet = s.id
      where s.who = ? and s.status = 'call' and n.page in (select value from json_each(?)) order by s.id`,
    )
    .all(who, JSON.stringify(ids)) as { id: number }[];
  const listed = listedOnce();
  return { calls: calls.map(s => sheetOf(s.id, listed)) };
}
// POST /api/book/send { id, spots? }: the sheet goes in SEND_MS, unless it's undone first. spots: where the notes lie
// on the pages showing its notes, so the board's writing there goes beside the nearest (bookwriting.ts.)
export function send(id: number, who = BOARD, at?: unknown) {
  const s = sheetRow(id, who);
  if (!s || s.status === 'sent') return 404;
  if (s.status === 'call') return [409, "a call's notes stay on its page: the agent on the call heard them"] as Refused;
  if (!count(s.id)) return [409, 'nothing on this sheet to send'] as Refused;
  const spots = writing.spotsOf(
    at,
    id => {
      const n = note(id);
      return !!n && !!sheetRow(n.sheet, who);
    },
    page => pageRow(page, who),
  );
  if (isRefused(spots)) return spots;
  if (s.status === 'open') {
    db.prepare("update book_sheets set status = 'sending', send_at = ? where id = ?").run(Date.now() + SEND_MS, s.id);
    writing.keepSpots(s.id, spots);
  }
  deliverLater();
  return sheetOf(s.id);
}
// POST /api/book/page/send { id, to }: a free page sent on its own (booksend.ts), delivered as a sheet's send is.
export async function sendPage(b: any, who = BOARD) {
  const sent = await booksend.sendPage(b, who);
  if (typeof sent === 'object' && !Array.isArray(sent)) deliverLater();
  return sent;
}
// POST /api/book/undo { id }: a send taken back within its seconds; the sheet is open again (a page sent on its own:
// booksend.ts undoPage; a notebook page's: notebooksend.ts undoSend.)
export function undo(id: number, who = BOARD) {
  const s = sheetRow(id, who);
  if (!s) return 404;
  if (s.page) return booksend.undoPage(s);
  if (s.notebook_page) return [409, "a notebook page's send is undone on its page"] as Refused;
  if (s.status === 'sending' && s.send_at! > Date.now()) {
    db.prepare("update book_sheets set status = 'open', send_at = null where id = ? and status = 'sending'").run(s.id);
    writing.dropSpots(s.id);
    // (past its seconds, its writing still being read)
  } else if (s.status === 'sending') return [409, 'too late to undo: the sheet is on its way'] as Refused;
  else if (s.status !== 'open') return [409, 'too late to undo: the sheet has gone'] as Refused;
  return sheetOf(s.id);
}
// A send's own timer, just past its seconds
const deliverLater = () => setTimeout(deliverDue, SEND_MS + 50).unref();
// Every send whose seconds are over goes now: at a send's own timer, at the server's start (one cut off by a restart),
// and before the sheets are read. The board's writing beside its notes is read first: it goes as soon as it's read
// (bookwriting.ts.)
export function deliverDue(now = Date.now()) {
  const due = db.prepare("select id from book_sheets where status = 'sending' and send_at <= ?").all(now) as {
    id: number;
  }[];
  for (const s of due)
    writing.readThenGo(s.id, wrote => {
      try {
        inOneStep(() => deliver(s.id, wrote));
      } catch (err) {
        // (it stays sending, tried again at the next read or start: never thrown from a send's timer)
        console.error(`Sheet #${s.id}: not delivered:`, err);
      }
    });
}
// What hears a sheet go, with the job it went as (a call's notes page: its asks' items, callnotes.ts)
const went: ((sheet: number, job: number) => void)[] = [];
export const onDelivered = (hear: (sheet: number, job: number) => void) => void went.push(hear);
function deliver(id: number, wrote: writing.Writing[]) {
  const s = db.prepare("select * from book_sheets where id = ? and status = 'sending'").get(id) as Sheet | undefined;
  if (!s) return;
  const tapped = new Date(s.send_at! - SEND_MS).toISOString(),
    late = notesOf(s.id).filter(n => n.created > tapped),
    notes = notesOf(s.id).filter(n => n.created <= tapped);
  if (!notes.length) writing.dropSpots(s.id);
  if (!notes.length && late.length) return void reopen(s);
  if (!notes.length) return void db.prepare('delete from book_sheets where id = ?').run(s.id);
  const kept = notes.map(n => keep(n, null)),
    // (writing beside a note wiped while it was read has no note to go under: it stays on the page, unsent)
    beside = wrote.filter(w => notes.some(n => n.id === w.note));
  const job = jobFor(s, notes, kept, beside);
  for (const k of kept) feedback.fromBook(k.from, job);
  writing.went(s.id, beside);
  db.prepare("update book_sheets set status = 'sent', sent = ?, job = ?, send_at = null where id = ?").run(
    new Date().toISOString(),
    job,
    s.id,
  );
  stayBehind(s, late);
  for (const hear of went) hear(s.id, job);
  db.prepare("update book_notes set status = 'sent' where sheet = ? and status = 'open'").run(s.id);
  publish({
    type: 'log',
    agent: s.owner ?? ceo(),
    text: `The board sent a sheet of ${notes.length} note${notes.length === 1 ? '' : 's'} from its book: job #${job}`,
  });
  // (every HQ open reads its book again now.)
  publish({ type: 'book', agent: s.owner ?? ceo(), text: 'sent' });
}
// The sheet's one task for its owner, or the CEO's routing check for a sheet nobody owns (and one that can't run on
// any seat, which the check passes on: jobs.ts NoSeat). A sheet or a page sent to the CEO goes to the check too, its
// notes the CEO's own there: the CEO hands them to whoever makes it (hq job --notes), and that job answers them. Returns
// its job. (the CEO's)
// (wrote: the board's writing beside the notes on the sheet, quoted under each.)
function jobFor(s: Sheet, notes: Note[], kept: ReturnType<typeof keep>[], wrote: writing.Writing[]) {
  // (and the version the board picked on a note, with its patch: bookpick.ts.)
  const texts = writing.withWriting(notes, withPicks(notes, withLinks(notes, kept)), wrote);
  const outsiders = outsidersOn(notes); // (invited people's notes on it, outside text: bookguests.ts)
  if (s.owner && s.owner !== ceo())
    try {
      const place = placeOf(notes);
      return createJob({
        agent: s.owner,
        ...(s.page
          ? booksend.pageTask(s.page, place, texts[0])
          : {
              title: `The board's notes on ${place}`.slice(0, 200),
              prompt: taskBrief(texts, outsiders, onPreviews(notes)),
            }),
        customers: outsiders.length > 0,
      }).id;
    } catch (err) {
      if (!(err instanceof NoSeat)) throw err;
    }
  // (each note as its own page's: the product or HQ it was made on, and that product's return it comes back as; a page
  // sent on its own named by its number in the book.)
  return routing.queue(
    kept.map((k, i) => {
      const routed = feedback.routedFromBook(k.id);
      return {
        ...routed,
        owner: s.owner ?? routed.owner,
        place: s.page ? `${placeOf(notes)} in the board's book` : routed.place,
        text: `${texts[i]}\n${fromTheBook(k.id, s.page)}`,
      };
    }),
  );
}
// What a routed note says of the book, for the job it goes to (the check's prompt quotes it as data): its answer clips
// onto it there, and a page sent on its own is read whole.
const fromTheBook = (id: number, page: number | null) =>
  `From the board's book: the job it goes to clips its answer onto it there with \`hq answer ${id} "..."\`\
${page ? `; it is page #${page} as the board drew it, which \`hq sketch ${page}\` reads` : ''}.`;
// Where the notes were made, as the task's title names it: each address a note was made on (an owner's sheet page holds
// a day's notes from any of their pages), or a free page's number and label
const placeOf = (notes: Note[]) =>
  [
    ...new Set(
      notes.map(n => {
        const p = pageRow(n.page, null)!;
        return p.url
          ? addressOf((JSON.parse(n.anchor) as Anchor).url)
          : `page #${p.id}${p.label ? ` “${p.label}”` : ''}`;
      }),
    ),
  ].join(', ');
// A note's page as a title names it: an HQ page by its path and query, a preview's whole, its fragment left out
const addressOf = (url: string) => {
  const u = new URL(url, ORIGIN);
  return `${u.origin === new URL(ORIGIN).origin ? '' : u.origin}${u.pathname}${u.search}`;
};
// Whether some of the notes were made on a page off HQ's own: a product's preview, in review mode
const onPreviews = (notes: Note[]) =>
  notes.some(n => new URL((JSON.parse(n.anchor) as Anchor).url, ORIGIN).origin !== new URL(ORIGIN).origin);
// A note as a sent note on HQ (feedback.ts fromBook), its id there kept on it: { id, text, from }: from, to give it to
// its job once there is one
export function keep(n: Note, job: number | null) {
  const a = JSON.parse(n.anchor) as Anchor;
  // (by: an invited person's note is kept as theirs, an outside reviewer's.)
  // (video: a film's moment.)
  const from = {
    url: a.url,
    words: n.words,
    el: a.el,
    view: a.view,
    video: a.video,
    snip: n.snip,
    review: n.review,
    by: n.by,
  };
  const kept = feedback.fromBook(from, job);
  db.prepare('update book_notes set review = ? where id = ?').run(kept.id, n.id);
  return { ...kept, from: { ...from, review: kept.id } };
}
// (outsiders: invited people some of the notes are from; previews: whether some were typed on a product's preview,
// whose own code could have written one: routing.ts provenance; --artifact; "A question for the board about a note is a
// card", hq ask --note)
const taskBrief = (
  texts: string[],
  outsiders: string[],
  previews: boolean,
) => `The board wrote ${texts.length === 1 ? 'a note' : `${texts.length} notes`} on your work in \
its book (the Pencil on HQ's pages) and sent ${texts.length === 1 ? 'it' : 'them'} to you as one sheet: ${texts.length === 1 ? 'it is' : 'they are'} \
yours to take on, as one piece of work. \`hq note <id>\` saves a note's snip (the page around the mark, the ink on it) \
as a picture to look at.

When a note is done or answered, clip your answer onto it: \`hq answer <id> "what you did, or the answer"\` (plain \
words for the board, a sentence or two; \`--picture <file>\` or \`--link <preview url>\` to show it, \`--artifact <id>\` \
for something new that runs, an app or a page, by its id in HQ's artifacts). The board ticks it, or writes a reply under \
it, which comes back to you as a new note.
A question for the board about a note is a card, never an answer that ends in a question: \`hq ask ... --note <id>\` \
clips it under the note in the book, and on its desk phone; one answer closes both.
${outsideBrief(outsiders)}${previews ? `\n${routing.provenance('Each note on a preview (a page off HQ)')}\n` : ''}
${texts.join('\n\n')}`;

// A sheet goes as the board saw it when it tapped the plane: a note that joined it in its seconds to undo (a product
// page's script can post one, a guest can write one) stays behind, on a new open sheet for the same owner (made once
// the sent one is sent: an owner has one unsent sheet), numbered from 1 there.
// A late note keeps its links to the other late notes only: one to a note that went would point off its new sheet.
function stayBehind(s: Sheet, late: Note[]) {
  if (!late.length) return;
  const next = db
    .prepare('insert into book_sheets (who, owner, created) values (?, ?, ?)')
    .run(s.who, s.owner, new Date().toISOString()).lastInsertRowid;
  const moving = new Set(late.map(n => n.id));
  late.forEach((n, i) => {
    db.prepare('update book_notes set sheet = ?, n = ? where id = ?').run(next, i + 1, n.id);
    for (const other of linksOf(n.id)) if (!moving.has(other)) setLink(n.id, other, false);
  });
}
// ...and a sheet whose every note came in its seconds goes nowhere: it's open again with them
function reopen(s: Sheet) {
  db.prepare("update book_sheets set status = 'open', send_at = null where id = ?").run(s.id);
  renumber(s.id);
}

// (a send cut off by a restart goes as the server starts, once every module is in)
setImmediate(() => deliverDue());
