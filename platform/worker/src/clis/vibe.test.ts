// node --test src/clis/vibe.test.ts
// Mistral Vibe's stream and run export, read by the worker's own readers once vibe.ts turns them into Claude Code events.
// The lines are vibe 2.26.1's own (`vibe -p --output streaming --output-dir`), captured against a local server playing
// Mistral's chat completions API: a reply, tool calls, a 429, a 401, a 403 and a home without a key. Each export keeps only
// the fields vibe.ts reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vibe } from './vibe.ts';
import { limitReset, observe, outcome, verdict } from '../outcome.ts';
import { usageOf } from '../usage.ts';
import { see, verdictOf, written } from '../verdict.ts';

const REVIEW = [
  '{"id": "user-turn-574eb38edea87516b13fa6abec64c8e4-1", "sessionId": "d24df678-22e6-b542-f71e-f82ca72059b5", "turnId": "turn-574eb38edea87516b13fa6abec64c8e4", "inputEntryId": null, "createdAt": 1792054437321, "updatedAt": 1792054437321, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "user", "content": [{"type": "text", "text": "Say hello."}], "source": "turn_start", "userDisplayContent": null}',
  '{"id": "effect-5aa9072b-c460-5bba-9b00-2580378d667b", "sessionId": "d24df678-22e6-b542-f71e-f82ca72059b5", "turnId": "turn-574eb38edea87516b13fa6abec64c8e4", "inputEntryId": "user-turn-574eb38edea87516b13fa6abec64c8e4-1", "createdAt": 1792054437454, "updatedAt": 1792054437492, "generationStatus": "completed", "relatedEntryId": null, "type": "effect", "title": "file_system.bash", "detail": {"toolName": "file_system.bash", "display": {"summary": "bash: echo checked", "content": null, "suffix": "", "verb": "Running", "message": "echo checked", "settledVerb": "Ran", "settledMessage": "echo checked", "statusText": "Running command"}, "kind": "shell", "input": {"command": "echo checked"}}, "state": {"status": "completed", "output": {"stdout": "checked\\n", "stderr": "", "output": "", "truncated": false}, "outputText": "checked\\n", "durationMs": 0.0, "display": {"success": true, "verb": "Ran", "message": "echo checked", "warnings": [], "approvalNote": null, "suffix": ""}, "decision": "execute", "approvalType": "always", "approvalSource": "bypass"}}',
  '{"id": "effect-cb6c91e4-9b8b-5daa-8980-0edf86691030", "sessionId": "d24df678-22e6-b542-f71e-f82ca72059b5", "turnId": "turn-574eb38edea87516b13fa6abec64c8e4", "inputEntryId": "user-turn-574eb38edea87516b13fa6abec64c8e4-1", "createdAt": 1792054437579, "updatedAt": 1792054437605, "generationStatus": "completed", "relatedEntryId": null, "type": "effect", "title": "file_system.write_file", "detail": {"toolName": "file_system.write_file", "display": {"summary": "Writing .hq/review.json", "content": "{\\"decision\\": \\"merge\\", \\"summary\\": \\"ok\\"}", "suffix": "", "verb": "Creating", "message": ".hq/review.json", "settledVerb": "Created", "settledMessage": ".hq/review.json", "statusText": "Writing file"}, "kind": "file_write", "input": {"filePath": ".hq/review.json", "content": "{\\"decision\\": \\"merge\\", \\"summary\\": \\"ok\\"}"}}, "state": {"status": "completed", "output": {"filePath": "/work/homes/12276/tmp/tmp.79gMqu4G2m/run/home.6035/proj/.hq/review.json", "content": "{\\"decision\\": \\"merge\\", \\"summary\\": \\"ok\\"}", "fileExisted": false, "previousContent": null}, "outputText": "", "durationMs": 0.0, "display": {"success": true, "verb": "Created", "message": ".hq/review.json", "warnings": [], "approvalNote": null, "suffix": ""}, "decision": "execute", "approvalType": "always", "approvalSource": "bypass"}}',
  '{"id": "assistant-0bc052b7-ec34-56be-9dfd-3561329dc33e", "sessionId": "d24df678-22e6-b542-f71e-f82ca72059b5", "turnId": "turn-574eb38edea87516b13fa6abec64c8e4", "inputEntryId": "user-turn-574eb38edea87516b13fa6abec64c8e4-1", "createdAt": 1792054437659, "updatedAt": 1792054437659, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "assistant", "content": [{"type": "text", "text": "```json\\n{\\"decision\\": \\"merge\\", \\"summary\\": \\"ok\\"}\\n```"}], "source": "harness", "userDisplayContent": null}',
  '{"outcome": "finished", "stop_reason": null, "error": null, "session_id": "d24df678-22e6-b542-f71e-f82ca72059b5", "usage": {"input_tokens": 3600, "output_tokens": 90, "cached_input_tokens": 0, "total_tokens": 3690}, "cost_usd": 0.006075, "steps": 3, "config": {"active_model": ""}, "schema_version": 1, "exit_code": 0}',
];
const EDITS = [
  '{"id": "user-turn-3ef2704c97bb8dbc582085bb579fd662-1", "sessionId": "36aecab0-ecc3-7457-ed84-cafd728350ef", "turnId": "turn-3ef2704c97bb8dbc582085bb579fd662", "inputEntryId": null, "createdAt": 1792054449979, "updatedAt": 1792054449979, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "user", "content": [{"type": "text", "text": "Say hello."}], "source": "turn_start", "userDisplayContent": null}',
  '{"id": "effect-5aa9072b-c460-5bba-9b00-2580378d667b", "sessionId": "36aecab0-ecc3-7457-ed84-cafd728350ef", "turnId": "turn-3ef2704c97bb8dbc582085bb579fd662", "inputEntryId": "user-turn-3ef2704c97bb8dbc582085bb579fd662-1", "createdAt": 1792054450096, "updatedAt": 1792054450130, "generationStatus": "completed", "relatedEntryId": null, "type": "effect", "title": "file_system.write_file", "detail": {"toolName": "file_system.write_file", "display": {"summary": "Writing a.txt", "content": "one two", "suffix": "", "verb": "Creating", "message": "a.txt", "settledVerb": "Created", "settledMessage": "a.txt", "statusText": "Writing file"}, "kind": "file_write", "input": {"filePath": "a.txt", "content": "one two"}}, "state": {"status": "completed", "output": {"filePath": "/work/homes/12276/tmp/tmp.79gMqu4G2m/run/home.EOVV/proj/a.txt", "content": "one two", "fileExisted": false, "previousContent": null}, "outputText": "", "durationMs": 0.0, "display": {"success": true, "verb": "Created", "message": "a.txt", "warnings": [], "approvalNote": null, "suffix": ""}, "decision": "execute", "approvalType": "always", "approvalSource": "bypass"}}',
  '{"id": "effect-cb6c91e4-9b8b-5daa-8980-0edf86691030", "sessionId": "36aecab0-ecc3-7457-ed84-cafd728350ef", "turnId": "turn-3ef2704c97bb8dbc582085bb579fd662", "inputEntryId": "user-turn-3ef2704c97bb8dbc582085bb579fd662-1", "createdAt": 1792054450197, "updatedAt": 1792054450241, "generationStatus": "completed", "relatedEntryId": null, "type": "effect", "title": "file_system.search_replace", "detail": {"toolName": "file_system.search_replace", "display": {"summary": "Editing a.txt", "content": null, "suffix": "", "verb": "Editing", "message": "a.txt", "settledVerb": "Edited", "settledMessage": "a.txt", "statusText": "Editing file"}, "kind": "file_edit", "input": {"filePath": "a.txt", "changes": [{"oldString": "two", "newString": "three", "replaceAll": false}]}}, "state": {"status": "completed", "output": {"file": "/work/homes/12276/tmp/tmp.79gMqu4G2m/run/home.EOVV/proj/a.txt", "oldString": null, "newString": null, "occurrences": [{"startLine": 1, "oldText": "two", "newText": "three"}]}, "outputText": "", "durationMs": 0.0, "display": {"success": true, "verb": "Edited", "message": "a.txt", "warnings": [], "approvalNote": null, "suffix": ""}, "decision": "execute", "approvalType": "always", "approvalSource": "bypass"}}',
  '{"id": "effect-2202c05f-8c27-5921-a925-18edf396031a", "sessionId": "36aecab0-ecc3-7457-ed84-cafd728350ef", "turnId": "turn-3ef2704c97bb8dbc582085bb579fd662", "inputEntryId": "user-turn-3ef2704c97bb8dbc582085bb579fd662-1", "createdAt": 1792054450342, "updatedAt": 1792054450363, "generationStatus": "completed", "relatedEntryId": null, "type": "effect", "title": "file_system.read_file", "detail": {"toolName": "file_system.read_file", "display": {"summary": "Reading missing.txt", "content": null, "suffix": "", "verb": "Reading", "message": "missing.txt", "settledVerb": "Read", "settledMessage": "missing.txt", "statusText": "Reading file"}, "kind": "file_read", "input": {"filePath": "missing.txt", "offset": null, "limit": 2000}}, "state": {"status": "failed", "error": {"message": "File not found at: /work/homes/12276/tmp/tmp.79gMqu4G2m/run/home.EOVV/proj/missing.txt", "code": "tool_failed", "details": null}, "output": {"type": "failure", "content": [], "_meta": {"approval": {"approvalSource": "bypass", "approvalType": "always", "decision": "execute"}}, "error": {"code": "tool_failed", "message": "File not found at: /work/homes/12276/tmp/tmp.79gMqu4G2m/run/home.EOVV/proj/missing.txt", "retryable": false}}, "outputText": "", "durationMs": 0.0, "display": {"success": false, "verb": "", "message": "File not found at: /work/homes/12276/tmp/tmp.79gMqu4G2m/run/home.EOVV/proj/missing.txt", "warnings": [], "approvalNote": null, "suffix": ""}, "decision": "execute", "approvalType": "always", "approvalSource": "bypass"}}',
  '{"id": "assistant-0546196c-1975-5b06-b159-99fcd1ca4ee7", "sessionId": "36aecab0-ecc3-7457-ed84-cafd728350ef", "turnId": "turn-3ef2704c97bb8dbc582085bb579fd662", "inputEntryId": "user-turn-3ef2704c97bb8dbc582085bb579fd662-1", "createdAt": 1792054450406, "updatedAt": 1792054450406, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "assistant", "content": [{"type": "text", "text": "Done."}], "source": "harness", "userDisplayContent": null}',
];
const LIMITED = [
  '{"id": "user-turn-f91b1cb472452a4f533c7b150e54c590-1", "sessionId": "ff2fc234-b58d-edc8-48d7-b37066fc6e15", "turnId": "turn-f91b1cb472452a4f533c7b150e54c590", "inputEntryId": null, "createdAt": 1792054469282, "updatedAt": 1792054469282, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "user", "content": [{"type": "text", "text": "Say hello."}], "source": "turn_start", "userDisplayContent": null}',
  '{"outcome": "infrastructure_failure", "stop_reason": null, "error": {"message": "API error occurred: Status 429. Body: {\\"object\\":\\"error\\",\\"message\\":\\"Requests rate limit exceeded\\",\\"type\\":\\"rate_limited\\",\\"param\\":null,\\"code\\":\\"1300\\"}", "code": "rate_limit"}, "session_id": "ff2fc234-b58d-edc8-48d7-b37066fc6e15", "usage": {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "total_tokens": 0}, "cost_usd": 0.0, "steps": 1, "config": {"active_model": ""}, "schema_version": 1, "exit_code": 2}',
];
const UNAUTHORIZED = [
  '{"id": "user-turn-51b90fe31b6a0dd20f3b40828c8230bd-1", "sessionId": "b84ca1f0-6ec0-e834-f979-c9aa961669aa", "turnId": "turn-51b90fe31b6a0dd20f3b40828c8230bd", "inputEntryId": null, "createdAt": 1792054474549, "updatedAt": 1792054474549, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "user", "content": [{"type": "text", "text": "Say hello."}], "source": "turn_start", "userDisplayContent": null}',
  '{"outcome": "config_error", "stop_reason": null, "error": {"message": "Invalid API key (from env var MISTRAL_API_KEY). Please check your API key and try again.", "code": "invalid_api_key"}, "session_id": "b84ca1f0-6ec0-e834-f979-c9aa961669aa", "usage": {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "total_tokens": 0}, "cost_usd": 0.0, "steps": 1, "config": {"active_model": ""}, "schema_version": 1, "exit_code": 1}',
];
const FORBIDDEN = [
  '{"id": "user-turn-9517119619c9dd867d2303891f3e1805-1", "sessionId": "c754d559-9f57-b4d6-2915-841142b8ff08", "turnId": "turn-9517119619c9dd867d2303891f3e1805", "inputEntryId": null, "createdAt": 1792054479060, "updatedAt": 1792054479060, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "user", "content": [{"type": "text", "text": "Say hello."}], "source": "turn_start", "userDisplayContent": null}',
  '{"outcome": "config_error", "stop_reason": null, "error": {"message": "Invalid API key. Please check your API key and try again.", "code": "invalid_api_key"}, "session_id": "c754d559-9f57-b4d6-2915-841142b8ff08", "usage": {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "total_tokens": 0}, "cost_usd": 0.0, "steps": 1, "config": {"active_model": ""}, "schema_version": 1, "exit_code": 1}',
];
const NO_KEY = [
  '{"outcome": "config_error", "stop_reason": null, "error": {"message": "Missing MISTRAL_API_KEY environment variable for mistral provider. Set the environment variable (e.g. in ~/.vibe/.env or your shell), or run `vibe --setup` once interactively.", "code": null}, "session_id": null, "usage": null, "cost_usd": null, "steps": null, "config": null, "schema_version": 1, "exit_code": 1}',
];
const ASKED = [
  '{"id": "538d0872-233f-494b-93be-39368a4b951f", "sessionId": "a29d964b-91e7-614d-64c5-b5c1834b1af0", "turnId": "80890119-ea7e-4ecf-8000-aa8cc6d8a6c0", "inputEntryId": null, "createdAt": 1792054551966, "updatedAt": 1792054551966, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "user", "content": [{"type": "text", "text": "Say hello."}], "source": "turn_start", "userDisplayContent": null}',
  '{"id": "0a3f99ad-cf23-4b6d-a4a2-26c13acf2648", "sessionId": "a29d964b-91e7-614d-64c5-b5c1834b1af0", "turnId": "80890119-ea7e-4ecf-8000-aa8cc6d8a6c0", "inputEntryId": null, "createdAt": 1792054552025, "updatedAt": 1792054552037, "generationStatus": "completed", "relatedEntryId": null, "type": "message", "role": "assistant", "content": [{"type": "text", "text": "Hello from the scripted model."}], "source": null, "userDisplayContent": null}',
  '{"outcome": "finished", "stop_reason": null, "error": null, "session_id": "a29d964b-91e7-614d-64c5-b5c1834b1af0", "usage": {"input_tokens": 1200, "output_tokens": 30, "cached_input_tokens": 1000, "total_tokens": 1230}, "cost_usd": 0.000675, "steps": null, "config": {"active_model": ""}, "schema_version": 1, "exit_code": 0}',
];

// The worker's reading of a run: every line through events(), the export last with the CLI's exit code set first, and
// the seat's verdict with Vibe's own error texts (worker.ts).
function read(lines: string[], exitCode: number, stderr = '') {
  const state: Record<string, unknown> = {};
  const events = lines.flatMap(line => {
    const parsed = JSON.parse(line);
    if (vibe.export && typeof parsed.schema_version === 'number') state.exitCode = exitCode;
    return vibe.events(parsed, state) as any[];
  });
  const how = outcome();
  for (const e of events) observe(how, e);
  const result = events.find(e => e.type === 'result');
  return { events, how, result, ended: verdict(how, 'vibe', stderr, vibe.errors), usage: usageOf(result) };
}
const lastSaid = (events: any[]) =>
  events
    .filter(e => e.type === 'assistant')
    .flatMap(e => e.message.content)
    .filter(c => c.type === 'text')
    .at(-1)?.text ?? '';

test('a finished run reads as a session with its reply, its usage and no failure', () => {
  const { events, result, ended, usage } = read(REVIEW, 0);
  assert.equal(ended, undefined);
  assert.equal(result.is_error, false);
  assert.equal(result.session_id, 'd24df678-22e6-b542-f71e-f82ca72059b5');
  assert.equal(events[0].session_id, result.session_id);
  assert.deepEqual(usage, {
    models: { 'mistral-medium-3.5': { input: 3600, cacheWrite: 0, cacheRead: 0, output: 90, cost: 0.006075 } },
    cost: 0.006075,
  });
});

test("a reviewer's verdict reads back from its final message, and from its own write of the file", () => {
  const verdictJson = '{"decision": "merge", "summary": "ok"}';
  const { events } = read(REVIEW, 0);
  const file = written('/w', '/w/.hq/review.json');
  for (const e of events) see(file, e);
  assert.equal(verdictOf(file, lastSaid(events)), verdictJson);
  assert.equal(verdictOf(file, 'Reviewed, all good.'), verdictJson);
});

test("Vibe's edits apply to what the stream wrote, as Claude's Write and Edit do", () => {
  const { events } = read(EDITS, 0);
  const file = written('/w', '/w/a.txt');
  for (const e of events) see(file, e);
  assert.equal(verdictOf(file, ''), 'one three');
  const failedRead = events.flatMap(e => e.message?.content ?? []).find(c => c.type === 'tool_result' && c.is_error);
  assert.match(failedRead.content, /File not found/);
});

test('a 429 after Vibe gave up retrying is a usage limit', () => {
  assert.equal(read(LIMITED, 2).ended, 'limited');
});

test('a refused key, a 403 and a home without a key are a sign-out', () => {
  assert.equal(read(UNAUTHORIZED, 1).ended, 'auth');
  assert.equal(read(FORBIDDEN, 1).ended, 'auth');
  assert.equal(read(NO_KEY, 1).ended, 'auth');
});

test('an export a job rewrote decides nothing without the exit code to match', () => {
  const forged = [...REVIEW.slice(0, -1), LIMITED.at(-1)!];
  assert.equal(read(forged, 0).ended, undefined);
  assert.equal(read(UNAUTHORIZED, 2).ended, undefined);
  // (Vibe killed, and the words of a sign-out or a limit left in the export, or on its stderr once it said something)
  const left = (message: string) => [
    ...REVIEW.slice(0, -1),
    JSON.stringify({ schema_version: 1, outcome: 'failed', error: { message } }),
  ];
  for (const code of [1, 2]) {
    assert.equal(read(left('Invalid API key'), code).ended, undefined);
    assert.equal(read(left('Rate limits exceeded'), code).ended, undefined);
    assert.equal(read(REVIEW.slice(0, -1), code, 'Invalid API key').ended, undefined);
  }
});

test("a real limit's own words give the time it lifts", () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const limited = JSON.parse(LIMITED.at(-1)!);
  limited.error.message = 'API error occurred: Status 429. Rate limit exceeded, try again in 20 minutes';
  const { how, ended } = read([LIMITED[0], JSON.stringify(limited)], 2);
  assert.equal(ended, 'limited');
  assert.equal(limitReset(how, '', 1, now), now + 20 * 60e3);
});

test('cached input counts apart from the rest of the input', () => {
  const { usage, result } = read(ASKED, 0);
  assert.equal(result.result, 'Hello from the scripted model.');
  assert.deepEqual(usage!.models['mistral-medium-3.5'], {
    input: 200,
    cacheWrite: 0,
    cacheRead: 1000,
    output: 30,
    cost: 0.000675,
  });
});
