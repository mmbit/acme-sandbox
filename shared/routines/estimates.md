This week's estimate check, for the agent who answers for the estimates (org.yaml's `roles.estimates`, else the CEO):
how far the week's estimates and what the work really took lay apart, which deadlines were met or missed and why, which
process changes landed and what they bought, and the past jobs those changes made stale given what they'd cost now.
Estimates should keep getting tighter without throwing the dataset away: a measurement never changes, a forecast stands
beside it (the Estimates playbook).

**What to read.**
- The week's finished tasks: `hq estimate --calibration --days 7` and `hq estimate --accuracy --save <file>` (each one at
  a time: they're heavy). Count a task's whole working time, its review rounds, rulings and fixes included (the whole
  and its split), never its waits in the queue, which the plan works out. Tokens beside time: each first estimate's
  work, review and fix tokens against what was used, phase by phase, and by the confidence level saved with it (low,
  medium, high), with how many tasks each covers. Missing estimates, missing usage reports and unfinished tasks stay
  visible and unscored.
- The deliverables whose windows or deadlines fell in the week, met or missed (`hq deliverable`, the status report's
  deadlines section, `hq report`), and for each miss why: the size, a wait nobody planned, a review round, a card.
- The process changes that landed: the week's `company/DECISIONS.md` entries and merged pull requests that change how
  work runs (a gate added or dropped, a test route moved, a review rule, a new tool).

**What to do.**
- Name the causes that recur (a kind of work that runs long, a phase nobody sizes, a tool showing the wrong numbers) and
  fix each: in the estimate tool or its guidance where that's yours to change, else a proposal (`hq propose`). Judgment,
  not rules: no new caps, flags or formulas.
- For each process change, judge which past jobs it made stale and what each would cost now, and record it:
  `hq estimate adjust <job> <time> "why"`, or several at once as a JSON list on stdin, each job with its own time and
  reason (the change, and what it changed in that job's work). Never a factor over a set: what a change removed differs
  per job. A job whose adjustment turns out wrong gets a new one, or `none` to withdraw it.
- Queued work whose saved size leans on jobs you adjusted: `hq estimate '#<job>'` shows its references; re-size it
  with `hq estimate set` and a why where it no longer holds.
- Check last week's adjustments against what the work done since took: a job sized on adjusted comparisons that ran
  long says the adjustment went too far.
- Write the week's numbers and causes in the company's estimates note, under a dated heading: what was measured, what
  missed and why, what you changed or proposed, which jobs you adjusted and for which change.

If the estimates stay off and you can't see why, put it to the board on the desk phone (`hq ask`): what you found and
what you tried. It would rather help than have them stay off.

Once two weeks in a row find the estimates close and no new cause, propose to whoever owns the schedule that this runs
monthly (`week: "1 of 4"`). A quiet week: its numbers in the note, no jobs.
