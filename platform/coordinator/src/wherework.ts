// Where a task belongs, for whoever places it (a refused hand-off: projects.ts threadForJob; the owner's sort:
// sorting.ts planning): read and judged, never matched on paths or titles (docs/projects.md).
import { ceo, org, projects } from './company.ts';

// The work in no deliverable as people read it: the CEO's desk, named for the CEO as org.yaml names them ("Juno's
// desk"), or as projects.yaml's groups.unsorted names it.
export function deskName() {
  const named = projects().groups.unsorted?.name;
  if (named) return named;
  const id = ceo(),
    agent = (org().departments ?? []).flatMap((d: any) => d.agents ?? []).find((a: any) => a.id === id);
  return `${agent.name}'s desk`;
}

// (the desk's name, and what it holds)
export const whereWorkGoes = () =>
  `A task belongs to the project its work is for: the one whose product, screens, tools, machinery or plan it changes. ${deskName()} (work in no deliverable) holds only the CEO's own running of the company: its checks, rounds, call follow-ups and meeting work.`;
