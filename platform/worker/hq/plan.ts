// A project's plan (hq plan): its deliverables, the deliverables each needs and their tasks in order, which the
// project's owner and the CEO draw and change (the coordinator's plan.ts).
import * as api from './api.ts';
import { at, duration } from './estimate.ts';
import { takeNeeds, takeValues } from './flags.ts';
import { companyLevels } from './files.ts';
import { asHelp, rules, SIDE_BY_SIDE, type Levels } from './levels.ts';
import { present, print, stop, text } from './output.ts';

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
  undated: boolean;
  needs: string[];
  eta: number | null;
  stall: string | null;
  tasks: Task[];
  to_do_ms: number;
  split: boolean;
  done: number;
  ruled: { pr: number; round: number } | null;
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
const threadUsage =
  () => `usage: hq plan deliverable <project> "name" "done when" [--needs <deliverable>]... [--slug <slug>]
${companyLevels().lines.thread}`;
const renameUsage = () => `usage: hq plan rename <deliverable> "name" ["done when"] [--slug <slug>]
${companyLevels().lines.thread}`;
const USAGE = `usage: hq plan <project> [--json], hq plan deliverable <project> "name" "done when" [--needs <deliverable>]...
[--slug <slug>], hq plan need <deliverable> <deliverable>, hq plan unneed <deliverable> <deliverable> "why",
hq plan move <job> <place>, hq plan drop <job> "why",
hq plan done <deliverable>, hq plan rename <deliverable> "name" ["done when"] [--slug <slug>], or hq plan title <job> "title"`;

// (help reads the company's levels when it's shown)
// (a feature's pieces chained with need)
export const plan = {
  get help() {
    const own = companyLevels();
    return `
   hq plan <project> [--json]                        the project's plan: its open deliverables, those another needs
                                                     first, each with its "done when", deadline, needs, ETA and
                                                     tasks in order (agent, title, size, state); --json: all of it as data.${asHelp(...marksHelp(own))}
   hq plan deliverable <project> "name" "done when" [--needs <deliverable>]... [--slug <slug>]
                                                     draw a new deliverable, owned by the project's owner: "done when" is
                                                     the goal, what goes live. It's read back in its product and
                                                     project, beside the project's other open deliverables. It starts
                                                     after the deliverables it needs: those named, else the last one
                                                     chained from the one under way it most likely continues (the
                                                     drawing job's, else the project's newest), so draws in a row run
                                                     as one chain. Its tasks: hq job --deliverable <project>/<slug>
                                                     --code WORD. hq plan thread, the old name, still works
   hq plan need <deliverable> <deliverable>          the first deliverable starts once the second is done and merged (a
                                                     loop is refused, at any depth): how a feature's pieces that go
                                                     live separately are chained, one merging at a time
   hq plan unneed <deliverable> <deliverable> "why"  the first runs beside the second from now, for the reason given:
                                                     only for work on other files, as work on the same files stays
                                                     chained (side by side it collides and is merged by hand)
   hq plan move <job> <place>                        a task to its place among its deliverable's tasks still to start
                                                     (1: next)
   hq plan drop <job> "why"                          a task that never started leaves the plan (cancelled, why on its feed)
   hq plan done <deliverable>                        a deliverable whose "done when" is met with nothing to merge
   hq plan rename <deliverable> "name" ["done when"] [--slug <slug>]
                                                     an open deliverable's new name, maybe its "done when" and slug (the
                                                     old id keeps finding it, its jobs and pauses following)
   hq plan title <job> "title"                       a task that hasn't started gets a new title
                                                     Only the project's owner and the CEO change a plan: anyone else
                                                     proposes it to the owner (hq propose --project <project>). Each name
                                                     shows its level:${asHelp(...rules(own.lines, own.plain), OWN_LEVELS)}`;
  },

  async run([action, ...args]: string[]) {
    if (action === 'deliverable' || action === 'thread') return drawThread(args);
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
    split.thread_ms !== null && `a deliverable whose tasks to do add up past ${duration(split.thread_ms / 60_000)}`,
  ].filter(Boolean);
  return [
    ...(sizes.length ? [`It marks ${sizes.join(' and ')}, to judge a split.`] : []),
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
  if (!found.threads.length) return print('No open deliverables: draw one with hq plan deliverable.');
  for (const t of found.threads) print('', ...threadLines(t, found.split));
}

// The thread, its "done when", deadline, needs and ETA, then its tasks in order, with the marks the company's
// sizes give them.
function threadLines(t: Thread, split: Plan['split']) {
  const finish = t.eta === null ? `no ETA${t.stall ? ` (${text(t.stall)})` : ''}` : `ETA ${at(t.eta)}`;
  const window = t.undated ? ', no deadline set' : t.deadline === null ? '' : `, deadline ${at(t.deadline)}`;
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
    ...(t.ruled ? [`  Its review has ruled (PR #${t.ruled.pr}, round ${t.ruled.round}): ${RULED(t.id)}`] : []),
  ];
}
const RULED = (thread: string) => `new work: hq plan deliverable with --needs ${text(thread)}.`;
const SPLIT_TASK = 'split it into its steps (hq plan drop, then hq job --deliverable for each).';
const SPLIT_THREAD = (thread: string) =>
  `a somewhat bigger deliverable is fine: only a later part that goes live on its own is drawn as a deliverable of its own (hq plan deliverable with --needs ${text(thread)}), its tasks moved there (hq job move).`;

async function drawThread(given: string[]) {
  const { needs, args: rest } = takeNeeds(given, 'No deliverable was drawn');
  const { values, args } = takeValues(rest, ['--slug'], 'No deliverable was drawn');
  const [project, name, goal, ...more] = args;
  if (!project || !name?.trim() || !goal?.trim() || more.length) stop(threadUsage());
  const answer = await api.change('plan/thread', { body: api.withSpeaker({ project, name, goal, needs, ...values }) });
  const drawn = api.parseOrNull(answer.body) as (Placed & { needs?: string[]; chain?: string }) | null;
  if (!api.isSuccess(answer.status) || !drawn?.id)
    stop(`No deliverable was drawn: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    `Deliverable drawn${drawn.needs?.length ? `, needing ${drawn.needs.map(text).join(', ')}` : ''}:`,
    ...placedLines(drawn),
    ...(present(drawn.chain) ? [text(drawn.chain)] : []),
    `Its tasks: hq job --deliverable ${text(drawn.id)} <agent> "title" <brief> --code WORD`, // (--code)
  );
}

// hq plan rename: read back as hq plan deliverable reads a drawn one.
async function renameThread(given: string[]) {
  const { values, args } = takeValues(given, ['--slug'], 'Nothing changed');
  const [thread, name, goal, ...more] = args;
  if (!thread || !name?.trim() || goal?.trim() === '' || more.length) stop(renameUsage());
  const answer = await api.change('plan/rename', { body: api.withSpeaker({ thread, name, goal, ...values }) });
  const renamed = api.parseOrNull(answer.body) as Placed | null;
  if (!api.isSuccess(answer.status) || !renamed?.id) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    `Deliverable renamed${renamed.was !== renamed.id ? ` (${text(renamed.was)} still finds it)` : ''}:`,
    ...placedLines(renamed),
  );
}

// The deliverable as the board reads it: product, project and deliverable, its "done when", then the project's other
// open deliverables
function placedLines(t: Placed) {
  const { product, project, beside } = t.place;
  return [
    `  ${[product, project.name, t.name].filter(Boolean).map(text).join(' › ')} (${text(t.id)})`,
    `  done when ${text(t.goal)}`,
    beside.length
      ? `${text(project.name)}'s other open deliverables:`
      : `It's the only open deliverable in ${text(project.name)}.`,
    ...beside.map(b => `  ${text(b.id)}  ${text(b.name)}`),
  ];
}

// hq plan unneed takes why: it puts the two deliverables side by side.
async function need(action: 'need' | 'unneed', args: string[]) {
  const [thread, needs, why, ...rest] = args;
  const drop = action === 'unneed';
  const whyRight = drop ? !!why?.trim() : why === undefined;
  if (!thread || !needs || rest.length || !whyRight) stop(USAGE);
  const answer = await api.change('plan/need', {
    body: api.withSpeaker({ thread, needs, drop, ...(drop && { why }) }),
  });
  if (!api.isSuccess(answer.status)) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(
    drop
      ? `${thread} no longer needs ${needs}: it can run beside it now. ${SIDE_BY_SIDE}`
      : `${thread} starts once ${needs} is done and merged.`,
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
  print(route === 'plan/drop' ? `Job #${args[0]} left the plan.` : `Deliverable ${args[0]} is done.`);
}
