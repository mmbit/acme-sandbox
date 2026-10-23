# Bounded claim-plan observation


`company/observations.yaml` optionally enables one cohort:

```yaml
claim_plans:
  id: a-unique-observation
  duration_ms: 3600000
```

Without that setting collection is off. The id runs once in the database. It starts when live ordering starts,
names `GIT_COMMIT`, and stops after the configured duration. Its persisted `started_at` and `ends_at` are UTC
Unix milliseconds. Membership is entry in `[started_at, ends_at)`, using the real clock rather than the planner's
optional `now` argument. A synchronous play that enters before the end is included even if it finishes later.
The one-shot timer closes an idle cohort too. No work is created to exercise a reason.

Every watched `ordering.current` call contributes to the summary, including kept hits and fresh durations below
300 ms. Calls before `ordering.start()` are outside the live cohort. Fresh reasons are `start`, `new_job`,
`hq_log`, `hq_status` and `expiry`. A new maximum job id since the previous fresh plan takes reporting precedence
over a simultaneous published HQ invalidation. Otherwise HQ attribution follows the existing first log/status
that clears the kept plan. Agent-originated events do not clear it. `expiry` retains the existing rule: the plan
is kept at exactly ten seconds and expires after that. Reporting never changes plan inputs or eligibility.

The stored JSON has both fresh/kept totals and summaries for each reason:

- `count`, `errors`, `failures` at **wall duration >= 100 ms**, `under300` (below 300 ms), and `failures_under300`
  (failures from 100 ms up to 300 ms). Errors also prevent acceptance, regardless of their duration.
- Wall duration total `wall_ms` and maximum `max_ms`, without rounding or a reporting floor.
- Process CPU totals `cpu_user_ms` and `cpu_system_ms`, and the maximum per-call combined `cpu_max_ms`.

Wall timing covers the current call's newest-job lookup and plan selection/play, ending before observation
persistence and the existing slow-hold log. It excludes later use of the returned eligibility function. CPU uses
`process.cpuUsage`, so it measures the coordinator process, including any concurrent native-thread CPU, rather
than attributing CPU exclusively to the JavaScript play. The observation adds a summary write per call, outside
its measured duration. This overhead is part of the live route, not a performance repair.

`claim_observations` retains one fixed-size JSON summary per configured id, without truncation or the latency
sensor's three-hour cleanup. Every write contains the full cumulative summary. Persistence failures propagate to the
owning error boundary. The collector does not catch or retry them. The final timer writes outside a claim's
transaction and clears the active cohort only after that write succeeds. A successfully persisted `complete` state
establishes full interval coverage and zero dropped samples. `collecting` or `interrupted` has incomplete interval coverage and unknown dropped observations (`null`).
A failed final write leaves a collecting row, so it cannot masquerade as complete. A process restart marks a
previous collecting id interrupted and never restarts or extends it, even on the same revision.

Empty reason summaries keep a null maximum. `missing_fresh_reasons` explicitly lists them. Full interval
coverage alone is not a timing pass: acceptance also requires observed natural new-job, HQ-change and expiry
cohorts, zero fresh errors and zero fresh failures. An absent cohort remains unproved.

The status report includes every stored summary in its bounded claim-plan section. A live agent job can also
read `GET /api/agent/claim-plans` with its normal bearer token. For example, from the repository root:

```sh
node --input-type=module -e 'import { getJson } from "./platform/worker/hq/api.ts"; console.log(JSON.stringify(await getJson("claim-plans"), null, 2));'
```

Read after deployment in its own event-based job. If the cohort is still collecting, queue the final read at its
reported `ends_at` UTC time and end the job. Never poll or restart collection to obtain a desired outcome. An
interruption, absent reason or measured failure must be recorded honestly. Any later observation or repair is
separate work proposed to the project owner.
