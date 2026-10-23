// node --test src/outcome.test.ts   How a run ended comes from what the CLI reports, never from the model's own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitReset, observe, outcome, verdict, whole } from './outcome.ts';

const run = (events: any[]) => { const o = outcome(); for (const e of events) observe(o, e); return o; };
const said = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] }, ...extra });

test('a job that writes about a rate limit (or a 401) and exits nonzero failed: it was not limited or signed out', () => {
  const o = run([said('Printful answered 429: we hit their rate limit, usage limit reached. Unauthorized (401) on the retry.'),
    { type: 'result', subtype: 'success', is_error: false, result: 'We hit the rate limit. Please run /login on Printful.' }]);
  assert.equal(verdict(o, 'claude', ''), undefined);
});

test("Claude's own error message decides: a usage limit, or a sign-in the seat lost", () => {
  const limited = run([said('Working on it.'),
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2_000_000_000, rateLimitType: 'five_hour' } },
    said("You've hit your limit · resets 3pm", { error: 'rate_limit' }),
    { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit · resets 3pm" }]);
  assert.equal(verdict(limited, 'claude', ''), 'limited');
  assert.equal(limitReset(limited, '', 1, 1_900_000_000_000), 2_000_000_000_000 + 60_000, "the CLI's reset time");

  const out = run([said('Invalid API key · Please run /login', { error: 'authentication_failed' })]);
  assert.equal(verdict(out, 'claude', ''), 'auth');
  assert.equal(verdict(run([{ type: 'result', subtype: 'success', is_error: true, api_error_status: 401 }]), 'claude', ''), 'auth');
});

test("an error the session got past, or a team member's, doesn't decide", () => {
  const o = run([said('Overloaded', { error: 'rate_limit', parent_tool_use_id: 'toolu_1' }),
    said('max tokens', { error: 'max_output_tokens' }), said('Carrying on.')]);
  assert.equal(verdict(o, 'claude', ''), undefined);
});

test("Claude's stderr counts only when the CLI never started a session; Codex reports its errors as text", () => {
  assert.equal(verdict(outcome(), 'claude', 'Error: Invalid API key · Please run /login'), 'auth');
  assert.equal(verdict(run([said('hi')]), 'claude', 'hook: the board says we hit a rate limit'), undefined);
  assert.equal(verdict(run([{ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 3 hours." } }]), 'codex', ''), 'limited');
  assert.equal(verdict(run([{ type: 'error', message: 'Your workspace is out of credits. Ask your workspace admin to add more.' }]), 'codex', ''), 'limited');
  assert.equal(verdict(run([{ type: 'item.completed', item: { type: 'agent_message', text: 'rate limit' } }]), 'codex', ''), undefined);
});

// Codex 0.157.1's own words, from runs against a scripted ChatGPT backend (job #5380).
const codexFailed = (message: string) => run([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
  { type: 'error', message }, { type: 'turn.failed', error: { message } }]);
const LIMITED = 'You’ve hit your usage limit. To get more access now, send a request to your admin or try again at Oct 9th, 2026 8:14 PM.';

test("Codex: the turn's own error decides, never a side request's line on stderr", () => {
  const noise = 'ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: '
    + 'Could not parse your authentication token. Please try signing in again.\nERROR rmcp::transport::worker: HTTP 429: rate limit';
  assert.equal(verdict(codexFailed(LIMITED), 'codex', noise), 'limited', 'a 401 on the model list is not the seat signed out');
  assert.equal(verdict(codexFailed('stream disconnected before completion'), 'codex', noise), undefined, 'nor is a 429 there a limit');
  assert.equal(verdict(run([{ type: 'thread.started', thread_id: 't' }]), 'codex', 'Error: no thread with id: t'), undefined);
  assert.equal(verdict(outcome(), 'codex', 'Error: Not logged in'), 'auth', 'stderr when it died before any event');
});

test('Codex: a sign-in it can no longer refresh, or one the server turned away, asks for a sign-in', () => {
  for (const why of [' because your refresh token was already used', ' because your refresh token has expired',
    ' because your refresh token was revoked', ''])
    assert.equal(verdict(codexFailed(`Your access token could not be refreshed${why}. Please log out and sign in again.`), 'codex', ''), 'auth');
  assert.equal(verdict(codexFailed('unexpected status 401 Unauthorized: Your authentication token has been invalidated. '
    + 'Please try signing in again., url: https://chatgpt.com/backend-api/codex/responses'), 'codex', ''), 'auth');
  assert.equal(verdict(codexFailed('exceeded retry limit, last status: 429 Too Many Requests'), 'codex', ''), 'limited');
});

test('Codex: an account OpenAI deactivated is closed, not signed out: a sign-in card could never work', () => {
  const closed = 'unexpected status 401 Unauthorized: Your OpenAI account has been deactivated, please check your email for more information. '
    + 'If you feel this is an error, contact us through our help center at help.openai.com., url: https://chatgpt.com/backend-api/codex/responses';
  assert.equal(verdict(codexFailed(closed), 'codex', ''), 'closed');
  assert.equal(verdict(outcome(), 'codex', `Error: ${closed}`), 'closed', 'stderr when it died before any event');
  assert.equal(verdict(run([{ type: 'item.completed', item: { type: 'agent_message', text: 'Your OpenAI account has been deactivated' } }]), 'codex', ''),
    undefined, 'what the model wrote never decides');
});

test("Codex's limit says when it lifts: that day and time (UTC in the worker), not a backoff", () => {
  const now = Date.UTC(2026, 9, 5, 19, 14);
  assert.equal(limitReset(codexFailed(LIMITED), '', 1, now), Date.UTC(2026, 9, 9, 20, 14) + 60_000);
  assert.equal(limitReset(codexFailed('You’ve hit your usage limit. Upgrade to Plus to continue using Codex '
    + '(https://chatgpt.com/explore/plus), or try again at 10:16 PM.'), '', 1, now), Date.UTC(2026, 9, 5, 22, 16) + 60_000);
  assert.equal(limitReset(codexFailed('You’ve hit your usage limit. Try again at 8:05 AM.'), '', 1, now), Date.UTC(2026, 9, 6, 8, 5) + 60_000);
  assert.equal(limitReset(codexFailed('try again later'), '', 1, now), now + 30 * 60e3, 'no time named: the backoff');
});

test('a long report is kept whole up to the guard, and past it cut with a line saying so', () => {
  assert.equal(whole('short', 10), 'short');
  const cut = whole('x'.repeat(50), 10);
  assert.match(cut, /^x{10}\n\n… \(cut here: 50 characters, only the first 10 kept\)$/);
});

// Codex's own words when the API turns its first request away as invalid, over HTTP (0.157.1 and 0.160.1 against a
// scripted backend) and over a websocket (the shape of 2026-10-06's failed runs).
test('Codex: a first request the API refused as invalid is the seat refused; one later in the run, or any other error, is the job', () => {
  const http = JSON.stringify({ error: { type: 'invalid_request_error', code: 'unsupported_parameter', message: "Unsupported parameter: 'reasoning.summary'", param: 'reasoning.summary' } });
  const ws = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'The requested model is not supported.' } });
  assert.equal(verdict(codexFailed(http), 'codex', ''), 'refused');
  assert.equal(verdict(codexFailed(ws), 'codex', ''), 'refused');
  // a model the CLI doesn't know: its own warning comes first, as an item (0.157.1 and 0.160.1).
  const unknown = run([{ type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-6.9-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
    { type: 'turn.started' }, { type: 'error', message: http }, { type: 'turn.failed', error: { message: http } }]);
  assert.equal(verdict(unknown, 'codex', ''), 'refused', "the CLI's own warning isn't an item the run got back");
  const later = run([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Reading the diff.' } }, { type: 'turn.failed', error: { message: ws } }]);
  assert.equal(verdict(later, 'codex', ''), undefined, 'a run that got items back failed on its own request (its context, say)');
  assert.equal(verdict(codexFailed(JSON.stringify({ type: 'error', status: 500, error: { type: 'server_error', message: 'oops' } })), 'codex', ''), undefined);
  assert.equal(verdict(codexFailed('invalid_request_error: status 400'), 'codex', ''), undefined, 'only the API\'s JSON, never words');
  assert.equal(verdict(codexFailed(JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } })), 'codex', ''), 'limited');
  assert.equal(verdict(run([{ type: 'result', is_error: true, api_error_status: 400 }]), 'claude', ''), undefined, "Claude's runs aren't judged this way");
});

test("another CLI: its stream's own signals and its own error texts decide, never the model's words", () => {
  const errors = { closed: /account (is )?suspended/i, auth: /invalid api key/i, limit: /quota exhausted/i };
  assert.equal(verdict(run([said('the account is suspended, quota exhausted')]), 'agy', '', errors), undefined);
  assert.equal(verdict(run([{ type: 'result', is_error: true, api_error_status: 429 }]), 'agy', '', errors), 'limited');
  assert.equal(verdict(run([{ type: 'result', is_error: true, api_error_status: 401 }]), 'vibe', '', errors), 'auth');
  assert.equal(verdict(run([]), 'vibe', 'Error: Invalid API key.', errors), 'auth');
  assert.equal(verdict(run([]), 'agy', 'Error: your account is suspended', errors), 'closed');
  assert.equal(verdict(run([{ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Quota exhausted' }] } }]), 'agy', '', errors), 'limited');
});
