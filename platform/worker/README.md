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
