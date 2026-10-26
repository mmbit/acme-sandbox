// The board's conversation with the CEO over the intercom. It's one long-lived job whose session is resumed for
// each message, so the CEO remembers the conversation. The CEO's final message of each turn is the reply. What the board
// says while the CEO is still answering waits, and goes in the next turn. Every line is shown and kept as it is: a key's
// value is redacted where it's stored (db.ts).
import { db, once, setting, remember } from './db.ts';
import { publish } from './events.ts';
import { createJob, findAgent, preview, holdsCustomerData, handedCustomerData, holdsKeys, handedKeys, callSeat, workerQuiet } from './jobs.ts';   // (customer data; paused)
import { STANDING } from './jobcodes.ts';
import { ceo, roles, unstaffed } from './company.ts';
import * as pictures from './pictures.ts';
import { DEFAULT_ESTIMATE_SCALE } from '../../worker/src/estimating.ts';

// A calls row named c carries keys if it or any call it resumed concerns a credential card.
export function carriesKeys(call: number) {
  return !!db.prepare(`select 1 from calls c where c.id = ? and ${keysCondition()}`).get(call);
}
export function keysCondition() {
  return `exists (with recursive up(id) as (select c.id union select e.value from up join calls u on u.id = up.id, json_each(u.resumes) e)
    select 1 from up join calls uc on uc.id = up.id join requests ur on ur.id = uc.request where ur.kind = 'credential' or ur.secrets is not null)`;
}

// sent: 0 = waiting for the CEO, 2 = with the CEO (in a turn that hasn't answered yet), 1 = answered. A line only counts as
// heard once the CEO's turn ends done: a failed turn's lines go to the CEO again. 3 = goes with the next turn but starts none:
// the notes of a call the CEO's follow-up job already handled (callNotes()).
// (the chat table and its other columns are in db.ts)
// Old lines have no session id. Restrict later CEO replies conservatively, and all existing sessions that may remember
// them. A pending carrier without a call id cannot prove its notes are safe. New sessions hear only the masked recap.
once('2026-10-17-keys-chat-sessions', () => {
  db.exec("update chat set about_keys = 1 where who = 'call' and call is null and sent in (0, 2, 3)");
  const keyed = db.prepare(`select c.id, c.agent, j.result from calls c left join jobs j on j.id = c.job and j.kind = 'work' where ${keysCondition()}`)
    .all() as { id: number; agent: string; result: string | null }[];
  const mark = db.prepare("update chat set about_keys = 1 where (who = 'call' and call = ?) or (who = ? and text = ?)");
  for (const c of keyed) mark.run(c.id, c.agent, c.result?.trim() || null);
  db.exec(`update chat set about_keys = 1 where who in (select agent from jobs where kind = 'chat')
    and id >= (select min(id) from chat where about_keys = 1);
    update jobs set about_keys = 1 where kind = 'chat' and exists (select 1 from chat where about_keys = 1)`);
});

// The lines the CEO hears: the board's, those from outside the chat (call), and an invited person's (guest: fromGuest).
const HEARD = "('board', 'call', 'guest')";

// The CEO's lines are theirs by id (who), and shown by name
const ceoName = () => findAgent(ceo())?.name ?? 'the CEO';

// While the company has nobody but the CEO, the intercom is its onboarding: the board is new to it, and the CEO interviews
// it about the business (the company's own playbook), then founds the team.
const ONBOARDING = `
The company is new: you have no team yet, and this conversation is its onboarding. Follow company/playbooks/intake.md
from wherever the conversation is now.`;
// a time told on the intercom comes from hq when and goes on the work's thread as its window as it's queued (hq job --by:
// askwindow.ts.).
//
// Shifted work: the agreed deadlines' facts come with hq job, hq cancel and hq when (deadlines.ts), the judgment is the
// CEO's (call.ts says the same).
// A long reply hears so in its next turn (LONG_REPLY).
const brief = (fixer = roles().process) => `The board is talking with you over HQ's intercom: a chat, turn by turn, in this one session.
Your final message of each turn is exactly what the board sees, so make it your reply: conversational and plain.
Lead with the answer in one or two sentences; add at most three short bullets, only if they help. About 80 words or
fewer. Leave out what goes without saying (that HQ tells the board if a time slips, review steps), your process, and
job, pull request, item or message numbers: name the person and a rough time instead ("Ada, today"). A card
number only for a card the board sees on its desk phone. A fitting emoji or two is welcome. For example: "Good catch,
the glow came off but its margin stayed. Ada's fixing it today, no card needed. 👍"
Answer questions from what you know and what's in the repo. When the board decides something (a priority, a
playbook change, a new piece of work), act on it: hand work off with \`hq job\`, or make a small document change
yourself in this session (it becomes a pull request for review), and say what you did. Anything that needs the
board's formal approval under company/AUTHORITY.md still goes to the desk phone.
Fixes to how the company itself works (calls and the voice line, hand-offs, orchestration, knowledge search, HQ and
the coordinator) are the Process team's to build: hand them to ${findAgent(fixer)?.name ?? fixer} with \`hq job\` and the full brief. Never suggest
the board's own Claude Code for them; that's for quick fixes the board chooses to make itself.
Before queueing work, read \`hq estimate "..."\` for clean past-job scopes and actual times. Judge the scope yourself,
then queue with \`--size <time> --refs <job,job> --why "scope comparison"\`. With no comparable job, omit refs and explain
why. ${DEFAULT_ESTIMATE_SCALE}
The estimate is saved once. Only the CEO changes it when work slips. Use that same size for
\`hq when "..." --size <time>\` before telling the board when something will be done (\`--by\` the
board's time: whether it makes it, and only if not, what would). Give one plain time. What the board asks for here takes
its window as you queue it, \`hq job ... --by <when>\`, so HQ orders the thread's work by it from the first minute (its
reviews and fixes too) and pauses work in the way, and you see it in your summary if the thread slips: the board's time,
else hq when's, or \`--by <project>/<slug>\` when it serves a deliverable with a window (the meeting it's needed for).
Only when the board gave no time and it serves nothing timed, \`--by none\`. Work already queued: \`hq window <thread |
job | pr:<n>> <when>\`. When the board says a line of work is urgent, its window's deadline is now:
\`hq window <thread> 1m\`.
New work shifts other work, and the board knows it: say nothing about shifts unless an agreed deadline moves or the
board asks. \`hq job\`, \`hq cancel\` and \`hq when\` give each agreed deadline (a thread's window) its finish, its
slack and its slack some hours ago. When its finish lands past the deadline, the deadline moves: say so plainly. A
margin eaten but still made, or slack that keeps shrinking as work piles on, is yours to plan with: don't mention it
unless the board asks. Before you queue work that eats into a deadline, weigh how much it matters, how much the
board wants it now and how big the risk is, then queue it \`--after\` that deadline's work to protect it, or now anyway:
a real judgment each time, never a set line. Say a warning once: this chat and the board's calls show what it has heard.
Don't update your profile every turn: only when something worth remembering was decided.${unstaffed() ? ONBOARDING : ''}`;

// A fresh chat job after a turn failed three times: the board's words go to the CEO again, in a new session. The title
// marks the batch it was started for: once a turn ends done it's the ordinary chat job again (answered()).
const CHAT = 'Intercom chat with the board';
const AGAIN = `${CHAT} (starting over)`;

const current = () => db.prepare("select * from jobs where kind = 'chat' and id not in (select job from quick_runs) order by id desc limit 1").get() as
  { id: number; status: string; engine: string; not_before: number | null } | undefined;

// A quick run: one turn of the chat kind for any agent, outside the intercom, on the worker's chat slot (no queue, no
// pacing, no hold), for what's answered within seconds (the book's questions: bookslips.ts). The slot is a Claude seat's,
// so every quick run is on Claude, as its agent with its profile, on Claude's model when the agent's own engine is
// another. Its final message goes back to the module that started it (its purpose's heard), never to the intercom: none
// of the intercom's lines, recap or brief.
db.exec('create table if not exists quick_runs (job integer primary key, purpose text not null)');
type Heard = (job: number, status: string, result: string) => void;
const purposes = new Map<string, Heard>();
// (each purpose once, at its module's load)
export const onQuickRun = (purpose: string, heard: Heard) => void purposes.set(purpose, heard);
export function quickRun(agent: string, title: string, prompt: string, purpose: string) {
  if (!purposes.has(purpose)) throw new Error(`no module hears a quick run for ${purpose}`);
  const id = createJob({ agent, kind: 'chat', engine: 'claude', title, prompt }).id;
  db.prepare('insert into quick_runs (job, purpose) values (?, ?)').run(id, purpose);
  return id;
}
const purposeOf = (job: number) =>
  (db.prepare('select purpose from quick_runs where job = ?').get(job) as { purpose: string } | undefined)?.purpose;
// Whether a chat job is the intercom's (a quick run's isn't)
export const intercom = (job: number) => !purposeOf(job);
// A chat job's run ended (jobs.ts): a quick run's answer to its purpose, an intercom turn's to the board.
export function ended(job: { id: number; title?: string }, status: string, result?: string) {
  const purpose = purposeOf(job.id);
  if (purpose) return purposes.get(purpose)?.(job.id, status, (result ?? '').trim());
  answered(job, status, result);
}
// pictureIds: the board's pictures that go with the line; who: whose line, the board's or a call's (or an invited person's, fromGuest)
export function say(text: string, call?: string, callId?: number, pictureIds: number[] = [], who = call ? 'call' : 'board') {
  // A very long talk is fine (a two-hour call is about 100,000 characters); this only stops a runaway, and says so.
  text = text.trim();
  if (text.length > 400_000) text = `${text.slice(0, 400_000)}\n\n… (cut here: the message had ${text.length.toLocaleString('en')} characters)`;
  if (!text && !pictureIds.length) return 400;
  const line = db.prepare('insert into chat (ts, who, text, shown, call) values (?, ?, ?, ?, ?)').run(new Date().toISOString(),
    who, text, call ?? null, callId ?? null).lastInsertRowid; // (who)
  pictures.attach(pictureIds, Number(line));   // (before it's delivered: its turn hears them)
  const job = current();
  if (!job || ['failed', 'cancelled'].includes(job.status)) start(CHAT, job?.id);
  else if (job.status === 'done') deliver(job.id);
  else if (job.status === 'queued') deliver(job.id); // not started yet: this message joins the ones waiting
  else if (job.status === 'blocked') deliver(job.id); // waiting on the desk phone: the CEO answers this meanwhile
  return history();
}
// A line from a person the board invited (sketches.ts: a sketch from their own Sketchbook), heard by the CEO as the board's
// are: text, what the CEO hears, says whose it is and that it's outside text (charter rule 9); shown, what the intercom
// shows the board (history).
export const fromGuest = (text: string, shown: string, pictureIds: number[]) => say(text, shown, undefined, pictureIds, 'guest');
// A line the board typed in HQ, with the pictures it attached (pictures.ts). A picture no longer waiting refuses the
// line and names it, so HQ can take it out of the tray. The reason covers all that pictures.waiting counts: sent
// already, removed, or gone after a day.
export function fromBoard(text: string, picked: unknown) {
  const p = pictures.waiting(picked);
  if (!p) return 400;
  if (p.missing.length) return [409, 'a picture is no longer waiting to be sent: it was sent already, removed, or went unsent for a day', { missing: p.missing }];
  return say(text, undefined, undefined, p.ids);
}
// A reply past LONG_REPLY words (about 80 asked, brief()) gets a gentle nudge in the CEO's next turn, never a refusal: the
// board has read it already. Kept between runs as the reply's word count (the settings table) until a turn hears it,
// once, even if that turn parks.
const LONG_REPLY = 100, LONG = 'chat.long_reply';
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
// A turn ended: the CEO's reply, then anything the board said meanwhile. A turn that failed (three times, jobs.ts) hasn't
// heard the board: its lines wait again, and a fresh session gets them once. If that fails too, they wait for the
// board's next message, which brings them along. Only the batch the fresh session was started for goes without a
// restart: its first turn that ends done makes it the ordinary chat job again.
export function answered(job: { id: number; title?: string }, status: string, result?: string) {
  const done = status === 'done', reply = (result ?? '').trim() || '(no reply)';
  // A call this turn followed up (a call about the intercom's own card, jobs.ts tell()): its reply is the call's notes in
  // HQ's Calls too (ledger.ts reply).
  if (done) db.prepare("update calls set reply = ? where job = ? and processed_at is null and id in (select call from chat where who = 'call' and sent = 2)")
    .run(reply, job.id);
  const heard = db.prepare(`update chat set sent = ${done ? 1 : 0} where who in ${HEARD} and sent = 2`).run().changes; // (HEARD)
  const again = !done && heard > 0 && job.title !== AGAIN;
  if (done && job.title === AGAIN) db.prepare('update jobs set title = ? where id = ?').run(CHAT, job.id);
  // (only a turn's own reply counts: one that ended done.)
  if (done) remember(LONG, words(reply) > LONG_REPLY ? String(words(reply)) : null);
  const text = done ? reply
    : again ? "Sorry, I lost my train of thought there. I'm starting over with everything you said, so there's no need to repeat it."
    : heard ? "Sorry, I can't answer right now. Nothing you said is lost: I'll hear all of it with your next message."
    : 'Sorry, something went wrong on my side there.';
  db.prepare('insert into chat (ts, who, text, sent, about_customer, about_keys) values (?, ?, ?, 1, ?, ?)').run(new Date().toISOString(), ceo(), text,
    Number(holdsCustomerData(job.id)), Number(holdsKeys(job.id)));
  publish({ type: 'chat', agent: ceo(), to: 'board', text: preview(text, 160) });   // (a bubble; the intercom has it all)
  if (again) start(AGAIN, job.id);
  else if (done && db.prepare(`select 1 from chat where who in ${HEARD} and sent = 0`).get()) deliver(job.id); // (HEARD)
}

// A new chat job (a new session) hears every line the CEO hasn't answered yet, including any a job that was cancelled
// or failed had taken, and gets the conversation before them (recap()). A call it hears again (its line is among them:
// chat.call), and a request that's still open, are logged against the job that hears them now. Lines an earlier turn had
// may already have been acted on: after a failed turn the new session is told so whenever it gets any (ones a turn still
// had, or ones older than the CEO's latest reply: a turn that ends done hands on everything that came in meanwhile, so only
// a failed turn leaves those waiting).
function start(title: string, replaces?: number) {
  const had = db.prepare(`update chat set sent = 0 where who in ${HEARD} and sent = 2`).run().changes > 0; // (HEARD)
  const again = had || !!db.prepare(`select 1 from chat where who in ${HEARD} and sent = 0 and id < (select coalesce(max(id), 0) from chat where who = ?)`).get(ceo());
  // (word: its task code's, jobcodes.ts.)
  const id = createJob({ agent: ceo(), kind: 'chat', word: STANDING.chat, title, prompt: brief() + recap() }).id;
  if (replaces) {
    // (the new session follows the call up afresh: an earlier reply isn't its.)
    db.prepare("update calls set job = ?, reply = null where job = ? and id in (select call from chat where who = 'call' and sent = 0)").run(id, replaces);
    db.prepare("update requests set job = ? where job = ? and status = 'open'").run(id, replaces);
  }
  deliver(id, again); // (again)
}

// A fresh session doesn't remember the conversation: its brief has the intercom's latest lines that were heard already
// (the ones still to come are its first turn).
function recap() {
  const said = lines(30, 'sent = 1');
  return !said.length ? '' : `\n\nThis session is new. The conversation so far (its latest lines):\n\n${said.map(line).join('\n')}`;
}
// (a guest's)
const line = (m: ReturnType<typeof lines>[number]) => m.who === 'call' ? `(${m.text})`
  : m.who === 'guest' ? `(${withPictures(m.text.slice(0, 1000), m.pictures)})`
  : `${m.who === 'board' ? 'Board' : ceoName()}: ${withPictures(m.text.slice(0, 1000), m.pictures)}`;

// A line as it's shown outside the session that heard it (a call's prompt, a fresh session's recap, the intercom's
// record: intercom.ts): a call as its one-line title (its transcript is the call's own), a line about a customer as a
// placeholder (about_customer), a line that came of a call about a card for keys as another (about_keys). Its three
// parameters are shownAs()'s.
export const SHOWN = "iif(who = 'call', coalesce(shown, ?1), iif(about_customer, ?2, iif(about_keys, ?3, text)))";
export const shownAs = () => [`Call with ${ceoName()}`, "(a reply that holds a customer's details: the board read it in the intercom)",
  '(a reply about a call on a card for keys: the board read it in the intercom)'];
// The intercom's latest lines, each whole
export function lines(limit: number, where = '1') {
  const rows = db.prepare(`select id, who, ${SHOWN} text from chat where ${where} order by id desc limit ?4`)
    .all(...shownAs(), limit) as { id: number; who: string; text: string }[];
  return rows.reverse().map(r => ({ who: r.who, text: r.text, pictures: pictures.ofLine(r.id) }));
}
// The pictures a line came with, by number, after its words: a recap cuts a long line's words, never its pictures. A
// call's agent can't open them, a fresh session saves them with hq picture.
export const withPictures = (text: string, ids: number[]) => !ids.length ? text
  : `${text}${text ? ' ' : ''}(with ${ids.length === 1 ? 'picture' : 'pictures'} ${ids.map(id => `#${id}`).join(', ')})`;
const AGAIN_SAYS = " (your last session broke off before it answered, so you're hearing this again; if a turn before this one already acted on something here, don't do it twice: check with hq jobs, the repo and the desk phone)"; // (its head deliver's)

// A turn that parked (the CEO asked the board on the desk phone) doesn't hear what came in during it until it's resumed:
// it's resumed now if anything did. Its request stays open.
export const parked = (id: number) => intercom(id) && deliver(id);

// What reaches the CEO's intercom from outside the chat (a call about the CEO's desk phone request, the board's answer to
// it) goes in as a line of the chat too, shown as one line ('shown'), so it's heard like everything the board types:
// by the latest chat job, whatever state it's in, and a failed turn keeps it and a fresh session hears it again
// (answered()). A running turn gets it as soon as it ends: the next turn if it ends done or parks, a fresh session if
// it fails. Returns the job that hears it. A call's line carries the call, so the call goes with it to a fresh session.
export function hear(text: string, shown: string, call?: number) {
  say(text, shown, call);
  return current()!.id;
}
// A call's line was in a turn that ended done (answered(): a line that came in during the turn is only delivered
// after it), so the intercom has heard the call (ledger.ts finished()).
export const heard = (call: number) => !!db.prepare("select 1 from chat where call = ? and who = 'call' and sent = 1").get(call);

// Queue the chat job with what the board said since the CEO last heard from it (added to a turn that hasn't
// started yet), and any call notes waiting to go along. A new turn starts its attempts from 0, so it too is tried again
// twice (jobs.ts).
// (an invited person's lines too, HEARD, headed as not the board's when only theirs
// wait, each picture of theirs as theirs)
function deliver(id: number, again = false) {
  const unsent = db.prepare(`select id, who, text, about_customer, about_keys, call from chat where who in ${HEARD} and sent in (0, 3) order by id`)
    .all() as { id: number; who: string; text: string; about_customer: number; about_keys: number; call: number | null }[];
  if (!unsent.length) return;
  const says = `${unsent.some(m => m.who !== 'guest') ? 'The board says' : GUEST_HEAD}${again ? AGAIN_SAYS : ''}:`;
  if (unsent.some(m => m.about_customer)) handedCustomerData(id);
  if (unsent.some(m => m.about_keys || (m.call && carriesKeys(m.call)))) handedKeys(id);
  db.prepare(`update chat set sent = 2 where who in ${HEARD} and sent in (0, 3) and id <= ?`).run(unsent.at(-1)!.id); // (HEARD)
  const job = db.prepare('select status, note from jobs where id = ?').get(id) as { status: string; note: string | null };
  const adds = job.status === 'queued' && job.note, long = adds ? undefined : setting(LONG);
  if (long) remember(LONG, null);
  let marked = !adds || !job.note!.includes(GUEST_HEAD);
  const before = adds ? `${job.note}\n\n`
    : `${long ? `(From HQ, not the board: your last reply ran ${long} words. Keep to about 80, the answer first.)\n\n` : ''}${says}\n\n`;
  db.prepare("update jobs set status = 'queued', seat = null, not_before = 0, note = ?, attempts = iif(status = 'queued', attempts, 0) where id = ?")
    .run(before + unsent.map(m => {
      const text = [m.text, pictures.mention(pictures.ofLine(m.id), m.who === 'guest')].filter(Boolean).join('\n\n');
      if (marked || m.who === 'guest') return text;
      marked = true;   // (the board's line joining a note headed as the intercom's says it's the board's)
      return `The board says:\n\n${text}`;
    }).join('\n\n'), id);
}
const GUEST_HEAD = 'From the intercom, not the board';

// The CEO's calls have a follow-up job like everyone's (ledger.ts). The board reads its notes here, as the CEO's reply after
// the call, and the next turn hears them (without one starting just for that), so the CEO's session knows what was done.
export function callNotes(call: number, job: number, notes: string, mins: number) {
  const ts = new Date().toISOString();
  const about = Number(holdsCustomerData(job));   // a follow-up of a call about a customer card (ledger.ts)
  const keys = Number(carriesKeys(call));
  db.prepare("insert into chat (ts, who, text, shown, sent, about_customer, about_keys, call) values (?, 'call', ?, ?, 3, ?, ?, ?)").run(ts, `We had a call (call #${call}). Your follow-up job #${job} went through it, recorded what I asked for and handed out the work; these are its notes, which I read here as your reply:\n\n${notes}`, `Call with ${ceoName()} · about ${mins} min`, about, keys, call);
  db.prepare('insert into chat (ts, who, text, sent, about_customer, about_keys) values (?, ?, ?, 1, ?, ?)').run(ts, ceo(), notes, about, keys);
  publish({ type: 'chat', agent: ceo(), to: 'board', text: preview(notes, 160) });
}

// thinking: 'notes' while the follow-up of a call with the CEO is still at work, which takes minutes (ledger.ts).
const following = () => !!db.prepare(`select 1 from calls c join jobs j on j.id = c.job
  where c.agent = ? and j.status in ('queued', 'running', 'blocked')`).get(ceo());   // the follow-up, not the work it handed out
export const history = () => ({
  messages: (db.prepare('select id, ts, who, coalesce(shown, text) as text from chat order by id desc limit 60').all() as { id: number }[]).reverse()
    .map(m => { const ids = pictures.ofLine(m.id); return ids.length ? { ...m, pictures: ids } : m; }),
  thinking: ['queued', 'running'].includes(current()?.status ?? '') || following() && 'notes',
  paused: paused(),
  // a new company before its first line: HQ opens the intercom and asks which language to talk in.
  welcome: unstaffed() && !db.prepare('select 1 from chat limit 1').get(),
});

// Why the CEO's turn isn't under way when it's due, so HQ says so instead of "thinking": the worker isn't calling in
// (restarting, or not up at all), the turn is to be tried again at a time (a failed try), or every Claude seat is at its
// limit (until: the first back) or signed out. The turn starts on its own once that's over (the intercom's own slot,
// on any seat with room). null: it's under way, or starts in seconds.
export type ChatPause = { why: 'restarting' } | { why: 'later' | 'seat'; until: number } | { why: 'signin' };
export function paused(t = Date.now()): ChatPause | null {
  const job = current();
  if (!job || !['queued', 'running'].includes(job.status)) return null;
  if (workerQuiet(t)) return { why: 'restarting' };
  if (job.status === 'running') return null;
  if ((job.not_before ?? 0) > t) return { why: 'later', until: job.not_before! };
  if (job.engine !== 'claude') return null;   // (the seats are Claude's: callSeat)
  const seat = callSeat(t);
  if (seat.room) return null;
  return seat.why === 'limit' ? { why: 'seat', until: seat.until } : { why: 'signin' };
}
