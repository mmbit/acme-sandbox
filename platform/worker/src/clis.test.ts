// node --test src/clis.test.ts
// What crosses between a seat and the runs on it whichever CLI it runs: a refreshed sign-in coming back, and a session
// resumed only on the CLI that started it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIS, refreshOnly, resumeOn, sessionTag } from './clis.ts';

// The shape of Go's oauth2.Token as agy saves it, with the account's identity beside it
const TOKEN = {
  access_token: 'ya29.first',
  token_type: 'Bearer',
  refresh_token: '1//seat-own',
  expiry: '2026-10-15T12:00:00Z',
  account: { email: 'seat@example.com', project_id: 'p-1' },
};
const file = (o: object) => JSON.stringify(o);
const fields = CLIS.agy.refreshed!;

test("a run's refresh of agy's sign-in goes back to the seat: a new access token and expiry, all else as handed", () => {
  const refreshed = { ...TOKEN, access_token: 'ya29.second', expiry: '2026-10-15T13:00:00Z' };
  assert.equal(refreshOnly(file(TOKEN), file(refreshed), fields), true);
  assert.equal(refreshOnly(file(TOKEN), file(TOKEN), fields), false, 'nothing changed: nothing to write');
});

test('a job that rewrites the sign-in file is refused: another account, another refresh token, a new field, garbage', () => {
  const rewritten = [
    { ...TOKEN, access_token: 'ya29.other', account: { email: 'someone@example.com', project_id: 'p-1' } },
    { ...TOKEN, refresh_token: '1//another-account' },
    { ...TOKEN, access_token: 'ya29.other', proxy: 'https://elsewhere.example' },
    { ...TOKEN, access_token: { nested: 'x' } },
    (({ account: _, ...rest }) => rest)(TOKEN),
  ];
  for (const r of rewritten) assert.equal(refreshOnly(file(TOKEN), file(r), fields), false, file(r));
  assert.equal(refreshOnly(file(TOKEN), 'not json', fields), false);
  assert.equal(refreshOnly(file(TOKEN), file({ ...TOKEN, access_token: 'x'.repeat(70_000) }), fields), false);
  assert.equal(CLIS.vibe.refreshed, undefined, "Vibe's key never comes back from a run");
});

test('a job whose session came from Claude, claimed on a Vibe seat: a new session, the full briefing, no --resume', () => {
  // as saved: a session on the job's engine's own CLI as it is, another CLI's tagged with it
  assert.equal(sessionTag('claude', 'claude', 'abc'), 'abc');
  assert.equal(sessionTag('vibe', 'claude', 'abc'), 'vibe:abc');
  const onVibe = resumeOn('vibe', 'claude', 'abc');
  assert.deepEqual(onVibe, { session: null, switched: true });
  const home = '/tmp/h';
  assert.ok(!CLIS.vibe.run({ home, session: onVibe.session, reviewing: false }).includes('--resume'));
  assert.ok(
    !CLIS.agy
      .run({ home, session: resumeOn('agy', 'claude', 'vibe:abc').session, reviewing: false })
      .includes('--conversation'),
  );
  // its own CLI's session resumes, back on its own engine's CLI too
  assert.deepEqual(resumeOn('vibe', 'claude', 'vibe:xyz'), { session: 'xyz', switched: false });
  assert.ok(CLIS.vibe.run({ home, session: 'xyz', reviewing: false }).join(' ').includes('--resume xyz'));
  assert.deepEqual(resumeOn('claude', 'claude', 'abc'), { session: 'abc', switched: false });
  assert.deepEqual(resumeOn('claude', 'claude', 'vibe:xyz'), { session: null, switched: true });
  assert.deepEqual(resumeOn('codex', 'claude', null), { session: null, switched: false });
});
