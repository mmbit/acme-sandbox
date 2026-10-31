
# Bounded memory inspection handoff

The mechanism starts disarmed. Process can arm one separately authorized attempt.
The existing HQ SQLite database retains at most one notice receipt, one pressure
receipt and one terminal disposition. No new attempt name replaces that singleton.
There is no rearm, reset, extension, migration, receipt overwrite or receipt history
operation. Normal reports add no durable observation while disarmed or terminal.

## Released operations

Only a job in the department of `roles.process` may use these operations. Calls
cannot use them. Implementation does not authorize released use. The released owner
must first verify the complete reviewed release and all repairs in the actual
coordinator and worker lifetimes. A deployment event alone is insufficient.

`hq room binding` reads only coordinator identity/revision, the naturally reported
worker source identity and any existing attempt identity. It accesses no witness,
notice or history population. Its route is `GET /api/agent/room/inspection/binding`.
Verify those identities against actual adopted processes and source bytes using the
released checklist, before constructing the binding. An existing attempt forbids
another arm.

The company's `company/infra.env` sets `MEMORY_INSPECTION_BUDGET_MS` to its
separately authorized observation budget. Missing or zero leaves arming unavailable.
A positive budget must be integer milliseconds within Node's timer range, at most
2,147,483,647 ms. A configured budget never arms automatically and cannot change an
existing attempt's recorded bounds. It grants no authority to use the mechanism.

Record this binding in a local JSON file, using verified values rather than this
example's placeholders. The example uses a hypothetical 60,000 ms company budget.
Times are integer Unix epoch milliseconds. `startedAt`
retains the process's original fractional timestamp. `workerDigest` is the full
SHA-256 digest of the verified staged worker source and company configuration.
The digest is the Process operator's verified adoption attestation. The mechanism
checks the reporting worker session and actual coordinator identity, rather than
recomputing staged files or sampling a meter.

```json
{
  "authority": "the released owner authority",
  "armedAt": 0,
  "closesAt": 60000,
  "verifiedAt": 0,
  "coordinator": { "pid": 0, "startedAt": 0, "revision": "actual released revision" },
  "worker": { "pid": 0, "startedAt": 0, "session": "verified random evidence session" },
  "workerDigest": "the verified 64-character lowercase hexadecimal SHA-256 digest"
}
```

`closesAt - armedAt` must equal `MEMORY_INSPECTION_BUDGET_MS`. Name both absolute
timestamps before arming. The request must arrive inside those bounds, after `armedAt` and
before `closesAt`. Transport consumes the recorded budget and never extends it.
Adoption verification must be no more than 180,000 ms old and cannot be future dated.
The current coordinator PID/start/revision and naturally reporting worker source
must match. A development coordinator cannot arm. Failed prerequisites refuse the
operation before receipt inspection. The released task must stop on a refusal,
without another attempt.

```sh
hq room arm /absolute/path/to/binding.json
hq room inspection <attempt>
```

The arm response supplies the immutable attempt identity, acceptedAt, recorded
arm/close and adoption binding. It is returned after the arm is durable. The exact
routes are `POST /api/agent/room/inspection/arm` with the binding object, and
`GET /api/agent/room/inspection?id=<attempt>`. Unknown identities return 404.
The read route returns only this durable handoff. It does not inspect current room,
consume a notice or page spell, delivery or run history.

The released arm task queues one separately authorized consumer at the recorded
absolute closing instant, then ends. It supplies the returned identity and binding.
No agent needs to stay alive, poll for natural work or depend on a readiness notice.
This mechanism emits no readiness notification. Receipt writes and terminal closure
are synchronous database commits, so later retrieval cannot precede their durability.

## Existing decision rules and the arm boundary

At successful arm, `beginNoticeObservation` clears the existing tracker's endpoint
summaries. It retains worker identity and sequence high-water marks. The next
natural reports use the same `observeNoticeReport`, `qualifies` and warning hooks
as the ordinary notice summaries. No rule is copied. Resetting the observation
boundary neither fabricates a warning nor truncates an old span into fresh evidence.
An uninterrupted old span cannot be imported. Two distinct new qualifying processed
reports are required, with original endpoints, observed count and coordinator order.
Every intervening processed decision must qualify. Both actual warning emission
paths, including a delayed cause-only warning, invalidate active observation.
There is no arbitrary duration requirement. Endpoints may share a millisecond,
while their worker identities and coordinator order remain distinct.

The natural `room.reportRoom` path first completes low-memory notice processing,
then updates retained worker records, then calls `inspectReportBoundary`. Thus a
pressure gate carried by that report is available in the same boundary. Each
population is independent. Once preserved, its slot is no longer inspected or
replaced. All writes for a boundary, including completion when both slots exist,
commit in one existing `inOneStep` transaction.

Notice inspection reuses original qualification, then independently checks source,
original receipt, every required input/read and quiet predecessor at inspection.
Both endpoints must remain fresh within 180,000 ms in the bound session. The snapshot
includes original categories, reserves, calm/reason/CPU distinctions, actual none
transitions, source joins, original receipt times, order/count, input ages and flags.
A fresh last endpoint cannot rescue an old first endpoint.

Pressure inspection uses the existing fixed pressure population and `pressureBlocked`
predicate, then checks the full causal and freshness contract. It verifies the
eligible ordinary seats, false room, ordinarySelected=false, every measured short
path and no successful unthrottled short ordinary path. Original measurement,
trigger, source and receipt ages are independent. Actual availability and reserves
reuse the shared worker calculations, including raw PSI and OOM readings. Threshold
pressure suffices without a new OOM.
A quiet input held by the original trigger must retain that exact live ten-second
hold. CPU-only, reserve-only, no-seat and all-throttled cases do not qualify. A later
incident fallback stays separate from the ordinary gate proof. A throttled path may
carry its own calmer measurement if the hold expired between sequential reads.
Resends do not refresh original source, inputs or coordinator receipt.

## Closure and historical review

The fixed closing instant stops inspection even if its timer runs late. A one-shot
unref timer persists `expired` without needing another report or consumer. Two
receipts close `complete` earlier. A newly reported worker lifetime closes
`interrupted` before witness inspection. Coordinator shutdown closes interrupted
synchronously, as does normal process exit. A replacement coordinator interrupts an
unfinished saved attempt when it starts. Importing report modules in an operator
command does not start or end the coordinator lifetime. A replacement never resumes
the old attempt.
A hard process death cannot write while dead. Recovery records interruption with
its detection time and states that the actual exit instant remains unknown.

Each disposition is write once and names the exact missing receipt slots. Missing
populations remain unresolved, with opportunity, stale inputs, nonqualification,
supersession, loss and untransmitted work unknown. Completed receipts survive any
interruption with their original adoption and session labels. No absence of pressure
or continuous coverage is inferred. Expiry is an observation budget, never a new
acceptance deadline or a prediction of natural pressure.

Retrieval returns immutable original inspection inputs and qualification flags,
`inspectedAt`, the original adoption binding, `agesAtInspection`, and separately
computed `agesAtRetrieval`. `retrieval.historical` is always true and
`currentSessionRoom` is always false. The elapsed time does not freshen any receipt.
The consumer may run after close and after coordinator replacement. It reviews the
original authorized inspection, without another live observation or new authority.
Receipts prove only actual observed decisions within their bounds. They do not prove
continuous kernel calm, delivery to all users, a named queued-job rejection, process
start or events lost before transmission.

A consumer arriving after close finalizes a still-pending expiry before returning
the handoff, even if the one-shot timer has not had its event-loop turn. This
performs no witness inspection or current-room read, and cannot extend observation.
