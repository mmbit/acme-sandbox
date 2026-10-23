// Mistral Vibe (PyPI mistral-vibe) on a seat: its programmatic mode, and its stream and run export read as Claude
// Code's.
import type { Cli } from '../clis.ts';
import { streamMessage } from './stream.ts';
import { count } from '../usage.ts';

// The run export (--output-dir) goes in the job's home, where the worker reads it once Vibe has exited. The job can
// write there, so the usage and cost it gives are only as honest as the job.
const RUN_DIR = '.vibe-run';
// Vibe's own default model, which an unset or unknown VIBE_ACTIVE_MODEL falls back to.
const DEFAULT_MODEL = 'mistral-medium-3.5';

export const vibe: Cli = {
  name: 'Mistral Vibe',
  bin: 'vibe',
  // VIBE_TEST_DISABLE_KEYRING keeps the key in .vibe/.env, never in a system keyring a job could share.
  home: home => ({
    VIBE_HOME: `${home}/.vibe`,
    VIBE_TEST_DISABLE_KEYRING: '1',
    VIBE_ENABLE_TELEMETRY: 'false',
    VIBE_ENABLE_UPDATE_CHECKS: 'false',
    VIBE_ENABLE_AUTO_UPDATE: 'false',
  }),
  credentials: ['.vibe/.env'],
  // `-p` with no text reads the prompt from stdin. A work job trusts its clone, so AGENTS.md loads (an untrusted folder
  // ignores it). A reviewer's stays untrusted. --auto-approve runs every tool with no sandbox, a reviewer's too: an
  // accepted limit (the AI providers note).
  run: o => [
    ...programmatic(o.home),
    '--auto-approve',
    ...(o.reviewing ? [] : ['--trust']),
    ...(o.session ? ['--resume', o.session] : []),
  ],
  // The default harness offers its file and shell tools whatever --enabled-tools says. The legacy one honours it, and
  // the plan agent leaves any tool that asks for approval denied.
  ask: o => [...programmatic(o.home), '--legacy-harness', '--agent', 'plan', '--enabled-tools', 'none'],
  env: o => (o.model ? { VIBE_ACTIVE_MODEL: o.model } : ({} as Record<string, string>)),
  events,
  export: `${RUN_DIR}/export.json`,
  // .vibe holds a project's config.toml, hooks, tools, skills, agents, plugins and prompts. .agents holds skills.
  strip: ['.vibe', '.agents'],
  key: key => ({ '.vibe/.env': `MISTRAL_API_KEY=${key}\n` }),
  errors: {
    // (no closed: a closed account's 403 reaches its output as "Invalid API key", as a 401 does)
    auth: /Invalid API key|Missing MISTRAL_API_KEY/i,
    limit: /Rate limits? exceeded|Status 429/i,
  },
};

function programmatic(home: string) {
  return ['-p', '--output', 'streaming', '--output-dir', `${home}/${RUN_DIR}`];
}

// One line of `--output streaming`, a completed history entry, or the run export last. The run's state keeps its
// session, its last reply and how the CLI exited (exitCode, set by the worker).
function events(e: any, state: Record<string, unknown>): object[] {
  if (typeof e?.schema_version === 'number' && typeof e.outcome === 'string') return [resultOf(e, state)];
  if (e?.generationStatus !== 'completed' || typeof e.sessionId !== 'string') return [];
  const session_id = (state.session = e.sessionId);
  if (e.type === 'message' && e.role === 'user' && e.source === 'turn_start')
    return [{ type: 'system', subtype: 'init', session_id }];
  if (e.type === 'message' && e.role === 'assistant') {
    const text = textOf(e.content);
    if (!text) return [];
    state.last = text;
    return [streamMessage('assistant', session_id, [{ type: 'text', text }])];
  }
  if (e.type === 'effect') {
    const { name, input } = toolCall(e.detail);
    const failed = e.state?.status !== 'completed';
    const output = failed
      ? String(e.state?.error?.message ?? e.state?.status ?? '')
      : String(e.state?.outputText ?? '');
    const use = { type: 'tool_use', id: e.id, name, input };
    const result = { type: 'tool_result', tool_use_id: e.id, content: output, is_error: failed };
    return [streamMessage('assistant', session_id, [use]), streamMessage('user', session_id, [result])];
  }
  return [];
}

const textOf = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .filter(c => c?.type === 'text')
    .map(c => String(c.text))
    .join('\n\n');

// Vibe's tools under Claude Code's names and inputs, so the worker's steps and a reviewer's verdict read them. Any
// other tool keeps its own name, which the verdict counts as a step that may write anything.
function toolCall(detail: any): { name: string; input: Record<string, unknown> } {
  const tool = String(detail?.toolName ?? '').replace(/^file_system\./, '');
  const input = detail?.input ?? {};
  const file_path = input.filePath ?? input.path;
  if (tool === 'bash') return { name: 'Bash', input: { command: input.command } };
  if (tool === 'read_file') return { name: 'Read', input: { file_path } };
  if (tool === 'write_file') return { name: 'Write', input: { file_path, content: input.content } };
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if ((tool === 'search_replace' || tool === 'edit') && changes.length === 1) {
    const [change] = changes;
    return {
      name: 'Edit',
      input: {
        file_path,
        old_string: change.oldString,
        new_string: change.newString,
        replace_all: !!change.replaceAll,
      },
    };
  }
  if (tool === 'search_replace' || tool === 'edit') return { name: 'MultiEdit', input: { file_path, edits: changes } };
  return { name: tool || String(detail?.toolName), input };
}

// The run export as Claude's result. A job's processes can write the export, so a limit or a sign-out also needs the
// exit code the worker saw: 2 is a failure under the agent (a 429 after Vibe's retries), 1 a run that couldn't start.
// Its error's words reach the seat's verdict (and the limit's reset time) only then; otherwise a fixed text stands in.
function resultOf(x: any, state: Record<string, unknown>) {
  const exitCode = state.exitCode ?? x.exit_code;
  const code = x.error?.code,
    message = String(x.error?.message ?? '');
  const signedOut = exitCode === 1 && (code === 'invalid_api_key' || /^Missing \w+ environment variable/.test(message));
  const status = exitCode === 2 && code === 'rate_limit' ? 429 : signedOut ? 401 : undefined;
  const usage = x.usage ?? {},
    cached = count(usage.cached_input_tokens),
    cost = count(x.cost_usd);
  const model = String(x.config?.active_model || DEFAULT_MODEL);
  const isError = x.outcome !== 'finished';
  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    session_id: state.session,
    ...(isError ? {} : { result: state.last }),
    ...(status ? { api_error_status: status } : {}),
    ...(x.error ? { errors: [status ? message : 'error_during_execution'] } : {}),
    total_cost_usd: cost,
    modelUsage: {
      [model]: {
        inputTokens: Math.max(0, count(usage.input_tokens) - cached),
        cacheReadInputTokens: cached,
        cacheCreationInputTokens: 0,
        outputTokens: count(usage.output_tokens),
        costUSD: cost,
      },
    },
  };
}
