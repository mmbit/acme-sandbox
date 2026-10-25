# Confined inference acceptance

`smoke.py` checks a trusted inference executable through stdin and stdout. It executes one allowlisted read-only
tool, replays the complete assistant message, checks the final answer, and measures driver-visible GPU state.
It has no network client and never launches a shell from model output. Python's standard library is sufficient.

The runtime and its weight store must be provisioned separately. This folder contains the acceptance caller and
process fixtures, not an inference engine. A successful fixture run proves caller behavior only.

## Run it

Supply a company manifest with an immutable runtime image, runtime commit, exact weight revisions and digests,
the expected GGUF architecture, GPU split, context, output budget and sampling parameters. The caller refuses an
unpinned image before it starts a runtime or reads a GPU: a registry digest (`name@sha256:...`) or a local image's
id (`sha256:...`). The run kind's image in org.yaml is that same reference. A process can't see its own image, so
the runtime's readiness doesn't name it. The runtime executable must validate the provisioned files and use its
embedded build identity. It must not echo the requested identity as evidence of its own build.

Retain the helper manager's deployed-kind receipt alongside the smoke report as separate acceptance evidence.
The machinery owner records the machine, kind, container, configured immutable image reference and Docker-resolved
image id from the manager-owned container. Its configured reference must match the manifest's `runtime.image`
and org.yaml. For a local image pin, the resolved id must also equal that pin. For a registry digest, retain
both the pinned reference and resolved id. Runtime readiness establishes the loaded build and model identity.
The deployment receipt establishes the image identity.

Run this **inside the GPU helper**, with its existing no-network filter and a disposable workspace:

```sh
python3 shared/inference/smoke.py \
  --manifest company/experiments/trial-models.json \
  --runtime /opt/inference/bin/chat \
  --report smoke.json
```

The helper's outer `hq run --minutes` budget bounds the experiment, including loading and shutdown. The caller
does not retry failed inference, reduce context, substitute a model or continue to the next model after failure.
The caller atomically replaces its report after the baseline, runtime launch, readiness, each response, tool
handling, EOF request, shutdown, cleanup request and release checks. Increased sampled peaks and sampling failures are saved during
loading and inference too. Each save emits one flushed JSON stage marker on stdout with `type: smoke`, `stage`,
`passed` and, for model stages, `modelIndex` (zero-based manifest order). Markers stay below HQ's 300-character
line limit. Full measurements, including readiness, turns, peaks and process identities, are in the report only.
Collect that report with `hq run --bring smoke.json` on a completed run. Retain the helper's streamed markers
outside the run as well as collected files. The caller records failures and separate cleanup failures.
A partial report keeps `passed: false`. It does not establish the external termination outcome
or post-termination release. No successful shutdown is reported after forced cleanup.

The readiness prerequisite includes measured per-card headroom, no competing GPU helper run, accounted persistent
weight storage and image/download capacity. The machinery owner supplies that admission check. The smoke caller
does not grant itself GPUs or evict existing users. A new run kind must be lent-only and keep `sockets` disabled.

## Stdio contract

The caller launches `<runtime> --manifest <absolute-json-path> --model <name>` as an argument array. The runtime
loads only that model. It emits a single JSON object per stdout line and keeps diagnostics on stderr.

The first line is a readiness object with these fields:

| Field | Evidence |
| --- | --- |
| `type` | `ready` |
| `modelSha256` | Verified digest of the provisioned weight file |
| `runtimeCommit` | Embedded runtime build commit |
| `architecture`, `templateSha256` | Loaded GGUF architecture and digest of its embedded chat template |
| `backend`, `devices` | Actual `CUDA` backend and selected zero-based GPU indices |
| `gpuLayers`, `totalLayers` | Actual offloaded and total model layer counts, both positive and equal |
| `contextTokens` | Allocated total context, including prompt and output |

Each stdin line is a Chat Completions request with a numeric `id`, `messages`, `tools`, `tool_choice`, `max_tokens`
and the model's sampling fields. Each response echoes that `id`, with one `choices` entry containing `message`
and `finish_reason`. `usage` and `timings` remain optional and are recorded as unknown when absent. The first
response must have a structured `tool_calls` message. The caller accepts only `read_nonce` with empty arguments.
It supplies a fresh unpredictable nonce as that call's tool result. The second request retains every field of the
assistant message, including `reasoning_content`. Its response must end with `stop` and return that exact nonce.
Text resembling a tool call is never parsed or executed. A `length` finish is a failure.

EOF must unload the model, destroy its CUDA contexts, end every child and exit zero. The caller checks that the
runtime's process group is gone. On failure or SIGTERM it kills that group and waits. The helper's existing
run-user cleanup covers detached processes, hard termination, expiry and `hq run stop`. The machinery owner must
also demonstrate those helper-level paths with the real runtime before readiness is claimed. SIGKILL cannot
run caller cleanup. Expiry can collect the last saved report, but explicit stop skips output and file collection.
For each live stop or expiry check, first collect a pre-load baseline in an ordinary completed helper run on the
same machine and GPU kind. For example, from the repo root, with `inference` replaced by the provisioned kind:

```sh
hq run --kind inference --paths shared/inference --bring stop-before.xml -- sh -c 'nvidia-smi -q -x > stop-before.xml'
```

Confirm that file arrived before starting the termination trial, with no competing GPU run between measurements.
Retain the streamed stage markers with `hq run lines <id> > stages.log 2>&1` in the background from the moment the
run is sent (its warnings and the run's terminal outcome come on stderr), and the external `hq run stop` result
. For expiry retain
the external expiry outcome too. Once helper cleanup has completed, collect the post-stop snapshot in another
ordinary completed helper run on that same machine and kind:

```sh
hq run --kind inference --paths shared/inference --bring stop-after.xml -- sh -c 'nvidia-smi -q -x > stop-after.xml'
```

Compare the two brought XML files for per-card UUIDs, used/free memory and graphics/compute identities. Require
restored memory, no trial compute processes and preserved board-process identities. Streamed markers identify
stages only and cannot supply the baseline or full measurements. Retain full load/tool measurements from the
separate completed smoke run. Record the snapshot comparison as post-stop evidence, never as caller
`normalShutdown`. A missing external outcome or either collected snapshot leaves stop acceptance incomplete.

## Timing and memory evidence

The caller reads `nvidia-smi -q -x` before each model, every 250 ms during its lifetime, and after it exits.
It retains UUIDs, used/free memory and graphics and compute process identities. Every requested card must show
an allocation increase. The next model starts only when used memory is no higher, free memory is no lower and
the driver-visible process identities match the original snapshot. There is no unexplained tolerance or retry.
A desktop allocation change can therefore make this test inconclusive and fail it.

Each turn records caller `exchangeSeconds` from request serialization through the complete response read and
JSON decode, using a monotonic clock. It includes transport and runtime processing, and excludes report writes.
`toolSeconds` covers validation of the returned tool call, nonce generation and tool-result message construction.
It excludes both exchanges and report writes. These caller durations remain separate from runtime `timings`
and `usage`, which are retained unchanged or null when absent. Prefill and decode require the runtime's own
measurements. Caller exchange time cannot separate them or fill missing runtime measurements.

`peakUsedMiB` is the maximum sampled **whole-card** reading, not an exact allocator peak or memory attributable
solely to inference. A short allocation can fall between samples. `shutdownSeconds` measures EOF to process exit.
`releaseCheckSeconds` measures the final cleanup/check stage. Sum those two for the normal EOF-to-release-check
interval. Retain actual runtime buffer/offload measurements with this report. Driver process visibility can be
limited by the host, so this inventory alone does not prove that every host application stayed unchanged.

## Caller checks

```sh
python3 -m unittest discover -s shared/inference -p 'test_*.py'
```

The fixtures stand in for the external runtime and GPU driver. They check sequential loading, full reasoning
replay, missing pins, tool rejection, truncation, retained memory and a disappearing graphics process. A delayed
driver check holds each fixture allocation until the driver has sampled it. The fixture publishes shared state
by atomic replacement. Timing checks retain both caller durations and optional runtime measurements. Caller
SIGTERM interruption checks process-group cleanup. Hard caller termination during loading, inference, tool
handling and shutdown checks retained files and stage markers under HQ's line limit without a finalizer.
These fixtures do not exercise helper stop or expiry, load weights, exercise CUDA or establish compatibility
of a runtime build.

## OpenCode transport preparation


`coding.py` prepares a headless OpenCode caller using `provider.mjs`, a local AI SDK v3 provider. This is separate
from the runtime acceptance caller above. These scripts install no OpenCode distribution, Git toolchain or offline
dependency seed. The operator supplies reviewed tools and demonstrates the real OpenCode fixture before model use.

The caller owns the runtime, validates readiness and lends its stdin/stdout descriptors to OpenCode. The provider
reads and writes anonymous pipes. It imports no HTTP client, starts no proxy and executes no tools. OpenCode and
the provider remain trusted. The local `tools.mjs` plugin mediates candidate tool execution through `tools.py`.
Requests are serial, and auxiliary, concurrent and post-completion requests poison the session and leave failure
telemetry. The provider retains every original assistant message, including reasoning and unknown
fields, and restores it on the next turn. A changed or dropped history, unsupported media, unapproved tool or
non-success finish reason fails the run. It does not retry or repair model output.

The supported upstream extension points inspected are OpenCode's headless `run` in-process fetch and the provider
loader's `file://` SDK import. Pin the release, resolved commit and distribution integrity in company settings.
Pass that settings file and an owner-reviewed toolchain receipt. The receipt has `reviewed: true`, an `opencode`
object exactly equal to the settings, and a `sha256` map for `opencode`, `provider`, `git`, `home`, `tools.mjs`,
`tools.py` and `confinement.py`. The `home` digest checks `opencode-home.tar` beside the receipt. The receipt is review
evidence supplied by the owner, not a claim that a JSON boolean establishes approval. Preserve the actual review and artifact provenance outside the candidate.

The offline seed must contain only the pinned plugin package and its reviewed dependencies, package manifest and
lock at `.config/opencode/`. No credentials, sessions, extra plugins, personal config or previous candidate output.
OpenCode attempts a background dependency installation for a fresh writable config directory even when default
plugins are disabled. The owner must verify that its fully materialized seed avoids that path under NONET. Git and
all test dependencies must also be materialized through the reviewed owner flow, with actual versions and bytes
recorded. The scripts do not install or download them. No runtime or weight pin changes are required by the pipe
transport itself. Image or helper changes remain the machinery owner's work.

After that preparation, the caller's interface is:

```sh
python3 shared/inference/coding.py \
  --manifest <model-manifest.json> --model <one-model> \
  --settings <opencode-settings.json> --receipt <reviewed-toolchain.json> \
  --runtime /opt/inference/bin/chat --opencode <reviewed-executable> \
  --source <immutable-base.tar> --source-receipt <base.json> --revision <named-full-commit> \
  --workspace <fresh-source-snapshot> --prompt <candidate-only-prompt.txt> \
  --phase execution --report <outside-workspace/report.json>
```

The outer helper limit still bounds the entire run. The caller reuses readiness, per-card sampling, EOF unload,
process-group cleanup and release checks. It adds per-phase request/usage/failure records, raw runtime timings,
OpenCode wall time and tool durations/statuses from OpenCode's JSON events. Missing usage, timing or tool duration
stays unknown. Local equivalent USD stays null. External design/review usage and cost are separate phase
records. `--phase repair` identifies a separate repair run. Save streamed stage markers outside the helper as for
the acceptance caller. Never count this caller's fixture results as another CUDA or termination acceptance.

OpenCode receives a fresh seeded home and an allowlisted environment, including its preflight version probe.
It runs from that trusted home, outside the candidate repository. Project configuration, default plugins,
external skills, model catalog fetches, updates, snapshots, LSP and formatters are disabled. A fixed title avoids
an auxiliary title request. Compaction and subagent tools are disabled. The only enabled tools are the plugin's
`candidate_read`, `candidate_write`, `candidate_edit`, `candidate_bash`, `candidate_glob` and `candidate_grep`, selected
by settings' `tools` using the names without the prefix. Builtin tool execution is refused. The worker enforces
settings' `commands` patterns and executes one argument vector without shell interpolation. The bash tool lists
those patterns and refuses shell operators, substitutions and newlines as a whole. Refusals and input errors return
one plain line, without Python tracebacks or supervisor paths. No automatic commit step exists.

Read accepts a one-based `offset` and a `limit` (default 200, maximum 2000). It numbers lines and caps each
response at about one eighth of the manifest's `contextTokens`, estimated at four bytes per token.
`metadata.nextOffset` and a visible continuation notice identify the next page. Lines over 2000 characters are marked as truncated. Glob and grep
return at most 100 results within the same byte cap and tell the caller to narrow its search on truncation. Grep
reads at most 1 MiB per file and reports skipped binary, oversized or unreadable files. These search bounds keep
a broad query from consuming the context before an edit. Every tool and argument carries usage guidance.

The reviewed receipt also supplies `sandbox.readOnly`, an explicit list of absolute dependency paths, and
`sandbox.path`, the candidate command PATH string. The owner materializes these dependencies and records their
versions and bytes in the review. Include only the required executables, libraries and runtime configuration,
including the shell used by package scripts and Node's OpenSSL configuration where required. Do not include broad system roots, process
files, GPU devices, supervisor scripts, the runtime, OpenCode, evidence or immutable source archives. The caller
rejects dependencies overlapping its protected files or the candidate workspace. No host dependency directories
are granted automatically.

Every tool starts a fresh worker. Before it touches candidate input, the worker closes descriptors above stderr,
clears the supervisor environment, and applies Landlock filesystem restrictions plus a seccomp syscall allowlist.
Only the disposable source tree is writable. Approved dependencies are read-only. `/dev/null` is the sole implicit
device grant. Process tracing, process-memory access, pidfds, external signals, asynchronous signal ownership,
shared IPC, file attribute changes and process-group escape are denied. Socket creation and connection are denied,
with Unix socket pairs allowed for child IPC. The inherited NONET filter stays in force. Runtime pipes, provider
telemetry, policy files and evidence stay with the trusted supervisor and OpenCode, outside this boundary.
Post-candidate Git inspection uses the same boundary because candidate Git configuration can execute code.
Linux x86-64 and Landlock ABI 3 or newer are required. Missing confinement stops the run.

Before loading a model, `boundary.py` runs a deterministic `node --test` tool fixture that imports source from its
disposable tree. It verifies source writes, read-only dependency access, evidence and trusted-tooling denial,
symlink denial, closed inherited descriptors, supervisor process denial and blocked TCP/Unix connections.
The report retains `candidateBoundary` and a `candidate-boundary` stage. Failure prevents candidate inference.
This preflight does not replace the pinned OpenCode fixture or independent evaluator runs.

### Source exports and evaluator separation

`export.py --repository <repo> --revision <full-commit> --scope <scope.json> --archive <base.tar>` exports only
the exact file allowlist in `scope.json`'s `paths`. It reads committed blobs with Git, never the working tree. It
creates fresh Git tree/commit metadata around those original blobs. The scratch commit is explicitly synthetic,
not the original revision. Its receipt maps every path to its original blob and records both commit identities
and the archive digest. No original history, later object, excluded file, hook or remote is copied. Symlinks and
submodules are unsupported and refused. The deterministic archive is made read-only and retained outside candidates.

For each arm, the caller verifies the archive digest and named revision, creates a new workspace, unpacks it,
checks the initial Git state and rejects any object outside the fresh snapshot's reachable graph. The destination
must not already exist. Send only that arm's export and source provenance, approved prompt, rules and reviewed tools.
Do not send the original checkout, receipts containing evaluator scope,
reference fixes, holdouts, designs meant only for reviewers, another arm's output or evaluator instructions.
Keep holdouts in a distinct evaluator run after the candidate exits. Do not mount personal directories. Baseline
and candidate evaluation must use real Git and the same accepted test route, with changed-file scope checked
before execution. The caller rejects a changed HEAD or edits outside settings' `editablePaths`. It records tool
failures and command exit codes without treating a repaired tool failure as a failed final task. Actual formatter,
lint and type gates remain evaluator checks. Candidate patches remain experiment artifacts and cannot merge.

An experiment packet defines its evaluator environment, required checks and acceptance criteria separately.
Checks needing sockets or authenticated tools must remain outside the no-network inference container. A passing
transport fixture establishes neither evaluator readiness nor candidate acceptance. Keep evaluator material outside
candidates and retain actual outcomes without substituting component checks for required evaluation.

### Focused checks

The `test_provider.py`, `test_export.py`, `test_coding.py` and `test_tools.py` fixtures exercise real anonymous pipes, full reasoning
and opaque-field replay, truncation and lane rejection, a deterministic scoped Git snapshot with unusual paths,
the shared caller lifecycle using a CLI stand-in, and real plugin/worker file/edit/test execution under the OS
boundary. They do not execute OpenCode. Run the standard caller check
command above. To validate a pinned OpenCode installation, additionally demonstrate real read/edit/test work
against a deterministic fake runtime under NONET, its offline isolated home, a denied tool and retained failures.
Evaluator readiness and comparison procedures belong in the experiment packet.

`fixture.py` supplies the real OpenCode read/edit/test check once the reviewed executable and offline seed exist:

```sh
python3 shared/inference/fixture.py --opencode <reviewed-executable> \
  --settings <opencode-settings.json> --receipt <reviewed-toolchain.json> --report <fixture-report.json> \
  [--case positive|denied-command|unapproved-tool|truncation|auxiliary]
```

Run it under the real NONET boundary. It first verifies the candidate OS boundary, then uses deterministic stdio
replies to drive OpenCode's mediated `candidate_read`, `candidate_edit` and `candidate_bash` tools. It checks an
arithmetic test fails before and passes after the edit, and verifies full message replay and exactly four requests. No weights or CUDA runtime start. Its token counts and timings are synthetic fixture
fields, explicitly not performance measurements. The other cases are the route's refusals, each scripted the same
way, and pass when the route refuses and the fixture stays unrepaired: a command outside the allowlist (the
confined worker turns it into a tool error), a tool the settings don't expose, a `length` answer, and OpenCode's own
session-title request beside the task (`coding.run_opencode(..., auxiliary=True)` lets it ask, which only this
fixture does). The refused cases keep the provider's failure in their report. It does not replace an experiment
packet's evaluator checks.
