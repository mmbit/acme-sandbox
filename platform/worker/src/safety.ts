// What may cross from the worker (root, holds GITHUB_TOKEN and WORKER_TOKEN) to agents (a uid per slot, slots.ts).
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

// From the worker's own environment only these pass; everything else (tokens, NODE_OPTIONS, proxies) stays behind.
const PASS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'SHELL', 'PLAYWRIGHT_BROWSERS_PATH', 'DISABLE_AUTOUPDATER', 'CI'];
// What the worker sets per seat and job. Anything else it passes by mistake is dropped, not leaked.
// (HQ_RENDERS: the renders store, which jobs may read, renders.ts)
// (the seat's sign-in never: it goes on a pipe, SIGN_IN below)
// (a seat's provider: where Claude Code sends its requests, and the models behind its aliases, providers.ts)
const SET = new Set(['HOME', 'USER', 'SHELL', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CODEX_HOME', 'HQ_URL', 'HQ_TOKEN', 'HQ_AGENT', 'HQ_JOB', 'HQ_JOB_DIR', 'HQ_RENDERS',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']);
// Test partner keys as /api/worker/secrets hands them out (PRINTAPI_TEST_CLIENT_ID arrives as PRINTAPI_CLIENT_ID).
const KEY = /^((PRINTAPI|STRIPE)_(?!TEST_|LIVE_)[A-Z0-9_]{2,40}|ANTHROPICEVAL_API_KEY)$/;

// A seat's sign-in (a token, or a key: providers.ts claudeEnv) reaches the Claude CLI on a pipe, its fd 3, never in its environment: everything a job runs has the
// CLI's uid and could read its /proc/<pid>/environ. The CLI reads the pipe to its end as it starts, and the sign-in is
// then in no variable, open descriptor or file of the job's (safety.test.ts, with the real CLI). The spawn's stdio needs
// a fourth 'pipe' for it (SIGN_IN.stdio).
export const SIGN_IN = {
  vars: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' },
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'] as 'pipe'[],
  hand(child: ChildProcess, token: string) { const p = child.stdio[3] as Writable | null; p?.on('error', () => {}); p?.end(token); },
};

// seatVars: the names another CLI's seat sets (clis.ts home and env), which pass as SET's do.
export function agentEnv(env: NodeJS.ProcessEnv, set: Record<string, string | undefined> = {}, keys: Record<string, unknown> = {}, seatVars: string[] = []) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys ?? {})) if (KEY.test(k) && typeof v === 'string') out[k] = v;
  for (const k of PASS) if (env[k] !== undefined) out[k] = env[k]!;
  for (const [k, v] of Object.entries(set)) if ((SET.has(k) || seatVars.includes(k)) && v !== undefined) out[k] = v;
  return out;
}

// Never let anything that looks like a key reach logs, reports, events or board requests. The same pattern as the
// coordinator's redact() (events.ts): keys by shape (each at a word start, so "desk-phone" stays), a password in a
// URL (a failed clone prints its URL; the host stays), Bearer and Basic headers, Twilio's account:token, and keys
// without a shape of their own (HQ_TOKEN, a PIN) by their name.
const KEYS = /\b(sk-|sk_|rk_|whsec_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|(?<=\/\/)[^\s/@:]+:[^\s/@]+(?=@)|\b(Bearer|Basic) [A-Za-z0-9._~+\/=-]{8,}|\bAC[0-9a-f]{32}:[0-9a-f]{32}\b/g;
const NAMED = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PIN))(["']?\s*[=:]\s*["']?)[^\s"'&;,]{6,}/g;
export const redact = (s: string) => s.replace(KEYS, '[redacted]').replace(NAMED, '$1$2[redacted]');
// A JSON file (a review verdict) redacted value by value, so it stays JSON: on the raw text NAMED can take the backslash
// of an escaped quote (\"HQ_TOKEN=x\") and leave a bare quote that ends the string. Text that isn't JSON is redacted as text.
export function redactJson(s: string) {
  const walk = (v: unknown): unknown => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), walk(x)])) : v;
  try { return JSON.stringify(walk(JSON.parse(s)), null, 2); } catch { return redact(s); }
}

// The only branches the worker pushes, and the only form a reviewed commit may take. A job's work goes on job/<n>; a
// thread task's own profile lines go to main on profile/<its id> (git.ts pushProfile), which nothing else pushes.
export const JOB_BRANCH = /^job\/\d+$/;
export const PROFILE_BRANCH = /^profile\/\d+$/;
// The branch a work job runs on: its job/<n>, or the profile/<n> of the profile pull request it fixes (pr).
export const workRunsOn = (branch: string, pr?: number | null) => JOB_BRANCH.test(branch) || (!!pr && PROFILE_BRANCH.test(branch));
export const SHA = /^[0-9a-f]{40}$/;

// Project/local config a checked-out branch could carry that the CLIs would act on: Claude Code runs hooks and an
// apiKeyHelper from .claude/settings*.json and launches MCP servers from .mcp.json; Codex launches .codex/config.toml's
// `mcp_servers` (its `notify` it ignores from a project-local file). A branch with any of these could run code inside a
// job — forging a reviewer/consolidator's .hq/review.json verdict (so a change merges unreviewed) or a work job's
// .hq/request.json. None of our branches carry them, so the worker strips them from every clone before it runs the CLI.
export const BRANCH_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.codex/config.toml', '.codex/hooks.json'];
// A reviewer or consolidator's clone loses the CLIs' whole project folders too: a branch's agents, skills and commands
// (frontmatter hooks, `!`-command blocks) are config the CLI may load, and a reviewer reads the change through git
// (`git diff origin/main...HEAD`, `git show`), which doesn't need these in the working tree. It never commits. Codex
// also reads `.agents` (its skills, `.agents/skills`, and plugin marketplaces) from any clone, trusted or not: a branch's
// skill reaches a reviewer's context as an instruction (0.160.1, against a scripted backend).
export const REVIEW_STRIP = ['.claude', '.codex', '.agents', '.mcp.json'];

// The Claude Code CLI arguments for a job. A reviewer or consolidator reads only user settings (--setting-sources user):
// it needs nothing of the branch's own project config (it reads the files it must with its tools), so no branch-committed
// hook, apiKeyHelper or MCP server loads while it reviews. A work job keeps the default sources, so its CLAUDE.md memory
// (AGENTS.md) still loads; the branch's settings files are stripped from the clone (BRANCH_CONFIG) instead, and its own
// settings (auto mode, inbox hooks) and team-member agent come from the explicit --settings and --agents here.
// autocompact: the context size at which Claude Code compacts the conversation (company/models.yaml), as tokens or
// `auto`; anything else is left out rather than passed on.
export function claudeArgs(o: { reviewing: boolean; settings: object; agents?: string[]; model?: string; effort?: string; autocompact?: string; session?: string | null }): string[] {
  const compactAt = /^(auto|\d+[kKmM]?)$/.test(o.autocompact ?? '') ? o.autocompact! : undefined;
  return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto',
    ...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : []),
    ...(compactAt ? ['--autocompact', compactAt] : []),
    '--settings', JSON.stringify(o.settings),
    ...(o.reviewing ? ['--setting-sources', 'user'] : (o.agents ?? [])),
    ...(o.session ? ['--resume', o.session] : [])];
}

// The Codex CLI arguments for a reviewer asked once more whether its verdict stands (askVerdictAgain, worker.ts). Codex has
// no switch for no tools. These flags disable the shell, image viewer and web search. The read-only sandbox refuses
// writes with no approvals. Code-mode exec, apply_patch and sub-agents remain available. A refused patch can test whether
// a file holds given lines without showing a step on the JSON stream. Sub-agent steps can also be absent from that stream.
// It runs from an empty folder in a home made anew. Any step shown in its stream or recorded in its own session log
// there, a code-mode call or a sub-agent's included, voids its answer (seeSessionLogs, verdictFromAnswer, verdict.ts).
export function codexAskArgs(o: { model?: string; effort?: string }): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image',
    ...(o.model ? ['-m', o.model] : []), ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []), '-'];
}
