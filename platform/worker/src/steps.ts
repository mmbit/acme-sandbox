// An agent's steps as HQ shows them: a short line in plain words for each tool call, written here from the call itself
// (no model is asked). (The lines a job changes come from its clone: git.ts branchLines. The tests it passed come from
// HQ's test results:)
// Each line goes out twice: text, what anything agents can read keeps (the coordinator's events and job_log tables, the
// reports drawn from them), is the kind of step and what it names (a file, a host), never its arguments: a command or a
// search can carry a customer's details the job is rightly working with (charter rule 7). board is the line itself, for
// the board's own HQ session alone, which sees everything anyway.

export type Step = { text: string; board?: string };

const file = (p: unknown) =>
  String(p ?? '')
    .split('/')
    .pop() || 'a file';
const quote = (s: unknown, n = 60) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// What a Claude Code tool call does, in a line. Null for a call HQ shows otherwise (team members, messages) or not at all.
export function stepOf(name: string, input: any = {}): Step | null {
  switch (name) {
    case 'Read':
      return { text: `Reading ${file(input.file_path)}` };
    case 'Write':
      return { text: `Writing ${file(input.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
      return { text: `Editing ${file(input.file_path)}` };
    case 'NotebookEdit':
      return { text: `Editing ${file(input.notebook_path)}` };
    case 'Grep':
      return { text: 'Searching the files', board: `Searching for “${quote(input.pattern, 40)}”` };
    case 'Glob':
      return { text: 'Looking for files', board: `Looking for ${quote(input.pattern, 40)}` };
    // Claude Code asks for a few words on what each command does: the best line there is
    case 'Bash':
      return { text: 'Running a command', board: quote(input.description) || `Running ${quote(input.command, 50)}` };
    case 'WebSearch':
      return { text: 'Searching the web', board: `Searching the web for “${quote(input.query, 40)}”` };
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(input.url).host;
      } catch {
        /* (no host to show) */
      }
      return { text: host ? `Reading ${host}` : 'Reading a web page' };
    }
    case 'TodoWrite':
      return { text: 'Updating its plan' };
    case 'Agent':
    case 'Task':
    case 'SendMessage':
      return null;
    default:
      return { text: name.startsWith('mcp__') ? `Using ${name.split('__')[1] ?? 'a tool'}` : `Using ${name}` };
  }
}

// The same call as the job's log in HQ's projects view shows it (the coordinator's log.ts): for the board, as it was
// made, the command, the file, the search, cut at a readable length; for agents, its kind and what it names (stepOf).
export function detailOf(name: string, input: any = {}): Step {
  const made = madeAs(name, input);
  const kind =
    name === 'Agent' || name === 'Task'
      ? 'Starting a team member'
      : name === 'SendMessage'
        ? `To ${quote(input.to, 40)}`
        : stepOf(name, input)!.text;
  return made === kind ? { text: kind } : { text: kind, board: made };
}
function madeAs(name: string, input: any) {
  const s = (v: unknown, n = 300) => quote(v, n);
  switch (name) {
    case 'Bash':
      return `$ ${s(input.command, 600)}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `${name} ${s(input.file_path)}`;
    case 'NotebookEdit':
      return `Edit ${s(input.notebook_path)}`;
    case 'Grep':
      return `Grep “${s(input.pattern, 120)}”${input.path ? ` in ${s(input.path)}` : ''}${input.glob ? ` (${s(input.glob, 60)})` : ''}`;
    case 'Glob':
      return `Glob ${s(input.pattern, 120)}${input.path ? ` in ${s(input.path)}` : ''}`;
    case 'WebSearch':
      return `Search “${s(input.query, 200)}”`;
    case 'WebFetch':
      return `Fetch ${s(input.url)}`;
    case 'TodoWrite':
      return `Plan: ${s((input.todos ?? []).map((t: any) => `${t.status === 'completed' ? '✓ ' : ''}${t.content}`).join(' · '), 400)}`;
    case 'Agent':
    case 'Task':
      return `Team: ${s(input.description ?? input.name, 200)}`;
    case 'SendMessage':
      return `To ${s(input.to, 40)}: ${s(input.summary ?? input.message, 200)}`;
    default:
      return `${name} ${s(JSON.stringify(input), 300)}`;
  }
}

// Whether the Agent call that started a team member came back with its work done, or failed. The tool's own output
// says which: a background member's call comes back at once, 'async_launched', and its end is the session's
// task_notification.
export const memberReturned = (userEvent: any, toolResult: any) =>
  !!toolResult?.is_error || userEvent?.tool_use_result?.status === 'completed';
// A team member as the Agent call that starts it gives it: its name (the call's name, else its description, where the
// tool has none) and its task, the description, unless that only repeats the name (HQ then shows its latest step).
export function memberOf(input: any) {
  const name = String(input?.name ?? input?.description ?? 'helper'),
    said = String(input?.description ?? '').trim();
  const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return { name, task: bare(said) && bare(said) !== bare(name) ? said : '' };
}
// The tokens an event of the run wrote, about four characters each: Claude's text, thinking and tool calls (a message
// comes as one event per block; its usage there is the message's start, before it wrote anything), and Codex's
// replies, reasoning and commands as each completes.
const CHARS_PER_TOKEN = 4;
export function writtenTokens(e: any) {
  const parts =
    e?.type === 'assistant'
      ? (e.message?.content ?? []).map(
          (c: any) => c?.text ?? c?.thinking ?? (c?.type === 'tool_use' ? JSON.stringify(c.input ?? '') : ''),
        )
      : e?.type === 'item.completed'
        ? [e.item?.text ?? e.item?.command ?? '']
        : [];
  const chars = parts.reduce((n: number, p: unknown) => n + (typeof p === 'string' ? p.length : 0), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
