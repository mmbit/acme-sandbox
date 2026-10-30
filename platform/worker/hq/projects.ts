// The company's projects and their deliverables (hq deliverable, hq project): HQ's projects view groups every job by
// them.
import * as api from './api.ts';
import { companyLevels } from './files.ts';
import { takeValues } from './flags.ts';
import { asHelp } from './levels.ts';
import { print, shown, stop, text } from './output.ts';
import * as outlooks from './outlooks.ts';
import * as pauses from './pauses.ts';

export const deliverable = {
  help: `
   hq deliverable list [<project>] [--all]           the open deliverables, all or one project's (--all: the done ones
                                                     too). hq thread, the old name, still works
   hq deliverable move <project>/<slug> <project>    move the deliverable to another project, as <project>/<slug> there,
                                                     with its jobs, reviews, pause and estimates (its owner, the CEO or
                                                     Process). The old id keeps working. Out of a pause: its owner or
                                                     the CEO, with --why "reason", shown on the feed${outlooks.help}${pauses.help('thread')}`,

  async run([action, ...args]: string[]) {
    if (action === 'pause') return pauses.pause('thread', args);
    if (action === 'resume') return pauses.resume('thread', args);
    if (action?.includes('/') && !args.length) return outlooks.thread(action);
    if (action === 'new')
      stop('A deliverable is drawn in its project\'s plan now: hq plan deliverable <project> "name" "done when"');
    if (action === 'done') stop("A deliverable is closed in its project's plan now: hq plan done <project>/<slug>");
    if (action === 'list') return listThreads(args);
    if (action === 'sort')
      stop(
        `Project owners draw their deliverables: hq plan deliverable <project> "name" "done when". The job's agent, the CEO or Process places work in no deliverable: hq job move <job> <project>/<slug>`,
      );
    if (action === 'move') return moveThread(args);
    stop(
      'usage: hq deliverable list [<project>] [--all], hq deliverable move <project>/<slug> <project>, hq deliverable <project>/<slug>, or hq deliverable pause | resume <project>/<slug> (a new deliverable: hq plan deliverable)',
    );
  },
};

// hq projects: every open deliverable's live outlook in a line (outlooks.ts).
export const projectLines = {
  help: outlooks.projectsHelp,
  run: outlooks.projects,
};

// hq now: who's at work and what each open card holds up, live (outlooks.ts).
export const now = {
  help: outlooks.nowHelp,
  run: outlooks.now,
};

// (help reads the company's line for a project when it's shown)
// (hq project business in the help and the usage line below)
export const project = {
  get help() {
    return `
   hq project say <project> "sentence"               where the project stands, in one sentence the board reads at its top
                                                     in the projects view (the project's owner or the CEO). Say a new one
                                                     when it's no longer true
   hq project new <id> "name" --code XX --owner <agent> [--business <id>]
                                                     the CEO makes a project in its business (its product), with its
                                                     owner, who draws its plan (hq plan). --code: two or three capitals,
                                                     the prefix of its tasks' codes (HQ-COVERS), its own for good.${asHelp(companyLevels().lines.project)}
   hq project goal <project> on | off                the CEO marks a project one of our goals, or no longer: its bets are
                                                     its deliverables, their windows its dates and their done when its
                                                     number.
                                                     While a goal is open, the CEO's check runs every hour with it
   hq project code <project> XX                      the CEO gives a project made before codes its prefix, once
   hq project owner <project> <agent>                the CEO names a project's owner
   hq project business <project> <business | none>   the CEO moves a project into a business (one of projects.yaml's),
                                                     or out of any: its id, code and deliverables stay
   hq project rename <project> "name"                the CEO's: the name only. A project under a new id is hq project
                                                     new, its deliverables moved there (hq deliverable move), then hq
                                                     project done
   hq project done <project>                         a finished project leaves the lists (its owner or the CEO), once it
                                                     has no open deliverable, work or proposal: a new deliverable or task
                                                     in it is refused. A finished area that comes back is a new project${pauses.help('project')}`;
  },

  async run([action, ...args]: string[]) {
    if (action === 'pause') return pauses.pause('project', args);
    if (action === 'resume') return pauses.resume('project', args);
    if (action === 'new') return newProject(args);
    if (action === 'owner') return setOwner(args);
    if (action === 'business') return setBusiness(args);
    if (action === 'code') return setCode(args);
    if (action === 'rename') return renameProject(args);
    if (action === 'goal') return markGoal(args);
    if (action === 'done') return projectDone(args);
    const [id, sentence, ...rest] = args;
    if (action !== 'say' || !id || !sentence?.trim() || rest.length)
      stop(
        'usage: hq project say <project> "sentence", hq project new <id> "name" --code XX --owner <agent> [--business <id>], hq project code <project> XX, hq project goal <project> on | off, hq project owner <project> <agent>, hq project business <project> <business | none>, hq project rename <project> "name", hq project done <project>, or hq project pause | resume <project>',
      );
    const answer = await api.change('project-notes', { body: api.withSpeaker({ project: id, text: sentence }) });
    if (shown(api.parseOrNull(answer.body)?.ok) !== 'true') {
      stop(`Nothing recorded: ${api.errorIn(answer.body, 'no answer')}`);
    }
    print(`Recorded ${id}'s sentence.`);
  },
};

// hq project new and owner: the CEO's (the coordinator's plan.ts).
async function newProject(given: string[]) {
  const { values, args } = takeValues(given, ['--owner', '--business', '--code'], 'No project was made');
  const [id, name, ...rest] = args;
  if (!id || !name?.trim() || !values.owner || !values.code || rest.length)
    stop(
      `usage: hq project new <id> "name" --code XX --owner <agent> [--business <id>]\n${companyLevels().lines.project}`,
    );
  const answer = await api.change('projects/new', { body: api.withSpeaker({ id, name, ...values }) });
  const made = api.parseOrNull(answer.body) as { id?: string } | null;
  if (!api.isSuccess(answer.status) || !made?.id) stop(`No project was made: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Project ${id} made, owned by ${values.owner}: its plan is hq plan ${id}.`);
}

// hq project goal (the coordinator's goals.ts).
async function markGoal([id, onOff, ...rest]: string[]) {
  if (!id || (onOff !== 'on' && onOff !== 'off') || rest.length) stop('usage: hq project goal <project> on | off');
  const answer = await api.change('projects/goal', { body: api.withSpeaker({ id, goal: onOff === 'on' }) });
  if (!api.isSuccess(answer.status)) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(onOff === 'on' ? `${id} is one of our goals now.` : `${id} is no longer a goal.`);
}

// hq project code (the coordinator's plan.ts setCode).
async function setCode([id, code, ...rest]: string[]) {
  if (!id || !code || rest.length) stop('usage: hq project code <project> XX');
  const answer = await api.change('projects/code', { body: api.withSpeaker({ id, code }) });
  const given = api.parseOrNull(answer.body) as { code?: string } | null;
  if (!api.isSuccess(answer.status) || !given?.code) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(`${id}'s tasks' codes start ${text(given.code)}- now.`);
}

async function setOwner([id, owner, ...rest]: string[]) {
  if (!id || !owner || rest.length) stop('usage: hq project owner <project> <agent>');
  const answer = await api.change('projects/owner', { body: api.withSpeaker({ id, owner }) });
  if (shown(api.parseOrNull(answer.body)?.ok) !== 'true')
    stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(`${owner} owns ${id} now.`);
}

// hq project business (the coordinator's plan.ts setBusiness).
async function setBusiness([id, business, ...rest]: string[]) {
  if (!id || !business || rest.length) stop('usage: hq project business <project> <business | none>');
  const answer = await api.call('projects/business', { body: api.withSpeaker({ id, business }) });
  const moved = api.parseOrNull(answer.body) as { business?: string } | null;
  if (!api.isSuccess(answer.status) || !moved) stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(moved.business ? `${id} is in ${text(moved.business)} now.` : `${id} is in no business now.`);
}

// hq project rename and done (the coordinator's plan.ts).
async function renameProject([id, name, ...rest]: string[]) {
  if (!id || !name?.trim() || rest.length)
    stop(`usage: hq project rename <project> "name"\n${companyLevels().lines.project}`);
  const answer = await api.change('projects/rename', { body: api.withSpeaker({ id, name }) });
  const renamed = api.parseOrNull(answer.body) as { name?: string } | null;
  if (!api.isSuccess(answer.status) || !renamed?.name)
    stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(`${id} is ${text(renamed.name)} now.`);
}

async function projectDone([id, ...rest]: string[]) {
  if (!id || rest.length) stop('usage: hq project done <project>');
  const answer = await api.change('projects/done', { body: api.withSpeaker({ id }) });
  if (shown(api.parseOrNull(answer.body)?.ok) !== 'true')
    stop(`Nothing changed: ${api.errorIn(answer.body, 'no answer')}`);
  print(`${id} is done: it has left the lists, and shows among the completed projects.`);
}

type Thread = { id: string; project: string; name: string; owner: string; goal: string; status: string; open: number };

async function moveThread(given: string[]) {
  const {
    values: { why },
    args: [id, project, ...rest],
  } = takeValues(given, ['--why'], 'Nothing moved');
  if (!id || !project || rest.length) stop('usage: hq deliverable move <project>/<slug> <project>');
  const answer = await api.change('threads/move', { body: api.withSpeaker({ id, project, why }) });
  if (!api.isSuccess(answer.status)) stop(`Nothing moved: ${api.errorIn(answer.body, 'no answer')}`);
  const moved = JSON.parse(answer.body) as Thread;
  print(`Deliverable ${text(moved.name)} is ${text(moved.id)} now; ${id} still finds it.`);
}

async function listThreads(given: string[]) {
  const all = given.includes('--all');
  const [projectId, ...rest] = given.filter(arg => arg !== '--all');
  if (rest.length) stop('usage: hq deliverable list [<project>] [--all]');
  const query = [projectId && `project=${api.uri(projectId)}`, all && 'all=1'].filter(Boolean).join('&');
  const route = query ? `threads?${query}` : 'threads';
  const threads: Thread[] = JSON.parse(await api.orStop(api.get(route), "Couldn't list the deliverables."));
  if (threads.length === 0) return print(`No ${all ? '' : 'open '}deliverables${projectId ? ` in ${projectId}` : ''}.`);
  print(...threads.map(threadLine));
}

// The id, name, owner and how many open jobs it has (or done), then its goal
function threadLine(listed: Thread) {
  const state = listed.status === 'done' ? 'done' : `${listed.open} open`;
  return `${text(listed.id)}  ${text(listed.name)} (${text(listed.owner)}, ${state})  done when ${text(listed.goal)}`;
}
