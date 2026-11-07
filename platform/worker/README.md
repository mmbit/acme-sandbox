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


A session returns its work slot and seat place before its push checks queue. The fifteen work users and the intercom
user stay available for sessions. Fifteen separate checks users run pushes in isolation, with one push per user.
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

The checks users are created in the worker Dockerfile. Deployment builds that image through `infra/compose.yaml`
and `infra/sync.sh`, then replaces the changed worker container. This first release needs the image rebuild, rather
than only a code reload. Later code-only releases retain the ordinary reload path.

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
