# Worker capacity capture


The optional `company/worker-capacity.json` configures a bounded, content-free capture:

- `samples`: attempts per worker process, a nonnegative integer. Zero disables capture.
- `job`: numeric capture identifier. Files append under `/work/capacity-<job>/`.

A company without this file uses the disabled defaults in `platform/worker/capacity.json`.
`infra/worker.sh`, called by deployment, stages the committed configuration beside the worker as `capacity.json`.
The staged revision includes both the worker tree and configuration blob. A config-only deployment changes that
revision and uses the existing process reload, keeping running jobs and the container. The worker reads that
immutable configuration once at startup. No container environment change is needed.

To end a capture, merge a change setting `samples` to zero in the company file. Keep `job` and existing capture
files. Logs identify each supervisor process and its completed or interrupted budget. A reload while enabled
starts another per-process budget and preserves earlier rows.

## Push checks


A session returns its work slot and seat place before its push checks queue. The work users and the intercom user
stay available for sessions. Separate checks users, one per work slot (slots.ts `CHECK_SLOTS`), run pushes in
isolation, with one push per user.
A push waiting for a checks user has root-owned folders. The worker kills and sweeps the previous user's processes
and temporary files before handing its folders over. Checks retain their own user through test-turn, browser and
memory waits. A full checks-user pool queues more checks without holding any session slots.

Run records retain the checks user, or a waiting checks identity. Reloads reserve the users whose checks still run
and take queued checks back independently of the original session slot. Stop and ownership loss cancel queued
checks and clean an active user's processes before another push takes it.

The memory report's `runningMb` contains session-slot occupants. `checks` identifies ended sessions that retain a
job lease but consume no session or seat place. Checks' actual memory remains included in the worker's measured use
and share enforcement. The forecast conservatively keeps that memory external until a later report measures its
release. `heldSlots` and `totalSlots` continue to describe work slots alone.

The checks users are created in the worker Dockerfile, so a change to their number needs the image rebuilt
(`infra/compose.yaml`, `infra/sync.sh`) rather than only a code reload.

## Account readings


Subscription-seat recovery reads accounts independently of job admission.
After startup, a ready Claude seat needs observed five-hour and weekly
windows. Restored weekly usage and expired reset times do not satisfy that
read. A ready Codex seat needs a provider reading, which may report only the
week.

The account-reading loop runs immediately, then waits one minute between
passes. Claude reads are due for held seats and ready seats with incomplete
readings, at most once every ten minutes per seat. Codex reads are due for
ready unread seats and unconfirmed held seats with a configured stop or
available credits that the seat is not spending. Held Codex checks wait an
hour after the hold starts or the last account read. Each Codex account
attempt is also spaced at least an hour from that loop's previous attempt
on the seat.

Failed reads leave other seats' checks running and retry while still due,
at the same per-seat intervals. Paused, removed, signed-out and key seats
are excluded.

## Seat pacing

Pacing reduces concurrent ordinary runs when a seat is ahead of its week's pace.
The allowance per wall hour is the remaining share to the pacing target, minus the
two-point reading margin, divided by hours until reset. The worker divides that
allowance by the seat's measured weekly cost per agent-hour and rounds down to a
whole number of concurrent runs. A seat whose one run costs more than that allowance
keeps one place. After each run on it, the seat rests with none, long enough that the
run's spend over the run and the rest together comes to the allowance. Its average
spend so lands on its week's budget by the reset, instead of reaching its stop days early. A rest still going is added to, and
none lasts past the reset. The worker reports the rest's end to HQ, which hands it back
in the seat list after a restart. An unmeasured or zero cost permits one place, with no
rest, until a useful price is available. The coordinator supplies its existing measured
seat prices with the worker's seat list.

The same admission limit includes the near-stop band: within ten points of either
active window's stop, one run at a time. Configured stops still admit no runs at or
past the stop. Running work is not killed by a reduction in pacing places. New
ordinary claims wait for a place to free or a rest to end, while urgent claims can use
spare places, and a resting seat, within the stop and engine limits. Urgent runs count
toward the next rest all the same. Intercom and incident reservations keep their
existing access. Credits bypass quota stops but retain weekly pacing.

The forecast uses the same allowance and rests with its measured prices. HQ's seat
line names the ordinary concurrency, or the rest's end, and the remaining weekly
allowance per wall hour. Changing work costs, provider reading lag and urgent work
still move measured spend around the allowance. Stop handling remains responsible
for keeping work inside the seat's configured window.
