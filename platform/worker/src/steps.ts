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
      return {
        text: commandKind(input.command),
        board: quote(input.description) || `Running ${quote(input.command, 50)}`,
      };
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

// A command as agents read it: the program it runs and the script, npm script or
// subcommand that program takes first (node book-check.mjs, npm run gates, hq report, git log), so a colleague can see
// what a job is busy with (hq activity), but never its other arguments, where a customer's details can be. A script
// is named like a file read (its base name); words that aren't plain names are left out, and so is every word that
// comes from inside quotes (or after a backslash): only bash -c's own body is read, the same way (job #24913).
const RUNNERS = new Set(['node', 'python', 'python3', 'tsx', 'deno', 'bun', 'bash', 'sh']),
  SUBCOMMANDS = new Set(['hq', 'git', 'npm', 'npx', 'pnpm', 'yarn', 'docker', 'gh']),
  SKIPPED = new Set(['cd', 'export', 'set', 'source', '.', 'sleep', 'echo']);
export function commandKind(command: unknown, depth = 0): string {
  const parts = wordsOf(String(command ?? ''))
    .map(ws =>
      ws.slice(
        Math.max(
          0,
          ws.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.lead)),
        ),
      ),
    )
    .filter(ws => ws[0] && !(!ws[0].quoted && SKIPPED.has(ws[0].text)));
  const [program, ...rest] = parts[0] ?? [];
  const name = program && !program.quoted ? (program.text.split('/').pop() ?? '') : '';
  if (!/^[A-Za-z][\w.+-]*$/.test(name)) return 'Running a command';
  const flags = rest.filter(w => !w.quoted && w.text.startsWith('-')).map(w => w.text),
    args = rest.filter(w => w.quoted || !w.text.startsWith('-')),
    plain = (w?: Word) => (w && !w.quoted ? w.text : '');
  // (bash -lc '…', as Codex runs every command: the command inside, read whole before anything is split)
  const flagC = rest.findIndex(w => !w.quoted && /^-[a-z]*c[a-z]*$/.test(w.text));
  if ((name === 'bash' || name === 'sh') && flagC >= 0 && rest[flagC + 1] && depth === 0)
    return commandKind(rest[flagC + 1].text, 1);
  let what = '';
  // (inline code, python -c or node -e, names no script)
  if (RUNNERS.has(name) && !flags.some(w => ['-c', '-e', '--eval', '-p', '--print'].includes(w))) {
    const script = /\.[A-Za-z]{1,4}$/.test(plain(args[0])) ? plain(args[0]).split('/').pop() : '';
    if (script && /^[\w.+-]+$/.test(script)) what = ` ${script}`;
  } else if (SUBCOMMANDS.has(name) && /^[a-z][a-z-]*$/.test(plain(args[0]))) {
    what = ` ${plain(args[0])}`;
    if (plain(args[0]) === 'run' && /^[\w:.-]+$/.test(plain(args[1]))) what += ` ${plain(args[1])}`;
  }
  return `Running ${name}${what}`;
}

// A command's simple commands (split at && || ; | & and line ends outside quotes), each as its words, the way a shell
// reads them: a quoted string is part of one word, never split. quoted: some of the word came from inside quotes or
// after a backslash; lead: the word up to its first quote (an assignment's name). A comment and a here-document's body
// are left out (from the line a << ends, nothing more is read).
type Word = { text: string; quoted: boolean; lead: string };
function wordsOf(s: string): Word[][] {
  const commands: Word[][] = [[]];
  let word: Word | null = null,
    heredoc = false;
  const add = (t: string, quoted = false) => {
    word ??= { text: '', quoted: false, lead: '' };
    if (!quoted && !word.quoted) word.lead += t;
    word.text += t;
    word.quoted ||= quoted;
  };
  const end = () => {
    if (word) commands.at(-1)!.push(word);
    word = null;
  };
  const cut = () => {
    end();
    if (commands.at(-1)!.length) commands.push([]);
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i],
      q = chunkAt(s, i);
    if (q) {
      if (q.text !== null) add(q.text, true);
      i = q.end;
    } else if (c === '#' && !word) {
      const line = s.indexOf('\n', i);
      i = (line < 0 ? s.length : line) - 1;
    } else if (c === '\n') {
      if (heredoc) break;
      cut();
    } else if (/\s/.test(c)) end();
    else if (c === '|' && s[i - 1] === '>' && /[<>]$/.test((word as Word | null)?.text ?? '')) add(c);
    else if (c === ';' || c === '|') {
      cut();
      if (s[i + 1] === c || (c === '|' && s[i + 1] === '&')) i++;
    } else if (c === '&') {
      // (2>&1, >&2 and &> are redirections, not a command's end)
      if (s[i + 1] === '>' || (s[i + 1] !== '&' && /[<>]$/.test((word as Word | null)?.text ?? ''))) add(c);
      else {
        cut();
        if (s[i + 1] === '&') i++;
      }
    } else {
      if (heredocAt(s, i)) heredoc = true;
      add(c);
    }
  }
  end();
  return commands.map(withoutRedirections).filter(ws => ws.length);
}
// A simple command's words without its redirections (>file, 2>&1, <<EOF, >|out), which name no word: with its operator
// alone, the next word is its operand.
function withoutRedirections(ws: Word[]): Word[] {
  const redirection = (w?: Word) => !!w && /^(\d*|&)[<>]/.test(w.lead),
    operator = (w?: Word) => redirection(w) && !w!.quoted && /^(\d*|&)[<>]+[&|]?$/.test(w!.text);
  return ws.filter((w, k) => !redirection(w) && !operator(ws[k - 1]));
}
// The quoted text or substitution that starts at i, read whole ('…', $'…', "…", a backslash's character, `…`, $(…),
// ${…} and the process substitutions <(…) and >(…)), and the index of its last character; null where none starts.
function chunkAt(s: string, i: number): { text: string | null; end: number } | null {
  const c = s[i];
  if (c === "'" || c === '"' || c === '\\' || (c === '$' && s[i + 1] === "'")) return quotedAt(s, i);
  if (c !== '`' && !(/[$<>]/.test(c) && s[i + 1] === '(') && !(c === '$' && s[i + 1] === '{')) return null;
  const end = substitutionEnd(s, i);
  return { text: s.slice(i, end + 1), end };
}
// The quoted text that starts at i ('…', $'…', "…" or a backslash's one character) and the index of its last character.
// A backslash before a line end continues the line: no text.
function quotedAt(s: string, i: number): { text: string | null; end: number } {
  if (s[i] === '\\') return { text: s[i + 1] === '\n' ? null : (s[i + 1] ?? ''), end: i + 1 };
  if (s[i] === '$') {
    // ($'…' takes backslash escapes, \' among them)
    let j = i + 2;
    for (; j < s.length && s[j] !== "'"; j++) if (s[j] === '\\') j++;
    return { text: s.slice(i + 2, j), end: Math.min(j, s.length) };
  }
  if (s[i] === "'") {
    const close = s.indexOf("'", i + 1),
      end = close < 0 ? s.length : close;
    return { text: s.slice(i + 1, end), end };
  }
  let text = '',
    j = i + 1;
  for (; j < s.length && s[j] !== '"'; j++) {
    if (s[j] === '`' || (s[j] === '$' && (s[j + 1] === '(' || s[j + 1] === '{'))) {
      const e = substitutionEnd(s, j);
      text += s.slice(j, e + 1);
      j = e;
    } else text += s[j] === '\\' && j + 1 < s.length ? s[++j] : s[j];
  }
  return { text, end: j };
}
// The index of the last character of the command substitution or expansion that starts at i (`…`, $(…) or ${…}), read
// whole: what is quoted inside it is quoted at its own level, so a quote there doesn't end an outer one.
function substitutionEnd(s: string, i: number): number {
  let j = i + 1;
  if (s[i] === '`') {
    for (; j < s.length && s[j] !== '`'; j++) if (s[j] === '\\') j++;
    return Math.min(j, s.length);
  }
  const open = s[j],
    close = open === '(' ? ')' : '}',
    cases: number[] = [];
  // (the end of the last quoted part or substitution read whole: its ')' is no separator)
  let skipped = -1;
  for (let depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j = skipped = j + 1;
    // (in $(…) a comment runs to its line end: a ')' or a quote there closes nothing)
    else if (open === '(' && c === '#' && /[\s|&;()<>]/.test(s[j - 1])) {
      const line = s.indexOf('\n', j);
      j = (line < 0 ? s.length : line) - 1;
    }
    // (where a here-document's body ends depends on how bash reads its delimiter and its lines (bytes, ANSI-C escapes,
    // the locale, line continuations, a ')' after the delimiter): rather than follow it, the substitution runs on to the
    // command's end, so nothing after it is named)
    else if (open === '(' && heredocAt(s, j)) return s.length;
    // (and from a case to its esac, each a command's first word (after a separator or a pattern's ')', then any reserved
    // words or braces, each a word of its own), a ')' at the case's own level ends a pattern)
    else if (
      open === '(' &&
      /^(case|esac)(?![^\s;&|)])/.test(s.slice(j, j + 5)) &&
      (m => !!m && m.index !== skipped)(
        /[;&|()\n][ \t]*(?:(?:then|do|else|elif|if|while|until|[{!])[ \t]+)*$/.exec(s.slice(0, j)),
      )
    ) {
      if (c === 'c') cases.push(depth);
      else cases.pop();
      j += 3;
    } else if (c === "'" || c === '"' || (c === '$' && s[j + 1] === "'")) j = skipped = quotedAt(s, j).end;
    else if (c === '`' || (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{'))) j = skipped = substitutionEnd(s, j);
    else if (c === open) depth++;
    else if (c === close && cases.at(-1) !== depth && !--depth) return j;
  }
  return s.length;
}
// Whether a here-document's operator (<< or <<-, not the here-string's <<<) starts at i, or may: a < before a line
// continuation, which bash joins to what comes after it.
function heredocAt(s: string, i: number): boolean {
  if (s[i] !== '<') return false;
  return s.startsWith('\\\n', i + 1) || (s[i + 1] === '<' && s[i - 1] !== '<' && s[i + 2] !== '<');
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
