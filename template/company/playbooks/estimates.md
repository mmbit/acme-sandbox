# Estimates: measured times and adjusted ones


Every estimate stands on done jobs like the work: their agent time, measured from their runs. A process change (a gate
dropped, a test route moved, a review rule) can make part of that time stale: the jobs before it did work nobody does
now. We never throw those jobs away, and nobody registers every change formally. Instead the weekly estimate check
(`shared/routines/estimates.md`) judges what each change made stale and gives those jobs an adjusted time.

## What an adjusted time is

- A forecast beside the measurement: what that job's work would cost now, with why (the change, and what it changed in
  that job), who set it and when. The measured time never changes.
- Set per job, each with its own reason, never a factor over a set: what a change removed differs per job.
- A later adjustment of the same job replaces it, and `none` withdraws it; the earlier ones stay as history.

## Reading one when you size work

`hq estimate` (and a call's estimate tool) shows an adjusted job with both: "Measured 1 h 11, now about 40 min: <why>
(<who>, <date>)". The picks and the size from them count the adjusted time, so a comparison's stale part no longer
pulls the estimate up. When you compare scopes yourself, use the adjusted time for the part it says still holds, and
judge whether your work carries the old step anyway (some work still needs the check that was dropped as a gate).

What stays on the measurement: the scoring of estimates against what happened (`--accuracy`, `--calibration`), the
sizers' bias the plan corrects given sizes by, and the timing audit. Those measure what work took, never a forecast.

## Who sets one

The estimates role (org.yaml's `roles.estimates`) in its weekly check, and the CEO: `hq estimate adjust <job> <time>
"why"`, or a JSON list on stdin (`hq estimate adjust - < list.json`). They also re-size queued work that leans on
adjusted jobs (`hq estimate set`). Anyone else who sees a stale comparison tells them (`hq say`), with the job and the
change.
