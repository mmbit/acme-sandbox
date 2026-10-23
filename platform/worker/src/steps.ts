// An agent's steps as HQ shows them: a short line in plain words for each tool call, written here from the call itself
// (no model is asked). (The lines a job changes come from its clone: git.ts branchLines. The tests it passed come from
// HQ's test results:)
// A job that holds a customer's own details shows only what kind of step it takes: no paths, searches or commands. The
// board's own view in HQ (the live feed and a job's log as HQ shows it) gets the step itself all the same (shown).

export type Step = { text: string };

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
export function stepOf(name: string, input: any = {}, guarded = false): Step | null {
  switch (name) {
    case 'Read':
      return { text: guarded ? 'Reading a file' : `Reading ${file(input.file_path)}` };
    case 'Write':
      return { text: guarded ? 'Writing a file' : `Writing ${file(input.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
      return { text: guarded ? 'Editing a file' : `Editing ${file(input.file_path)}` };
    case 'NotebookEdit':
      return { text: guarded ? 'Editing a notebook' : `Editing ${file(input.notebook_path)}` };
    case 'Grep':
      return { text: guarded ? 'Searching the files' : `Searching for “${quote(input.pattern, 40)}”` };
    case 'Glob':
      return { text: guarded ? 'Looking for files' : `Looking for ${quote(input.pattern, 40)}` };
    // Claude Code asks for a few words on what each command does: the best line there is
    case 'Bash':
      return {
        text: guarded ? 'Running a command' : quote(input.description) || `Running ${quote(input.command, 50)}`,
      };
    case 'WebSearch':
      return { text: guarded ? 'Searching the web' : `Searching the web for “${quote(input.query, 40)}”` };
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(input.url).host;
      } catch {
        /* (no host to show) */
      }
      return { text: guarded || !host ? 'Reading a web page' : `Reading ${host}` };
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

// The same call as the job's log in HQ's projects view shows it (the coordinator's log.ts): as it was made, the
// command, the file, the search, cut at a readable length. A job holding a customer's details logs only its plain
// line (stepOf).
export function detailOf(name: string, input: any = {}, guarded = false): string | null {
  if (guarded) return stepOf(name, input, true)?.text ?? null;
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

// A line as it goes out: text, what anything agents can read keeps (the coordinator's events and job_log tables, the
// reports drawn from them); board, for a job holding a customer's details only, the line itself, for the board's own
// HQ session alone, which sees everything anyway (events.ts publish, log.ts logStep). A line agents can't read at all
// (what such a job's agent says between steps) has no text.
export type Shown = { text: string | null; board?: string };
export const shown = (guarded: boolean, line: (guarded: boolean) => string | null | undefined): Shown | null => {
  const full = line(false) ?? null;
  if (!guarded) return full === null ? null : { text: full };
  const kindOnly = line(true) ?? null;
  if (full === null || full === kindOnly) return kindOnly === null ? null : { text: kindOnly };
  return { text: kindOnly, board: full };
};

// Whether a job's lines go out guarded (shown): from its claim if it held a customer's details then, or from the
// coordinator's answer to one of its lines that says it holds them now (handed them mid-run: hq mail, a customer card).
// What was on its way before, the coordinator keeps for the board alone (server.ts kept).
export function guard(customers: boolean) {
  const g = {
    on: customers,
    follow: (sent: Promise<Response | void>) =>
      sent
        .then(r => (r?.ok ? r.json() : undefined))
        .then(a => {
          if (a?.customers) g.on = true;
        })
        .catch(() => {}),
  };
  return g;
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
