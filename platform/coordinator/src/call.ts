// Calls with the team, for the voice line (platform/voice): the agent's prompt on the phone (who they are, how to
// talk, the company as it is right now), and after the call the transcript goes to a follow-up job, which records what
// was said as items and hands them out (the call ledger, ledger.ts). Every call is logged for HQ's computer.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.ts';
import { REPO_DIR } from './config.ts';
import * as chat from './chat.ts';
import * as intercom from './intercom.ts';
import { findAgent, nameOf, boardId, callModel, callSeat, readsReport, readsCard, REPORT_LEFT_OUT, extendJob, handedCustomerData } from './jobs.ts';
import * as messages from './messages.ts';
import { customerCall } from './memory.ts';
import * as ledger from './ledger.ts';
import * as review from './review.ts';   // (reach)
import * as pictures from './pictures.ts';
import * as feedback from './feedback.ts';
import { heldFor, isHidden } from './later.ts';
import { org, ceo, names, roles, timeZone, unstaffed, companyTime, titleOf, respellings } from './company.ts';
import { LANGUAGES, type BoardLanguage } from './language.ts';

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
// start (status live) and the token is bound to it, so what's recorded during the call (a promise) belongs to it and
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
// voice line. phone: a call on the phone line (Twilio), which has no screen to share pictures on.
// What the line itself says when the agent can't answer: whether a Claude seat has room now (callSeat), and the company's
// clock for the time a limit ends. respell: the company's words as the speech engines should say them (company.ts).
const line = () => ({ seat: callSeat(), timeZone: timeZone(), respell: respellings() });
// pins: the review notes the board ticked when it rang from HQ's Reviews (feedback.ts pinsFor): the call is about them,
// for good (a restart reads them from the call, not the line), and the voice line gets their screenshots (pins in the
// answer). Ones sent or discarded since HQ showed them don't come; if none are left, it's a call like any other.
// lang: the board's language (language.ts) as HQ or the phone line read it when the call started, which the voice line
// speaks and hears in: one it doesn't know is English.
const spoken = (lang: string): BoardLanguage => Object.hasOwn(LANGUAGES, lang) ? lang as BoardLanguage : 'en';
export function context(agent: string, lang: string, request = 0, again = '', phone = false, pins: unknown = null) {
  const who = findAgent(agent);
  if (!who || who.temp || boardId(agent)) return 404;
  const live = again ? db.prepare(`select c.id, c.request, c.resumes, t.listed from call_tokens t join calls c on c.id = t.call and c.agent = t.agent
    where t.hash = ? and t.agent = ? and t.expires > ? and c.status = 'live'`).get(sha256(again), agent, Date.now()) as { id: number; request: number | null; resumes: string | null; listed: string } | undefined : undefined;
  // A restart whose call has ended (handed over, expired or swept) is refused, never a new call: the voice line restarts
  // an agent whose reply the hang-up cut off, and a new call there would have a token nothing ever hands back.
  if (again && !live) return 409;
  const req = about(agent, live ? live.request ?? 0 : request);
  if (live) {  // a restart
    const pinned = feedback.pinsOf(live.id);
    const p = heard(prompt(spoken(lang), agent, req, live.id, phone, pinned, JSON.parse(live.resumes ?? '[]'))), listed = [...new Set([...JSON.parse(live.listed) as number[], ...p.listed])];
    db.prepare('update call_tokens set listed = ? where hash = ?').run(JSON.stringify(listed), sha256(again));
    return { prompt: p.text, token: again, call: live.id, key: pictures.callKey(sha256(again)), voice: who.voice, ...callModel(), ...line(),
      pins: feedback.shots(pinned) };
  }
  const token = randomBytes(32).toString('base64url');
  db.prepare('delete from call_tokens where expires < ?').run(Date.now() - 86400e3);
  const earlier = unfinished(agent);
  const call = Number(db.prepare("insert into calls (ts, agent, request, lines, status, resumes) values (?, ?, ?, '[]', 'live', ?)")
    .run(new Date().toISOString(), agent, req?.id ?? null, earlier.length ? JSON.stringify(earlier) : null).lastInsertRowid);
  const pinned = pins == null ? [] : feedback.pinsFor(pins) ?? [];
  feedback.pin(call, pinned);
  const p = heard(prompt(spoken(lang), agent, req, 0, phone, pinned, earlier, call));
  db.prepare('insert into call_tokens (hash, agent, expires, call, listed) values (?, ?, ?, ?, ?)')
    .run(sha256(token), agent, Date.now() + CALL_MS, call, JSON.stringify(p.listed));
  // call: HQ watches its follow-up by it. key: HQ's picture uploads for this call carry it (pictures.ts)
  return { prompt: p.text, token, call, key: pictures.callKey(sha256(token)), voice: who.voice, ...callModel(), ...line(),
    pins: feedback.shots(pinned) };
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
    const pinned = feedback.pinsOf(c.id);
    if (pinned.length) text += `\nThe board's review pins it was about:${pinned.map(n => `\n- Pin #${n.id} on ${n.page}: ${cut(n.note, 300)} (${n.status === 'pending' ? 'waiting in HQ' : n.status})`).join('')}`;
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
export const callAgent = (token: string) => token ? db.prepare('select agent, call, listed from call_tokens where hash = ? and expires > ?')
  .get(sha256(token), Date.now()) as { agent: string; call: number | null; listed: string } | undefined : undefined;

// A job the call queued (hq job from its token): its agent may add to it until the call ends (addToJob).
export const queuedOn = (call: number, job: number) =>
  db.prepare("update call_tokens set queued = json_insert(queued, '$[#]', ?) where call = ?").run(job, call);
// Whether the call queued that job (queuedOn), and why a work job the call names for `to` isn't theirs: a misheard
// number names someone else's (a promise's job: server.ts promisedWork; reach checks it too).
export function queuedHere(call: number | undefined, job: number) {
  const queued = call ? (db.prepare('select queued from call_tokens where call = ?').get(call) as { queued: string } | undefined)?.queued : undefined;
  return (JSON.parse(queued ?? '[]') as number[]).includes(job);
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
// jobs: any other is the follow-up's, from the transcript. On a customer's call, the job that gets the words holds their
// details, as does a job the message becomes (messages.toJob). A refusal is [status, why], or a bare status from send.
type Added = { job: number; agent: string; added: 'brief' | 'message' | 'job'; message?: number; became?: number };
export function addToJob(me: { agent: string; callId?: number }, id: number, text: string): Added | [number, string] | number {
  text = text.trim();
  if (!text) return [400, 'say what the board added or changed'];
  if (text.length > messages.MAX) return [413, `too long (${text.length.toLocaleString('en')} > ${messages.MAX.toLocaleString('en')}): keep the addition short; the follow-up has the whole call`];
  const call = me.callId;
  if (!call || !queuedHere(call, id))
    return [409, `job #${id} wasn't queued on this call: only a job you queued on it takes an addition now. The call's follow-up adds to any other from the transcript`];
  const job = db.prepare('select agent, title, status from jobs where id = ?').get(id) as { agent: string; title: string; status: string };
  const customers = customerCall(call);
  if (extendJob(id, `${me.agent}, on a call with the board`, text) !== 404) {
    if (customers) handedCustomerData(id);
    return { job: id, agent: job.agent, added: 'brief' };
  }
  if (['done', 'failed', 'cancelled'].includes(job.status))
    return [409, `job #${id} has ${job.status === 'done' ? 'finished' : `been ${job.status === 'failed' ? 'stopped' : 'cancelled'}`}. If the board still wants it, queue it as a new job with the whole brief`];
  const message = `An addition to your job #${id} (${job.title}), from ${me.agent}'s call with the board (call #${call}), where it was queued. `
    + `It's part of the brief: act on it with the rest.\n\n${text}`;
  if (message.length > messages.MAX) return [413, `too long for a job that has started (${text.length.toLocaleString('en')} characters, and the note around it counts): keep the addition short; the follow-up has the whole call`];
  const sent = messages.send({ agent: me.agent, job: null, call, customers }, job.agent, message, id);
  if (sent === 429) return [429, `this call has added ${messages.PER_HOUR} times in the past hour: put the rest in one addition, or leave it to the call's follow-up`];
  if (typeof sent === 'number') return sent;
  if (sent.state === 'queued') {
    if (customers) handedCustomerData(id);   // its session reads the customer's words at its next step
    return { job: id, agent: job.agent, added: 'message', message: sent.id };
  }
  return { job: id, agent: job.agent, added: 'job', message: sent.id, became: sent.job };
}

// As often as the board's word needs, with the recipient checked to catch a
// misheard number. Reviews take guidance only before starting. It's in the call agent's words, which the follow-up
// checks against the transcript (ledger.ts reached).
type ReachedJob = { id: number; agent: string; title: string; step: string | null; status: string; kind: string; engine: string | null; session: string | null; pr: number | null; round: number | null; branch: string | null };
type Reached = { job: number; agent: string; item: number; message?: number; pr?: number; round?: number; ruling?: 'started' | 'later' };
export function reach(me: { agent: string; callId?: number }, to: string, id: number, what: string, text: string): Reached | [number, string] {
  const call = me.callId;
  text = text.trim(); what = what.trim();
  if (!call) return [403, 'only a call reaches work under way'];
  if (!text) return [400, 'say what the job needs to know'];
  if (!ledger.oneLine(what, ledger.WHAT)) return [400, `what needs one plain line of at most ${ledger.WHAT} characters: the board reads it`];
  if (customerCall(call)) return [409, "a call about a customer's details passes nothing on mid-call: the follow-up does, from the call"];
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
    const item = ledger.reached(call, { owner: to, what, words: text, job: work.id, ref: `sent on call #${call} to PR #${job.pr}'s review` });
    return { job: id, agent: to, item, pr: job.pr!, round: job.round ?? 0, ruling: review.rulingBegun(job.pr!, job.round ?? 0) };
  }
  if (!going) return [409, `job #${id}, ${nameOf(job)}, isn't running (${job.status === 'blocked' ? 'it waits for the board' : job.status}): the follow-up passes it on`];
  if (job.engine !== 'claude') return [409, `job #${id} runs on ${job.engine === 'codex' ? 'Codex' : job.engine}, which can't take a message mid-job: the follow-up passes it on`];
  const message = `From ${me.agent}'s call with the board (call #${call}), for your job #${id} (${nameOf(job)}) while it runs: the board's word on `
    + `this work as it stands now, in ${me.agent}'s words. Weigh it with your brief, as the board's. The call's follow-up checks it against `
    + `the call's transcript, and tells you if it was misheard.\n\n${text}`;
  if (message.length > messages.MAX) return [413, `too long (${text.length.toLocaleString('en')} characters, and the note around it counts): keep it to what the job needs now`];
  const sent = messages.send({ agent: me.agent, job: null, call, customers: false }, to, message, id);
  if (typeof sent === 'number') return [sent, sent === 429 ? `this call has sent ${messages.PER_HOUR} messages in the past hour` : 'HQ refused it'];
  const item = ledger.reached(call, { owner: to, what, words: text, job: id, ref: `sent on call #${call} as message #${sent.id}` });
  return { job: id, agent: to, item, message: sent.id };
}

// The call ended: its row gets the transcript, and its first follow-up (ledger.ts). A call where nobody spoke and
// nothing was recorded leaves nothing behind.
export function handOver(agent: string, lines: string[], request = 0, token = '') {
  const bound = token ? (db.prepare('select call from call_tokens where hash = ?').get(sha256(token)) as { call: number | null } | undefined)?.call : undefined;
  if (token) db.prepare('delete from call_tokens where hash = ?').run(sha256(token));
  const was = bound ? db.prepare('select id, status, lines from calls where id = ? and agent = ?').get(bound, agent) as { id: number; status: string; lines: string } | undefined : undefined;
  // A late transcript (the sweep ended the call) goes to that call (ledger.late); one whose call isn't found (its token
  // unknown, or swept a day after it expired) gets a new row.
  const req = about(agent, request);
  if (was?.status === 'ended' && was.lines === '[]' && lines?.length) { ledger.late(was.id, lines); return { ok: true }; }
  const live = was?.status === 'live' ? was.id : undefined;
  const recorded = live ? ledger.items(live).length > 0 : false;
  if ((!lines?.length && !recorded) || !findAgent(agent)) {
    if (live) { db.prepare('delete from calls where id = ?').run(live); pictures.forgetCall(live); }   // (its number can come back)
    return { ok: true };
  }
  const ts = new Date().toISOString();
  const id = live ?? Number(db.prepare("insert into calls (ts, agent, lines) values (?, ?, '[]')").run(ts, agent).lastInsertRowid);
  db.prepare("update calls set ts = ?, lines_at = ?, request = ?, lines = ?, status = 'ended' where id = ?")
    .run(ts, ts, req?.id ?? null, JSON.stringify(lines ?? []), id);
  ledger.followUp(id);
  return { ok: true };
}

// The call log for HQ's computer: each call, its follow-up (the reply it set, ledger.ts reply) and what the team
// took from it (each item's plain line and where it stands). Never the transcript, nor the words an item quotes: the
// board is never shown its own transcripts (DECISIONS.md, 2026-09-28).
export const calls = () => (db.prepare(`select c.id, c.ts, c.agent, c.request, c.job, c.status as state, c.processed_at is not null as processed, c.attempts, j.status, c.reply
  from calls c left join jobs j on j.id = c.job where c.status != 'live' order by c.id desc limit 30`).all() as any[])
  .map(c => ({ ...c, ...ledger.forBoard(c.id) }));

// On the phone: who they are, how to talk, and the company as it is right now; listed: the open items it numbers, and
// where each one's line ends. The open items come before the parts that can grow (the company right now), so an
// over-long briefing cuts those first (fit()).
// `restarted`: the call this session takes over (context()), and what's on its list already. pins: the review notes the
// call is about. carried: the calls it carries on from (carriedOn()), and `call` this one.
function prompt(lang: BoardLanguage, agent: string, req?: Req, restarted = 0, phone = false, pins: any[] = [], carried: number[] = [], call = restarted) {
  const head = `${instructions(lang, agent, phone)}
## You
${profile(read(`company/people/${agent.replace(/[^a-z0-9-]/g, '')}.md`))}

${recentWork(agent)}${req ? `## What this call is about
Your own desk phone request to the board, #${req.id}: ${req.title}
${req.body.length > 20_000 ? `${req.body.slice(0, 20_000).trimEnd()}… (cut here: the request has ${req.body.length.toLocaleString('en')} characters)` : req.body}
After the call you get the transcript, and ${req.status === 'open' ? "the request stays on the board's desk phone until you close it" : `the request is off the board's desk phone already (${req.status})`}.
${req.kind === 'credential' ? `It asks for keys. Help the board find them, but never ask them to read a key, password or code out loud: they go in the fields on the desk phone (you never see them). If the board starts reading one out, stop them.\n` : ''}
` : ''}${restarted ? `## Already noted on this call
Your session on this call stopped and was restarted: it's still the same call. What was noted on it so far is on its
list already, so don't note it again (replace one to change it):
${ledger.items(restarted).map(i => `- #${i.id}: ${i.what} (${i.kind} for ${i.owner}, ${i.status})`).join('\n') || '- nothing yet'}

` : ''}` + feedback.pinsText(pins);   // the board's pins, on a call about them
  const open = ledger.stillOpen(8, [restarted, ...carried]);
  const now = companyNow();
  const before = carriedOn(carried, call, ARG_BYTES - Buffer.byteLength(`${head}${open.text}${now}`));
  const text = `${head}${open.text}${before.text}${now}`;
  return { text, listed: [...open.listed.map(l => ({ id: l.id, end: head.length + l.end })),
    ...before.listed.map(l => ({ id: l.id, end: head.length + open.text.length + l.end }))] };
}

// Who they are on the call and how to talk: the call's rules, then AGENTS.md
// eslint-disable-next-line max-lines-per-function -- one template of words, the call's instructions: a data table in prose
function instructions(lang: BoardLanguage, agent: string, phone: boolean) {
  const who = findAgent(agent)!, name = String(who.name ?? agent), role = titleOf(who);
  const pron = who.pronouns ? ` (${who.pronouns})` : '';
  // "Answer directly without deliberating": a call's model always thinks when it judges it useful (Opus 5.5 can't turn
  // thinking off; effort is low) and the board waits through it; Anthropic's advice for a fast first token is this line
  // (and the pictures sentence: the voice line shows the agent what the board shares on HQ's call screen. A phone call
  // has no screen.)
  // a time told on the call goes on the promise, which its job carries, or the work under way it names (askwindow.ts).
  // The board's ask gets a time as it's queued, else it waits behind every window: the board's own, or the window of
  // the deliverable it serves (its thread's, or one that needs it); with neither, the agent judges a time itself (noted
  // with promise) or leaves it untimed, and never asks the board by when.
  // A time from the when tool: the work played into the plan (when.ts).
  // Where planned work stands: the eta tool (voice hq_tools.py, outlooks.ts findOutlooks).
  // hang_up: the agent ends the call once the board has clearly said goodbye (the voice line's Call.leave), with a
  // goodbye in its own words.
  // add: what the board adds to a job the call queued goes into it (addToJob).
  // reach: the board's settled word to work under way, for real need only, as often as the board's word needs
  // No numbers aloud: the briefing and the tools number the work for the agent's tools, never for the board's ears.
  // Every tool answer says it again (voice hq_tools.py ALOUD). (the answer first, an example, plain times)
  // WebSearch is enabled by guard.TOOLS.
  // Shifted work: the job and when tools give each agreed deadline's facts (deadlines.ts); the board hears of shifts
  // only when an agreed deadline moves or it asks; whether one is safe or tight and where new work goes is the agent's
  // judgment, never a rule in the tool, and nothing records what was said: earlier calls and the intercom show it.

  return `You are ${name}${pron}, ${role} at ${names().name}, an AI-run company. You're on a live voice call with the board (the human owner).
Your words are spoken aloud: reply in one to three short spoken sentences, in plain words, the answer first. No
lists, markdown, emoji or links. Be warm and direct, and ask one question when you need to. Speak ${LANGUAGES[lang].name}.
When you give a time, say it plainly ("this evening", "in about an hour"). For example: "I've queued that for Ada; you'll see it this
evening."
Never say a number for work aloud (a job, card, pull request, call, item or pin), not even once: the board can't see
them on a call, and hearing them makes the call run long. Say what the work is and whose it is. The numbers in this
briefing and in your tools' answers are for your tools, and your written follow-up carries them.
Answer directly without deliberating: the board hears every second before your first word, and the careful work is
your follow-up's, after the call.
You can look things up during the call: the search tool finds the Handbook, playbooks, notes, the shared craft library,
the board's earlier calls with everyone, the intercom and your own past work by meaning and by words, history lists your own recent work, call reads an earlier call
(yours or a colleague's) and its summary by its number, intercom reads the board's intercom chat (a day in full, or lines by words),
eta reads where planned work stands now (a project's or thread's ETA, its window and slack, what it waits on), and
the company's files (main) are your working directory for Grep, Glob and Read, and WebSearch searches the web for what's
outside the company (a fact, a price, the news).
When these can answer the board's question, look it up now and answer on the call, never "I'll check after the call": only
live state they can't see (logs, the servers, ad platforms) or work too long for a call waits for the follow-up.
Hand work to a colleague with the job tool: a short
title and the full brief, in their terms (it's all they get). Before queueing, use estimate to inspect past jobs' scopes
and clean actual times. You know this task's context: judge its size between comparable jobs and give job your size,
refs and why. With no comparable scope, give your reason and an empty refs list. That estimate is saved once at queue
time. Only the CEO changes it when work slips. Use the same size with when. When the board adds to or changes a job you queued on this
call, put it into that job with add and its number, then and there: never a second job beside it, nor a promise to add
it after the call. When the board's settled word matters to work already under way before the call ends (a running job,
or a pull request's review, by its number below), pass it on with reach, as often as the board's word needs; anything still
being worked out goes to the follow-up. Anything you promise goes in with promise before you say
it's done; the team follows it up after the call and the board sees whether it happened. Work the board asks for gets
its time as it's queued, or it waits behind every window: the time the board names, or the window of the deliverable it
serves (queue it on that deliverable's thread, or a thread it needs: the job tool's answer says what it serves). When it
has neither, the job tool's answer says so: never ask the board by when. When it wants the work soon or by a time, it
says so or the call makes it clear; otherwise the time is your judgment: set a sensible one (the when tool's) and note it
with promise, or leave the work untimed.
Before you give a time, check it, never a feeling: for work already planned, eta; for new work, the when tool, which
plays it into the plan, every seat and window counted (an AI hour is one agent working for an hour, waits for a seat left out). When the board names a time,
give it by: only when the work doesn't make it, say what would. Give one plain time. When you tell the board a time,
note it with promise, and give the job that does it its item, or, for work already under way (a review, a running
job), name that job in the promise: it becomes the window of the work's thread at once, while you're still on the line,
so HQ orders its work by it and the CEO sees it if it slips. A job with a time names its thread. Never tell the board that HQ will tell it if a time slips: it knows that rule.
New work shifts other work, and the board knows it: say nothing about shifts unless an agreed deadline moves or the
board asks. The job and when tools give each agreed deadline (a thread's window, a time the board was given) its
finish, its slack, and its slack some hours ago. When its finish lands past the deadline, the deadline moves: say so
plainly. A margin eaten but still made, or slack that keeps shrinking as work piles on, is yours to plan with: don't
mention it unless the board asks. Before you queue work that eats into a deadline, weigh how much it matters, how
much the board wants it now and how big the risk is, then queue it after that deadline's work (after) to
protect it, or now anyway: a real judgment each time, never a set line. Say a warning once: the earlier calls and the
intercom show what the board has already heard. A hand-off is done only when
the tool answers with a job number; never tell the board something was sent or forwarded otherwise. While a tool, job or
promise runs, the board hears a soft tick on the line, so you needn't announce it; keep the tool quick. Whatever you write before a tool is spoken at once and the board has heard it: after the
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
The board's words reach you through speech recognition, which can turn background noise or other people talking
into words: if what you hear seems garbled, unrelated or not addressed to you, say you didn't catch that.
${phone ? '' : `The board can also show you pictures on screen during the call: they come with its words, or on their own with a short note.
`}${agent === ceo() && unstaffed() ? `The company has no team yet besides you. Hand out no work on this call: after it, your follow-up hires the
team first and gives the work to the new people (company/playbooks/founding.md). Tell the board that's what happens next.
` : ''}
${read('AGENTS.md').trim()}
`;
}

// Their own recent work, so a call about something they did finds it: jobs finished, the rest of the last day by title,
// and their latest desk phone requests. A report or card about a customer stays with the job working on it (jobs.ts
// Reader): the call has no job.
function recentWork(agent: string) {
  const caller = { id: 0, agent };
  const report = (j: Record<string, any>) => {
    if (!readsReport({ id: j.id, customers: j.customers }, caller)) return `(${REPORT_LEFT_OUT})`;
    return cut(j.result, 500) || 'no report';
  };
  const done = (db.prepare(`select j.id, j.title, j.step, j.round, j.status, j.result, j.customers, (select number from prs
    where branch = coalesce(j.branch, 'job/' || j.id) order by number desc limit 1) pr from jobs j
    where j.agent = ? and j.kind = 'work' and j.status in ('done', 'failed') order by coalesce(j.finished, j.created) desc, j.id desc limit 8`).all(agent) as Record<string, any>[])
    .map(j => `- Job #${j.id}, ${nameOf(j as { title: string })} (${j.status}${j.pr ? `, PR #${j.pr}` : ''}): ${report(j)}`).join('\n') || '- none';
  // The rest of the last day, titles only, up to 40 lines. History and search have the reports.
  const day = new Date(Date.now() - 24 * 3600_000).toISOString();
  const today = db.prepare(`select j.id, j.title, j.step, j.round, j.status, (select number || ' ' || status from prs where branch = coalesce(j.branch, 'job/' || j.id)
    order by number desc limit 1) pr from jobs j where j.agent = ? and j.kind = 'work' and j.status in ('done', 'failed') and coalesce(j.finished, j.created) >= ?
    order by coalesce(j.finished, j.created) desc, j.id desc limit 41 offset 8`).all(agent, day) as Record<string, any>[];
  const earlier = today.slice(0, 40).map(j => `- Job #${j.id}, ${nameOf(j as { title: string })} (${j.status}${j.pr ? `, PR #${j.pr}` : ''})`).join('\n')
    + (today.length > 40 ? '\n- …and more: history lists them all' : '');
  const asked = (db.prepare(`select r.id, r.title, r.status, r.answer from requests r left join jobs j on j.id = r.job
    where coalesce(j.agent, r.agent) = ? and r.kind != 'login' order by r.id desc limit 5`).all(agent) as Record<string, any>[])
    .map(r => `- #${r.id}, ${r.title} (${r.status})${r.answer && readsCard(r.id, caller) ? `. The board answered: ${cut(r.answer, 1500)}` : ''}`).join('\n') || '- none';
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

// The company right now: the team, the desk phone, work and reviews under way, the intercom's latest and the newest
// decisions
function companyNow() {
  const rows = (sql: string) => db.prepare(sql).all() as Record<string, string>[];
  // (a card for later is off the desk phone until then: the board put it aside, or it isn't due yet)
  // (or it's held until work it waits for is live)
  const laterNote = (hiddenUntil: string) => isHidden(hiddenUntil) ? ` (for later: off the desk phone until ${companyTime(Date.parse(hiddenUntil))})` : '';
  const heldNote = (id: string) => { const work = heldFor(Number(id)); return work ? ` (held: off the desk phone until ${work} is live)` : ''; };
  const requests = rows("select id, title, hidden_until from requests where status = 'open' order by id")
    .map(r => `- ${r.title}${heldNote(r.id)}${laterNote(r.hidden_until)}`).join('\n') || '- none';
  // (by number, and the reviews under way, for reach)
  // (step, round: a job's name, nameOf.)
  const jobs = rows("select id, agent, title, step, round, status from jobs where status in ('running', 'queued', 'blocked') and kind in ('work', 'chat') order by id desc limit 15")
    .map(j => `- #${j.id}, ${j.agent}: ${nameOf(j as { title: string })} (${j.status})`).join('\n') || '- none';
  const reviews = rows("select id, agent, title, step, round, status from jobs where status in ('running', 'queued') and kind in ('review', 'consolidate') order by id desc limit 10")
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
Waiting on the board's desk phone:
${requests}
Work in progress:
${jobs}
Reviews under way:
${reviews}
The intercom chat, the board's typed conversation with the CEO. Everything ever said there is there to look up (the
intercom tool, and search): before you tell the board something wasn't asked or written down, look there.
${earlierToday}Latest in the intercom chat:
${talk || '(nothing yet)'}

## Recent decisions
${decisions(read('company/DECISIONS.md'))}`;
}

// A file of the company's repo (main), or nothing when it isn't there
const read = (f: string) => { try { return readFileSync(`${REPO_DIR}/${f}`, 'utf8'); } catch { return ''; } };

const cut = (t: string | null, n: number) => { const s = (t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n).trimEnd()}… (cut here)` : s; };

// A profile is hundreds of lines, oldest work first: the call gets who they are, their newest track record and the top
// of their working memory, and is told what's left out (the first 40 lines were the oldest entries).
function profile(text: string, recent = 8, memory = 30) {
  if (!text.trim()) return '(no profile yet)';
  const part = (h: string) => text.split(/^## /m).find(p => p.startsWith(h))?.slice(h.length).trim() ?? '';
  const head = text.split(/^## /m)[0].trim(), items = (t: string) => t.split(/\n(?=- )/).filter(Boolean);
  const track = items(part('Track record')), mem = part('Working memory').split('\n');
  const more = (n: number, what: string) => n > 0 ? `\n(${n} ${what} left out here: search or read your profile for them.)` : '';
  return `${head}\n\n### Personality\n${part('Personality')}\n\n### Track record, newest\n${track.slice(-recent).join('\n')}${more(track.length - recent, 'older entries')}`
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
