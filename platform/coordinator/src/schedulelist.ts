// The schedule's entries (company/schedule.yaml and shows.yaml) and the routines' projects they make, read from the
// files alone: schedule.ts runs them, and a tool that shows them (a theme's view of the projects) reads them here, no
// database opened.: the entries and their projects are read from files alone, so a tool
// (theme/covers/view.mjs) uses the coordinator's rule without a database.
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';

// downtime: true runs the entry on spare capacity only (jobs.ts claim), for maintenance.
// week: "k of n" runs the entry one week in n, so a rotation of n entries costs one job a week (the refactoring pass).
// model, effort: a light check can run cheaper than its agent does (a model id or alias for the agent's engine).
// kind: what infra/report.sh's usage per kind of job counts the entry's jobs as, the reviews and fixes of their pull
// requests included ("refactoring": the refactoring passes, so the process review sees their share).
// routine: a recurring job every company runs, from shared/routines/<name>.md: its text first, then the entry's own prompt.
// project: the id of the routine's project its runs go to (keepProjects), else the entry's own; entries that take turns at
// one task (the security audits) name one. An entry names no thread: each run is a thread of its own, which ends.
// with: other agents: at its time a meeting of the entry's agent and those (meetings.ts), its prompt the brief, instead
// of one job.
// code: the word of its runs' task code (jobcodes.ts), each entry its own, which no queuer may claim (jobcodes.ts
// standingWords); a show's from shows.yaml. Without one, each run's agent names its own; a meeting's (with:) has no one
// to name it, so an entry with `with:` needs one.
export type Entry = {
  id: string;
  agent: string;
  at: string;
  title: string;
  prompt?: string;
  downtime?: boolean;
  week?: string;
  model?: string;
  effort?: string;
  kind?: string;
  routine?: string;
  with?: string[];
  code?: string;
  project?: string;
};

// The entries: schedule.yaml's, and one per show in shows.yaml (On Air, shared/routines/show.md), whose job the show's
// producer (its first host unless named) runs from the show's own settings there. A show with no time runs on demand only.
type Show = { id: string; name: string; at?: string; hosts: string[]; producer?: string; code?: string }; // (code)
const read = <T>(name: string): T[] => {
  const file = `${REPO_DIR}/company/${name}`;
  try {
    return existsSync(file) ? (parse(readFileSync(file, 'utf8')) ?? []) : [];
  } catch (err) {
    console.error(`Could not read ${name}:`, err);
    return [];
  }
};
export const entries = (): Entry[] => [
  ...read<Entry>('schedule.yaml'),
  ...read<Show>('shows.yaml').map(s => ({
    id: `show-${s.id}`,
    agent: s.producer ?? s.hosts?.[0],
    at: s.at ?? '',
    title: `On Air: ${s.name}`,
    routine: 'show',
    code: s.code,
    prompt: `The show: \`${s.id}\` in company/shows.yaml.`,
  })),
];

// A routine's project (schedule.ts keepProjects): the one its entry names (`project:`), else the entry's own id, named
// after its first entry's title and owned by its agent
export const projectOf = (e: Pick<Entry, 'id' | 'project'>) => e.project ?? e.id;
export function routineProjectsOf(list: Entry[]) {
  return [...new Set(list.map(projectOf))].map(id => {
    const first = list.find(e => projectOf(e) === id)!;
    return { id, name: first.title, owner: first.agent };
  });
}
