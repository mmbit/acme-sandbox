# Projects, threads and jobs: bringing a company's running work in

HQ groups work in three tiers. A **project** is one line of work with one owner (HQ's db, made by the CEO with `hq
project new`). A **thread** is one piece of work inside it, with a "done when" line (drawn by the project's owner with
`hq plan thread`). A **job** serves one thread (`jobs.thread`). Work a job leads to stays in its thread by itself: hand-offs, a pull request's
reviews and fixes, the job for a card's answer, the job an ordinary message becomes. HQ's projects view draws the tiers over the
agents view: the desktop's Projects app opens it, and the way out in the HUD's tools goes back to the building. It reads
`GET /api/projects` (`platform/hq/shell/projects.js`, its looks in `style.css` and the skins, checked by
`platform/hq/projects-check.mjs`). On top it puts the businesses `projects.yaml` groups the projects under, then
Recurring (the routines' projects), the work being placed with its latest finished runs, and the meetings, a tile each with
everyone at it and its topic put plainly (`meetingboard.ts`). A project lists its done threads on a
tap, and a done thread opens with its jobs (`GET /api/projects/thread`). Each level shows more on each card: a business's picture of the
work running in it and its owner (`projects.yaml`'s `owner:`), a project's deliverables up next with the play's times, a
thread's lines changed (its pull requests') and time, and a thread's tasks as a list in time order with each one's size,
what it waits on (the tasks by their codes behind an hourglass) and its code (`jobs.code`, the name the board reads instead
of a number); a card held off the desk phone sits under the task whose work it waits on to go live. The board sorts a
grid's projects by dragging (`POST /api/projects/order`), and every device follows that order.

Use `hq say --needs-answer <agent> "question"` when the caller needs a colleague's answer during its run.
HQ stores `needsAnswer` with the message. If no session reads it, including when a recipient ends without
acknowledging it, its job gets a one-task thread in the caller's project with its own branch and no dependency on
the caller. Without a project it stays in no thread. The project owner, else the CEO, still sorts and names it
before it starts. Keep it independent of the caller when sorting or splitting it. Capacity and other existing
holds still apply. Answer requests from the same caller to the same colleague join an unstarted answer job.
Ordinary messages join only ordinary message jobs and retain their inherited thread and task order.
The flag is explicit. HQ never infers it from the message's words.

A task's code is its project's prefix and a word for what it does (`HQ-COVERS`), easy to say on a call. The prefix is
the project's, two or three capitals given as the CEO makes it (`hq project new --code`, or once for an older project:
`hq project code`); work in no project takes `projects.yaml`'s `groups.unsorted.code`. Whoever queues
a task names its word (`hq job --code`, `hq inbox accept --code`, `hq meeting set --code`), and HQ refuses a word
another task in that project holds. The jobs HQ makes for a task (reviews, fix rounds, retries, bringing it up to date,
its answer from the board, a call's next follow-up, the end of an alarm) carry its code. A standing task of HQ's, a
watch or a routine, has a word of its own that each run of it carries (`createJob`'s `word`; a routine's from
`schedule.yaml`'s `code:`, which a meeting's entry must have), in the project made jobs go in (`made.ts madeCode`), a
routine's in its own project (the word alone, as those projects have no prefix).
Those words are HQ's (`jobcodes.ts STANDING` and the two files' `code:`): no queuer claims one, in any project, even
before its task first runs. A task HQ makes for something that
happened once (a bug report, a customer's question, a call's follow-up) gets no word from HQ, which has nothing to name
it by: the agent doing it names it once it has read it (`hq code`, `jobcodes.ts name`), and HQ shows its number till
then. A code never changes, a task moved to another project included (`jobcodes.ts`).

A company that takes the foundation merge with work already under way has its project owners draw their plans
(`hq plan thread`). The job's agent, the CEO or Process places unthreaded work in those threads (`hq job move`). Until
then nothing changes: with no `company/projects.yaml`, `hq job` asks for no thread, and the projects view shows the open
work as unsorted.

## A project's plan

Plans are drawn in four levels, and each name shows which level it is. The foundation's naming guide
(`worker/hq/levels.ts`) has a line for each, a rule that every name the board reads is plain human speech, examples
of names as agents write them and as the board reads them, and what the platform's own words mean; `hq plan`'s and `hq project`'s help show it with the
company's own:

- a **product** is what the company makes (a business in `projects.yaml`), holding projects;
- a **project** is something whole its product finishes, with one owner, who draws its plan, named by a noun, never a
  versioned catch-all; it may end (`hq project done`) or live on;
- a **thread** is a deliverable made in several steps, taking its project to its "done when", named plainly for what
  gets made, and always ends;
- a **task** is one agent's step along its thread, titled as that step alone.

A company adds to the guide in `company/levels.json` (`worker/hq/levels.ts` `levelsIn` reads and checks it for the
`hq` tools and for HQ alike; a wrong value throws, naming it):

```json
{
  "thread": "Ours: ...",
  "plain": "The board reads Dutch.",
  "examples": [{ "level": "thread", "from": "Growth targets that hold", "to": "Settlement growth targets" }],
  "terms": { "Skynet": "the company's own build server" },
  "ahead": "A plan looks ahead ...",
  "split_minutes": { "task": 120, "thread": 480 }
}
```

A line for a level (`product`, `project`, `thread`, `task`) or for `plain` follows the foundation's, in `hq plan`'s and
`hq project`'s help and usages, the owner's planning job, a name refused as another level's and the board's names'
model; `examples` come after the foundation's, and `terms` (what the company's own words mean, which briefs use without
saying) join the platform's, for that model alone. `ahead` is
said by `hq plan` when a project is its product's only open one, and shown in its help.
`split_minutes` are the sizes, in agent time, past which `hq plan` marks a task still to start (by the size the play
counts) and a thread whose tasks to do add up past it, each with how to split it: a nudge, never a refusal. Each left
out is the foundation's line alone, nothing said, or no mark. The marks come at the read, not when a task is queued: a new task
has no size until the estimate tool's sweep and then the sizer reach it, a minute or more later. The owner's planning
job reads its threads back the same way.

## The names the board reads

Agents name their work for each other; the board reads a plain version. A small model (the sizer's, `smallmodel.ts`)
writes it for every project, project sentence, thread, "done when" and task the board's views show, open or done (work,
running, waiting, done or in review; not a review's seats, whose names HQ writes, and never one holding customer
details, whose own titles stand), from the agent's words, the task's brief or the thread's or project's context, by the
naming guide, its examples and its terms (`plainnames.ts`). Nothing hooks the places names are written: whatever the
board can read with words not yet put plainly is due, open work first, so a new name, a rename or a retitle from any
tool is, and every name already there. The worker claims a thread's or a project's names at a time (`POST
/api/worker/names/claim` and `/answer`, worker.ts `namesLoop`). The agent's words stay on their row, for the agents and
their tools. The board's views (`GET /api/projects`, `/api/projects/thread`, `/api/jobs`, `/api/jobs/find`, `/api/work`)
show the plain version while the words it was made from stand (`boardnames.ts`). Until then, or once the words
change, they show the agent's own words in the same field, and the plain version replaces them when it comes. Why a
naming failed (a failed call or a wrong answer) stays on its `board_names` row for the agents and is logged as an
error; the board's views don't carry it. A failed name is asked again ten minutes after its call, as often as it takes.

No two levels share a name: a thread drawn or renamed to the name of a project or another open thread in its product,
a project made or renamed to one its product has, and a task titled as its thread or its project are refused, naming
the clash and the rule (names compared case-blind, punctuation and a leading "the" ignored; `names.ts`
`threadClash`). Only exact clashes: whether a name is clear stays the owner's judgment and the reviewer's. HQ's own
one-task threads, named after their job, are exempt. Work that repeats is a `schedule.yaml` entry, and an entry names
no thread.

A routine is a project like any other whose threads its schedule opens (`schedule.ts keepProjects`). HQ keeps a
project for each entry (its `project:`, else its id; entries that take turns at one task name one), named after the
entry, owned by its agent and in no business. Once no entry names it, it ends as `hq project done` would end it
(`projectdone.ts`), when its threads and work have settled, and is off the schedule till then. Each run is a one-task
thread there ("Weekly books check, 26 Oct"; a meeting's seats share one), so a routine has what every project has: its
runs as threads with their tasks, plans, times and pauses, and planned runs are on the board whether or not a seat is
free. Runs recorded before their routine had its project move there the same way, with their meeting's seats and their
review loops. An entry whose project id another project holds runs nowhere till it names its own. The projects view
lists the routines under Recurring, each with its interval and next run (`schedule.ts routines`); the board asks for a
run off schedule, there's no key for it. Downtime is a flag on the work (`downtime: true`, `hq job --downtime`),
never a group of its own. HQ's one-task threads end as their work merges, or once their job ends done with nothing to
merge or is cancelled (`threadends.ts endedEmpty`), and a routine's run once its job fails with nothing in its place
(the routine runs again at its next time); HQ's other one-task threads keep a failed job's thread for its takeover. An
owner's thread is ended by its owner (`hq plan done`).

A project's plan is data in HQ, never a pull request (`plan.ts`):
its threads, the threads each **needs** (`thread_needs`: one starts once every thread it needs is done and merged, in
any project), and each thread's **tasks**, its queued work jobs, in order (`jobs.seq`, the id order until the owner
moves one). Only the project's owner and the CEO change it; anyone else is refused with the line to use instead,
`hq propose`. Every change is logged in `plan_changes`, with who made it. A thread's owner is its project's, everywhere
it's read (`projects.ts ownerOf`), so `hq project owner` hands on every thread in it.

- `hq plan <project> [--json]`: the open threads, those another needs first, each with its "done when", window,
  needs, planned finish and tasks (agent, title, size, state). `GET /api/projects` carries the same needs and order,
  each thread's owner being its project's.
- `hq plan thread <project> "name" "done when" [--needs <thread>]... [--slug <slug>]` draws a thread; `hq plan need`
  and `hq plan unneed <thread> <thread>` add or take back a need (a loop is refused at any depth, across projects);
  `hq plan move <job> <place>` puts a task still to start in its place (1: next; tasks added later still come last);
  `hq plan drop <job> "why"` cancels a task that never started; `hq plan done <thread>` closes a thread whose goal is
  met with nothing to merge, or whose work merged. Its tasks are queued with `hq job --thread`, as before; `hq job --thread new:<project>
  "name" "done when"` draws the thread the same way first, refused before anything is written for anyone but the
  project's owner and the CEO (`newthread.ts`). A drawn thread is read back as
  the board reads it: its product, project, name and "done when", then the names of the project's other open threads.
- `hq plan rename <thread> "name" ["done when"] [--slug <slug>]` renames an open thread, read back the same way; a new
  slug makes it `<project>/<slug>` and its old id keeps resolving, as `hq thread move` does. `hq plan title <job>
  "title"` gives a task still to start a new title.
- `hq project new <id> "name" --owner <agent> [--business <id>]`, `hq project owner <project> <agent>` and `hq project
  rename <project> "name"` (the name only): the CEO's. A project under a new id is a new project, its threads moved
  there with `hq thread move`, the old one then done.
- `hq project business <project> <business | none>`, the CEO's too, puts an open project in one of `projects.yaml`'s
  businesses or moves it to another (`none`: out of any), keeping its id, code and threads; a name its new product has
  already, the project's or an open thread's, is refused, as for a rename.
- `hq project done <project>`, by its owner or the CEO, ends a finished project: refused while it has open threads,
  work still to run or in review, or proposals waiting, naming them. It leaves `hq projects`, `hq thread list`, the
  proposals' choices and `GET /api/projects`' projects, which lists it under `completed` with its done time and
  threads. A new thread or task in it is refused; a finished area that comes back is a new project.
- `hq propose` goes to the owner of the project it names (`--project`, else the proposer's thread's project; with
  neither, to the CEO). The owner reads and decides it in `hq inbox` (accept into a thread of the plan, or drop with
  why); the CEO sees every one with `hq inbox --all` and in the summary. The owner's planning job for the proposal's
  project, while one is open (queued, running or blocked, on any engine), takes it: it reads that project's inbox at
  its start and again before it ends, and what reached it after it started (new, or handed on with its project) and is
  still open when it ends gets the next one (`proposals.sweep`, every minute). With none open, a running Claude session
  of the owner hears it at its next step; otherwise HQ queues a new planning job, a one-task thread in the project, so
  a pause on one of an owner's projects holds only that project's sorting. With org.yaml's
  `review.drawWindowedChanges: true` (off unless set), a review's "changes" on a thread with a window is drawn at once,
  as `hq inbox accept findings:<pr> --for <author> --findings <blocking ids>` would: the PR's author fixes every
  blocking finding (or checks the touch-ups) in the reviewed thread, and the owner's running session hears of the task
  (a held notice, which lapses unread) and may cancel and redraw it (job #9562). Other findings on a thread with a
  window (a close, or any of them without that setting) wait in no planning job that isn't running:
  the owner's running session hears them first and holds them while it runs (once it ends, yields or parks on a card,
  the sweep hands them on and its unread notice lapses rather than becoming a message job), and a planning job holding
  any orders by the earliest of their windows, as the thread's own work does (job #8577). A "changes" item a later
  round or the merge has left closes by itself in the sweep, and while one waits with no fix task drawn, the thread's
  ETA says so, with no merge in sight. A proposal whose owner can't be told (the messages refuse the line)
  is refused, and nothing of it is kept, nor shown in HQ's feed. The CEO hears its own at the hourly check instead. When `hq project owner`
  hands a project on, its open proposals reach the new owner the same way, and the old owner's planning job for it that
  hasn't started stands down if nothing is left for it.
- Nothing HQ makes runs under a template name or as a bundle (`sorting.ts`). A
  job HQ makes from a template or holding several things (a colleague's message no session took in, the board's
  feedback on a product and its return to the board, outside notes on a preview, a repair of HQ standing still) starts
  under a template title but
  waits, on a `sorted` wake, until the owner of its project (else the CEO) sorts it in that same planning job: `hq
  inbox accept <id> --title "..." [--code WORD]` names it for what it does and lets it start in its thread (`hq job
  move` first for another), and work that joins it before it starts holds it again. A task belongs to the project its
  work is for, judged by whoever places it with that guidance (`wherework.ts whereWorkGoes`), never by paths or titles:
  only the CEO's own work stays in no thread, the desk's (its call follow-ups and meeting work), so a job of anyone
  else's in none is moved to its project before it's accepted, and a call's job for anyone but the CEO names its thread
  as any hand-off does. Unrelated parts become tasks of
  their own (`hq job`) and the rest is accepted, or it's dropped, which cancels it; a return to the board is only ever
  named. A review's follow-up bundle is accepted only under the accepter's title. A review's fix tasks are named by
  their consolidator: each blocking finding's `task`, and `touchups_task` for its touch-ups' check. `hq inbox accept
  findings:<pr>` takes that title when the findings it names share one, else needs `--title`; a pull request in
  no thread gets its author's fix round, which takes them together. A closed review's redrawn work keeps its work's own title. HQ's other
  jobs (alarms, checks, errors, watch, backups, a care bug report, an email's answer) are each one thing titled by
  what it is, and retries keep their job's title.

### Threads in order

How the platform plans: each thread's tasks one at a time on one branch, one pull request for the thread, read by the
claim, the worker and the review panel (`threadorder.ts`). There is no setting for it and no other way.

- **The order.** A task (a work job in a thread that isn't a pull request's fix or update) starts once the task before
  it in its thread (`jobs.seq`, else ids) is done: pushed, not merged. The thread's next task to
  start also waits until every thread it needs is done and merged. A task before it that failed with nothing in its
  place holds it; a replacement (`--lands`) takes the failed task's place. A failed task whose branch has an open pull
  request (open, stuck or with the board) holds nothing, since the thread's later tasks still push there (`jobs.ts`
  `failedAside`); once that pull request merges or closes, the failed task holds the thread again and the thread stays
  open. A task waiting for a time still to come
  (`hq job --when`) holds nothing: until then the tasks after it that haven't started go first, and once it's due it
  follows those that did (`inTurn`). The claim and the play read both as edges of
  `planner.ts` precedence (`follows`, until done; `needs`, until merged), which `backlog.ts` puts on the queue; a thread
  edge closing a loop with jobs' own waits is dropped and its task stalls saying so. A drawn thread with no task yet
  plays as one placeholder of its owner's, sized on its name and "done when" (`predictions.ts prepared`); while a window
  is at stake for it (its own, or one of a thread that needs it) it has no ETA, "no task drawn: nobody is building
  it", and so do the windowed threads that need it, which miss their window (`forecast.ts undrawnUnder`). `hq jobs`
  shows what holds a task ("after #n in its thread", "until <thread> merges", "until #n on its thread's pull request
  ends").
- **The branch.** The first task to push work (a commit, a pull request) makes its `job/<id>` the thread's
  (`threads.branch`); each later task runs on it (`jobs.branch`). A task that pushes nothing leaves the thread without a
  branch, so a thread whose work needed no change ends with `hq plan done`. The worker merges main into it at each later task's start (a conflict is left for the
  task's briefing to resolve first), and the briefing says the task's place, the task before it and the thread's "done
  when" (the claim's `inThread`).
- **One pull request.** At its push a task asks `POST /api/worker/thread-push` for the thread's title and tasks, and its
  push opens the thread's one pull request, or starts its next round if it's open. While the thread's next task starts
  now (running, or queued with only a seat to wait for: `threadorder.ts nextReady`), the push is held instead
  (`review.ts heldForThread`, kept as a push waiting for its ruling is): no round opens, and the next task starts at once
  on the branch. The last such task's push opens the round, its files against main the thread's whole work, so the
  thread is reviewed once, at its end. Finished work never waits for a task that isn't coming now: when the next task
  fails or ends with nothing pushed, the held push goes to review at once (`jobs.ts handOn`), and when it comes to wait
  for a time, a card or another thread's merge, at the next ruling sweep (`actOnRulings`, every 5 minutes). A pull
  request's fixes and the board's notes are never held, and a push is held only once it owes nothing: one that owes a
  redo, previews or its documents, or fails its gates or tests, goes back to its author first. While held it counts as in
  review: a job `--after` its task waits for the thread's pull request, and the task's call items tied to its work by a
  request or ref are judged once that pull request opens (`ledger.ts prOpened`). Its gates and tests run in the review,
  as for any push. A task that pushed nothing has its waits met at the thread's merge, never stranded.
  The thread's next task waits while a job of that pull request that pushes to the branch is open (a fix, or a ruling
  that may touch it up), and a ruling touches nothing up while a task works on the branch, so two sessions never push
  to one branch. A merge before the thread's last task runs settles the branch, and the next task starts a fresh one
  from main, whose push opens the thread's next pull request.
- **Its release.** A thread is one pull request, so no task in it waits for that pull request to merge
  (`threadrelease.ts`). `hq job --when deployed:` on the thread's own work (one of its tasks, the queuing one included,
  or its pull request) puts the job in HQ's one-task thread in the same project, and the answer says so. A task that
  gets into the thread waiting for its release anyway (moved or drawn in) runs after the merge, on a branch of its own.
- **Profile lines** go to main at each task's end on `profile/<the task's id>`, a branch the worker makes from main with
  only the agent's own profile and archive lines, which merges unreviewed as records do. The branch on origin is what was
  published (with any repair of it): each run sends it again on main as it is now, with the lines the thread gained since
  the thread commit it names (`Thread-Head`) or since the thread last took published lines back (`Profile-Lines`),
  whichever is later. Once published, the thread branch takes those files back to the version of main it last merged,
  so its merge leaves main's lines be. A failure fails the run before the thread's push; its run again sends only what
  was never published. Root merges main into that pull request as its one commit on main again, and a fix job on it
  pushes its repair the same way; a repair that leaves nothing for main deletes the branch and closes the pull request.
  Each push or deletion holds only while the branch is still at the publication its writer started from (none, for a
  new branch): of a run again and a repair at once, the later is refused rather than undo the other's lines.
- **A merge** clears the thread's branch (its next task starts a new one). A thread it leaves with nothing open or
  still to merge stays open, ready to judge (`threadjudge.ts`): HQ queues its owner a job with the thread's "done when"
  and each task's report (`threads.judge`; one that hasn't started takes the owner's next such thread in too), never
  held by a pause. The owner closes it with `hq plan done` or draws its next task. `hq projects`, `hq thread` and the
  CEO's summary say "ready to judge" until then, with the open threads that need it. HQ's one-task threads (a routine's
  run, a check, a note's job) and a judge's own thread close at their merge. The judge's brief carries each
  task's report as quoted data, and only a report its owner may read (`jobs.ts readsReport`): one holding a customer's
  own details stays with its job unless the owner has roles.customerData, and a judge handed it holds those details
  too.
- **Refusals.** A running job's `hq job` into a thread is its project's owner's or the CEO's (anyone else: `hq
  propose`), and `--after` a job in another thread is refused for `hq plan need`, in its own for the order it has.


## The steps

1. **Name the projects.** The CEO makes each (`hq project new`): an `id`, a `name`, an `owner` (an agent in
   `org.yaml`) and maybe the `business` it belongs to. A `projects:` list of those in `company/projects.yaml` (each
   maybe with a `product`, a `products/<slug>`) is lifted into HQ as the file is read, each id HQ hasn't got yet, and
   then leaves the file: from there the projects are HQ's. The file keeps `requireThread: false` until step 4. `businesses` lists those in the board's order, each an `id`, a `name` and
   maybe a `cover` (a picture under `theme/hq/`) and the `style` its covers are drawn in, its projects' too (`pixel`
   shows them at whole pixels, any other word or none smooth); `groups` can give
   Recurring and the work being placed (`recurring`, `unsorted`), and the meetings (`meetings`), a `cover` and `style`
   the same way. With no businesses, the projects come first. The routines'
   projects (`company/schedule.yaml`) show under Recurring.
2. **Draw the plans.** Once that's merged, each project's owner draws its threads (`hq plan thread`). The job's
   agent, the CEO or Process places unthreaded work in them (`hq job move <job> <project>/<slug>`, its reviews and fixes
   with it).
   The schedule's runs need none: each is a thread of its routine's project.
3. **The sentences.** Each project's owner says where the project stands, in one line (`hq project say <project>
   "..."`).
4. **Ask for threads from now on.** Once every job under way is in a thread, the CEO sets
   `requireThread: true` in `projects.yaml` by pull request. From then on, `hq job` refuses a job with no thread to
   inherit unless it names one (`--thread <project>/<slug>`, or `--thread new:<project> "name" "done when"`). That
   keeps every new piece of work inside one of the board's projects.
5. **Give HQ's own jobs a home.** The jobs HQ makes from the same template every time have no job to inherit a thread
   from. `made:` in `projects.yaml` sets a project per kind, by the app it's about: `errors` (the error scan's
   triage, by the app's slug, `care` for the support chat), `checks` (the CEO's hourly follow-through check and its
   repair, `hq`) and `alarms` (the CEO's job about a platform alarm, `hq`), as in `made: { errors: { care: company }
   }`. The watch's repairs of a live app go to the project its `product.yaml` names (`project:`), and so do a
   product's return to the board and the job for the board's answer on a card about it (`owed.ts`); the board's notes
   become tasks in their threads as the CEO routes them (`routing.ts`). Each
   such job starts a one-task thread of its own there (`<project>/job-<id>`, done when its work is merged), which its owner can fold into a thread of the plan. A kind or app with no entry, or whose project
   is done, goes to no project for the CEO to sort, but for a job with a window (a check, due by the end of its hour;
   an urgent alarm or repair, due as soon as it can), which throws instead and isn't made. A new company starts with
   the template's `projects.yaml` (its CEO's `office`, and checks and alarms there). A company without the file
   adds it once, the template's with its own CEO as the office's owner, before it takes this change: HQ lifts the
   office as it first reads it.

`hq job --check` marks QA, audits, security and compliance reads, which the view folds away. It applies to new jobs,
so existing ones stay unmarked.

## Moving work

The CEO, Process or the work's owner regroups what's sorted (`regroup.ts`). `hq thread move <project>/<slug> <project>`
takes a thread to another project as `<project>/<slug>` there, with its jobs, their reviews and fixes, its pause,
window and estimates. The old id keeps finding it everywhere a thread is named (`hq job --thread`, `hq thread`, `hq
plan`), since queued briefs name it, and no new thread can take it. `hq job move <job> <project>/<slug>`
moves work still going on to another open thread, the lead job on its branch with every review and fix round, which
later rounds inherit. If open threads need its old thread, the output names each one and its owner, with commands to
re-point each need. The owner keeps any old need by doing nothing. To re-point one or more, first run
`hq plan need <needing> <new>` once for that needing thread. If the addition is refused, stop and keep all old needs.
After it succeeds, run `hq plan unneed <needing> <old>` for each old need chosen independently for re-pointing.
For a move from A and B, the owner can keep A and re-point B, re-point A and keep B, or re-point both with the same
single addition. Keeping both needs takes no command. Adding the new need first preserves old needs on refusal.
If the needing thread is the destination, the destination depends on the needing thread, or the needing thread already
needs the destination, the notice offers keeping or removing the old need with `hq plan unneed <needing> <old>` only.
Each owner other than the mover gets one line through `hq say` per needing thread,
for the whole group moved. Needs stay where their owners drew them. A message refusal rolls the move back.
Splits and meeting seats use the same task-move command. A whole-thread move carries its needs with its identity.

Neither move takes work out from under an open pause: a thread takes its own pause along but
not its project's, and a job keeps only its project's. A move that would leave a pause behind is refused until it lifts.

## Pausing a project or a thread


A hold on a line of work ("no game work until the projects view is back") is state, not prose:
`hq project pause <project> "why"` or `hq thread pause <project>/<slug> "why"`, by the CEO or the project's owner, with
what wakes them to judge it: `--until <job>` for each job it waits for, `--until-time <time>`, or `--by-hand` (nothing
does). One naming none of them is refused. It lives in HQ's db (`pauses.ts`), not in `projects.yaml`, so it holds the
moment it's made. While it stands, the claim starts nothing queued on the thread, or on any thread of the project: no
work, and no review, ruling or fix of its pull requests, which wait in review until it lifts. Work already running goes on; the CEO's
hourly follow-through check lists it under the pause, to stop (`hq stop`) or let finish as the pause's reason says.
`hq stop` on a running review or ruling pauses it at its next step instead: it goes back in the queue in its session,
and the pause holds it until it lifts, so a half-written review is never read as a verdict. A
job queued onto a paused thread is accepted and told it's held, `hq jobs` and HQ's projects view say it's paused,
the live estimate plays it after the jobs the pause waits for (the earliest its owner could lift it), and the projects
view shows the pause with why and what it waits for.

The work in no thread has a pause of its own: `hq project pause unsorted "why"` (or the code of `projects.yaml`'s
`groups.unsorted`), the CEO's alone. It holds what lands there however it got there: work a call queued, HQ's fix
rounds and reviews on a pull request whose work had no thread, HQ's template and fault jobs before they're sorted. A
hold that pauses projects pauses this one too, or what it misses there starts anyway. It lets go of what no hold should
keep: the intercom, a meeting's seats, a board call's follow-up (the board heard, which is how a hold goes in and
lifts), expedited work, and an owner's sort that holds something open on a thread no pause holds (a job HQ made
that waits for it, review findings, a proposal for that thread): the hold doesn't keep work it lets run waiting on a
sort it never lets start. The play reads a job waiting for its sort as starting after that sort's job. Work it holds stays in no thread until it lifts: `hq job move` refuses to sort it out, as it
refuses to move work off any pause.

Nothing lifts a pause by itself (board, 25 Oct): what it waits for wakes its owner, who judges. Once its
`--until-time` has come and every `--until` job has merged or ended (closed with its commits on main, closed unmerged,
failed, cancelled, or done with nothing to merge), HQ queues its owner a job (the CEO for one carrying the board's
item), `pausewake.ts`: the pause's why, what was met, and each job's report and whether its work is on main. That job
is never held by a pause or the company's pause, and runs as soon as it can, which pacing lets through. The owner
lifts it (`hq project resume` or `hq thread resume`), takes the results to the board, or keeps it on for what's still
missing: the same `hq ... pause` on a paused target, by whoever may resume it, keeps that pause with the new why and
conditions, and they wake the owner afresh. No pause holds the CEO's hourly check either, though `projects.yaml`'s
`made.checks` draws it in a project a hold may pause: it is what judges the holds. The CEO's hourly check flags a pause whose waited-on work ended, or whose
woken owner left it on with nothing to wake them again, as off track that hour. Only the CEO resumes a pause the CEO
made or one carrying the board's item; a pause for the board's decision ends with the board's answer on its card. A pause can't wait for a job on what it pauses, or for one that needs work there first (its after,
its waits, another pause's `--until`, at any depth), which it would hold for good. A later `hq waits` change that would
close such a loop is refused too. A job meant to end before a pause is judged goes in a thread outside it.

A hold the board agrees on a call is recorded as the pause, and its item linked to it:
`hq item link <item> pause:<project or thread>` (a decision already handled goes on it as it is). The follow-through
read then shows the board's words beside the pause. A task or promise it carries stays on the hourly check while the
pause holds, and after a resume by hand until the jobs the pause waited for are merged.
