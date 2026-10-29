// The board's projects view (GET /api/projects and /api/projects/thread): the projects with their threads and jobs, from
// projects.ts, which re-exports it. (Its own module)
import { db, prepared } from './db.ts';
import { coverOf, projects, type Project } from './company.ts';
import { deskName } from './wherework.ts';
import { isOpenJob, jobRows, OPEN_JOBS } from './jobs.ts';
import { doneSince, linesOf, tallies, type Tallies } from './tallies.ts';
import { inBoardOrder } from './projectorder.ts';
import { routines } from './schedule.ts';
import { boardJobs, boardNames, boardThread, type BoardNames } from './boardnames.ts';
import { withFindings } from './reviewrows.ts';
import { meetingSeats } from './meetingboard.ts';
import { findThread, ownerOf, sentenceOf, type Thread } from './projects.ts';
import { pad } from './pad.ts';
import { isGoal } from './goals.ts';
import { oneTask } from './made.ts';

// GET /api/projects: the businesses the projects are grouped under and the side groups (company.ts projects), then
// projects with their owner's latest sentence and threads. A thread is ongoing while it has work that can still merge
// (open jobs, or done ones whose pull request is still in review: jobs.ts mergePending), or is open with no jobs yet,
// and its jobs come along, finished ones included. The rest are done (closed, or all their work finished) and show
// tallies (getThread has their jobs). Jobs read as GET /api/jobs words
// them (jobs.ts jobRows). A routine's project (schedule.ts keepProjects) carries its schedule (schedule.ts routines), its
// runs its threads. Jobs outside known threads are unsorted: the open ones, then
// the latest finished (recentLoose).
// Unsorted is the CEO's desk, under its name (wherework.ts deskName): call follow-ups and the CEO's own work, and other
// work outside the projects for the CEO to place.
// Each job has its place in its thread (seq), a thread's owner is its project's, and it lists the threads it needs
// (plan.ts). done threads' owners too:
// completed: the projects done (hq project done, plan.ts), the latest first, each with its done time and threads, for the
// view's ongoing / completed switch; their jobs aren't loose.
// Each thread has its lines (tallies.ts linesOf), and the projects come in the board's order (projectorder.ts).
// A project carries its cover where projects.yaml names one, in its business's style (company.ts coverOf).
// Its projects', sentences', threads' and jobs' names are the board's (boardnames.ts).
// The CEO's page (pad.ts) comes with it, at the view's top, and a project the CEO marked a goal says so (goals.ts).
export function listProjectBoard(t = Date.now()) {
  const threads = db.prepare('select * from threads order by created').all() as Thread[];
  const pending = pendingThreads();
  const rows = boardRows(pending, t);
  const schedules = routines();
  // (each thread's rows and tallies read once for the whole view; and the names.)
  const byThread = Map.groupBy(rows, j => j.thread),
    counted = tallies(),
    names = boardNames();
  const jobsOf = (id: string) => byThread.get(id) ?? [];
  const ongoing = (th: Thread) => pending.has(th.id) || (th.status === 'open' && !jobsOf(th.id).length);
  const listed = projects().list.map(project => {
    const sentence = sentenceOf(project.id);
    const own = threads.filter(th => th.project === project.id);
    return {
      ...names.project(project),
      ...coverOf(project),
      ...(schedules.has(project.id) && { schedule: schedules.get(project.id) }),
      ...(isGoal(project.id) && { goal: true }),
      sentence: sentence
        ? { ...names.sentence(project.id, sentence), since: doneSince(project.id, sentence.at) }
        : null,
      threads: own.filter(ongoing).map(th => ({
        ...shownThread(th, counted, names),
        owner: project.owner,
        jobs: jobsOf(th.id),
      })),
      done: own
        .filter(th => !ongoing(th))
        .map(th => ({ ...named(th, names), owner: project.owner, ...counted.tally(th) })),
    };
  });
  const completed = completedProjects(threads, counted, names),
    placed = new Set([...listed, ...completed].map(p => p.id));
  const known = new Set(threads.filter(th => placed.has(th.project)).map(th => th.id));
  const loose = [...rows.filter(j => isOpenJob(j) && !(j.thread && known.has(j.thread))), ...recentLoose(known, t)];
  const page = pad();
  return {
    page: page && { text: page.text, at: page.at },
    businesses: projects().businesses,
    groups: { ...projects().groups, unsorted: { ...projects().groups.unsorted, name: deskName() } },
    projects: inBoardOrder(listed),
    completed,
    unsorted: loose.filter(j => j.kind !== 'meeting'),
    meetings: meetingSeats(loose, t),
  };
}

// The view's jobs: those of the open threads and of the threads with work that can still merge, and the open ones.
// (by id, each set read through its index: with the planner's statistics an OR of the sets scanned every job row.
const boardRows = (pending: Set<string>, t: number) =>
  boardJobs(
    withFindings(
      jobRows(
        `j.id in (select id from jobs indexed by jobs_thread_state where thread in (select id from threads
      where status = 'open' union select value from json_each($pending))
    union select id from jobs indexed by jobs_status where status in ${OPEN_JOBS})`,
        t,
        { pending: JSON.stringify([...pending]) },
      ),
    ),
  );

// The threads with work that can still merge (jobs.ts mergePending): open work, or done work on a branch whose latest
// pull request is still in review.
// (the open work through the thread's index, which holds each job's state and branch: its rows hold their prompts and
// outputs; the done work from the pull requests in review, by branch, not each thread's whole history.)
const pendingThreads = () =>
  new Set(
    (
      db
        .prepare(
          `with reviewed as materialized (select p.branch from prs p where p.status in ('open', 'stuck', 'board')
            and p.number = (select max(number) from prs where branch = p.branch))
          select j.thread from jobs j indexed by jobs_thread_state where j.thread is not null and j.status in ${OPEN_JOBS}
          union select j.thread from reviewed r cross join jobs j indexed by jobs_branch on j.branch = r.branch
            where j.status = 'done' and j.thread is not null
          union select j.thread from reviewed r cross join jobs j on j.id = cast(substr(r.branch, 5) as integer)
            where r.branch = 'job/' || j.id and j.branch is null and j.status = 'done' and j.thread is not null`,
        )
        .all() as { thread: string }[]
    ).map(row => row.thread),
  );

// The projects done (hq project done), the latest first, each with when and its threads (all done) with their tallies.
const completedProjects = (threads: Thread[], counted: Tallies, names: BoardNames) =>
  (
    db
      .prepare(
        "select id, name, owner, product, business, done from projects where status = 'done' order by done desc, rowid",
      )
      .all() as (Project & { done: string })[]
  ).map(p => ({
    ...names.project(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null)) as Project & { done: string }),
    threads: threads
      .filter(th => th.project === p.id)
      .map(th => ({ ...named(th, names), owner: p.owner, ...counted.tally(th) })),
  }));

// The latest RECENT finished jobs outside known threads, newest first, but for meetings' seats (meetingSeats has
// those).
const RECENT = 10;
function recentLoose(known: Set<string>, t: number) {
  const kept = db
    .prepare(
      `select id from jobs where status not in ${OPEN_JOBS} and kind != 'meeting' and (thread is null or thread not in
      (select value from json_each(?))) order by id desc limit ${RECENT}`,
    )
    .all(JSON.stringify([...known])) as { id: number }[];
  return kept.length ? boardJobs(jobRows(`j.id in (${kept.map(j => j.id).join(', ')})`, t)) : [];
}

// GET /api/projects/thread: one thread as the board's view has it, its jobs included however long it's been done (the
// view opens a done one from its project), or 404.
export function getThread(id: string, t = Date.now()) {
  const thread = findThread(id);
  if (!thread) return 404;
  // (a moved thread found by its old id: its new one)
  // (by id through the thread's index, as jobRows reads them.)
  const jobs = boardJobs(
    withFindings(
      jobRows('j.id in (select id from jobs indexed by jobs_thread_state where thread = $thread)', t, {
        thread: thread.id,
      }),
    ),
  );
  return { ...boardThread(thread), ...wrapper(thread), owner: ownerOf(thread), lines: linesOf(thread.id), jobs };
}

// A thread's board name, and oneTask when it's HQ's one-task thread for a job of its own (made.ts), which the board
// reads as a task rather than a deliverable (HQ's threads.js boardKind)
const wrapper = (th: Thread) => (oneTask(th.id) ? { oneTask: true } : {});
const named = (th: Thread, names: BoardNames) => ({ ...names.thread(th), ...wrapper(th) });
// A thread as the board's view shows it: with the threads it needs and its lines.
const shownThread = (th: Thread, counted: Tallies, names: BoardNames) => ({
  ...named(th, names),
  needs: needsOf(th.id),
  lines: counted.linesOf(th.id),
});

// The threads a thread needs (plan.ts draws them)
export const needsOf = (thread: string) =>
  (prepared('select needs from thread_needs where thread = ? order by needs').all(thread) as { needs: string }[]).map(
    n => n.needs,
  );
