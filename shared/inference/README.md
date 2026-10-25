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
