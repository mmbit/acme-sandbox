// A run's account, kept as worker.ts reads its stream and reported with its finish: its token use so far (usage.ts) and
// whether anyone else may hold its token. HQ publishes the CEO's notes to the Overseer only from a run reported solo
// (the coordinator's overseer.ts).
import { count, sumUsage, usageOf, type Usage } from './usage.ts';

// usage: running totals for the session (resumed: it kept its home, so the engine may have started from the session's
// saved totals), with the run's own main thread (Main); before: the first launch's tokens, once a second one runs (a
// reviewer asked again whether its verdict stands). delegated: as far as the stream shows, read from the whole stream
// (a run taken over reads it again), and always for another CLI than Claude Code, whose stream alone is read for it. A
// model a shell command starts itself isn't in any stream. messages: the main thread's message ids seen so far.
export type Spent = {
  usage?: Usage & Main & { resumed: boolean; lastTurn?: number };
  before?: Usage;
  delegated: boolean;
  main: Main;
  messages: Set<string>;
  lastTurn?: number;
};

// The run's main thread, as Claude Code's stream shows it: opening, its first
// message's whole context (what the run started with, read again on every turn); openingWritten, the part of it written
// to the prompt cache (on a resume after the cache expired, the whole carried context); turns, its messages. A second
// launch keeps the first's opening and adds its turns. Codex's stream has none of it: one turn.completed per run, its
// figures the session's running totals.
export type Main = { opening?: number; openingWritten?: number; turns?: number };

export const spentOn = (cli: string): Spent => ({ delegated: cli !== 'claude', main: {}, messages: new Set() });

// Each event of the run's stream, as worker.ts reads it (another CLI's as the Claude Code events it stands for); `model`
// names Codex's model (usageOf). `now`: when it came, or none for an event read again (a run taken over).
export function see(spent: Spent, e: any, model: string | null | undefined, resumed: boolean, now?: number) {
  if (mayDelegate(e)) spent.delegated = true;
  measure(spent, e);
  if (now !== undefined && replied(e)) spent.lastTurn = now;
  // Token use (Claude's result, Codex's turn.completed): running totals for the session, so the last one counts
  const tokens = usageOf(e, model);
  const total = tokens && spent.before ? sumUsage(spent.before, tokens) : tokens;
  if (total)
    spent.usage = {
      ...total,
      ...spent.main,
      resumed,
      ...(spent.lastTurn !== undefined && { lastTurn: spent.lastTurn }),
    };
}

// A reply of the session's model on its main thread (Claude's, Codex's message): its prompt cache's hour starts with the
// request behind it, so the last one tells a later job whether the session is still warm (the coordinator's
// carryover.ts). Not the run's end, which comes after its stop hooks (the gates) and the push's checks.
const replied = (e: any) =>
  (e?.type === 'assistant' && !e.parent_tool_use_id) ||
  (e?.type === 'item.completed' && e.item?.type === 'agent_message');

// A main-thread message (no parent_tool_use_id) comes as one event per content block, all with its id.
function measure(spent: Spent, e: any) {
  const message = e?.type === 'assistant' && !e.parent_tool_use_id ? e.message : undefined;
  if (typeof message?.id !== 'string' || spent.messages.has(message.id)) return;
  spent.messages.add(message.id);
  spent.main.turns = spent.messages.size;
  if (spent.main.opening !== undefined) return;
  const u = message.usage;
  spent.main.openingWritten = count(u?.cache_creation_input_tokens);
  spent.main.opening = count(u?.input_tokens) + spent.main.openingWritten + count(u?.cache_read_input_tokens);
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
