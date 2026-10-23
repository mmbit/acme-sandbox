// Each owner's planning job: the one open takes the proposals and review findings that arrive for the owner
// (proposals.ts tell), and reads the whole inbox when it starts. Split from proposals.ts.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import { levels } from '../../worker/hq/levels.ts';
import { levelsOf } from './levels.ts';

// The owner's planning job still open (queued, running or blocked), whatever became of the proposals it was made for
export const openPlanning = (owner: string) =>
  db
    .prepare(
      `select j.id, j.status from planning_jobs p join jobs j on j.id = p.job where p.agent = ? and j.status in ${jobs.OPEN_JOBS}
      order by j.id desc`,
    )
    .get(owner) as { id: number; status: string } | undefined;

// The owner's planning job, which reads the whole inbox when it starts. It ends with the levels each name shows, in the
// company's lines (levels.ts), and how its plans look ahead.
const planning = (
  own = levelsOf(),
) => `Proposals and review findings for the projects you own arrive here: it waits in your inbox, out of the queue, until you decide it.

1. Read the inbox: \`hq inbox\` lists what waits for you, \`hq inbox <id>\` shows one in full.
2. Read the plan it would go in: \`hq plan <project>\` (its threads, their "done when", needs and tasks in order).
3. Decide each one:
   - review findings: read their domains and files, then draw one fix task per discipline with
     \`hq inbox accept findings:<pr> --for <agent> --findings <id,id,...>\`, or
     \`hq job --thread <thread> --findings <id,id,...> <agent> "title" <brief>\`.
     Name every finding the task answers. The last fix task's push starts the next round.
     A closed review needs its thread redrawn or the findings dropped.
   - part of a thread's "done when": \`hq inbox accept <id> --thread <project>/<slug>\`, then \`hq plan move\` it to its
     place among the thread's tasks if it isn't last;
   - beyond every thread: a thread of its own, \`hq inbox accept <id> --thread new:<project> "name" "done when"\`, with
     what it needs first (\`hq plan need <thread> <thread>\`);
   - another owner's project: drop it saying whose it is, so its proposer proposes it there;
   - not worth doing now: \`hq inbox drop <id> "why"\` (its proposer reads why).
4. Read \`hq plan <project>\` again for each thread you added to: split a task it marks to split into its steps, and
   draw the later part of a thread it marks as a thread of its own.
5. Before you end, read \`hq inbox\` again: what arrived while you worked waits there too. End when nothing waits for
   you. Change only the plans these inbox items require. Write no code.

Each name shows its level: a task whose title isn't its step gets one (\`hq plan title <job> "title"\`), a thread
whose name needs context a new one (\`hq plan rename <thread> "name" ["done when"]\`).
${[levels(own.lines), own.ahead].filter(Boolean).join('\n')}`;
// Planning jobs coordinate projects without producing a project deliverable, so they have no thread.
export function planningJob(owner: string) {
  const title = 'Sort new proposals into the plan';
  const { id } = jobs.createJob({ agent: owner, title, prompt: planning(), thread: null });
  db.prepare('insert into planning_jobs (job, agent) values (?, ?)').run(id, owner);
  return id;
}
