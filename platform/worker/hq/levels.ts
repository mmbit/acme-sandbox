// The levels a company's plans are drawn in, and how their names read: the foundation's base guide (its line for each
// level, the plain-words rule, and the examples and terms the board's names are written by), with what a company adds in its own
// company/levels.json (../../coordinator/docs/projects.md, "A project's plan"), read by the plan tools' help and usages,
// the owner's planning job (the coordinator's proposals.ts), the refusal of a name two levels share (its names.ts),
// hq plan's marks (its levels.ts) and the small model that writes the names the board reads (its plainnames.ts).
// Nothing imported but Node's: the coordinator reads it from here too.
import { readFileSync } from 'node:fs';

// How related work is drawn, the planner's judgment and never a count or a refusal (board, call 152): the levels' deliverable line, the CEO's hourly check and a meeting's review of the plans
export const RELATED_WORK =
  'Related work is one deliverable, its tasks in turn with one review at its end: a somewhat bigger deliverable is ' +
  'better than splitting it, and nobody works out first what each piece touches: when in doubt, it is one. A ' +
  'feature whose pieces go live separately is a chain, each deliverable needing the one before, so one merges at a ' +
  'time, never drawn to run side by side. A later piece is drawn needing the one before (hq plan deliverable ' +
  '--needs) before any of its tasks is queued: a queued task can start at once. The limit is seats, not agents: ' +
  'work side by side only spends the seats sooner, and the conflicts between its pieces lose more time than it ' +
  "gains. A small ask that isn't part of the feature never rides on its deliverable because the same agent has " +
  'both: it goes in the deliverable it belongs to, or one of its own.';

// What running deliverables side by side (hq plan unneed) is for, said wherever it's offered (board, call 165).
export const SIDE_BY_SIDE =
  'Only work that changes other files runs beside it: work on the same files stays chained, as side by side it ' +
  'collides and is merged by hand.';

// The deliverable line's "until its review has ruled".
export const LEVELS = {
  product: 'A product is what the company makes (a business in projects.yaml): it holds projects.',
  project:
    'A project is a part of its product with one owner, who draws its plan: something whole the product finishes (its ' +
    'user guide, one milestone, its shop, its launch, its website), named by a noun ("The user guide", not "Writing ' +
    'the guide"). Projects sit side by side at one level: never a product with a version number ("App 1.0"), where ' +
    'everything gravitates and a new version has nowhere to go. It may end (hq project done) or live on.',
  thread:
    'A deliverable takes its project to its "done when": a piece of work the board will see go live, adding one part ' +
    'to its project or improving one. Its tasks run in turn on one branch, any agent taking a turn, and it gets one ' +
    'review at its end. Deliverables are cut by what goes live, never one per note or call item: new work that ' +
    'belongs to an open deliverable is added to it before a new one is drawn, until its review has ruled (hq plan says ' +
    "so): from then it takes only its rulings' fixes, and new work goes in the next deliverable, drawn needing it, so " +
    'each round reviews one finished piece. ' +
    RELATED_WORK +
    ' Its name and "done when" are plain, short and ' +
    'concrete, saying what gets made ("Pick the shop\'s payment provider", "Sign-up emails in three languages", not ' +
    '"Payments, settled" or "Emails that land"). A card for the board is one step inside the deliverable that makes ' +
    'the thing, never a deliverable of its own, and a deliverable of one task belongs in the one it serves. It ends ' +
    'within hours, never days. Unrelated deliverables are two.',
  task:
    "A task is one agent's step along its deliverable, titled as that step alone, never with its deliverable's name " +
    'in front: about an hour of agent work, never two days.',
};
export type Level = keyof typeof LEVELS;
export const NO_SHARED_NAME = 'No two levels share a name.';
export const RECURRING = 'Work that repeats is a schedule entry (Recurring), never a deliverable or a project.';
// Every name the board reads, in plain words
export const PLAIN =
  "Every name the board reads (a project's, a deliverable's and its \"done when\", a task's, a project's sentence) " +
  "is plain human speech for someone who wasn't there: what gets made or the value it adds, in a few words, with no " +
  'internal terms, code names, file names or job, card or finding numbers, and no mannered prose or slogans.';
// The names the guide is shown by: an agent's words, and the same name as the board reads it
export type Example = { level: Level; from: string; to: string };
export const EXAMPLES: Example[] = [
  { level: 'project', from: 'Shop 1.0', to: 'The shop' },
  { level: 'thread', from: 'Payments, settled', to: "Pick the shop's payment provider" },
  { level: 'thread', from: 'Claim-plan cost', to: 'A free seat picks its next task fast' },
  {
    level: 'task',
    from: 'Read the retained claim-plan cohort at its boundary',
    to: "Measure how long HQ took to pick each free seat's next task",
  },
  { level: 'task', from: "Checkout: the board's pick, recorded", to: "Record the board's pick" },
  { level: 'task', from: 'Fix finding 614, finding 615', to: 'Fix a broken order path' },
  { level: 'task', from: 'Fix finding 702', to: 'Tidy two labels' },
  { level: 'task', from: 'Fix finding 731, finding 732, finding 733', to: 'Close a sign-in gap' },
];

// What the platform's own words mean, for the model that writes the board's names: a brief uses them without saying
export type Terms = Record<string, string>;
export const TERMS: Terms = {
  'claim plan': "HQ's plan of which queued task each free seat takes next",
  claim: 'a free seat taking its next task',
  seat: 'one AI subscription account that runs agents',
  slot: 'room for one agent to work on a seat',
  cohort: 'a set of measurements taken over a fixed time',
  'the play': "HQ's forecast of when each task starts and finishes",
  sizer: 'the model that estimates how long a task takes',
  'review panel': 'the reviewers who check a change before it goes live',
  'fix round': 'fixing what a review found',
  ruling: "a review's verdict",
  'touch-ups': 'small changes a reviewer made themselves',
  gates: 'the automatic checks every change must pass',
  wake: 'what a queued task waits for before it starts',
  card: "a question on the board's desk phone",
};

// All of it, a rule a line: the levels (the base guide's lines with a company's own), the rule across them and the
// plain-words rule
export const rules = (lines: Record<Level, string> = LEVELS, plain = PLAIN) => [
  ...Object.values(lines),
  `${NO_SHARED_NAME} ${RECURRING}`,
  plain,
];
export const levels = (lines: Record<Level, string> = LEVELS, plain = PLAIN) => rules(lines, plain).join('\n');

export type Split = { task_ms: number | null; thread_ms: number | null };
export type Levels = {
  lines: Record<Level, string>;
  plain: string;
  examples: Example[];
  terms: Terms;
  ahead: string | null;
  split: Split;
};

// The guide with the company's own in the repo at root (none outside one): a line it gives for a level, or for plain,
// follows the base guide's (its own words, its own examples), its examples come after the base's, its terms (what its
// own words mean) join the platform's, and it alone says
// ahead (what hq plan says when a project is its product's only open one) and split_minutes (the agent time past which
// hq plan marks a task still to start, and a thread's tasks to do, to split). Each left out is the base guide's alone,
// nothing said, no mark. A wrong one throws, naming it.
export function levelsIn(root: string | undefined): Levels {
  const given = setting(root === undefined ? undefined : fileIn(root), 'levels.json');
  const added = (base: string, name: string) => [base, line(given[name], name)].filter(Boolean).join(' ');
  const sizes = setting(given.split_minutes, 'split_minutes');
  return {
    lines: Object.fromEntries(Object.entries(LEVELS).map(([level, base]) => [level, added(base, level)])) as Record<
      Level,
      string
    >,
    plain: added(PLAIN, 'plain'),
    examples: [...EXAMPLES, ...examples(given.examples)],
    terms: { ...TERMS, ...terms(given.terms) },
    ahead: line(given.ahead, 'ahead'),
    split: { task_ms: minutes(sizes.task, 'task'), thread_ms: minutes(sizes.thread, 'thread') },
  };
}

function fileIn(root: string): unknown {
  let text;
  try {
    text = readFileSync(`${root}/company/levels.json`, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}
function setting(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`company/levels.json ${name}: a map of settings`);
  return value as Record<string, unknown>;
}
function line(value: unknown, name: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`company/levels.json ${name}: a line of text`);
  return value.trim();
}
function examples(value: unknown): Example[] {
  if (value === undefined || value === null) return [];
  const wrong = () =>
    new Error('company/levels.json examples: a list of { "level", "from", "to" }, a level and two names');
  if (!Array.isArray(value)) throw wrong();
  return value.map(e => {
    const { level, from, to } = (e ?? {}) as Record<string, unknown>;
    if (typeof level !== 'string' || !(level in LEVELS)) throw wrong();
    const [was, is] = [line(from, 'examples'), line(to, 'examples')];
    if (was === null || is === null) throw wrong();
    return { level: level as Level, from: was, to: is };
  });
}
function terms(value: unknown): Terms {
  return Object.fromEntries(
    Object.entries(setting(value, 'terms')).map(([term, meaning]) => {
      const said = line(meaning, `terms.${term}`);
      if (said === null) throw new Error(`company/levels.json terms.${term}: a line of text`);
      return [term, said];
    }),
  );
}
function minutes(value: unknown, name: string) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) <= 0)
    throw new Error(`company/levels.json split_minutes.${name}: whole minutes of agent time, above 0`);
  return (value as number) * 60_000;
}

// The texts as a command's help shows them: in its right-hand column, wrapped
export function asHelp(...texts: string[]) {
  const lines = texts.flatMap(t =>
    t.split(' ').reduce<string[]>((wrapped, word) => {
      const last = wrapped.length - 1;
      if (last >= 0 && wrapped[last].length + word.length < WIDTH) wrapped[last] += ` ${word}`;
      else wrapped.push(word);
      return wrapped;
    }, []),
  );
  return lines.map(line => `\n${' '.repeat(53)}${line}`).join('');
}
const WIDTH = 66;
