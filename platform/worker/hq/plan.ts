// A project's plan (hq plan): its threads, the threads each needs and their tasks in order, which the project's owner and
// the CEO draw and change (the coordinator's plan.ts).
import * as api from './api.ts';
import { at, duration } from './estimate.ts';
import { takeValues } from './flags.ts';
import { companyLevels } from './files.ts';
import { asHelp, rules, type Levels } from './levels.ts';
import { print, stop, text } from './output.ts';

type Task = {
  id: number;
  agent: string;
  title: string;
  status: string;
  started: string | null;
  size_ms: number | null;
  split: boolean;
};
type Thread = {
  id: string;
  name: string;
  goal: string;
  deadline: number | null;
  needs: string[];
  eta: number | null;
  stall: string | null;
  tasks: Task[];
  to_do_ms: number;
  split: boolean;
  done: number;
};
// product: its product's name and other open projects, null for a project in none; ahead and split: the company's levels
// (the coordinator's levels.ts), the marks on its tasks and threads.
type Plan = {
  id: string;
  name: string;
  owner: string;
  product: { name: string; others: { id: string; name: string }[] } | null;
  ahead: string | null;
  split: { task_ms: number | null; thread_ms: number | null };
  threads: Thread[];
};
// Where a drawn or renamed thread is (the coordinator's names.ts placeOf).
type Placed = {
  id: string;
  name: string;
  goal: string;
  was?: string;
  place: { product: string | null; project: { id: string; name: string }; beside: { id: string; name: string }[] };
};

// (rename and title, and the levels each name shows, the company's lines)
const threadUsage = () => `usage: hq plan thread <project> "name" "done when" [--needs <thread>]... [--slug <slug>]
${companyLevels().lines.thread}`;
const renameUsage = () => `usage: hq plan rename <thread> "name" ["done when"] [--slug <slug>]
${companyLevels().lines.thread}`;
const USAGE = `usage: hq plan <project> [--json], hq plan thread <project> "name" "done when" [--needs <thread>]... [--slug <slug>],
hq plan need | unneed <thread> <thread>, hq plan move <job> <place>, hq plan drop <job> "why", hq plan done <thread>,
hq plan rename <thread> "name" ["done when"] [--slug <slug>], or hq plan title <job> "title"`;

// (help reads the company's levels when it's shown)
export const plan = {
  get help() {
    const own = companyLevels();
    return `
   hq plan <project> [--json]                        the project's plan: its open threads, those another needs first,
                                                     each with its "done when", window, needs, planned finish and tasks
                                                     in order (agent, title, size, state); --json: all of it as data.${asHelp(...marksHelp(own))}
   hq plan thread <project> "name" "done when" [--needs <thread>]... [--slug <slug>]
                                                     draw a new thread, owned by the project's owner: "done when" is the
                                                     goal, naming its deliverable. It's read back in its
                                                     product and project, beside the project's other open threads. Its
                                                     tasks: hq job --thread <project>/<slug> --code WORD
   hq plan need <thread> <thread>                    the first thread starts once the second is done and merged (a loop
   hq plan unneed <thread> <thread>                  is refused, at any depth); unneed takes it back
   hq plan move <job> <place>                        a task to its place among its thread's tasks still to start (1: next)
   hq plan drop <job> "why"                          a task that never started leaves the plan (cancelled, why on its feed)
   hq plan done <thread>                             a thread whose "done when" is met with nothing to merge
   hq plan rename <thread> "name" ["done when"] [--slug <slug>]
                                                     an open thread's new name, maybe its "done when" and slug (the old
                                                     id keeps finding it, its jobs and pauses following)
   hq plan title <job> "title"                       a task that hasn't started gets a new title
                                                     Only the project's owner and the CEO change a plan: anyone else
                                                     proposes it to the owner (hq propose --project <project>). Each name
                                                     shows its level:${asHelp(...rules(own.lines, own.plain), OWN_LEVELS)}`;
  },

  async run([action, ...args]: string[]) {
    if (action === 'thread') return drawThread(args);
    if (action === 'need' || action === 'unneed') return need(action, args);
    if (action === 'move')
      return change('plan/move', args, ([id, place]) => ({ id: Number(id), place: Number(place) }));
    if (action === 'drop') return change('plan/drop', args, ([id, why]) => ({ id: Number(id), why }));
    if (action === 'done') return change('plan/done', args, ([thread]) => ({ thread }), 1);
    if (action === 'rename') return renameThread(args);
    if (action === 'title') return change('plan/title', args, ([id, title]) => ({ id: Number(id), title }));
    if (action && !action.startsWith('-')) return show(action, args);
    stop(USAGE);
  },
};

// What hq plan says by the company's levels: the sizes it marks to split, and its look ahead
function marksHelp({ split, ahead }: Levels) {
  const sizes = [
    split.task_ms !== null && `a task to start sized past ${duration(split.task_ms / 60_000)}`,
    split.thread_ms !== null && `a thread whose tasks to do add up past ${duration(split.thread_ms / 60_000)}`,
  ].filter(Boolean);
  return [
    ...(sizes.length ? [`It marks ${sizes.join(' and ')}, to split.`] : []),
    ...(ahead ? [`When nothing is planned beyond the project in its product, it says so: ${ahead}`] : []),
  ];
}
const OWN_LEVELS =
  "That's the foundation's naming guide: company/levels.json adds the company's own words and examples to a level's line and the plain-words rule, and sets the sizes marked and the look ahead.";

async function show(project: string, rest: string[]) {
  const json = rest.includes('--json');
  if (rest.some(arg => arg !== '--json')) stop(USAGE);
  const answer = await api.call(`plan?project=${api.uri(project)}`);
  if (answer.status === 404) stop(`There's no project ${project}.`);
  const found = api.parseOrNull(answer.body) as Plan | null;
  if (!api.isSuccess(answer.status) || !found)
    stop(`Couldn't read ${project}'s plan: ${api.errorIn(answer.body, 'no answer')}`);
  if (json) return print(JSON.stringify(found, null, 2));
  print(`${text(found.name)} (${text(found.id)}), ${text(found.owner)}'s plan`);
  if (found.ahead && found.product && !found.product.others.length)
    print(
      `It's ${text(found.product.name)}'s only open project: nothing is planned beyond it. ${text(found.ahead)} The CEO makes projects (hq project new).`,
    );
  if (!found.threads.length) return print('No open threads: draw one with hq plan thread.');
  for (const t of found.threads) print('', ...threadLines(t, found.split));
}

// The thread, its "done when", window, needs and planned finish, then its tasks in order, with the marks the company's
// sizes give them.
function threadLines(t: Thread, split: Plan['split']) {
  const finish =
    t.eta === null ? `no planned finish${t.stall ? ` (${text(t.stall)})` : ''}` : `planned finish ${at(t.eta)}`;
  const window = t.deadline === null ? '' : `, window ${at(t.deadline)}`;
  const needs = t.needs.length ? `, needs ${t.needs.map(text).join(', ')}` : '';
  let place = 0;
  const taskLines = t.tasks.flatMap(j => {
    const size = j.size_ms === null ? 'unsized' : duration(j.size_ms / 60_000);
    const toStart = j.status === 'queued' && j.started === null;
    const line = `  ${toStart ? `${++place}.` : '-'} #${j.id} ${text(j.agent)} (${size}, ${text(j.status)}): ${text(j.title)}`;
    return j.split ? [line, `     Sized past ${duration(split.task_ms! / 60_000)}: ${SPLIT_TASK}`] : [line];
  });
  const splitLine = t.split
    ? [
        `  Its tasks to do add up to ${duration(t.to_do_ms / 60_000)}, past ${duration(split.thread_ms! / 60_000)}: ${SPLIT_THREAD(t.id)}`,
      ]
    : [];
  return [
    `${text(t.id)}  ${text(t.name)}: ${finish}${window}${needs}`,
    `  done when ${text(t.goal)}`,
    ...(taskLines.length ? taskLines : ['  no tasks to do yet']),
    ...(t.done ? [`  (${t.done} done)`] : []),
    ...splitLine,
  ];
}
const SPLIT_TASK = 'split it into its steps (hq plan drop, then hq job --thread for each).';
const SPLIT_THREAD = (thread: string) =>
  `draw its later part as a thread of its own (hq plan thread with --needs ${text(thread)}) and move its tasks there (hq job move).`;

async function drawThread(given: string[]) {
  const needs: string[] = [];
  const rest = given.filter((arg, i) => {
    if (given[i - 1] === '--needs') return false;
    if (arg !== '--needs') return true;
    if (!given[i + 1]) stop('No thread was drawn: --needs takes a thread');
    needs.push(given[i + 1]);
    return false;
  });
  const { values, args } = takeValues(rest, ['--slug'], 'No thread was drawn');
  const [project, name, goal, ...more] = args;
  if (!project || !name?.trim() || !goal?.trim() || more.length) stop(threadUsage());
  const answer = await api.change('plan/thread', { body: api.withSpeaker({ project, name, goal, needs, ...values }) });
  const drawn = api.parseOrNull(answer.body) as Placed | null;
  if (!api.isSuccess(answer.status) || !drawn?.id)
    stop(`No thread was drawn: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    `Thread drawn${needs.length ? `, needing ${needs.join(', ')}` : ''}:`,
    ...placedLines(drawn),
    `Its tasks: hq job --thread ${text(drawn.id)} <agent> "title" <brief> --code WORD`, // (--code)
  );
}

// hq plan rename: read back as hq plan thread reads a drawn one.
async function renameThread(given: string[]) {
  const { values, args } = takeValues(given, ['--slug'], 'Nothing changed');
  const [thread, name, goal, ...more] = args;
  if (!thread || !name?.trim() || goal?.trim() === '' || more.length) stop(renameUsage());
  const answer = await api.change('plan/rename', { body: api.withSpeaker({ thread, name, goal, ...values }) });
  const renamed = api.parseOrNull(answer.body) as Placed | null;
  if (!api.isSuccess(answer.status) || !renamed?.id) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    `Thread renamed${renamed.was !== renamed.id ? ` (${text(renamed.was)} still finds it)` : ''}:`,
    ...placedLines(renamed),
  );
}

// The thread as the board reads it: product, project and thread, its "done when", then the project's other open threads
function placedLines(t: Placed) {
  const { product, project, beside } = t.place;
  return [
    `  ${[product, project.name, t.name].filter(Boolean).map(text).join(' › ')} (${text(t.id)})`,
    `  done when ${text(t.goal)}`,
    beside.length
      ? `${text(project.name)}'s other open threads:`
      : `It's the only open thread in ${text(project.name)}.`,
    ...beside.map(b => `  ${text(b.id)}  ${text(b.name)}`),
  ];
}

async function need(action: 'need' | 'unneed', args: string[]) {
  const [thread, needs, ...rest] = args;
  if (!thread || !needs || rest.length) stop(USAGE);
  const answer = await api.change('plan/need', { body: api.withSpeaker({ thread, needs, drop: action === 'unneed' }) });
  if (!api.isSuccess(answer.status)) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    action === 'need' ? `${thread} starts once ${needs} is done and merged.` : `${thread} no longer needs ${needs}.`,
  );
}

// move, drop, done and title: the change, or why not
async function change(route: string, args: string[], body: (args: string[]) => object, count = 2) {
  if (args.length !== count || args.some(arg => !arg.trim())) stop(USAGE);
  if (route !== 'plan/done' && !/^[0-9]+$/.test(args[0])) stop(USAGE);
  const answer = await api.change(route, { body: api.withSpeaker(body(args)) });
  const made = api.parseOrNull(answer.body) as { ok?: boolean; order?: number[] } | null;
  if (!api.isSuccess(answer.status) || !made?.ok) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  if (route === 'plan/move') return print(`In order now: ${made.order!.map(id => `#${id}`).join(', ')}.`);
  if (route === 'plan/title') return print(`Job #${args[0]} is titled ${text(args[1])} now.`);
  print(route === 'plan/drop' ? `Job #${args[0]} left the plan.` : `Thread ${args[0]} is done.`);
}
