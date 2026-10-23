// Classifies tool inputs into a fixed vocabulary without retaining arguments.
import { literalCommands, type SyntaxReason } from './syntax.ts';
import { fileOperands, type ReadDiagnostic } from './reads.ts';
export const LOOKUPS = [
  'charter',
  'profile',
  'department',
  'rules',
  'memory',
  'notes',
  'search',
  'history',
  'help',
] as const;
export const SOURCES = [
  'hq/discovery',
  'hq/run',
  'hq/memory',
  'hq/jobs',
  'hq/estimate',
  'hq/preview',
  'hq/studio',
  'hq/pictures',
  'hq/cards',
  'hq/mail',
  'hq/other',
  'coordinator',
  'kits',
  'infra',
] as const;
export const COMMANDS = [
  'help',
  'search',
  'history',
  'call',
  'intercom',
  'jobs',
  'job',
  'estimate',
  'status',
  'run',
  'preview',
  'picture',
  'studio',
  'request',
  'ask',
  'wait',
  'other',
] as const;
export const ACTIVITIES = ['browser', 'gates', 'tests'] as const;
export type Lookup = (typeof LOOKUPS)[number];
export type Source = (typeof SOURCES)[number];
export type Command = (typeof COMMANDS)[number];
export type Activity = (typeof ACTIVITIES)[number];
export type UnknownReason =
  'shellSyntax' | 'shellProgram' | 'readOptions' | 'fileSearch' | 'fileChange' | 'web' | 'mcp' | 'otherTool';
export type Diagnostic =
  | SyntaxReason
  | 'directoryProgram'
  | 'searchProgram'
  | 'versionControlProgram'
  | 'interpreterProgram'
  | 'outputProgram'
  | 'environmentProgram'
  | 'otherProgram'
  | ReadDiagnostic;
export type Category = Lookup | Source | Command | Activity | UnknownReason | Diagnostic;
export type Labels = {
  lookups: Lookup[];
  sources: Source[];
  commands: Command[];
  activities: Activity[];
  boundary: boolean;
  unknownReasons: UnknownReason[];
  diagnostics: Diagnostic[];
};

export function classify(name: string, input: any): Labels {
  if (name === 'Read') return paths([String(input.file_path ?? '')]);
  if (name === 'Bash') return shell(String(input.command ?? ''));
  if (['TodoWrite', 'Agent', 'Task', 'SendMessage'].includes(name)) return empty();
  const reason = ['Grep', 'Glob'].includes(name)
    ? 'fileSearch'
    : ['Edit', 'Write', 'MultiEdit'].includes(name)
      ? 'fileChange'
      : ['WebSearch', 'WebFetch'].includes(name)
        ? 'web'
        : name.startsWith('mcp__') || name === 'CodexMCP'
          ? 'mcp'
          : 'otherTool';
  return unknown(reason);
}

function paths(files: string[]): Labels {
  const lookups: Lookup[] = [],
    sources: Source[] = [];
  for (const file of files) {
    const lookup = lookupOf(file),
      source = sourceOf(file);
    if (lookup) lookups.push(lookup);
    if (source) sources.push(source);
  }
  return { ...empty(), lookups, sources, boundary: files.some(file => !lookupOf(file)), unknownReasons: [] };
}

function lookupOf(file: string): Lookup | null {
  if (/(^|\/)company\/CHARTER\.md$/.test(file)) return 'charter';
  if (/(^|\/)company\/people\/[^/]+\.md$/.test(file)) return 'profile';
  if (/(^|\/)company\/departments\/[^/]+\.md$/.test(file)) return 'department';
  if (/(^|\/)(AGENTS|CODE_STYLE)\.md$/.test(file)) return 'rules';
  if (/(^|\/)MEMORY\.md$/.test(file)) return 'memory';
  if (/(^|\/)(knowledge\/|shared\/craft\/|company\/playbooks\/)/.test(file)) return 'notes';
  return null;
}

function sourceOf(file: string): Source | null {
  if (!/\.(ts|js|mjs|cjs|sh|py|sql)$/.test(file)) return null;
  if (/(^|\/)platform\/worker\/hq\//.test(file)) {
    const module = file.split('/').at(-1);
    const families: Record<string, Source> = {
      'main.ts': 'hq/discovery',
      'runs.ts': 'hq/run',
      'memory.ts': 'hq/memory',
      'jobs.ts': 'hq/jobs',
      'estimate.ts': 'hq/estimate',
      'preview.ts': 'hq/preview',
      'studio.ts': 'hq/studio',
      'pictures.ts': 'hq/pictures',
      'cards.ts': 'hq/cards',
      'mail.ts': 'hq/mail',
    };
    return families[module ?? ''] ?? 'hq/other';
  }
  if (/(^|\/)platform\/coordinator\/src\//.test(file)) return 'coordinator';
  if (/(^|\/)kits\//.test(file)) return 'kits';
  if (/(^|\/)infra\//.test(file)) return 'infra';
  return null;
}

// Compound control flow and dynamic commands stay unknown rather than inventing executed commands.
function shell(command: string): Labels {
  const labels = literalCommands(command).map(literal =>
    'words' in literal ? wordsOf(literal.words) : unknown('shellSyntax', literal.reason),
  );
  return {
    lookups: labels.flatMap(label => label.lookups),
    sources: labels.flatMap(label => label.sources),
    commands: labels.flatMap(label => label.commands),
    activities: labels.flatMap(label => label.activities),
    boundary: labels.some(label => label.boundary),
    unknownReasons: labels.flatMap(label => label.unknownReasons),
    diagnostics: labels.flatMap(label => label.diagnostics),
  };
}

function wordsOf(words: string[]): Labels {
  const [program, ...args] = words;
  if (['bash', '/bin/bash', 'sh', '/bin/sh'].includes(program) && ['-c', '-lc'].includes(args[0]) && args.length === 2)
    return shell(args[1]);
  if (program === 'hq') return hq(args);
  if (program === 'pwd' || (program === 'git' && args[0] === 'status')) return empty();
  if (['cat', 'head', 'tail'].includes(program)) {
    const read = fileOperands(program, args);
    return 'files' in read ? paths(read.files) : unknown('readOptions', read.diagnostic);
  }
  if (program === 'sed' && args[0] === '-n' && args.length === 3) return paths([args[2]]);
  const browser =
    (program === 'node' && /(^|\/)[^/]+-check\.mjs$/.test(args[0] ?? '')) ||
    (program === 'npx' && args[0] === 'playwright') ||
    program === 'playwright';
  const activity = browser
    ? 'browser'
    : program === 'npm' && args[0] === 'run' && args[1] === 'gates'
      ? 'gates'
      : (program === 'npm' && ['test', 'tests'].includes(args[0] === 'run' ? args[1] : args[0])) ||
          (program === 'node' && args.includes('--test'))
        ? 'tests'
        : null;
  return activity
    ? { ...empty(), activities: [activity], boundary: true }
    : unknown('shellProgram', programOf(program));
}

function hq(args: string[]): Labels {
  if (args[0] === '--as') args = args.slice(2);
  const name = args[0] ?? 'help';
  const command = COMMANDS.find(command => command === name) ?? 'other';
  const help = ['help', '--help', '-h'].includes(name) || args.includes('--help');
  const lookup = help
    ? 'help'
    : ['search', 'history', 'call', 'intercom'].includes(name)
      ? name === 'search'
        ? 'search'
        : 'history'
      : null;
  return {
    ...empty(),
    commands: [help ? 'help' : command],
    lookups: lookup ? [lookup] : [],
    boundary: !lookup && name !== 'status',
  };
}

function programOf(program: string): Diagnostic {
  const families = new Map<string, Diagnostic>([
    ['cd', 'directoryProgram'],
    ['ls', 'directoryProgram'],
    ['find', 'directoryProgram'],
    ['rg', 'searchProgram'],
    ['grep', 'searchProgram'],
    ['egrep', 'searchProgram'],
    ['fgrep', 'searchProgram'],
    ['git', 'versionControlProgram'],
    ['gh', 'versionControlProgram'],
    ['node', 'interpreterProgram'],
    ['python', 'interpreterProgram'],
    ['python3', 'interpreterProgram'],
    ['ruby', 'interpreterProgram'],
    ['perl', 'interpreterProgram'],
    ['bash', 'interpreterProgram'],
    ['/bin/bash', 'interpreterProgram'],
    ['sh', 'interpreterProgram'],
    ['/bin/sh', 'interpreterProgram'],
    ['npm', 'interpreterProgram'],
    ['npx', 'interpreterProgram'],
    ['echo', 'outputProgram'],
    ['printf', 'outputProgram'],
    ['wc', 'outputProgram'],
    ['sort', 'outputProgram'],
    ['uniq', 'outputProgram'],
    ['cut', 'outputProgram'],
    ['tr', 'outputProgram'],
    ['tee', 'outputProgram'],
    ['sed', 'outputProgram'],
    ['awk', 'outputProgram'],
    ['env', 'environmentProgram'],
    ['export', 'environmentProgram'],
    ['set', 'environmentProgram'],
    ['timeout', 'environmentProgram'],
  ]);
  return families.get(program) ?? 'otherProgram';
}

const empty = (): Labels => ({
  lookups: [],
  sources: [],
  commands: [],
  activities: [],
  boundary: false,
  unknownReasons: [],
  diagnostics: [],
});

const unknown = (reason: UnknownReason, diagnostic?: Diagnostic): Labels => ({
  ...empty(),
  boundary: true,
  unknownReasons: [reason],
  diagnostics: diagnostic ? [diagnostic] : [],
});
