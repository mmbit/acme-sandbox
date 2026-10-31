# Projects, deliverables and jobs: bringing a company's running work in

HQ groups work in three tiers. A **project** is one line of work with one owner (HQ's db, made by the CEO with `hq
project new`). A **deliverable** is one piece of work inside it, with a "done when" line (drawn by the project's owner with
`hq plan deliverable`). A **job** serves one deliverable (`jobs.thread`). Work a job leads to stays in its deliverable by itself: hand-offs, a pull request's
reviews and fixes, the job for a card's answer, the job an ordinary message becomes. "Deliverable" is the word wherever
people read it (HQ, the `hq` commands and their help, the worker's briefing, the prompts); the schema, the API and the
code call it a thread (`threads`, `jobs.thread`, `threadorder.ts`), and the old command names (`hq thread`, `hq plan
thread`, `--thread`) still work. HQ's one-task wrappers (`<project>/job-<n>`: a routine's run, a loose job, a message's
job) show to the board as tasks, not deliverables (`threads.js boardKind`).

HQ's projects view draws the tiers over the
agents view: the desktop's Projects app opens it, and the way out in the HUD's tools goes back to the building. It reads
`GET /api/projects` (`platform/hq/shell/projects.js`, its looks in `style.css` and the skins, checked by
`platform/hq/projects-check.mjs`). On top it puts the businesses `projects.yaml` groups the projects under, then
Recurring (the routines' projects), the work being placed with its latest finished runs, and the meetings, a tile each with
everyone at it and its topic put plainly (`meetingboard.ts`). A project lists its done deliverables on a
tap, and a done deliverable opens with its jobs (`GET /api/projects/thread`). Each level shows more on each card: a business's picture of the
work running in it and its owner (`projects.yaml`'s `owner:`), a project's deliverables up next with the play's times, a
deliverable's lines changed (its pull requests') and time, and a deliverable's tasks as a list in time order with each one's size,
what it waits on (the tasks by their codes behind an hourglass) and its code (`jobs.code`, the name the board reads instead
of a number); a card held off the desk phone sits under the task whose work it waits on to go live. The board sorts a
grid's projects by dragging (`POST /api/projects/order`), and every device follows that order.

Use `hq say --needs-answer <agent> "question"` when the caller needs a colleague's answer during its run.
HQ stores `needsAnswer` with the message. If no session reads it, including when a recipient ends without
acknowledging it, its job gets a one-task wrapper in the caller's project with its own branch and no dependency on
the caller. Without a project it stays in no deliverable. The project owner, else the CEO, still sorts and names it
before it starts. Keep it independent of the caller when sorting or splitting it. Capacity and other existing
holds still apply. Answer requests from the same caller to the same colleague join an unstarted answer job.
Ordinary messages join only ordinary message jobs and retain their inherited deliverable and task order.
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
(`hq plan deliverable`). The job's agent, the CEO or Process places work in no deliverable in those deliverables (`hq job move`). Until
then nothing changes: with no `company/projects.yaml`, `hq job` asks for no deliverable, and the projects view shows the open
work as unsorted.

## A project's plan

Plans are drawn in four levels, and each name shows which level it is. The foundation's naming guide
(`worker/hq/levels.ts`) has a line for each, a rule that every name the board reads is plain human speech, examples
of names as agents write them and as the board reads them, and what the platform's own words mean; `hq plan`'s and `hq project`'s help show it with the
company's own:

- a **product** is what the company makes (a business in `projects.yaml`), holding projects;
- a **project** is something whole its product finishes, with one owner, who draws its plan, named by a noun, never a
  versioned catch-all; it may end (`hq project done`) or live on;
- a **deliverable** is one feature made whole, in one or several steps, taking its project to its "done when", named
  plainly for what gets made, and always ends;
- a **task** is one agent's step along its deliverable, titled as that step alone.

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
counts) and a deliverable whose tasks to do add up past it, each with how to judge a split: a nudge, never a refusal. Each left
out is the foundation's line alone, nothing said, or no mark. The marks come at the read, not when a task is queued: a new task
has no size until the estimate tool's sweep and then the sizer reach it, a minute or more later. The owner's planning
job reads its deliverables back the same way.

### Drawing a deliverable whole

A deliverable is cut by what the board will see go live, never one per note, call item or proposal: several agents
take turns in one (one branch, the gates, push tests, documents check and previews on each task's push, one review at
its end, reading the branch merged with main). A call's follow-up, the board's notes, a sort of the inbox or the CEO's
hourly check adds new work to the open deliverable whose feature it serves before it draws a new one; a new one is
for a feature no open deliverable makes. Related work is one deliverable, and a feature whose pieces go live separately
is a chain, each piece drawn needing the one before (`hq plan deliverable --needs`), so one merges at a time. That is
the planner's judgment, in the words of `levels.ts` `RELATED_WORK` (the levels' deliverable line, the CEO's hourly
check and a meeting's review): nothing counts or refuses deliverables running at once. A company's own review numbers go in its `levels.json` `thread` line, which every drawing
prompt shows as guidance, never a cap. For an ETA, a deliverable's review is about one round when it's small (under about 200
changed lines) and two to two and a half when it's big (past about 500).

### One deadline per deliverable

The board or CEO chooses one deadline for the named deliverable (`hq window`). Whoever queues a task reads the
open plan and judges which deliverable's goal it serves. A follow-up of work in flight joins that deliverable by
default. Every task inherits its deadline, so `hq job` asks for no task-level time, even when the deliverable has
none. The plan, live claim, reviews, fixes and seat pacing read the same deadline through `jobs.thread`. Changing
it updates all that work on the next plan read, without copied task deadlines. The CEO's summary, plan and board's
deliverable view say "no deadline set" once for the deliverable. The CEO settles that gap for the whole. A task
in no deliverable takes `--by <when>`, `--by <project>/<slug>` or `--by none`. Outside a live call, an unfiled board
ask without `--by` asks the CEO for its time. The CEO’s own ask is refused. A filed task’s `--by <when>` sets or
tightens the deliverable’s deadline. Filing is judgment. Scheduling is an algorithm. A filed task is not refused for
lacking a deadline.

## The names the board reads

Agents name their work for each other; the board reads a plain version. A small model (the sizer's, `smallmodel.ts`)
writes it for every project, project sentence, deliverable, "done when" and task the board's views show, open or done (work,
running, waiting, done or in review; not a review's seats, whose names HQ writes, and never one holding customer
details, whose own titles stand), from the agent's words, the task's brief or the deliverable's or project's context, by the
naming guide, its examples and its terms (`plainnames.ts`). Nothing hooks the places names are written: whatever the
board can read with words not yet put plainly is due, open work first, so a new name, a rename or a retitle from any
tool is, and every name already there. The worker claims a deliverable's or a project's names at a time (`POST
/api/worker/names/claim` and `/answer`, worker.ts `namesLoop`). The agent's words stay on their row, for the agents and
their tools. The board's views (`GET /api/projects`, `/api/projects/thread`, `/api/jobs`, `/api/jobs/find`, `/api/work`)
show the plain version while the words it was made from stand (`boardnames.ts`). Until then, or once the words
change, they show the agent's own words in the same field, and the plain version replaces them when it comes. Why a
naming failed (a failed call or a wrong answer) stays on its `board_names` row for the agents and is logged as an
error; the board's views don't carry it. A failed name is asked again ten minutes after its call, as often as it takes.

No two levels share a name: a deliverable drawn or renamed to the name of a project or another open deliverable in its product,
a project made or renamed to one its product has, and a task titled as its deliverable or its project are refused, naming
the clash and the rule (names compared case-blind, punctuation and a leading "the" ignored; `names.ts`
`threadClash`). Only exact clashes: whether a name is clear stays the owner's judgment and the reviewer's. HQ's own
one-task wrappers, named after their job, are exempt. Work that repeats is a `schedule.yaml` entry, and an entry names
no deliverable.

A routine is a project like any other whose deliverables its schedule opens (`schedule.ts keepProjects`). HQ keeps a
project for each entry (its `project:`, else its id; entries that take turns at one task name one), named after the
entry, owned by its agent and in no business. Once no entry names it, it ends as `hq project done` would end it
(`projectdone.ts`), when its deliverables and work have settled, and is off the schedule till then. Each run is a one-task
deliverable there ("Weekly books check, 26 Oct"; a meeting's seats share one), so a routine has what every project has: its
runs as deliverables with their tasks, plans, times and pauses, and planned runs are on the board whether or not a seat is
free. Runs recorded before their routine had its project move there the same way, with their meeting's seats and their
review loops. An entry whose project id another project holds runs nowhere till it names its own. The projects view
lists the routines under Recurring, each with its interval and next run (`schedule.ts routines`); the board asks for a
run off schedule, there's no key for it. Downtime is a flag on the work (`downtime: true`, `hq job --downtime`),
never a group of its own. HQ's one-task wrappers end as their work merges, or once their job ends done with nothing to
merge or is cancelled (`threadends.ts endedEmpty`), and a routine's run once its job fails with nothing in its place
(the routine runs again at its next time); HQ's other one-task wrappers keep a failed job's deliverable for its takeover. An
owner's deliverable is ended by its owner (`hq plan done`): a task's run that ends with nothing to merge (done with no
pull request, failed or stopped) ends HQ's wrapper as above, or wakes an owner's deliverable's judge (`threadends.ts
runEnded`, below).

A project's plan is data in HQ, never a pull request (`plan.ts`):
its deliverables, the deliverables each **needs** (`thread_needs`: one starts once every deliverable it needs is done and merged, in
any project), and each deliverable's **tasks**, its queued work jobs, in order (`jobs.seq`, the id order until the owner
moves one). Only the project's owner and the CEO change it; anyone else is refused with the line to use instead,
`hq propose`. Every change is logged in `plan_changes`, with who made it. A deliverable's owner is its project's, everywhere
it's read (`projects.ts ownerOf`), so `hq project owner` hands on every deliverable in it.

- `hq plan <project> [--json]`: the open deliverables, those another needs first, each with its "done when", window,
  needs, planned finish and tasks (agent, title, size, state). `GET /api/projects` carries the same needs and order,
  each deliverable's owner being its project's.
- `hq plan deliverable <project> "name" "done when" [--needs <deliverable>]... [--slug <slug>]` draws a deliverable; `hq plan need`
  and `hq plan unneed <deliverable> <deliverable>` add or take back a need (a loop is refused at any depth, across projects);
  `hq plan move <job> <place>` puts a task still to start in its place (1: next; tasks added later still come last);
  `hq plan drop <job> "why"` cancels a task that never started; `hq plan done <deliverable>` closes a deliverable whose goal is
  met with nothing to merge, or whose work merged. Its tasks are queued with `hq job --deliverable`, as before; `hq job --deliverable new:<project>
  "name" "done when"` draws the deliverable the same way first, refused before anything is written for anyone but the
  project's owner and the CEO (`newthread.ts`). A drawn deliverable is read back as
  the board reads it: its product, project, name and "done when", then the names of the project's other open deliverables.
  With no `--needs` it needs the last one chained from the deliverable under way it most likely continues (the drawing
  job's, else the project's newest), so draws in a row run as one chain. A paused one is passed over, and so is one whose
  open work is all booked for a later time (`hq job --when` a time) with no pull request open, with what waits for it:
  each is named in the answer, for the drawer to `hq plan need` when the work shares its files, so ready work never
  queues behind a read days away.
- `hq plan rename <deliverable> "name" ["done when"] [--slug <slug>]` renames an open deliverable, read back the same way; a new
  slug makes it `<project>/<slug>` and its old id keeps resolving, as `hq deliverable move` does. `hq plan title <job>
  "title"` gives a task still to start a new title.
- `hq project new <id> "name" --owner <agent> [--business <id>]`, `hq project owner <project> <agent>` and `hq project
  rename <project> "name"` (the name only): the CEO's. A project under a new id is a new project, its deliverables moved
  there with `hq deliverable move`, the old one then done.
- `hq project business <project> <business | none>`, the CEO's too, puts an open project in one of `projects.yaml`'s
  businesses or moves it to another (`none`: out of any), keeping its id, code and deliverables; a name its new product has
  already, the project's or an open deliverable's, is refused, as for a rename.
- `hq project done <project>`, by its owner or the CEO, ends a finished project: refused while it has open deliverables,
  work still to run or in review, or proposals waiting, naming them. It leaves `hq projects`, `hq deliverable list`, the
  proposals' choices and `GET /api/projects`' projects, which lists it under `completed` with its done time and
  deliverables. A new deliverable or task in it is refused; a finished area that comes back is a new project.
- `hq propose` goes to the owner of the project it names (`--project`, else the proposer's deliverable's project; with
  neither, to the CEO). The owner reads and decides it in `hq inbox` (accept into a deliverable of the plan, or drop with
  why); the CEO sees every one with `hq inbox --all` and in the summary. The owner's planning job for the proposal's
  project, while one is open (queued, running or blocked, on any engine), takes it: it reads that project's inbox at
  its start and again before it ends, and what reached it after it started (new, or handed on with its project) and is
  still open when it ends gets the next one (`proposals.sweep`, every minute). With none open, a running Claude session
  of the owner hears it at its next step; otherwise HQ queues a new planning job, a one-task wrapper in the project, so
  a pause on one of an owner's projects holds only that project's sorting. With org.yaml's
  `review.drawWindowedChanges: true` (off unless set), a review's "changes" on a deliverable with a window is drawn at once,
  as `hq inbox accept findings:<pr> --for <author> --findings <blocking ids>` would: the PR's author fixes every
  blocking finding (or checks the touch-ups) in the reviewed deliverable, and the owner's running session hears of the task
  (a held notice, which lapses unread) and may cancel and redraw it (job #9562). A draw HQ can't make at once (`hq inbox
  accept` refuses it) leaves the item with its owner as any other, findings and all, and its ruling isn't ruled again
. Other findings on a deliverable with a
  window (a close, or any of them without that setting) wait in no planning job that isn't running:
  the owner's running session hears them first and holds them while it runs (once it ends, yields or parks on a card,
  the sweep hands them on and its unread notice lapses rather than becoming a message job), and a planning job holding
  any orders by the earliest of their windows, as the deliverable's own work does (job #8577). A "changes" item a later
  round or the merge has left closes by itself in the sweep, and while one waits with no fix task drawn, the deliverable's
  ETA says so, with no merge in sight. A proposal whose owner can't be told (the messages refuse the line)
  is refused, and nothing of it is kept, nor shown in HQ's feed. The CEO hears its own at the hourly check instead. When `hq project owner`
  hands a project on, its open proposals reach the new owner the same way, and the old owner's planning job for it that
  hasn't started stands down if nothing is left for it.
- Nothing HQ makes runs under a template name or as a bundle (`sorting.ts`). A
  job HQ makes from a template or holding several things (a colleague's message no session took in, the board's
  feedback on a product and its return to the board, outside notes on a preview, a repair of HQ standing still) starts
  under a template title but
  waits, on a `sorted` wake, until the owner of its project (else the CEO) sorts it in that same planning job: `hq
  inbox accept <id> --title "..." [--code WORD]` names it for what it does and lets it start in its deliverable (`hq job
  move` first for another), and work that joins it before it starts holds it again. A task belongs to the project its
  work is for, judged by whoever places it with that guidance (`wherework.ts whereWorkGoes`), never by paths or titles:
  only the CEO's own work stays in no deliverable, the desk's (its call follow-ups and meeting work), so a job of anyone
  else's in none is moved to its project before it's accepted, and a call's job for anyone but the CEO names its deliverable
  as any hand-off does. Unrelated parts become tasks of
  their own (`hq job`) and the rest is accepted, or it's dropped, which cancels it; a return to the board is only ever
  named. A review's follow-up bundle is accepted only under the accepter's title. A review's fix tasks are named by
  their consolidator: each blocking finding's `task`, and `touchups_task` for its touch-ups' check. `hq inbox accept
  findings:<pr>` takes that title when the findings it names share one, else needs `--title`; a pull request in
  no deliverable gets its author's fix round, which takes them together. A closed review's redrawn work keeps its work's own title. HQ's other
  jobs (alarms, checks, errors, watch, backups, a care bug report, an email's answer) are each one thing titled by
  what it is, and retries keep their job's title.

### Deliverables in order

How the platform plans: each deliverable's tasks one at a time on one branch, one pull request for the deliverable, read by the
claim, the worker and the review panel (`threadorder.ts`). There is no setting for it and no other way.

- **The order.** A task (a work job in a deliverable that isn't a pull request's fix or update) starts once the task before
  it in its deliverable (`jobs.seq`, else ids) is done: pushed, not merged. The deliverable's next task to
  start also waits until every deliverable it needs is done and merged, except one whose work is all pushed and whose pull
  request is stuck: that one holds only its own files, so what needs it runs beside it and merges after it only where the
  two share files (`threadorder.ts needsOpen`, `mergeorder.ts`), and the stuck one goes to its author at the stuck sweep
  (`review.ts stuckToAuthor`, once for each state it's stuck in). A task before it that failed with nothing in its
  place holds it when it was drawn before that failure, counting on its work; one drawn since (a redo queued without
  `--lands`, the next step) is the owner's call, made knowing it failed, and goes on. A replacement (`--lands`) takes the failed task's place. A failed task whose branch has an open pull
  request (open, stuck or with the board) holds nothing, since the deliverable's later tasks still push there (`jobs.ts`
  `failedAside`); once that pull request merges or closes, the failed task again holds the tasks drawn before it failed and the deliverable stays
  open. A task waiting for a time still to come
  (`hq job --when`) holds nothing: until then the tasks after it that haven't started go first, and once it's due it
  follows those that did (`inTurn`). The claim and the play read both as edges of
  `planner.ts` precedence (`follows`, until done; `needs`, until merged), which `backlog.ts` puts on the queue; a deliverable
  edge closing a loop with jobs' own waits is dropped and its task stalls saying so. A drawn deliverable with no task yet
  plays as one placeholder of its owner's, sized on its name and "done when" (`predictions.ts prepared`); while a window
  is at stake for it (its own, or one of a deliverable that needs it) it has no ETA, "no task drawn: nobody is building
  it", and so do the windowed deliverables that need it, which miss their window (`forecast.ts undrawnUnder`). `hq jobs`
  shows what holds a task ("after #n in its deliverable", "until <deliverable> merges", "until #n on its deliverable's pull request
  ends").
- **The branch.** The first task to push work (a commit, a pull request) makes its `job/<id>` the deliverable's
  (`threads.branch`); each later task runs on it (`jobs.branch`). A task that pushes nothing leaves the deliverable without a
  branch, so a deliverable whose work needed no change ends with `hq plan done`. The worker merges main into it at each later task's start (a conflict is left for the
  task's briefing to resolve first), and the briefing says the task's place, the task before it and the deliverable's "done
  when" (the claim's `inThread`).
- **One pull request.** At its push a task asks `POST /api/worker/thread-push` for the deliverable's title and tasks, and its
  push opens the deliverable's one pull request, or starts its next round if it's open. While the deliverable's next task starts
  now (running, or queued with only a seat to wait for: `threadorder.ts nextReady`), the push is held instead
  (`review.ts heldForThread`, kept as a push waiting for its ruling is): no round opens, and the next task starts at once
  on the branch. The last such task's push opens the round, its files against main the deliverable's whole work, so the
  deliverable is reviewed once, at its end. Finished work never waits for a task that isn't coming now: when the next task
  fails or ends with nothing pushed, the held push goes to review at once (`jobs.ts handOn`), and when it comes to wait
  for a time, a card or another deliverable's merge, at the next ruling sweep (`actOnRulings`, every 5 minutes). A pull
  request's fixes and the board's notes are never held, and a push is held only once it owes nothing: one that owes a
  redo, previews or its documents, or fails its gates or tests, goes back to its author first. While held it counts as in
  review: a job `--after` its task waits for the deliverable's pull request, and the task's call items tied to its work by a
  request or ref are judged once that pull request opens (`ledger.ts prOpened`). Its gates and tests run in the review,
  as for any push. A task that pushed nothing has its waits met at the deliverable's merge, never stranded.
  The deliverable's next task waits while a job of that pull request that pushes to the branch is open (a fix, or a ruling
  that may touch it up), and a ruling touches nothing up while a task works on the branch, so two sessions never push
  to one branch. A merge before the deliverable's last task runs settles the branch, as does a close with every commit
  on main already, and the next task starts a fresh one from main, whose
  push opens the deliverable's next pull request.
- **Its release.** A deliverable is one pull request, so no task in it waits for that pull request to merge
  (`threadrelease.ts`). `hq job --when deployed:` on the deliverable's own work (one of its tasks, the queuing one included,
  or its pull request) puts the job in HQ's one-task wrapper in the same project, and the answer says so. A task that
  gets into the deliverable waiting for its release anyway (moved or drawn in) runs after the merge, on a branch of its own.
- **Profile lines** go to main at each task's end on `profile/<the task's id>`, a branch the worker makes from main with
  only the agent's own profile and archive lines, which merges unreviewed as records do. The branch on origin is what was
  published (with any repair of it): each run sends it again on main as it is now, with the lines the deliverable gained since
  the deliverable commit it names (`Thread-Head`) or since the deliverable last took published lines back (`Profile-Lines`),
  whichever is later. Once published, the deliverable branch takes those files back to the version of main it last merged,
  so its merge leaves main's lines be. A failure fails the run before the deliverable's push; its run again sends only what
  was never published. Root merges main into that pull request as its one commit on main again, and a fix job on it
  pushes its repair the same way; a repair that leaves nothing for main deletes the branch and closes the pull request.
  Each push or deletion holds only while the branch is still at the publication its writer started from (none, for a
  new branch): of a run again and a repair at once, the later is refused rather than undo the other's lines.
- **A merge**, or a pull request closed with every commit on main already, clears the deliverable's branch (its next
  task starts a new one). A deliverable it leaves with nothing open or
  still to merge stays open, ready to judge (`threadjudge.ts`): HQ queues its owner a job with the deliverable's "done when"
  and each task's report (`threads.judge`; one that hasn't started takes the owner's next such deliverable in too), never
  held by a pause. So does an owner's deliverable whose last task ends with nothing to merge (done with no pull
  request, failed or stopped, or is cancelled before it runs: `threadends.ts runEnded`), once nothing in it is open or still to merge, never a judge's
  own. A task that joins a deliverable before its judge has started (a landing, a requeue, the owner's next task) takes
  it out of that judge, whose brief is rewritten from the others it judges, or which is cancelled if it judges none
  (`threadjudge.ts release`, from `jobs.ts createJob`); its end wakes a judge again.
  The owner closes it with `hq plan done` or draws its next task. `hq projects`, `hq deliverable` and the
  CEO's summary say "ready to judge" until then, with the open deliverables that need it. HQ's one-task wrappers (a routine's
  run, a check, a note's job) and a judge's own deliverable close at their merge. The judge's brief carries each
  task's report as quoted data, and only a report its owner may read (`jobs.ts readsReport`): one holding a customer's
  own details stays with its job unless the owner has roles.customerData, and a judge handed it holds those details
  too.
- **Refusals.** A running job's `hq job` into a deliverable is its project's owner's or the CEO's (anyone else: `hq
  propose`), and `--after` a job in another deliverable is refused for `hq plan need`, in its own for the order it has.


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
2. **Draw the plans.** Once that's merged, each project's owner draws its deliverables (`hq plan deliverable`). The job's
   agent, the CEO or Process places work in no deliverable in them (`hq job move <job> <project>/<slug>`, its reviews and fixes
   with it).
   The schedule's runs need none: each is a deliverable of its routine's project.
3. **The sentences.** Each project's owner says where the project stands, in one line (`hq project say <project>
   "..."`).
4. **Ask for deliverables from now on.** Once every job under way is in a deliverable, the CEO sets
   `requireThread: true` in `projects.yaml` by pull request. From then on, `hq job` refuses a job with no deliverable to
   inherit unless it names one (`--deliverable <project>/<slug>`, or `--deliverable new:<project> "name" "done when"`), a
   call's agent included, and a job HQ makes with none to inherit or be given (no `made:` project for its kind, a fault's,
   a call's follow-up for another agent) waits unstarted for the CEO to place it, as a held job in the CEO's inbox
   (`sorting.ts holdLoose`, before each claim; a pull request's loop steps go where their lead is). That keeps every piece
   of work inside one of the board's projects but the CEO's own running of the company (its checks, rounds and call
   follow-ups), which the projects view shows as the CEO's desk, named for the CEO (`wherework.ts deskName`: "Juno's desk",
   or `groups.unsorted.name`).
5. **Give HQ's own jobs a home.** The jobs HQ makes from the same template every time have no job to inherit a deliverable
   from. `made:` in `projects.yaml` sets a project per kind, by the app it's about: `errors` (the error scan's
   triage, by the app's slug, `care` for the support chat), `checks` (the CEO's hourly follow-through check and its
   repair, `hq`), `alarms` (the CEO's job about a platform alarm, `hq`) and `carries` (the checks on a commit main took
   outside review and the foundation keeper's fix, `hq`), as in `made: { errors: { care: company }
   }`. The watch's repairs of a live app go to the project its `product.yaml` names (`project:`), and so do a
   product's return to the board and the job for the board's answer on a card about it (`owed.ts`); the board's notes
   become tasks in their deliverables as the CEO routes them (`routing.ts`). Each
   such job starts a one-task wrapper of its own there (`<project>/job-<id>`, done when its work is merged), which its owner can fold into a deliverable of the plan. A kind or app with no entry, or whose project
   is done, goes to no project for the CEO to sort, but for a job with a window (a check, due by the end of its hour;
   an urgent alarm or repair, due as soon as it can), which throws instead and isn't made. A new company starts with
   the template's `projects.yaml` (its CEO's `office`, and checks and alarms there). A company without the file
   adds it once, the template's with its own CEO as the office's owner, before it takes this change: HQ lifts the
   office as it first reads it.

`hq job --check` marks QA, audits, security and compliance reads, which the view folds away. It applies to new jobs,
so existing ones stay unmarked.

## Moving work

The CEO, Process or the work's owner regroups what's sorted (`regroup.ts`). `hq deliverable move <project>/<slug> <project>`
takes a deliverable to another project as `<project>/<slug>` there, with its jobs, their reviews and fixes, its pause,
window and estimates. The old id keeps finding it everywhere a deliverable is named (`hq job --deliverable`, `hq deliverable`, `hq
plan`), since queued briefs name it, and no new deliverable can take it. `hq job move <job> <project>/<slug>`
moves work still going on to another open deliverable, the lead job on its branch with every review and fix round, which
later rounds inherit. If open deliverables need its old deliverable, the output names each one and its owner, with commands to
re-point each need. The owner keeps any old need by doing nothing. To re-point one or more, first run
`hq plan need <needing> <new>` once for that needing deliverable. If the addition is refused, stop and keep all old needs.
After it succeeds, run `hq plan unneed <needing> <old>` for each old need chosen independently for re-pointing.
For a move from A and B, the owner can keep A and re-point B, re-point A and keep B, or re-point both with the same
single addition. Keeping both needs takes no command. Adding the new need first preserves old needs on refusal.
If the needing deliverable is the destination, the destination depends on the needing deliverable, or the needing deliverable already
needs the destination, the notice offers keeping or removing the old need with `hq plan unneed <needing> <old>` only.
Each owner other than the mover gets one line through `hq say` per needing deliverable,
for the whole group moved. Needs stay where their owners drew them. A message refusal rolls the move back.
Splits and meeting seats use the same task-move command. A whole-deliverable move carries its needs with its identity.

Neither move takes work out from under an open pause: a deliverable takes its own pause along but
not its project's, and a job keeps only its project's. A move that would leave a pause behind is refused until it lifts.

## Pausing a project or a deliverable


A hold on a line of work ("no game work until the projects view is back") is state, not prose. It is only for work that
must wait on a condition (something from the board, a decision it has to make, a hold it asked for), never to put other
work first: that is a window, and the scheduler makes room by itself (board, call 169). A hold is
`hq project pause <project> "why"` or `hq deliverable pause <project>/<slug> "why"`, by the CEO or the project's owner, with
what wakes them to judge it: `--until <job>` for each job it waits for, `--until-time <time>`, or `--by-hand` (nothing
does). One naming none of them is refused. It lives in HQ's db (`pauses.ts`), not in `projects.yaml`, so it holds the
moment it's made. While it stands, the claim starts nothing queued on the deliverable, or on any deliverable of the project: no
work, and no review, ruling or fix of its pull requests, which wait in review until it lifts. Work already running yields at its next step,
as it does to the scheduler's room, and goes on in its session once the pause lifts; the run that made the pause runs on
to its end (`jobs.ts` `pauseSuspends`). A running review or ruling runs to its end, and
`hq stop` on one pauses it at its next step instead: it goes back in the queue in its session,
and the pause holds it until it lifts, so a half-written review is never read as a verdict. A
job queued onto a paused deliverable is accepted and told it's held, `hq jobs` and HQ's projects view say it's paused,
the live estimate plays it after the jobs the pause waits for (the earliest its owner could lift it), and the projects
view shows the pause with why and what it waits for.

The work in no deliverable has a pause of its own: `hq project pause unsorted "why"` (or the code of `projects.yaml`'s
`groups.unsorted`), the CEO's alone. It holds what lands there however it got there: work a call queued, HQ's fix
rounds and reviews on a pull request whose work had no deliverable, HQ's template and fault jobs before they're sorted. A
hold that pauses projects pauses this one too, or what it misses there starts anyway. It lets go of what no hold should
keep: the intercom, a meeting's seats, a board call's follow-up (the board heard, which is how a hold goes in and
lifts), expedited work, and an owner's sort that holds something open on a deliverable no pause holds (a job HQ made
that waits for it, review findings, a proposal for that deliverable): the hold doesn't keep work it lets run waiting on a
sort it never lets start. The play reads a job waiting for its sort as starting after that sort's job. Work it holds stays in no deliverable until it lifts: `hq job move` refuses to sort it out, as it
refuses to move work off any pause.

Nothing lifts a pause by itself (board, 25 Oct): what it waits for wakes its owner, who judges. Once its
`--until-time` has come and every `--until` job has merged or ended (closed with its commits on main, closed unmerged,
failed, cancelled, or done with nothing to merge), HQ queues its owner a job (the CEO for one carrying the board's
item), `pausewake.ts`: the pause's why, what was met, and each job's report and whether its work is on main. That job
is never held by a pause or the company's pause, and runs as soon as it can, which pacing lets through. The owner
lifts it (`hq project resume` or `hq deliverable resume`), takes the results to the board, or keeps it on for what's still
missing: the same `hq ... pause` on a paused target, by whoever may resume it, keeps that pause with the new why and
conditions, and they wake the owner afresh. No pause holds the CEO's hourly check either, though `projects.yaml`'s
`made.checks` draws it in a project a hold may pause: it is what judges the holds. The CEO's hourly check flags a pause whose waited-on work ended, or whose
woken owner left it on with nothing to wake them again, as off track that hour. Only the CEO resumes a pause the CEO
made or one carrying the board's item; a pause for the board's decision ends with the board's answer on its card. A pause can't wait for a job on what it pauses, or for one that needs work there first (its after,
its waits, another pause's `--until`, at any depth), which it would hold for good. A later `hq waits` change that would
close such a loop is refused too. A job meant to end before a pause is judged goes in a deliverable outside it.

A hold the board agrees on a call is recorded as the pause, and its item linked to it:
`hq item link <item> pause:<project or deliverable>` (a decision already handled goes on it as it is). The follow-through
read then shows the board's words beside the pause. A task or promise it carries stays on the hourly check while the
pause holds, and after a resume by hand until the jobs the pause waited for are merged.
