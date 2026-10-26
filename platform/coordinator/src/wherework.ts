// Where a task belongs, for whoever places it (a refused hand-off: projects.ts threadForJob; the owner's sort:
// sorting.ts planning): read and judged, never matched on paths or titles (docs/projects.md).
import { projects } from './company.ts';

export const whereWorkGoes = () => {
  const desk = projects().groups.unsorted?.name;
  return `A task belongs to the project its work is for: the one whose product, screens, tools, machinery or plan it changes. ${
    desk ? `The ${desk} (work in no thread)` : 'Work in no thread'
  } holds only the CEO's own work: its call follow-ups and meeting work.`;
};
