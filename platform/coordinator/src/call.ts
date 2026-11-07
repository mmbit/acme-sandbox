// Calls with the team, for the voice line (platform/voice): the agent's prompt on the phone (who they are, how to
// talk, the company as it is right now), and after the call the transcript goes to a follow-up job, which records what
// was said as items and hands them out (the call ledger, ledger.ts). Every call is logged for HQ's computer.
// (its messages say deliverable, the board's word for a thread)
import { ONE_DEADLINE } from '../../worker/hq/levels.ts';
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.ts';
import * as chat from './chat.ts';
import * as intercom from './intercom.ts';
import { findAgent, nameOf, boardId, callModel, callSeat, readsReport, readsCard, REPORT_LEFT_OUT, extendJob, heldWith } from './jobs.ts';
import * as redraws from './redraws.ts';
import * as messages from './messages.ts';
import { forCall } from './callmessages.ts';
import { lineTimes } from './calltimes.ts';
import * as ledger from './ledger.ts';
import * as review from './review.ts';   // (reach)
import * as pictures from './pictures.ts';
import * as watchalong from './watchalong.ts';
import { publish } from './events.ts';
import * as walks from './walkthroughs.ts';
import * as goingon from './goingon.ts';
import * as forecast from './forecast.ts';
import * as goals from './goals.ts';
import { padBriefing } from './pad.ts';
import { guestPrompt } from './callguestbrief.ts';
import * as callbuilds from './callbuilds.ts';
import { read, section, profileOf, spokenAloud, replies, recognised } from './callspoken.ts';
import { org, ceo, names, roles, timeZone, unstaffed, companyTime, titleOf, respellings } from './company.ts';
import { LANGUAGES, type BoardLanguage } from './language.ts';
import { DEFAULT_ESTIMATE_SCALE, ONE_TIME } from '../../worker/hq/estimating.ts';
import { PAUSE_FOR, WINDOW_FIRST } from '../../worker/hq/levels.ts';

// The streaming voice line (platform/voice) asks for the prompt, and hands the transcript over the same way.
// A call can be about one of the agent's own desk phone requests: then the transcript is the board's answer to it.
// In any state, not just open (the board rings from an open card): on a call about keys the board types them into the
// card, so by the end it's answered, and the call must still be tied to it. The prompt shows the request's body, never
// its answer.
type Req = { id: number; title: string; body: string; kind: string; status: string };
const about = (agent: string, id: number) => id ? db.prepare(`select id, title, body, kind, status from requests where id = ? and agent = ? and kind != 'login'`)
  .get(id, agent) as Req | undefined : undefined;
// The agent on the call gets a token of its own for hq job, like a job's: only an org.yaml agent, never the
// board or a team member, and it stops working when the call ends or after 3 hours. The call's row exists from the
// start (status live) and the token is bound to it, so what's recorded during the call (what it writes down) belongs to it and
// survives a dropped line. (Spent tokens stay a day, so a voice line that comes back after a crash still finds its call, even once the
// sweep has ended it: ledger.late().) The voice line restarts a call agent that died or hung mid-call with the call's
// token (in the body, never the URL): the same row and token go on, so the transcript and what was noted before the
// restart end on one call, and the token ends with it. (A second row orphaned what was noted on the first and
// left its token working; a new token would refuse a hand-off the old session still had on its way.)
// The token keeps the open items its briefing numbered (listed): the call's replace changes only those, or what the call
// recorded itself (server.ts), so a misheard number can't cancel an unrelated item's jobs. Only the ones the agent hears:
// a line fit() cut off isn't listed (heard()). A restart adds the rebuilt briefing's, keeping the ones heard before.
const CALL_MS = 3 * 3600_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// voice: the agent's own English voice on calls (company.ts voiceOf), for the
// voice line; voices: its voice in a language where it has another (voicesOf).
// phone: a call on the phone line (Twilio), which has no screen to share pictures on.
// What the line itself says when the agent can't answer: whether a Claude seat has room now (callSeat), and the company's
// clock for the time a limit ends. respell: the company's words as the speech engines should say them (company.ts).
const line = () => ({ seat: callSeat(), timeZone: timeZone(), respell: respellings() });
// lang: the board's language (language.ts) as HQ or the phone line read it when the call started, which the voice line
// speaks and hears in: one it doesn't know is English.
const spoken = (lang: string): BoardLanguage => Object.hasOwn(LANGUAGES, lang) ? lang as BoardLanguage : 'en';
// walk: HQ rang from a card's Walk me through it (walkthroughs.ts)
// guest: the name of the board's guest carrying the call it left, on a restart: their own briefing (callguestbrief.ts),
// with nothing of the company's state, and the open items it numbers stay as they were.
export function context(agent: string, lang: string, request = 0, again = '', phone = false, walk = false, guest = '') {
  const who = findAgent(agent);
  if (!who || who.temp || boardId(agent)) return 404;
  if (guest && !again) return 400;  // (a guest only goes on with a call the board started)
  const live = again ? db.prepare(`select c.id, c.request, c.resumes, t.listed from call_tokens t join calls c on c.id = t.call and c.agent = t.agent
    where t.hash = ? and t.agent = ? and t.expires > ? and c.status = 'live'`).get(sha256(again), agent, Date.now()) as { id: number; request: number | null; resumes: string | null; listed: string } | undefined : undefined;
  // A restart whose call has ended (handed over, expired or swept) is refused, never a new call: the voice line restarts
  // an agent whose reply the hang-up cut off, and a new call there would have a token nothing ever hands back.
  if (again && !live) return 409;
  const req = about(agent, live ? live.request ?? 0 : request);
  if (live && guest)
    return { prompt: fit(guestPrompt(spoken(lang), agent, live.id, guest)), token: again, call: live.id, key: pictures.callKey(sha256(again)), voice: who.voice, voices: who.voices, ...callModel(), ...line() };
  if (live) {  // a restart
    const p = heard(prompt(spoken(lang), agent, req, live.id, phone, JSON.parse(live.resumes ?? '[]'))), listed = [...new Set([...JSON.parse(live.listed) as number[], ...p.listed])];
    db.prepare('update call_tokens set listed = ? where hash = ?').run(JSON.stringify(listed), sha256(again));
    return { prompt: p.text, token: again, call: live.id, key: pictures.callKey(sha256(again)), voice: who.voice, voices: who.voices, ...callModel(), ...line() };
  }
  const token = randomBytes(32).toString('base64url');
  db.prepare('delete from call_tokens where expires < ?').run(Date.now() - 86400e3);
  const earlier = unfinished(agent);
  // (phone)
  const call = Number(db.prepare("insert into calls (ts, agent, request, lines, status, resumes, phone) values (?, ?, ?, '[]', 'live', ?, ?)")
    .run(new Date().toISOString(), agent, req?.id ?? null, earlier.length ? JSON.stringify(earlier) : null, phone ? 1 : 0).lastInsertRowid);
  walks.begin(call, req?.id ?? 0, walk);
  const p = heard(prompt(spoken(lang), agent, req, 0, phone, earlier, call));
  db.prepare('insert into call_tokens (hash, agent, expires, call, listed) values (?, ?, ?, ?, ?)')
    .run(sha256(token), agent, Date.now() + CALL_MS, call, JSON.stringify(p.listed));
  // (the board's other HQ screens show themselves on it: watchalong.ts startOnScreen.
  if (!phone) publish({ type: 'book', text: 'call', call });
  // call: HQ watches its follow-up by it. key: HQ's picture uploads for this call carry it (pictures.ts)
  return { prompt: p.text, token, call, key: pictures.callKey(sha256(token)), voice: who.voice, voices: who.voices, ...callModel(), ...line() };
}
// The board can ring an agent again before its last call is followed up: a correction, or something else entirely. That
// call carries on from the agent's calls still waiting for their follow-up (calls.resumes, kept for a restart): their
// transcripts and what's noted on them come in the briefing, marked off from where this call starts. Their follow-ups go
// on as they are; this call's waits for them and acts only on what's new (ledger.ts followUp). Newest first within the
// room the rest of the briefing leaves on the phone line (ARG_BYTES): an older transcript that doesn't fit keeps its last
// lines and says so. Only calls that ended in the last day (an ended call's ts is its end): one the board added to days
// later ("We missed something") is followed up again, but it isn't what the board just said.
const EARLIER_CALLS = 3, EARLIER_MS = 24 * 3600_000;
const unfinished = (agent: string) => (db.prepare(`select id from calls where agent = ? and status = 'ended' and processed_at is null
  and ts > ? order by id desc limit ${EARLIER_CALLS}`).all(agent, new Date(Date.now() - EARLIER_MS).toISOString()) as { id: number }[]).map(c => c.id).reverse();
type Carried = { id: number; ts: string; job: number | null; lines: string; processed_at: string | null };
// room: the bytes the rest of the briefing leaves; the part around the transcripts is measured with none in it.
function carriedOn(ids: number[], call: number, room: number) {
  const rows = ids.map(id => db.prepare('select id, ts, job, lines, processed_at from calls where id = ?').get(id) as
    Carried | undefined).filter(c => !!c);
  if (!rows.length) return { text: '', listed: [] as { id: number; end: number }[] };
  const none = new Map(rows.map(c => [c.id, [] as string[]]));
  let left = room - Buffer.byteLength(carriedText(rows, none, call).text);
  const kept = new Map<number, string[]>();
  for (const c of [...rows].reverse()) {
    const lines = (JSON.parse(c.lines) as string[]).map((l, i) => `[${i + 1}] ${l}`), keep: string[] = [];
    for (let i = lines.length - 1; i >= 0 && left >= Buffer.byteLength(lines[i]) + 1; i--) { keep.unshift(lines[i]); left -= Buffer.byteLength(lines[i]) + 1; }
    kept.set(c.id, keep);
  }
  return carriedText(rows, kept, call);
}
function carriedText(rows: Carried[], kept: Map<number, string[]>, call: number) {
  const which = rows.length > 1 ? `calls ${rows.map(c => `#${c.id}`).join(' and ')}` : `call #${rows[0].id}`;
  let text = `## Carrying on from your ${which}
The board called you again before ${rows.length > 1 ? 'those calls were' : 'that call was'} followed up, so this call carries on from
${rows.length > 1 ? 'them' : 'it'}: what was said and noted there is below. ${rows.length > 1 ? 'Their' : 'Its'} follow-up still records and acts on all of
it: don't note or hand out any of it again. If the board changes something from ${rows.length > 1 ? 'them' : 'it'}, replace the item if
it's listed here; otherwise just confirm it: your follow-up after this call gets only this call's transcript, and
corrects the earlier items from it.
`;
  const listed: { id: number; end: number }[] = [];
  for (const c of rows) {
    const lines = JSON.parse(c.lines) as string[], keep = kept.get(c.id)!;
    // A restart builds this briefing again, so an earlier call may have been followed up by now.
    const state = c.processed_at ? `followed up since, by job #${c.job}` : c.job ? `its follow-up, job #${c.job}, hasn't finished` : '';
    text += `\n### Call #${c.id}, at ${companyTime(Date.parse(c.ts))}${state ? ` (${state})` : ''}\nNoted on it so far:`;
    const noted = ledger.items(c.id);
    for (const i of noted) {
      text += `\n- #${i.id}: ${i.what} (${i.kind} for ${i.owner}, ${i.status})`;
      if (i.status === 'open') listed.push({ id: i.id, end: text.length });
    }
    if (!noted.length) text += ' nothing yet';
    text += `\n${!lines.length ? "(No transcript: the line dropped before it was handed over.)"
      : `The transcript:\n${keep.length < lines.length ? `(Lines 1-${lines.length - keep.length} are left out here: the call tool reads call #${c.id} whole.)\n` : ''}`}${keep.join('\n')}\n`;
  }
  text += `\n**This call (#${call}) starts here.** Everything above was said on the earlier ${rows.length > 1 ? 'calls' : 'call'}; only what's said from now on is this call's.\n\n`;
  return { text, listed };
}

// The voice line passes the prompt to the CLI as one argument, and Linux refuses one over 128 KiB (E2BIG): no call would
// start. Most parts are capped, but not all (open request titles and job titles have no length limit), so an over-long
// briefing is cut here, and it says where it stops.
const ARG_BYTES = 120_000;
function fit(p: string) {
  if (Buffer.byteLength(p) <= ARG_BYTES) return p;
  const end = '\n\n(The briefing is cut here: it was too long for the phone line. Search for the rest.)';
  return Buffer.from(p).subarray(0, ARG_BYTES - Buffer.byteLength(end)).toString().replace(/\uFFFD$/, '') + end;
}
// The prompt as the agent gets it (fit()), and the open items it numbers whose line is in it whole: fit() keeps the
// start, so a line is heard if the cut prompt still starts with everything up to its end.
function heard(p: { text: string; listed: { id: number; end: number }[] }) {
  const text = fit(p.text);
  return { text, listed: p.listed.filter(l => text.startsWith(p.text.slice(0, l.end))).map(l => l.id) };
}
// The board's call live now on HQ, the newest (its other screens show themselves on it: watchalong.ts startOnScreen),
// never one on the phone line, where nobody looks at a screen.
// (phone)
export const liveNow = () => db.prepare("select id, agent from calls where status = 'live' and phone = 0 order by id desc limit 1").get() as { id: number; agent: string } | undefined;
export const callAgent = (token: string) => token ? db.prepare('select agent, call, listed from call_tokens where hash = ? and expires > ?')
  .get(sha256(token), Date.now()) as { agent: string; call: number | null; listed: string } | undefined : undefined;

// A job the call queued (hq job from its token): its agent may add to it until the call ends (addToJob).
export const queuedOn = (call: number, job: number) =>
  db.prepare('insert or ignore into call_jobs (call, job) values (?, ?)').run(call, job);
// Whether the call queued that job (queuedOn), and why a work job the call names for `to` isn't theirs: a misheard
// number names someone else's (a note's job: server.ts notedWork; reach checks it too).
export function queuedHere(call: number | undefined, job: number) {
  return !!call && !!db.prepare('select 1 from call_jobs where call = ? and job = ?').get(call, job);
}
export function notTheirs(to: string, id: number): [number, string] | undefined {
  const job = db.prepare("select agent, title, step, round from jobs where id = ? and kind = 'work'").get(id) as { agent: string; title: string; step: string | null; round: number | null } | undefined;
  if (!job) return [404, `there's no job #${id}: check the number`];
  if (job.agent !== to) return [409, `job #${id} is ${job.agent}'s (${nameOf(job)}), not ${to}'s: check the number`];
}
// What the board adds or corrects on a call about a job the call queued (the add tool, hq extend on a call), so it never
// waits for the follow-up or goes as a second job beside it. One that hasn't started takes it into its brief
// (jobs.extendJob), signed as added on the call. One that has (running, or paused to resume in its session) gets it as a
// message for that job alone (messages.send, only), which its session reads at its next step; a job that waits for the
// board or runs on Codex can't take one mid-job, so it's a job for its agent then, as for hq say. Only this call's own
// jobs: any other is the follow-up's, from the transcript. A refusal is [status, why], or a bare status from send.
type Added = { job: number; agent: string; added: 'brief' | 'message' | 'job'; message?: number; became?: number };
export function addToJob(me: { agent: string; callId?: number }, id: number, text: string): Added | [number, string] | number {
  text = text.trim();
  if (!text) return [400, 'say what the board added or changed'];
  if (text.length > messages.MAX) return [413, `too long (${text.length.toLocaleString('en')} > ${messages.MAX.toLocaleString('en')}): keep the addition short; the follow-up has the whole call`];
  const call = me.callId;
  if (!call || !queuedHere(call, id))
    return [409, `job #${id} wasn't queued on this call: only a job you queued on it takes an addition now. The call's follow-up adds to any other from the transcript`];
  const job = db.prepare('select agent, title, status from jobs where id = ?').get(id) as { agent: string; title: string; status: string };
  if (extendJob(id, `${me.agent}, on a call with the board`, text) !== 404) return { job: id, agent: job.agent, added: 'brief' };
  if (['done', 'failed', 'stopped', 'cancelled'].includes(job.status))
    return [409, `job #${id} has ${job.status === 'done' ? 'finished' : `been ${job.status === 'cancelled' ? 'cancelled' : 'stopped'}`}. If the board still wants it, queue it as a new job with the whole brief`];
  const message = `An addition to your job #${id} (${job.title}), from ${me.agent}'s call with the board (call #${call}), where it was queued. `
    + `It's part of the brief: act on it with the rest.\n\n${text}`;
  if (message.length > messages.MAX) return [413, `too long for a job that has started (${text.length.toLocaleString('en')} characters, and the note around it counts): keep the addition short; the follow-up has the whole call`];
  const sent = messages.send({ agent: me.agent, job: null, call }, job.agent, message, { only: id });
  if (sent === 429) return [429, `this call has added ${messages.PER_HOUR} times in the past hour: put the rest in one addition, or leave it to the call's follow-up`];
  if (typeof sent === 'number') return sent;
  if (sent.state === 'queued') return { job: id, agent: job.agent, added: 'message', message: sent.id };
  return { job: id, agent: job.agent, added: 'job', message: sent.id, became: sent.job };
}

// As often as the board's word needs, with the recipient checked to catch a
// misheard number. Reviews take guidance only before starting. It's in the call agent's words, which the follow-up
// checks against the transcript (ledger.ts reached).
type ReachedJob = { id: number; agent: string; title: string; step: string | null; status: string; kind: string; engine: string | null; session: string | null; pr: number | null; round: number | null; branch: string | null };
type Reached = { job: number; agent: string; item: number; message?: number; pr?: number; round?: number; ruling?: 'started' | 'later' };
// goal: why the board wants it, which the job reads with the words.
export function reach(me: { agent: string; callId?: number }, to: string, id: number, what: string, goal: string, text: string): Reached | [number, string] {
  const call = me.callId;
  text = text.trim(); what = what.trim(); goal = goal.trim();
  if (!call) return [403, 'only a call reaches work under way'];
  if (!text) return [400, 'say what the job needs to know'];
  if (!ledger.oneLine(what, ledger.WHAT)) return [400, `what needs one plain line of at most ${ledger.WHAT} characters: the board reads it`];
  if (!ledger.oneLine(goal, ledger.GOAL)) return [400, `goal needs one plain line of at most ${ledger.GOAL} characters: why the board wants it, in its own terms`];
  if (queuedHere(call, id)) return [409, `job #${id} was queued on this call: put the board's word into it with add`];
  const job = db.prepare('select id, agent, title, step, status, kind, engine, session, pr, round, branch from jobs where id = ?').get(id) as
    ReachedJob | undefined;
  if (!job || job.kind === 'chat') return [404, `there's no job #${id} to reach`];
  if (job.agent !== to) return [409, `job #${id} is ${job.agent}'s (${nameOf(job)}), not ${to}'s: check the number`];
  const going = job.status === 'running' || (job.status === 'queued' && !!job.session);
  if (job.kind !== 'work') {
    const pr = job.pr ? db.prepare('select status from prs where number = ?').get(job.pr) as { status: string } | undefined : undefined;
    // (the work job whose branch the pull request is: the item tied to it is what the panel reads)
    const work = job.branch ? db.prepare("select id from jobs where branch = ? and kind = 'work' order by id desc limit 1").get(job.branch) as { id: number } | undefined : undefined;
    if (!['running', 'queued'].includes(job.status) || pr?.status !== 'open' || !work)
      return [409, `job #${id}, ${nameOf(job)}, isn't under way any more: the follow-up passes it on`];
    const item = ledger.reached(call, { owner: to, what, goal, words: text, job: work.id, ref: `sent on call #${call} to PR #${job.pr}'s review` });
    return { job: id, agent: to, item, pr: job.pr!, round: job.round ?? 0, ruling: review.rulingBegun(job.pr!, job.round ?? 0) };
  }
  if (!going) return [409, `job #${id}, ${nameOf(job)}, isn't running (${job.status === 'blocked' ? 'it waits for the board' : job.status}): the follow-up passes it on`];
  if (job.engine !== 'claude') return [409, `job #${id} runs on ${job.engine === 'codex' ? 'Codex' : job.engine}, which can't take a message mid-job: the follow-up passes it on`];
  const message = `From ${me.agent}'s call with the board (call #${call}), for your job #${id} (${nameOf(job)}) while it runs: the board's word on `
    + `this work as it stands now, in ${me.agent}'s words. Weigh it with your brief, as the board's. The call's follow-up checks it against `
    + `the call's transcript, and tells you if it was misheard.\n\nWhy the board wants this: ${goal}\n\n${text}`;
  if (message.length > messages.MAX) return [413, `too long (${text.length.toLocaleString('en')} characters, and the note around it counts): keep it to what the job needs now`];
  const sent = messages.send({ agent: me.agent, job: null, call }, to, message, { only: id });
  if (typeof sent === 'number') return [sent, sent === 429 ? `this call has sent ${messages.PER_HOUR} messages in the past hour` : 'HQ refused it'];
  const item = ledger.reached(call, { owner: to, what, goal, words: text, job: id, ref: `sent on call #${call} as message #${sent.id}` });
  return { job: id, agent: to, item, message: sent.id };
}

// The call ended: its row gets the transcript, and its first follow-up (ledger.ts). A call where nobody spoke and
// nothing was recorded leaves nothing behind. times: when each line was said (the voice line's clock, ms), kept only
// one a line (calls.line_times).
export function handOver(agent: string, lines: string[], request = 0, token = '', times?: unknown) {
  const bound = token ? (db.prepare('select call from call_tokens where hash = ?').get(sha256(token)) as { call: number | null } | undefined)?.call : undefined;
  // The token stops working here but is kept its day (context() clears it), so a repeat finds its call. The voice line
  // sends an end again when HQ's reply was lost.
  if (token) db.prepare('update call_tokens set expires = min(expires, ?) where hash = ?').run(Date.now(), sha256(token));
  const was = bound ? db.prepare('select id, status, lines, lines_at from calls where id = ? and agent = ?').get(bound, agent) as { id: number; status: string; lines: string; lines_at: string | null } | undefined : undefined;
  // (a repeat of an end HQ took: no second row, no second follow-up. lines_at: an end or a late transcript came in,
  // never kept()'s lines nor the sweep.)
  if (was && was.status !== 'live' && (was.lines_at || was.lines === JSON.stringify(lines))) return { ok: true };
  // A late transcript (the sweep ended the call) goes to that call (ledger.late); one whose call isn't found (its token
  // unknown, or swept a day after it expired) gets a new row.
  const req = about(agent, request);
  const said = lineTimes(lines, times);
  // (the sweep's call may hold the lines kept() had before the line lost it: the whole transcript takes their place)
  if (was?.status === 'ended' && lines?.length) { ledger.late(was.id, lines, said); return { ok: true }; }
  const live = was?.status === 'live' ? was.id : undefined;
  // (its notes page stays in My journal as the board left it, or is deleted if nothing is on it.)
  if (live) ledger.callEnded(live);
  if (live) callbuilds.endedCall(live);
  const recorded = live ? ledger.items(live).length > 0 : false;
  if ((!lines?.length && !recorded) || !findAgent(agent)) {
    if (live) ledger.forgetCall(live);
    return { ok: true };
  }
  const ts = new Date().toISOString();
  const id = live ?? Number(db.prepare("insert into calls (ts, agent, lines) values (?, ?, '[]')").run(ts, agent).lastInsertRowid);
  db.prepare("update calls set ts = ?, lines_at = ?, request = ?, lines = ?, line_times = ?, status = 'ended' where id = ?")
    .run(ts, ts, req?.id ?? null, JSON.stringify(lines ?? []), said, id);
  watchalong.endCall(id);
  ledger.followUp(id);
  return { ok: true };
}

// The transcript so far, while the call goes on (the voice line sends it as it grows): a call that loses its line keeps
// what was said in HQ, and the CEO reads a call still going on (memory.ts canRead). Only the call's own live row, by
// its token; the hand-over still ends it. Its answer carries the colleagues' messages for the call since the last
// (callmessages.ts forCall).
// lines: none when they haven't changed since the last (only the messages, then).
export function kept(agent: string, lines: string[] | undefined, token = '', times?: unknown) {
  const bound = token ? (db.prepare(`select t.call from call_tokens t join calls c on c.id = t.call
    where t.hash = ? and c.agent = ? and c.status = 'live'`).get(sha256(token), agent) as { call: number } | undefined)?.call : undefined;
  if (!bound) return 404;
  if (lines) db.prepare('update calls set lines = ?, line_times = ? where id = ?').run(JSON.stringify(lines), lineTimes(lines, times), bound);
  // (and its prototypes built since, or not: callbuilds.ts.)
  return { ok: true, messages: forCall(bound), built: callbuilds.heard(bound) };
}

// The call log for HQ's computer: each call, its follow-up (the reply it set, ledger.ts reply) and what the team
// took from it (each item's plain line and where it stands). Never the transcript, nor the words an item quotes: the
// board is never shown its own transcripts (DECISIONS.md, 2026-09-28). recorded: it has a walk-through to watch back
// (watchalong.ts).
export const calls = () => (db.prepare(`select c.id, c.ts, c.agent, c.request, c.job, c.status as state, c.processed_at is not null as processed, c.attempts, j.status, c.reply
  from calls c left join jobs j on j.id = c.job where c.status != 'live' order by c.id desc limit 30`).all() as any[])
  .map(c => ({ ...c, ...ledger.forBoard(c.id), recorded: watchalong.recorded(c.id) }));

// On the phone: who they are, how to talk, and the company as it is right now; listed: the open items it numbers, and
// where each one's line ends. The open items come before the parts that can grow (the company right now), so an
// over-long briefing cuts those first (fit()).
// `restarted`: the call this session takes over (context()), and what's on its list already. carried: the calls it
// carries on from (carriedOn()), and `call` this one. On a call in HQ it says when to use which of the notes page's tools
// (a change about what the board shows comes with its crop by default), and that the board's scribbles are for the agent to judge.
function prompt(lang: BoardLanguage, agent: string, req?: Req, restarted = 0, phone = false, carried: number[] = [], call = restarted) {
  // (its number: a colleague's quick job saves a prototype for it by that.)
  const head = `${instructions(lang, agent, phone)}
This call is #${call}.
## You
${profile(profileOf(agent))}

${recentWork(agent, call)}${req ? `## What this call is about
Your own desk phone request to the board, #${req.id}: ${req.title}
${req.body.length > 20_000 ? `${req.body.slice(0, 20_000).trimEnd()}… (cut here: the request has ${req.body.length.toLocaleString('en')} characters)` : req.body}
After the call you get the transcript, and ${req.status === 'open' ? "the request stays on the board's desk phone until you close it" : `the request is off the board's desk phone already (${req.status})`}.
${call && walks.isWalk(call) ? walks.BRIEFING : ''}${req.kind === 'credential' ? `It asks for keys. Help the board find them, but never ask them to read a key, password or code out loud: they go in the fields on the desk phone (you never see them). If the board starts reading one out, stop them.\n` : ''}
` : ''}${restarted ? `## Already noted on this call
Your session on this call stopped and was restarted: it's still the same call. What was noted on it so far is on its
list already, so don't note it again (replace one to change it):
${ledger.items(restarted).map(i => `- #${i.id}: ${i.what} (${i.kind} for ${i.owner}, ${i.status})`).join('\n') || '- nothing yet'}

` : ''}`;
  const open = ledger.stillOpen(8, [restarted, ...carried]);
  const now = companyNow(agent);
  const before = carriedOn(carried, call, ARG_BYTES - Buffer.byteLength(`${head}${open.text}${now}`));
  const text = `${head}${open.text}${before.text}${now}`;
  return { text, listed: [...open.listed.map(l => ({ id: l.id, end: head.length + l.end })),
    ...before.listed.map(l => ({ id: l.id, end: head.length + open.text.length + l.end }))] };
}

// Who they are on the call and how to talk: the call's rules, then AGENTS.md. A window puts work first, a pause only
// waits on a condition.
// (the notes page's try) (the call's notes in plain words)
// eslint-disable-next-line max-lines-per-function -- one template of words, the call's instructions: a data table in prose
function instructions(lang: BoardLanguage, agent: string, phone: boolean) {
  const who = findAgent(agent)!, name = String(who.name ?? agent), role = titleOf(who);
  const pron = who.pronouns ? ` (${who.pronouns})` : '';
  // The rules of talking on the line are the ones a guest's briefing has too (callspoken.ts: the Dutch marks, the
  // spoken replies, answering directly, speech recognition).
  // The pictures sentence: the voice line shows the agent what the board shares on HQ's call screen. A phone call has
  // no screen.
  // a time told on the call is written down with what's to be done, which its job carries, or the work under way it
  // names (askwindow.ts). One kind of note, written down with one tool.
  // Follow-ups inherit the deadline of the deliverable they serve. Missing times show once for that deliverable.
  // A job queued on a call in HQ carries its note on the call's notes page (ledger.ts noteOnPage).
  // A time from the when tool: the work played into the plan (when.ts). A time far past the board's is the agent's to
  // solve on the call: it sets windows as it queues or releases, and the when and eta answers say what to check when a
  // finish misses (worker/hq deadlines.ts lateLines). Judgment, never a refusal.
  // Where planned work stands: the eta tool (voice hq_tools.py, outlooks.ts findOutlooks).
  // What's going on now: the eta tool with no query (hq now, goingon.ts).
  // What a job is doing this minute: the activity tool (hq activity, activity.ts).
  // hang_up: the agent ends the call once the board has clearly said goodbye (the voice line's Call.leave), with a
  // goodbye in its own words.
  // add: what the board adds to a job the call queued goes into it (addToJob).
  // reach: the board's settled word to work under way, for real need only, as often as the board's word needs
  // manage: the agent manages the company's work on the call as off it (voice hq_tools.py MANAGE, server.ts
  // MANAGE_ROUTES), never a note for the follow-up to do it
  // No numbers aloud: the briefing and the tools number the work for the agent's tools, never for the board's ears.
  // Every tool answer says it again (voice hq_tools.py ALOUD). (the answer first, an example, plain times)
  // A time aloud: the template's own line says how.
  // WebSearch is enabled by guard.TOOLS. Its reply ends in a Sources list a call would read aloud (voice server.py
  // spoken() drops only the links), so the prompt says never.
  // report, git and WebFetch: the agent reads what a job reads, but no shell (voice reads.py, guard.TOOLS).
  // One time, the plan's, no margin of our own, doubt with its reason (ONE_TIME).
  // Any time told is the four-in-five one, and a time we give is ours: only one the board set itself is news when
  // missed, once.
  // Shifted work: the job and when tools give each agreed deadline's facts (deadlines.ts); the board hears of shifts
  // only when a time it set itself will be missed or it asks; whether one is safe or tight and where new work goes is the
  // agent's judgment, never a rule in the tool, and nothing records what was said: earlier calls and the intercom show it.
  // The call's language is the line's, one value for its voice, its ears and these words, and it holds against any
  // other language in the briefing (talk of a meeting in Dutch on an English call) or a tool's answer. An answer is what we'll do, the rest when asked.
  // The call's notes read later without the call: per idea a sketch and full sentences of what was said; the page about
  // the call's subject, a fault in our tools on the list alone (write_down's page).
  // The board's ink in the call's notes is its agent's alone, and on the agent's own scraps it points and goes once the
  // turn on it is done (ink/callpointers.ts).
  const spokenIn = LANGUAGES[lang].name;
  return `You are ${name}${pron}, ${role} at ${names().name}, an AI-run company. You're on a live voice call with the board (the human owner).
The call's language is ${spokenIn}: HQ's language setting, in which the line voices your words and hears the board.
Speak ${spokenIn} from your first word to your last, whatever language the briefing, your tools' answers, the
intercom, earlier calls or the work are in: talk of a meeting in another language is about that meeting, not this call. To have a call in another
language, the board changes HQ's language and calls again.
${spokenAloud(lang)} When the board raises a
problem or asks for something, say what we'll do about it, and stop there: not who it goes to, what you don't know
yet, your guesses at the cause or how the work will go, unless the board asks. Every extra sentence is one it waits through.
When you give a time, say it plainly in one short natural sentence, never a bare time: "Ada's fix will be live at
twenty-five past two." Then only what the board must know about it (a real risk, a choice it has), never the working
behind it (how many rounds, what the plan counts, how far along someone is). Say it in the board's own time: ${boardClock()}
Never say a number for work aloud (a job, card, pull request, call, item or pin), not even once: the board can't see
them on a call, and hearing them makes the call run long. Say what the work is. The numbers in this
briefing and in your tools' answers are for your tools, and your written follow-up carries them.
${replies('the board')}, and the careful work is
your follow-up's, after the call.
You can look things up during the call: the search tool finds the Handbook, playbooks, notes, the shared craft library,
the board's earlier calls with everyone, the intercom and your own past work by meaning and by words, history lists your own recent work, call reads an earlier call
(yours or a colleague's) and its summary by its number, intercom reads the board's intercom chat (a day in full, or lines by words),
eta reads where planned work stands now (each deliverable's ETA, its window and slack, what it waits on, the board's
cards by name) and, with no query, what's going on right now: who's at work on what, why each runs while a hold is on, and
what each open card holds up, fresh each time (the briefing's list is from the call's start), activity reads what a job
or a colleague is doing this minute (its recent steps, statuses and messages, as the board sees them on its card in HQ), and
report reads the server's status report as your jobs do (jobs, pull requests and their findings, deploys, seats, errors and
each service's logs: its sections first, then one by words of its heading, or the lines with a job's number), git reads
the company's code on every branch, a job's unmerged work too (log, show, diff, grep), the company's files (main) are your
working directory for Grep, Glob and Read, and WebSearch and WebFetch search and read the web for what's outside the
company (a fact, a price, the news, a live page). Your answer is spoken, so never say or list its sources or links: say
what you found, and if the board asks where from, name the source in a few words.
When these can answer the board's question, look it up now and answer on the call, never "I'll check after the call": only
what they can't reach (ad platforms, a customer's details) or work too long for a call waits for the follow-up.
You manage the company's work on the call as you do off it, with the manage tool (hq's cancel, stop, pauses, the plan,
deliverables, windows, waits, the inbox, meetings, the desk phone's cards): when the board decides it, do it then and there
and say what you did, never leave it to your follow-up. ${WINDOW_FIRST} ${PAUSE_FOR}
Hand work to a colleague with the job tool: a short
title and the full brief, in their terms (it's all they get).${phone ? '' : " It's written in the call's notes too, so the board sees what reaches the team: for something you wrote down already, give its item instead."} Before queueing, use estimate to inspect past jobs' scopes
and clean actual times. You know this task's context: judge its size between comparable jobs and give job your size,
refs and why. With no comparable scope, give your reason and an empty refs list. ${DEFAULT_ESTIMATE_SCALE}
That estimate is saved once at queue
time. Only the CEO changes it when work slips. Use the same size with when. When the board adds to or changes a job you queued on this
call, put it into that job with add and its number, then and there: never a second job beside it, nor a note to add
it after the call. When the board's settled word matters to work already under way before the call ends (a running job,
or a pull request's review, by its number below), pass it on with reach, as often as the board's word needs; anything still
being worked out goes to the follow-up. Anything you tell the board you or a colleague will do, write down with write_down before you say
it's done; the team follows it up after the call and the board sees whether it happened.
${ONE_DEADLINE}
Never ask the board by when. If it named a time or you judge one sensible, set the deliverable's window as you
queue work or write its time down with write_down. Otherwise leave it untimed.
Before you give a time, check it, never a feeling: for work already planned, eta; for new work, the when tool, which
plays it into the plan, every seat and window counted (an AI hour is one agent working for an hour, waits for a seat left out). When the board names a time,
give it by: only when the work doesn't make it, say what would. When the board wants something by a time, that time is
yours to make: set its window as you queue it or release it (a resume or a lifted hold too, with manage's window), and
check it with when or eta before you tell the board anything. A time far past the board's is a problem to solve on the
call, never news to report: the tool's answer then says what to check.
${ONE_TIME}
When you tell the board a time,
write it down with write_down, and give the job that does it its item, or, for work already under way (a review, a
running job), name that job in it: it becomes the window of the work's deliverable at once, while you're still on the line,
so HQ orders its work by it. A time you give or offer is ours, even one the board takes: its slips are ours to plan
with and the board hears nothing of them. Only a time the board named itself, or asked for the work by, is the board's
(write_down with board_set): its miss, if nothing brings it back, is told once. Then set the time to tell the board as
its window (manage's window, without --board-set): it is ours from then on. If the board heard of this miss on a call
or the intercom already, only set the new window. A job with a time names its deliverable. Never tell the board that HQ will tell it if a time slips: it knows that rule.
New work shifts other work, and the board knows it: say nothing about shifts unless a time the board set itself will be
missed or the board asks. The job and when tools give each agreed deadline (a deliverable's window, a time the board was given) its
finish, its slack, and its slack some hours ago. A planned finish past the deadline is a slip: look for what brings the finish back.
When nothing does, say why the deadline cannot be met and what must change. A margin eaten but still made, or slack that keeps shrinking as work piles on, is yours to plan with: don't
mention it unless the board asks. Before you queue work that eats into a deadline, weigh how much it matters, how
much the board wants it now and how big the risk is, then queue it after that deadline's work (after) to
protect it, or now anyway: a real judgment each time, never a set line. Say a warning once: the earlier calls and the
intercom show what the board has already heard. A hand-off is done only when
the tool answers with a job number; never tell the board something was sent or forwarded otherwise. While a tool or a job
runs, the board hears a soft tick on the line, so you needn't announce it; keep the tool quick. Whatever you write before a tool is spoken at once and the board has heard it: after the
tool, carry on from there in the same reply, never say it again or start the reply over. When the board decides something,
confirm it in a few words: after the call you get the transcript and follow up. Once your business is done, stop there.
Never ask whether there's anything else or whether the board is done. If there's more, the board says so. Otherwise,
the board hangs up. When the board has clearly wrapped up the call (it said goodbye, asked you to end the call, or
thanked you to close it: "thank you, that's all"), say a short goodbye of your own that fits the call ("Thank you, talk
soon." is one example, not a set line) and end it with hang_up in the same reply: no recap of what was queued or noted
unless the board asks for one, nothing about deadlines. A thank-you while the business is still going (a
question of yours unanswered, a decision still to make, the board still explaining, or a new ask in the same words) is
no wrap-up: carry on. Never on a pause, and when you're unsure, stay on the line: the board can always hang up. If you
don't know something, say so.
Only state what's in front of you (this briefing, or a file you just read). Don't fill in details about work in
progress (who is on it, what's queued, when it's done) that you haven't checked: check with a tool, or say plainly
you haven't checked. A wrong detail on the phone means a correction afterwards.
Fixes to how the company itself works (calls and this phone line, hand-offs, orchestration, knowledge search, HQ and
the coordinator) are the Process team's to build, through the normal review: they go to ${findAgent(roles().process)?.name ?? roles().process} as a job. Never offer to
write a brief for the board's own Claude Code; that's for quick fixes the board chooses to make itself.
${recognised('the board')}
${phone ? '' : `The board can also show you pictures on screen during the call: they come with its words, or on their own with a short note.
You see its screen only while it shows it to you. When the board talks about something on its screen that you can't see,
ask to see it with ask_to_see then and there: that one step asks, and the board answers yes or no. Never tell it which
button to tap. Only what the board raised or agreed to goes in the call's notes or into work: something you notice on
your own, in a picture of its screen too (your copy can differ from what it sees), ask about first ("I see X, is that
on your screen too?") and note it only once the board says so.
The call's notes, its page in the board's Notebook, are yours to work as the board does, though its Undo takes back only
its own strokes, never yours: write down each change it asks for with write_down. By default a note carries a picture of
what the change is about, from one of the board's own notes or from the board's screen. Leave the picture out only for a
change about the notes themselves or when there's nothing to show; mark_notes circles, points at or highlights what you
mean; draw_picture puts a diagram or chart of yours in them as a picture, when the board wants to see something drawn;
change_note fixes a note of yours, moves or deletes what's there (read_notes first for anything you didn't just write). When the board asks to see a few versions of a change, write it down and start a try on it: its owner builds
them, and they appear under it.
The notes are about the call's subject, for someone who reads them later without the call: what's talked over (an
idea, a point, someone's view of how it should be) goes in as a small sketch of it beside full sentences of what was
said, by whom and why (draw_picture), not keywords. When you organise them again, the new notes take the old ones'
place (change_note deletes them), never a second list beside them. Something to be done outside the subject (a fault
in our own tools on a call about a product) goes on the call's list alone: write_down with page false.
The board scribbles on its screen to show you things ("move this here"): each scribble comes with its turn as a note of
its own, its picture the page around the ink. It's for you: nothing of it goes in the call's notes by itself. From what
the board says, write down what's worth keeping (from: 'note 3', the board's own note by the number the line gave it)
and let the rest be: not everything has to be written down. Its ink goes from the board's screen once your turn is done, so it can circle afresh.
What the board draws in the call's notes comes to you alone, once it stops drawing: nobody else answers it there. On your
own scraps and versions it points the same way (a choice on a card of yours circled, something crossed out), and goes
from the page once your turn on it is done: keep what it settles in your notes.
`}${agent === ceo() && unstaffed() ? `The company has no team yet besides you. Hand out no work on this call: after it, your follow-up hires the
team first and gives the work to the new people (company/playbooks/founding.md). Tell the board that's what happens next.
` : ''}
${read('AGENTS.md').trim()}
`;
}

// The board's clock (org.yaml's company.timeZone): what the call says is on it, as the tools' answers are (the voice line
// gives their hq the zone: guard.py agent_env); what the agent gives the tools is on it too, with its date and no zone
// (windows.ts parse).
function boardClock(now = Date.now()) {
  const zone = timeZone();
  const clock = (options: Intl.DateTimeFormatOptions, at = now) =>
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', ...options }).format(at);
  const there = clock({ weekday: 'short', day: 'numeric', month: 'short', timeZone: zone });
  const change = clockChange(zone, now);
  const next = change
    ? ` Its clocks change at ${clock({ weekday: 'short', day: 'numeric', month: 'short', timeZone: zone }, change)}: a time after that converts at its new offset.`
    : '';
  return `it lives on ${zone} time, where it's ${there} now (${clock({ timeZone: 'UTC' })}).${next} Your tools'
answers name each time's zone, on the board's clock where they can: one marked UTC is UTC, so convert it before you say it. Give
a tool (by, deadline) the board's own time as it said it, with its date and no zone (2026-10-26 09:00): HQ reads it on the
board's clock at that date's offset. A time with Z, or a time of day alone (14:30), is UTC.`;
}
// The first moment the zone's offset from UTC changes (summer or winter time) within the next half year, or none
const HALF_YEAR_MS = 183 * 86_400_000;
function clockChange(zone: string, now: number) {
  const offsets = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' });
  const offsetAt = (at: number) => offsets.formatToParts(at).find(p => p.type === 'timeZoneName')?.value;
  const before = offsetAt(now);
  let day = now;
  while (day - now < HALF_YEAR_MS && offsetAt(day + 86_400_000) === before) day += 86_400_000;
  if (day - now >= HALF_YEAR_MS) return undefined;
  // (to the minute between the last day on the old offset and the first on the new)
  let lo = day, hi = day + 86_400_000;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (offsetAt(mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Their own recent work, so a call about something they did finds it: jobs finished, the rest of the last day by title,
// and their latest desk phone requests. A report or card marked before as a customer's stays with the job working on it
// (jobs.ts holdsCustomerData): the call has no job. Both reads go by jobs_finished_work (db.ts), the last finished first,
// never every work job's row.
function recentWork(agent: string, call: number) {
  const caller = { id: 0, agent, callId: call };
  const report = (j: Record<string, any>) => {
    if (!readsReport({ id: j.id, customers: j.customers }, caller)) return `(${REPORT_LEFT_OUT})`;
    return cut(j.result, 500) || 'no report';
  };
  const done = (db.prepare(`select j.id, j.title, j.step, j.round, j.status, j.result, j.customers, (select number from prs
    where branch = coalesce(j.branch, 'job/' || j.id) order by number desc limit 1) pr from jobs j indexed by jobs_finished_work
    where j.agent = ? and j.kind = 'work' and j.status in ('done', 'failed') order by coalesce(j.finished, j.created) desc, j.id desc limit 8`).all(agent) as Record<string, any>[])
    .map(j => `- Job #${j.id}, ${nameOf(j as { title: string })} (${j.status}${j.pr ? `, PR #${j.pr}` : ''}): ${report(j)}`).join('\n') || '- none';
  // The rest of the last day, titles only, up to 40 lines. History and search have the reports.
  const day = new Date(Date.now() - 24 * 3600_000).toISOString();
  const today = db.prepare(`select j.id, j.title, j.step, j.round, j.status, (select number || ' ' || status from prs where branch = coalesce(j.branch, 'job/' || j.id)
    order by number desc limit 1) pr from jobs j indexed by jobs_finished_work where j.agent = ? and j.kind = 'work' and j.status in ('done', 'failed') and coalesce(j.finished, j.created) >= ?
    order by coalesce(j.finished, j.created) desc, j.id desc limit 41 offset 8`).all(agent, day) as Record<string, any>[];
  const earlier = today.slice(0, 40).map(j => `- Job #${j.id}, ${nameOf(j as { title: string })} (${j.status}${j.pr ? `, PR #${j.pr}` : ''})`).join('\n')
    + (today.length > 40 ? '\n- …and more: history lists them all' : '');
  const answer = (r: Record<string, any>) => {
    if (!r.answer || !readsCard(r.id, caller)) return '';
    return `. The board answered: ${cut(r.answer, 1500)}`;
  };
  const asked = (db.prepare(`select r.id, r.title, r.status, r.answer from requests r left join jobs j on j.id = r.job
    where coalesce(j.agent, r.agent) = ? and r.kind != 'login' order by r.id desc limit 5`).all(agent) as Record<string, any>[])
    .map(r => `- #${r.id}, ${r.title} (${r.status})${answer(r)}`).join('\n') || '- none';
  return `## Your own recent work
The last jobs you finished (most recent first; their report is their last message):
${done}
${earlier ? `Also finished in the last day (titles; history '#n' has the report):\n${earlier}\n` : ''}Your latest desk phone requests to the board:
${asked}
Work whose pull request is still open isn't on main yet, so it isn't in the files you can read, but history has its
report. If the board asks about something you did that isn't here, look it up now with history (a few words, or
'#n') or search, and answer from what they show; only if neither finds it, say so.

`;
}

// The company right now: the team, what's going on (goingon.ts: who's at work, the holds, the desk phone's cards and what
// waits on each), work and reviews queued, the intercom's latest and the newest decisions
function companyNow(agent: string) {
  const rows = (sql: string) => db.prepare(sql).all() as Record<string, string>[];
  // (by number, for reach and add: what's running is in goingon's list; step, round: a job's name, nameOf.)
  const jobs = rows("select id, agent, title, step, round, status from jobs where status in ('queued', 'blocked') and kind in ('work', 'chat') order by id desc limit 15")
    .map(j => `- #${j.id}, ${j.agent}: ${nameOf(j as { title: string })} (${j.status})`).join('\n') || '- none';
  // Only reviews that can start: one a paused project or thread holds waits with that pause (goingon lists the pauses),
  // never as a backlog of reviews. (heldWith: the claim's own hold.)
  const reviews = rows(redraws.query(`select id, agent, title, step, round, status from jobs j where status = 'queued'
    and kind in ('review', 'consolidate') and ${heldWith('j')} is null order by id desc limit 10`))
    .map(j => `- #${j.id}, ${j.agent}: ${nameOf(j as { title: string })} (${j.status})`).join('\n') || '- none';
  const team = (org().departments ?? []).flatMap((d: any) => (d.agents ?? []).filter((a: any) => !a.temp).map((a: any) => `- ${a.name}${a.pronouns ? ` (${a.pronouns})` : ''}: ${titleOf(a, '')} (${d.name})`)).join('\n');
  // a call's transcript and a desk phone answer stay with the jobs that hear them: the briefing only says they happened.
  // The intercom's latest lines, on every call. A call shows only by its title. Each line whole up to 2,000 characters (a
  // long paste says where it's cut: fit() keeps the whole prompt one argument). Before them, the board's other lines
  // today by their first words: the intercom tool reads any of them whole.
  const LATEST = 8;
  const talk = chat.lines(LATEST).map(m => m.who === 'call' ? `(${m.text})`
    : `${m.who === 'board' ? 'Board' : findAgent(ceo())?.name ?? 'the CEO'}: ${chat.withPictures(cut(m.text, 2000), m.pictures)}`).join('\n');
  const boardToday = intercom.boardToday(LATEST);
  const earlierToday = !boardToday.lines.length ? '' : `Earlier today, the board's lines by their first words${boardToday.more ? ` (the latest ${boardToday.lines.length}; ${boardToday.more} more before them)` : ''}:
${boardToday.lines.map(l => `- ${l}`).join('\n')}
`;
  return `## The company right now
The team:
${team}

${goingon.words(forecast.current())}
${agent === ceo() ? heartbeatPart() : ''}Queued or waiting for the board (the newest):
${jobs}
Reviews queued (one a paused project or deliverable holds waits with its pause, so it isn't listed here):
${reviews}
The intercom chat, the board's typed conversation with the CEO. Everything ever said there is there to look up (the
intercom tool, and search): before you tell the board something wasn't asked or written down, look there.
${earlierToday}Latest in the intercom chat:
${talk || '(nothing yet)'}

## Recent decisions
${decisions(read('company/DECISIONS.md'))}`;
}

// A call with the CEO has its heartbeat at hand: its page (pad.ts), its memory across its work, and the goals as the
// hourly check reads them (goals.ts). The call writes on the page with its page tool as the board settles things, and
// its follow-up adds what the call missed (ledger.ts brief).
function heartbeatPart() {
  const goalLines = goals.lines(forecast.current());
  const pageText = `${padBriefing("put it on the page with the page tool the moment it's settled, so it holds before this call's follow-up, which adds what the call missed")}\n`;
  return `${pageText}Our goals:\n${goalLines.map(l => `- ${l}`).join('\n') || '- none marked yet (hq project goal)'}\n`;
}

const cut = (t: string | null, n: number) => { const s = (t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n).trimEnd()}… (cut here)` : s; };

// A profile is hundreds of lines, oldest work first: the call gets who they are, their newest track record and the top
// of their working memory, and is told what's left out (the first 40 lines were the oldest entries).
function profile(text: string, recent = 8, memory = 30) {
  if (!text.trim()) return '(no profile yet)';
  const head = text.split(/^## /m)[0].trim(), items = (t: string) => t.split(/\n(?=- )/).filter(Boolean);
  const track = items(section(text, 'Track record')), mem = section(text, 'Working memory').split('\n');
  const more = (n: number, what: string) => n > 0 ? `\n(${n} ${what} left out here: search or read your profile for them.)` : '';
  return `${head}\n\n### Personality\n${section(text, 'Personality')}\n\n### Track record, newest\n${track.slice(-recent).join('\n')}${more(track.length - recent, 'older entries')}`
    + `\n\n### Working memory\n${mem.slice(0, memory).join('\n')}${more(mem.length - memory, 'more lines')}`;
}

// DECISIONS.md is newest first and far longer than a call needs: the newest entries whole, up to about 16,000
// characters, and a line saying how many older ones there are (it used to stop silently after 50 lines).
function decisions(text: string, budget = 16_000) {
  const [top, ...entries] = text.split(/^(?=## )/m);
  let used = 0, n = 0;
  while (n < entries.length && (n === 0 || used + entries[n].length <= budget)) used += entries[n++].length;
  return entries.slice(0, n).join('').trim() + (n < entries.length ? `\n\n(${entries.length - n} older entries aren't shown here: search for them, or read company/DECISIONS.md.)` : '') || top.trim();
}
