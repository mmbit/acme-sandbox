// node --test src/providers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEnv, codexArgs, credentialFile, modelFor } from './providers.ts';

const subscription = { engine: 'claude', signIn: 'login' as const };
const elsewhere = {
  engine: 'claude',
  provider: 'elsewhere',
  signIn: 'key' as const,
  url: 'https://api.elsewhere.example/anthropic',
  model: 'big-1',
  models: { haiku: 'small-1' },
};

test("a subscription seat runs as the CLI does: the job's model, its OAuth token on the pipe", () => {
  assert.equal(modelFor(subscription, 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.deepEqual(claudeEnv(subscription), { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' });
  assert.equal(credentialFile(subscription), 'token');
});

test('a seat elsewhere: its address, its models behind each alias, and its key on the pipe', () => {
  assert.equal(modelFor(elsewhere, 'claude-opus-5-5'), 'big-1');
  assert.equal(modelFor(elsewhere, 'claude-haiku-4-5'), 'small-1');
  assert.equal(modelFor(elsewhere, undefined), 'big-1');
  const env = claudeEnv(elsewhere);
  assert.equal(env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR, '3');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, elsewhere.url);
  assert.deepEqual([env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['big-1', 'small-1']);
  assert.equal(credentialFile(elsewhere), 'key');
  // Anthropic's own API with a key: the job's model, no address
  assert.deepEqual(claudeEnv({ engine: 'claude', signIn: 'key' }), { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3' });
});

test('a Codex seat elsewhere gets a provider of its own, right after exec', () => {
  const seat = {
    engine: 'codex',
    provider: 'other',
    signIn: 'key' as const,
    url: 'https://api.other.example/v1',
    model: 'coder-2',
  };
  const args = codexArgs(seat, ['exec', '--json', '-']);
  assert.deepEqual(args.slice(0, 3), ['exec', '-c', 'model_provider="seat"']);
  assert.ok(args.includes('model_providers.seat.base_url="https://api.other.example/v1"'));
  assert.deepEqual(args.slice(-2), ['--json', '-']);
  assert.deepEqual(codexArgs({ engine: 'codex', signIn: 'login' }, ['exec', '-']), ['exec', '-']);
  assert.equal(credentialFile(seat), 'auth.json');
});
