# Read-only worker room records


`hq room [spells | deliveries | runs] [--after <cursor>]` reads
`GET /api/agent/room/records`. Use a job token belonging to the department of `roles.process`.
The default history is `spells`. The response is JSON.

## History pages

| Population | Fields | Cursor |
| --- | --- | --- |
| `spells` | id, began, ended, free_mb, cause, took_mb, cause_free_mb | id, starting at `0` |
| `deliveries` | spell, job, back, linked began/ended, spell_found | spell.job, starting at `0.0` |
| `runs` | id, job, seat, started, ended, ended_as, provenance | id, starting at `0` |

Each page contains at most 100 rows. Pass its `next` cursor with the same population until `next`
is null. For example, `hq room deliveries --after 12.34` continues after spell 12 and job 34.
The CLI leaves omitted cursors to the route's defaults. Invalid populations or cursors receive the
route's refusal. The run history is named `runs` in both the command and response.

Pages are live reads. A spell's ended or a delivery's back may change between reads. Reread earlier
pages to see updates. The delivery left join preserves orphan rows with spell_found = 0.
A delivery records notice-hook bookkeeping, not proof that a person read it. Runs with ended_as
rebuilt or a missing seat have reconstructed provenance. Other rows record successful run starts.
Run records do not include failed admission attempts or exact numerical decision inputs.

## Current state and evidence limits


Each response includes these current-state fields:

| Field | Meaning |
| --- | --- |
| `inspectedAt` | Coordinator time when Process inspected the records, in milliseconds since the Unix epoch. |
| `coordinator.pid`, `coordinator.startedAt` | Coordinator process identity and process start time. |
| `room.report`, `room.capacity` | Latest received room report and planner capacity, each with its coordinator receipt time. |
| `notices.latest` | Latest coordinator notice state and its receipt time. |
| `retained` | The worker source identity and the two retained record wrappers described below. |

Missing in-memory state is null. Planner `memory.at` labels the report's sequential reads.
Each input has its own read bounds.

`retained.source` identifies the worker most recently reporting fixed records. Its pid,
startedAt and random session identify that process lifetime. The session is a process token,
not a job's conversation or an OS session. Each record and each memory read adds a process-wide
sequence. A room record also includes the already-read OS workerSessionId in its report.

`retained.room.record` preserves the actual outgoing room report, its overload pressure tuple,
and its own ordered measurement inputs. Inputs label the watch and report phases. The watch reads
short room without young reservations, free memory without young reservations, then room with
young reservations. The report reads free memory, planner starts, planner available memory and
meeting gathering in their existing order. These are distinct reads, not one atomic meter look.
The original report and pressure verdict/reasons/cause remain separate from the coordinator's
notice hysteresis. Pressure inputs retain the existing calm baseline free memory and per-job use,
memory verdict, thresholds, host/worker CPU PSI and CPU hysteresis. CPU overload does not become
a memory PSI brake. The calm baseline has no exact measurement identity.

`retained.decision.record` preserves the latest actual select-claim action and its own inputs,
slot and selected seat/engine/kind/room. Outcomes are no claim, claim selected, job claimed,
meeting held, empty claim or claim request failed. A claim answer replaces the record with a new
immutable copy only while that selection is still latest. It preserves the original inputs and selectedAt,
adds the actual job and held meeting identity when known and updates sourceAt. An answer to an
overwritten selection cannot recover its inputs. Chat and held-seat selection perform no memory read, so their input list is
empty. No-claim outcomes can include unavailable seats or throttling as well as memory shortage.
They do not alone prove memory blocked a particular job. A failed claim request leaves coordinator
assignment unconfirmed. A selected claim has no job identity yet.

Each ordered input has these fields:

| Field | Meaning |
| --- | --- |
| `phase` | `watch`, `report` or `selection`, identifying the action that used the reading. |
| `operation`, `value` | Admission function called and the number or boolean it returned. |
| `young` | Whether the operation applies reservations for jobs still starting. |
| `readStartedAt`, `readEndedAt` | Bounds of the input read, in milliseconds since the Unix epoch. |
| `measurement` | The memory meter reading used by this operation. |
| `reserves` | Reservation entries and allowances used by this operation. |

The measurement fields describe the memory calculation:

| Field | Meaning |
| --- | --- |
| `identity` | Worker process identity and sequence of this exact meter reading. |
| `readStartedAt`, `readEndedAt` | Bounds of the sequential cgroup reads. |
| `hostAvailableBytes` | Host MemAvailable, in bytes. |
| `memoryCurrentBytes`, `memoryMaxBytes` | Cgroup charged bytes and raw ceiling string. The ceiling can be `max`. |
| `raw.file` | Total cgroup file cache bytes, including shared memory. |
| `raw.active_file` | Active file cache bytes, or null when absent from the kernel reading. |
| `raw.shmem` | Shared memory bytes. |
| `raw.file_dirty`, `raw.file_writeback` | Dirty file bytes and file bytes being written back. |
| `raw.unevictable` | Bytes the kernel cannot evict. |
| `reclaimableFileBytes` | File cache available for reclaim after shared, dirty, writeback and unevictable bytes are charged. |
| `heldBytes` | Charged bytes after subtracting reclaimable file cache. |
| `availableBytes` | Host-bounded room below the cgroup ceiling, or zero while the memory pressure brake is active. |
| `memoryPressure`, `memoryEvents` | Raw cgroup memory PSI and event text. |
| `previousOomEvents` | Prior OOM and OOM-kill counters in that order, or null on the first reading. |
| `newOomEvent` | Whether either OOM counter increased since the prior reading. |
| `underPressure`, `pressureUntil` | Whether the memory brake is active and its expiry time. |

Required file categories must be present for a reading to succeed. The reservation fields are:

| Field | Meaning |
| --- | --- |
| `starting` | Actual startup reservations used. Each entry has expiry time `until` and allowance `mb`. Null means the operation did not apply startup reservations. |
| `heldSlots`, `heldMb` | Number of held meeting seats and their reserved memory in MiB. |
| `freeReserveMb` | Memory kept free after reservations, in MiB. |
| `defaultRunMb` | Startup allowance for an ordinary job, in MiB. |

Diagnostic and report reads retain their own inputs. An admission decision retains the inputs
used by its selection.

Each wrapper has receivedAt, receiptStale, sourceStale, measurementStale and previousSession.
Stale uses the existing three-minute freshness window, with source, measurement and receipt ages
tested separately. Measurement staleness is null for an unmetered selection. Resending an unchanged
record identity does not refresh its receipt. A worker's new source can leave an older
decision visible as previousSession until a new decision arrives. Inspection never treats it as
current-session evidence. A coordinator restart loses all retained copies.

The worker keeps at most one immutable latest room record and one immutable latest decision.
Each lives until replacement or process exit. The coordinator keeps at most one volatile copy of
each, replacing by identity through the existing room-report channel. There is no history,
database stream, journal, extra measurement read, timer or cadence change. A transient pressure
case can be overwritten before the next report or inspection and is then lost.

`joins.measurementToDecision` lists only the identities carried in the actual retained decision.
Room-to-decision and notice-history-to-measurement remain null. Delivery-to-spell remains the stored
join. Read missing alongside the records. Null history and absent natural pressure do not mean zero
historical events. Old capacity rows cannot acquire missing raw categories through this retention.
Inspection preserves pending notices and all-clears, and remains available only to Process jobs.
