// Google's Antigravity CLI (agy) on a seat: its headless stream-json mode, read as Claude Code's stream.
import type { Cli } from '../clis.ts';
import { streamMessage } from './stream.ts';
import { count } from '../usage.ts';

// Usage is reported per run, not per model: a run without --model is counted under this name.
const UNNAMED_MODEL = 'agy';

export const agy: Cli = {
  name: 'Antigravity CLI',
  bin: 'agy',
  // agy keeps everything under $HOME/.gemini, which the worker sets already. Its background updater would otherwise
  // replace the binary it runs from, and only the string "true" turns it off.
  home: () => ({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }),
  // With no Secret Service on D-Bus to reach, agy keeps its Google sign-in (and the account's tier and project) here.
  credentials: ['.gemini/antigravity-cli/antigravity-oauth-token'],
  // Its token is Go's oauth2.Token: a refresh brings a new access token and expiry, and Google keeps the refresh token
  refreshed: ['access_token', 'expiry', 'expires_in'],
  // Shell commands need --dangerously-skip-permissions: headless agy denies any tool that would ask, and carries on.
  run: o => [...headless(o), '--dangerously-skip-permissions', ...(o.session ? ['--conversation', o.session] : [])],
  // Without --dangerously-skip-permissions, commands, web pages and MCP tools are denied. Reading and writing files in
  // the working folder stays allowed, and the stream shows any such step.
  ask: o => headless(o),
  input: prompt => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
  events,
  // Rules, skills, workflows, hooks.json and mcp_config.json live in .agents (or .agent, _agents, _agent). GEMINI.md
  // and AGENTS.md at the root or in those folders are its instructions. Ours is AGENTS.md, which every engine reads.
  strip: [
    '.agents',
    '.agent',
    '_agents',
    '_agent',
    '.gemini',
    'GEMINI.md',
    '.codeium.yaml',
    '.codeium.yml',
    'codeium.yaml',
    'codeium.yml',
  ],
  // Plain `agy` prints a Google sign-in page and waits for the code that page shows only in a terminal it takes for an
  // SSH session (SSH_CONNECTION set; otherwise it opens a browser on this machine and asks for no code), and starts on
  // a screen that waits for Enter.
  signIn: { args: [], asks: 'code', env: { SSH_CONNECTION: '127.0.0.1 22 127.0.0.1 22' }, typed: '\r' },
  errors: {
    // The account's tier check: "Account ineligible: <reason>", reasons such as INELIGIBLE_ACCOUNT or ADMIN_SUSPENDED
    closed: /Account ineligible|INELIGIBLE_ACCOUNT|\b(ADMIN_|PARENT_)?SUSPENDED\b/,
    auth: /authentication (required|failed)|UNAUTHENTICATED|not logged into Antigravity|Please log out \(\/logout\) and log back in/i,
    limit: /RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|Out of credits/i,
  },
};

// The prompt comes on stdin as one stream-json message, and closing stdin ends the session once that turn is done.
// --print-timeout 0 leaves a run's time limit to the worker.
function headless(o: { model?: string; effort?: string }) {
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--print-timeout',
    '0',
    '--disable-slash-commands',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
  ];
}

// One line of agy's stream: init, step_update (a reply, a tool, or a step of its own) and result. The run's state keeps
// its conversation, its model, the reply text so far per step, and the tool steps already shown.
function events(e: any, state: Record<string, unknown>): object[] {
  if (e?.event === 'init') {
    state.model = e.init?.model;
    if (e.conversation_id) state.session = e.conversation_id;
    return [{ type: 'system', subtype: 'init', session_id: state.session, model: state.model }];
  }
  if (e?.event === 'result') return [resultOf(e.result ?? {}, state)];
  const step = e?.event === 'step_update' ? e.step_update : undefined;
  if (step?.step_type === 'agent_response') return reply(step, state);
  if (step?.step_type === 'tool') return toolStep(step, state);
  return [];
}

// A reply arrives as text deltas, in ACTIVE lines and the DONE line that ends the step: shown whole once it's done.
function reply(step: any, state: Record<string, unknown>): object[] {
  const texts = (state.texts ??= {}) as Record<string, string>;
  const text = (texts[step.step_index] ?? '') + (step.text_delta ?? '');
  if (step.state !== 'DONE') {
    texts[step.step_index] = text;
    return [];
  }
  delete texts[step.step_index];
  if (!text.trim()) return [];
  return [streamMessage('assistant', state.session, [{ type: 'text', text: text.trimEnd() }])];
}

// A tool step is ACTIVE when called and DONE with its output, or only DONE. Its call is shown once, its result at DONE.
function toolStep(step: any, state: Record<string, unknown>): object[] {
  const shown = (state.tools ??= new Set<string>()) as Set<string>;
  const id = `${step.conversation_id}:${step.step_index}`;
  const toolInfo = step.tool_info ?? {};
  const shownEvents: object[] = [];
  if (!shown.has(id)) {
    shown.add(id);
    const use = { type: 'tool_use', id, ...toolCall(toolInfo.name ?? step.tool_name, toolInfo.parameters ?? {}) };
    shownEvents.push(streamMessage('assistant', state.session, [use]));
  }
  if (step.state === 'DONE') {
    const failed = !!toolInfo.error;
    const content = failed
      ? String(toolInfo.error.message ?? toolInfo.error.type ?? '')
      : String(toolInfo.output ?? '');
    const toolResult = { type: 'tool_result', tool_use_id: id, content, is_error: failed };
    shownEvents.push(streamMessage('user', state.session, [toolResult]));
  }
  return shownEvents;
}

// agy's tools under Claude Code's names and inputs, so the worker's steps and a reviewer's verdict read them. Its
// stream shows a file tool's path but not the text it wrote, so a verdict file it writes stays unknown and the final
// message decides. Any other tool keeps its own name, which the verdict counts as a step that may write anything.
function toolCall(tool: string, input: any): { name: string; input: Record<string, unknown> } {
  if (tool === 'run_command') return { name: 'Bash', input: { command: input.CommandLine } };
  if (tool === 'view_file') return { name: 'Read', input: { file_path: input.AbsolutePath } };
  if (tool === 'write_to_file') return { name: 'Write', input: { file_path: input.TargetFile } };
  if (tool === 'replace_file_content' || tool === 'multi_replace_file_content')
    return { name: 'Edit', input: { file_path: input.TargetFile } };
  if (SEARCHES[tool]) return { name: SEARCHES[tool], input };
  if (tool === 'read_url_content') return { name: 'WebFetch', input: { url: input.Url } };
  if (tool === 'search_web') return { name: 'WebSearch', input: { query: input.query } };
  return { name: String(tool), input };
}
// Read-only searches, renamed only: their inputs keep agy's own names
const SEARCHES: Record<string, string> = { grep_search: 'Grep', find_by_name: 'Glob', list_dir: 'LS' };

// The run's result as Claude's. Its usage is the conversation's running total and its error is agy's own text, which
// names the API's HTTP status when the model's API answered with one ("Error 429, Message: ...").
function resultOf(r: any, state: Record<string, unknown>) {
  if (r.conversation_id) state.session = r.conversation_id;
  const isError = r.status !== 'SUCCESS';
  const error = String(r.error ?? '');
  const usage = r.usage ?? {};
  const model = String(state.model || UNNAMED_MODEL);
  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    session_id: state.session,
    ...(isError ? {} : { result: String(r.response ?? '').trimEnd() }),
    ...(isError ? { api_error_status: statusOf(error), errors: [error || r.status] } : {}),
    num_turns: r.num_turns,
    modelUsage: {
      [model]: {
        // input_tokens already leaves out the cached part, and output_tokens counts the thinking too
        inputTokens: count(usage.input_tokens),
        cacheReadInputTokens: count(usage.cache_read_tokens),
        cacheCreationInputTokens: 0,
        outputTokens: count(usage.output_tokens),
      },
    },
  };
}

// agy signs nothing in before it fails ("authentication failed or timed out"), so that text stands for a 401
function statusOf(error: string) {
  const http = error.match(/\bError (\d{3}), Message:/);
  if (http) return Number(http[1]);
  if (agy.errors.auth.test(error)) return 401;
  if (agy.errors.limit.test(error)) return 429;
  return undefined;
}
