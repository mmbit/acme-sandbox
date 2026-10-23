// A run's account, kept as worker.ts reads its stream and reported with its finish: its token use so far (usage.ts) and
// whether anyone else may hold its token. HQ publishes the CEO's notes to the Overseer only from a run reported solo
// (the coordinator's overseer.ts).
import { sumUsage, usageOf, type Usage } from './usage.ts';

// usage: running totals for the session (resumed: it kept its home, so the engine may have started from the session's
// saved totals); before: the first launch's tokens, once a second one runs (a reviewer asked again whether its verdict
// stands). delegated: as far as the stream shows, read from the whole stream (a run taken over reads it again), and
// always for another CLI than Claude Code, whose stream alone is read for it. A model a shell command starts itself
// isn't in any stream.
export type Spent = { usage?: Usage & { resumed: boolean }; before?: Usage; delegated: boolean };

export const spentOn = (cli: string): Spent => ({ delegated: cli !== 'claude' });

// Each event of the run's stream, as worker.ts reads it (another CLI's as the Claude Code events it stands for); `model`
// names Codex's model (usageOf).
export function see(spent: Spent, e: any, model: string | null | undefined, resumed: boolean) {
  if (mayDelegate(e)) spent.delegated = true;
  // Token use (Claude's result, Codex's turn.completed): running totals for the session, so the last one counts
  const tokens = usageOf(e, model);
  const total = tokens && spent.before ? sumUsage(spent.before, tokens) : tokens;
  if (total) spent.usage = { ...total, resumed };
}

// A second launch starts: its tokens add to the first's.
export const relaunched = (spent: Spent) => {
  spent.before = spent.usage;
};

// What the finish report carries of it.
export const report = (spent: Spent) => ({ usage: spent.usage, solo: !spent.delegated });

// Whether a Claude Code event may mean someone else holds the run's token: an event from inside another call (a member,
// a workflow's agent, a skill run apart: any parent_tool_use_id), or a call to a tool not known to work alone, Agent and
// Task, Workflow and Skill, MCP and any tool added later included. It fails closed, so a run is solo only while every
// call it made is one of these.
const ALONE = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'Monitor',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
]);
const mayDelegate = (e: any) =>
  !!e?.parent_tool_use_id ||
  (e?.type === 'assistant' &&
    (e.message?.content ?? []).some((c: any) => c?.type === 'tool_use' && !ALONE.has(c.name)));
