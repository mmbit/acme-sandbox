// How a run ended, from what the CLI itself reports, never from the model's own words: a job that writes "we hit
// the rate limit" and exits nonzero failed; it wasn't limited. Claude Code marks the messages it writes itself about
// a failed API call (error: 'rate_limit', 'authentication_failed', ...), gives the HTTP status in its result, and says
// when a usage window turned it away and until when (rate_limit_event). Codex reports its errors as events of their
// own (turn.failed, error), and neither CLI prints the model's text on stderr, so for Codex those are read as text.

// Codex's error texts, and a CLI that died before it said anything structured. (A Codex sign-in it can't refresh ends
// "Please log out and sign in again", with no 401 in it.)
const LIMIT = /usage limit|rate limit|limit reached|hit your limit|quota|too many requests|\b429\b|out of credits/i;
const AUTH = /invalid (api key|token|bearer)|unauthori[sz]ed|\b401\b|not logged in|please (run )?\/?login|oauth token has expired|sign(ing)? in again/i;
// An account its provider closed: OpenAI answers a deactivated account's requests with a 401 that says so ("Your OpenAI
// account has been deactivated, please check your email"). Not a sign-out: signing in again can't
// help, so the seat is closed until the board decides (the worker's 'closed').
const CLOSED = /account has been deactivated/i;

// failure: Codex's own last error, the turn's. items: Codex's completed items (a
// reply, a command, a reasoning step), none when its first request was turned away; not its own warnings, which are
// items of type error (a model it has no metadata for)
export type Outcome = { events: number; error?: string; status?: number; resetsAt?: number; cli: string; failure?: string; items: number };
export const outcome = (): Outcome => ({ events: 0, cli: '', items: 0 });

const texts = (e: any) => (e.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ');

// One event from the CLI's stream (Claude's stream-json or Codex's JSONL).
export function observe(o: Outcome, e: any) {
  o.events++;
  // (the session's own last message decides: an error it got past, or a team member's, doesn't)
  if (e.type === 'assistant' && !e.parent_tool_use_id) { o.error = e.error ? String(e.error) : undefined; if (e.error) o.cli += ` ${texts(e)}`; }
  if (e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected' && e.rate_limit_info.resetsAt) o.resetsAt = e.rate_limit_info.resetsAt * 1000;
  if (e.type === 'result' && e.is_error) {
    if (typeof e.api_error_status === 'number') o.status = e.api_error_status;
    if (Array.isArray(e.errors)) o.cli += ` ${e.errors.join(' ')}`;
  }
  if (e.type === 'turn.failed' || e.type === 'error') { o.failure = String(e.error?.message ?? e.message ?? ''); o.cli += ` ${o.failure}`; }
  if (e.type === 'item.completed' && e.item?.type !== 'error') o.items++;
}

// Why a run that exited nonzero stopped: its account closed, the seat's sign-in, a usage limit, a first request the API refused, or none of
// these (the job failed). stderr is the CLI's own; Claude's is only read when it never got as far as a session (a hook's
// output can reach it later). Codex's neither: it logs every side request's error there (the model list, connectors: a
// 401 on one isn't the seat's sign-in), so its turn's own last error decides (failure).
// 'refused': Codex's very first request came back as an invalid request (HTTP 400, or the API's invalid_request_error),
// before the run got a single item back: what the seat sends (the model, the CLI) is wrong, not the job, and every run on
// it will end the same way (a model the CLI didn't know yet, 2026-10-06). Its error is the API's JSON (`{"error": {...}}`
// over HTTP, `{"type": "error", "status": 400, "error": {...}}` over a websocket).
// cliName: the CLI the run was on. Another CLI's stream reads as Claude's (clis.ts), with its own error texts (errors), read
// in what it said of its errors, and in its stderr only when it said nothing (a job's processes may write there too, as
// for Claude): its account closed, if the provider says so in a way of its own.
export type CliErrors = { closed?: RegExp; auth: RegExp; limit: RegExp };
export function verdict(o: Outcome, cliName: string, stderr: string, errors?: CliErrors): 'closed' | 'auth' | 'limited' | 'refused' | undefined {
  if (errors) {
    const said = o.events ? o.cli : `${o.cli} ${stderr}`;
    if (errors.closed?.test(said)) return 'closed';
    if (o.error === 'authentication_failed' || o.status === 401 || errors.auth.test(said)) return 'auth';
    if (o.error === 'rate_limit' || o.status === 429 || errors.limit.test(said)) return 'limited';
    return;
  }
  const text = o.events ? (cliName === 'codex' ? o.failure ?? '' : '') : stderr;
  if (cliName === 'codex' && CLOSED.test(text)) return 'closed';
  if (o.error === 'authentication_failed' || o.status === 401 || AUTH.test(text)) return 'auth';
  if (o.error === 'rate_limit' || o.status === 429 || LIMIT.test(text)) return 'limited';
  if (cliName === 'codex' && o.events && !o.items && invalidRequest(o.failure)) return 'refused';
}
function invalidRequest(failure?: string) {
  try { const e = JSON.parse(failure ?? ''); return e?.status === 400 || e?.error?.type === 'invalid_request_error'; } catch { return false; }
}

// When a limited seat can take work again: the CLI's own reset time, or the time its message names, or a backoff.
export function limitReset(o: Outcome, stderr: string, attempts: number, now = Date.now()) {
  if (o.resetsAt && o.resetsAt > now) return o.resetsAt + 60_000;
  const text = `${o.cli} ${stderr}`;
  const inMin = text.match(/(?:try again|resets?) in (\d+)\s*(minute|hour)/i);
  if (inMin) return now + Number(inMin[1]) * (inMin[2].startsWith('h') ? 3600e3 : 60e3);
  // (Codex: "try again at 8:14 PM", or "try again at Oct 9th, 2026 8:14 PM" for a later day, in the worker's UTC.
  const at = text.match(/(?:resets?|try again)(?: at)? (?:([a-z]{3})\w* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    const ampm = at[6]?.toLowerCase();
    const h = ampm ? Number(at[4]) % 12 + (ampm === 'pm' ? 12 : 0) : Number(at[4]);
    const d = new Date(now); d.setUTCHours(h, Number(at[5] ?? 0), 0, 0);
    const month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : -1;
    if (month >= 0) d.setUTCFullYear(Number(at[3]), month, Number(at[2]));
    else if (d.getTime() < now) d.setUTCDate(d.getUTCDate() + 1);
    if (d.getTime() > now) return d.getTime() + 60_000;
  }
  return now + Math.min(30 * 60e3 * 2 ** Math.max(0, attempts - 1), 5 * 3600e3);
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// A text kept whole up to a runaway guard; past it, cut with a line that says so.
export const whole = (t: string, max: number) => t.length <= max ? t
  : `${t.slice(0, max).trimEnd()}\n\n… (cut here: ${t.length.toLocaleString('en')} characters, only the first ${max.toLocaleString('en')} kept)`;
// The opening of a text for a feed line or a bubble in HQ (the whole text is elsewhere), marked when it's cut.
export const preview = (t: string, max: number) => t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
// The end of a log (stderr), marked when its start is cut.
export const tail = (t: string, max: number) => t.length <= max ? t : `…${t.slice(-max)}`;

// What hq request parked (.hq/request.json) for the coordinator to file as a card: every field a card takes, so photo and
// document fields reach it too (jobs.ts finish), and so do its questions, address and decision.
export function parkedRequest(json: string) {
  const { kind, urgency, title, body, secrets, approves, address, photos, documents, zips, questions, products, back, topic, visibleFrom, decides } = JSON.parse(json);
  return { kind, urgency, title, body, secrets, approves, address, photos, documents, zips, questions, products, back, topic, visibleFrom, decides };
}
