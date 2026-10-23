// What a seat's provider changes about a run: where its CLI sends its requests, which model it asks for, and how it signs
// in. A subscription seat (sign_in 'login') runs as the CLI does by default; a key seat may be at another address, which
// speaks the CLI's own API (Anthropic's Messages API for Claude Code, OpenAI's Responses API for Codex).

import { CLIS } from './clis.ts';

export type SeatProvider = {
  engine: string;
  cli?: string; // (none: its engine's own CLI)
  provider?: string;
  signIn: 'login' | 'key';
  url?: string;
  model?: string;
  models?: Record<string, string>;
};

// The model families Claude Code knows by alias, each with its own setting for the model behind it
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

// The model a run asks for on this seat: the job's own at its CLI's provider, else the provider's model for the job's family
// (models.haiku for a Haiku job), or its one model.
export function modelFor(seat: SeatProvider, model: string | undefined) {
  if (!seat.model) return model;
  const family = FAMILIES.find(f => model?.toLowerCase().includes(f));
  return (family && seat.models?.[family]) || seat.model;
}

// The CLI a seat runs
export const cliOf = (seat: SeatProvider) => seat.cli ?? seat.engine;

// The file in the seat's folder that holds its sign-in: Codex keeps a key in its auth.json as it keeps a login, and the
// other CLIs keep theirs where they would in a home (clis.ts credentials), the seat's folder being one.
export const credentialFile = (seat: SeatProvider) =>
  CLIS[cliOf(seat)]?.credentials[0] ??
  (cliOf(seat) === 'codex' ? 'auth.json' : seat.signIn === 'key' ? 'key' : 'token');

// Claude Code's settings for the seat: how its sign-in comes on the pipe (an OAuth token or an API key, never in the env
// a job can read: safety.ts SIGN_IN), the provider's address, and its models behind each alias, so a team member started
// with "sonnet" asks the provider for one it has.
export function claudeEnv(seat: SeatProvider): Record<string, string> {
  const env: Record<string, string> =
    seat.signIn === 'key'
      ? { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3' }
      : { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' };
  if (seat.url) env.ANTHROPIC_BASE_URL = seat.url;
  if (seat.model)
    for (const f of FAMILIES) env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`] = seat.models?.[f] ?? seat.model;
  return env;
}

// Codex's arguments for a seat at another address: a provider of its own, signed in with the key in the seat's auth.json.
// They go right after the subcommand (exec), before its own flags.
export function codexArgs(seat: SeatProvider, args: string[]) {
  if (!seat.url) return args;
  const name = JSON.stringify(seat.provider ?? 'seat');
  const own = [
    '-c',
    'model_provider="seat"',
    '-c',
    `model_providers.seat.name=${name}`,
    '-c',
    `model_providers.seat.base_url=${JSON.stringify(seat.url)}`,
    '-c',
    'model_providers.seat.wire_api="responses"',
    '-c',
    'model_providers.seat.requires_openai_auth=true',
  ];
  return args[0] === 'exec' ? [args[0], ...own, ...args.slice(1)] : [...own, ...args];
}
