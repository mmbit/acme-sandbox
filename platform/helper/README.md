# The run helper

The machines the board lends HQ for long headless runs: a simulation over many seeds, a sweep of variants, a film's
render. An agent sends one with `hq run` (platform/worker/hq/runs.ts). HQ keeps it until a helper asks for work (the
coordinator's `runs.ts`), and the helper runs it and sends back its output and the files it names. The board lends as
many machines as it likes, each on a key of its own (the coordinator's `machines.ts`), and the fastest free one takes a
run. Our server runs the same helpers as its own, one per kind (infra/run_helpers.py), for the runs no lent machine
takes.

Every run is of a **kind** the company declares in org.yaml's `runs.kinds`: its image, its caps, and whether it gets
the machine's GPUs. Each lent machine and our server run one helper per kind, each in its own container of the kind's
image, and each takes only its own kind's runs. A machine may leave a kind out (a laptop with no graphics card runs no
render helper). A new kind is a few lines of settings, never new code, and nobody at the machines.

## The flow

1. `hq run --kind <name> --paths <folders> --bring <paths> --minutes n -- <command>` packs the folders as the job's
   tree has them now (uncommitted changes and new files included, through an index of its own) or at `--commit`, and
   sends the gzipped tar to HQ with the command. `--kind` may be left out when one kind is declared. HQ refuses an
   unknown kind and lists the kinds. It waits, so an agent starts it in the background. `--with <files>` adds files git
   ignores (a film's music, a clip: renders) to the bundle.
2. Each kind's helper asks HQ for work every 10 s (`POST /api/helper/take`, with its kind, cores, memory, speed and
   load). HQ gives it the oldest waiting run of its kind whose job still runs and that it may take (below), under an id
   new with each take (the take's attempt: the run's id and the take's number, `57-2`): the helper's later calls for the
   run name it and its log lines print it, so HQ refuses a call from an earlier take of the run, the same helper's
   included. The helper fetches the bundle, unpacks it in a fresh workspace, and runs the command from the folder
   `hq run` was started in, under the run's time limit. It beats every 10 s, with its load and the run's new output. HQ's
   answer to a beat stops the run once its job stopped it, the job ended or another take has it.
3. The helper sends the last MB of output (stderr in with stdout), the `--bring` files as a gzipped tar and the exit
   code. Then it kills every process of the runs' user and removes all it left (below). `hq run` prints the output,
   unpacks the files into the tree and exits with the run's code (124 past its limit).

**The fastest machine first.** Machines differ a lot, so each helper times a short fixed piece of integer work as it
starts (the same code everywhere, a fraction of a second on a recent core). HQ keeps a machine's **speed** for each
kind: that timing on one core times the cores the kind's runs get there. A lent machine's helper takes a waiting run of
its kind unless a faster machine is free for it:

- a faster machine whose helper of the kind asked for work in the last 20 s and has no run of it takes the run on its
  next ask, so the slower one leaves it;
- while the faster ones are busy, the slower one takes it once the run has waited `runs.takeMinutes` (org.yaml), as this
  server's helper does;
- a faster machine that hasn't asked in 20 s (off, asleep, stuck) holds nothing up.

A machine the board paused takes no run and counts for none of this. A run a machine lost goes to this server's helper
(below).

**This server's helpers.** The machines may be off, asleep or stuck, so our server runs the same helper.mjs for each
kind, in a container of the kind's image (`run-helper-<kind>`, below: its key is the server's `RUNS_TOKEN`, made by
infra/sync.sh). The one of the run's kind takes it:

- at once, when no lent machine the board hasn't paused has a helper of the run's kind that asked for work or beat in
  the last 90 s (another kind's helper asking makes no difference);
- once the run has waited `runs.takeMinutes`, the machines' helpers of its kind busy or not taking it;
- when a machine's helper went quiet mid-run (no beat for 3 minutes), sent nothing back 20 minutes past the run's limit,
  started again mid-run (a helper that starts again loses only its own kind's run), or the board removed the machine.
  The run waits again for this server's helper of its kind alone, and anything the lent one sends for it later is
  refused.

**A kind held for the lent machines.** A kind with `serverAfterLent: true` keeps its runs off this server until a lent
machine's helper of it has finished one. Until then a run of it waits for the lent machines alone (one a machine lost
waits for them again), and `hq run` gives it up after `takeMinutes` with no machine's helper asking. From that first
finished run on, this server takes the kind's runs as above. `holdUntilLent` lists departments whose work (fix rounds
too) waits in the queue until then: `hq jobs`, HQ's projects view and the status report say so, and it starts by itself after
that run.

If it loses a run the same way, the run is lost and `hq run` says so (with `--fallback here`, it runs in the job). When
neither a machine's helper of the kind nor this server's has asked for work for `takeMinutes`, `hq run` gives the run up
and says so. HQ routes a run to helpers asking for its kind, on the machines or here. Unless `--fallback here` was given,
nothing of a run ever runs in the job itself. If `hq run` itself is stopped, `hq run <id>` waits for the run again and
`hq run stop <id>` ends it.

**Here, when no machine takes it**. `hq run --fallback here` runs the command in
the job itself, from the folder it would start in on the helper, its files written in the tree as they are: when HQ
declares no such kind, when no helper that may take it asks for work as it's sent or for `takeMinutes` after (a kind for
the lent machines alone included), or when a machine lost it. The command sees `HQ_RUN_HERE=1`, so a tool that sends
itself off (the demo kit's films) knows to run as it is. `--minutes` is the helper's limit alone.

**Files back into the tree.** `hq run` reads the tar itself (platform/worker/hq/unpack.ts). GNU tar unpacks it into an
empty folder of its own. From there, `hq run` takes regular files and folders inside the paths the run named, with
their executable bit and nothing more, each written as a new file. It never writes through a link in the tree.
Anything else is left out and named.

## Setting it up

The board keeps the machines in HQ's **Settings › Machines**, as it keeps the seats in Settings › Seats. Each row is a
machine with its state (taking runs, running one, away, paused), what it has (cores, memory, a GPU) and its speed next
to this server's. A machine's page shows it live (below), and has:

- **Pause**: its helpers take no new run and finish the one they have. They still beat and show live.
- **Rename**: the name the board gives it, which agents read too (`hq run` says which machine a run is on).
- **Install again**: a new key and the install command that carries it, shown once (the old key stops working). For a
  machine whose helpers were started by hand, or after `manager.mjs` changed.
- **Remove**: its key stops working at once, so HQ lets none of its helpers in. A run one of them had goes on on this
  server's helper. The page shows the command that clears the machine itself.

**Add a machine** takes its name. HQ makes its key (`helper_` and 43 random characters), keeps only its hash, and shows
the machine's **install command** this once, its key in it: a `docker run` for Docker on any x86-64 machine (Docker
Desktop on Windows with WSL2 included), pasted in PowerShell, cmd or sh alike. It runs `manager.mjs`, fetched from
`GET /api/helper/manager` and checked against the sha256 in the command, which saves the key in its volume (named for
HQ's host, at `/state`) and starts its own container, `<host>-manager`, with the Docker socket. From then on the
manager asks HQ every minute what the machine should run (`POST /api/helper/setup`: every kind with its image and caps,
and which helpers have a run) and keeps it so:

- a container per helper, `<host>-<kind>_<n>`, `helpers` of them per kind (1 unless the kind says more), each with the
  kind's caps and `--gpus all` for `gpus: true`, the helper as root and its runs as uid 1000, as below. A changed kind
  replaces its helpers once their runs end. Helpers of a kind HQ no longer has go, and so do helpers an old start
  command made by hand for the same HQ.
- the helpers' code follows HQ: each fetches `GET /api/helper/code` as it starts, with no hash, since a helper reaches
  nothing but HQ (below). Only the manager, which holds the Docker socket, is pinned: a changed `manager.mjs` needs
  Install again.
- everything is named for HQ's host, so one machine can lend itself to several companies' HQs.

The page's remove command (`MANAGER=remove`) takes all of it away again: the helpers, the proxy, the network, the
manager and the key. `hq run helper` prints the install command (without a key) and the remove command for an agent
setting a machine up with the board. Only the board adds a machine or sees its key.

(The key command and per-kind start commands of a machine set up by hand still work, and `GET /api/machines/setup`
still lists them, but the screen shows only the install command: a hand-started helper can't take a kind whose runs
keep their sockets.)

At HQ's start, a key still saved on a desk-phone card for `RUN_HELPER_KEY` becomes the first machine: named as
org.yaml's `runs.helper` names it, its key kept by its hash, the key's file deleted, and its runs its own. No card asks
for that key.

## Live

Each helper reads its machine's load whenever it asks for work or beats: CPU in use since its last reading
(`/proc/stat`), memory in use (`/proc/meminfo`) and, where the kind's container has a GPU, its use and name
(`nvidia-smi`, only when the image has it, cut off after 2 s). Inside a container these are the machine's own. A beat
also carries the run's output since the last one, up to its last whole line, at most 4 KB (the last MB still goes back
whole at the end).

HQ keeps the latest readings and five minutes of them, and each running run's last 100 lines, each cut at 300
characters with any key in it redacted. None of it is stored, so a restart starts them again. Only the board's HQ sees
them: `GET /api/machines` and the org's read (each machine, then this server: `{ id, name, state, speed, cpus, memoryGb,
gpu, kinds, paused, added, seen, run?: { kind, job, agent, title, since, cores }, live?: { cpu, mem, gpu?, history:
[{ at, cpu, mem, gpu? }], lines } }`), and the `machines` event on HQ's feed as they change, at most every 2 s, so a page
redraws without polling. The lines are an agent's command's output: HQ shows them as text, never as markup.

Every look draws the rig from the same list (HQ's world.js): the lent machine at work (the fastest of those), else the
fastest. Wire draws a key for each lent machine that's on, taking runs or running one: how long it's been computing,
a light for each of its run's cores, and big, its use over the last minutes and its run's last lines.

## What the helper can reach

The container connects out to HQ over HTTPS and nowhere else. On a machine set up with its install command it sits on
a Docker network of its own with no route out (`internal`), and its one way out is the manager's proxy, which opens a
connection (CONNECT) to HQ's host and the package registries only (`registry.npmjs.org`, `pypi.org`,
`files.pythonhosted.org`: `FIXED` in manager.mjs, which HQ can't change), never to a private address, whatever a name
resolves to. Every run is code from our own repo, but the sandbox
assumes it could be hostile:

- **No port or host workspace.** It publishes nothing (`-p` never appears). Its mounts are the helpers' Docker volume
  (`/state`: the key) and two in-memory folders (`/tmp` for its code, `/work` for the runs). A kind with `gpus: true`
  also exposes GPU devices and host driver files through Docker's GPU runtime (`--gpus all`). Its runs share the GPUs
  with the machine's other programs. It mounts no personal folders or host workspace.
- **No privileges.** `--cap-drop ALL` gives back only SETUID and SETGID, so the helper (root in the container, with no
  other capability) can start runs as another user. `no-new-privileges`, a read-only image, and caps on CPUs, memory,
  `/work`'s size and the number of processes.
- **Runs as another user, with no network.** Every run's process belongs to uid 1000, so it can't signal, trace or read
  the helper or its key. Its environment holds `PATH`, `HOME`, `TMPDIR` and `LANG` only. A seccomp filter
  (`NONET` in helper.mjs, set with Perl's `syscall` before the command starts, kept across every exec and fork) refuses
  every socket but a Unix one, connecting and io_uring. It goes on while the process is still root, before it becomes
  uid 1000, so no process of the runs' user is ever unfiltered. So a run reaches no address at
  all: not HQ, the machine, its local network or the internet. The filter accepts x86-64 calls only, and the helper
  refuses to start on another architecture.
- **A kind whose runs keep their sockets** (`sockets: true`, a push's tests, which start local servers) runs without
  that filter, on the machines set up with their install command alone: HQ gives its runs only to a helper that says
  it's on the manager's network (`locked`), never to this server's or one started by hand. So a run reaches what its
  helper does: its own loopback, HQ and the registries through the proxy, for its packages (cached in the helper's
  `/cache`, which npm and a wheel's pinned hash check), and nothing else.
- **Nothing left behind.** When the command ends, or its time runs out, `kill(-1)` as uid 1000 ends every process the
  run started (detached ones too), and `--init` reaps them, all before its files are packed. A run that outlives it
  (stopping or ending the process that sends it) stops the helper after a few seconds, and Docker's restart ends it. The
  files are packed as uid 1000 with no network. A `--bring` path behind a link (the workspace, the tree or a folder on
  the way) is left out. A beat still under way is cancelled, so HQ's late "stop" for a run never reaches the next one.
  Then everything uid 1000 left goes: the work folder's contents, its files in `/dev/shm` and `/dev/mqueue` (POSIX
  shared memory and message queues, folders it locked included) and the System V IPC objects it created. These are the
  container's own.
  If any of it can't be removed, the helper stops, and Docker's restart clears it before another run. Runs cannot write
  to `/tmp`, which holds only the helper's code.
- **No secret but its key.** HQ sends the command, the folders named and the paths to bring back. What goes the other
  way besides the run's results is its machine's load and the run's newest output, which only the board's HQ shows. A job's environment
  (its test keys) stays here: the bundle is files from the tree only. Our secrets are never in the tree.
- **HQ is the only one it trusts.** On a machine set up by hand, the helper's code is pinned by its hash in the start
  command. With the manager, the manager's code is pinned (it holds the Docker socket) and the helpers' follows HQ: a
  compromised HQ could send hostile helper code or a hostile run, and either stays in the locked container, on a
  network that reaches HQ and the registries alone. It can't change the manager, the network or the proxy's hosts.

The helper needs SETUID and SETGID to change user, and a run as the helper's own user could read its key. Docker's own
seccomp profile still applies under the filter, with user namespaces refused. A run reaches no address: not Docker's DNS, the WSL2 VM, the Windows host or
its network. It can read what any container sees of the machine (CPU, kernel, memory), which comes back only to the job.
The code with the network is pinned, but the image's node and perl run it too: HQ can't swap either, but a kind's image
is trusted like the code, so pin a kind's image by digest when it isn't an official one. A kind's image may be private on
GitHub's registry (ghcr.io): the manager asks HQ for the sign-in at each pull (`POST /api/helper/pull`, with its key), and
HQ gives it from its own key, `REGISTRY_GHCR_TOKEN` (read:packages alone), for an image one of its kinds names and
nothing else; the machine passes it to Docker for that pull and never keeps it. Without the key, HQ puts a card for it
on the desk phone and the pull waits. A kind with `gpus: true` puts
the GPU driver in reach of its runs: it gets a read of its own before it's declared. On a new Docker host, check the flags before any real run
(uid 1000, no capabilities, seccomp on, no socket but a Unix one, no key).

The helper's own requests carry its key (`Authorization: Bearer`). HQ finds its machine by the key's hash, or compares it
in constant time with this server's. A helper reaches only the runs its machine holds. The agent routes (`/api/agent/runs*`) are inside Docker
only, like all of `/api/agent/` (infra/Caddyfile).

This server's helpers run the same way. infra/products.py writes one compose service per kind into
infra/generated/products.yaml (infra/run_helpers.py), each `run-helper-<kind>`, for the kinds HQ takes: the coordinator
writes their names and images to run-kinds.json in its data volume when org.yaml's kinds change, and the server deploys
again within a minute or two. Each is built by platform/helper/Dockerfile on the kind's image with the same user and
entrypoint the start command gives, so a run that falls back here has its kind's tools. Each helper runs one task at a
time, and different kinds can run together. Whatever the kind asks for on the lent machines, each has the server's caps
(4 CPUs, 3 GB with a 1 GB `/work`) and no GPUs: a run that needs more than that, or a graphics card, is slow here or
fails with its own error. They read and send their load as the machines' helpers do, and show as "This server" in
`GET /api/machines`.
Their only network is an internal one shared with the coordinator alone, so they don't reach the internet either. A
kind's image is pulled onto the server at the next deploy, so a big one (a render kind's) takes its disk too. Every
kind's image can read the shared server key and request runs of any declared kind. The image must be trusted with
all those runs, just as each image on a lent machine must be trusted with that machine's shared key.

## Limits

org.yaml's `runs:` sets them. `helper` names the lent machines where agents read them, and the first machine. `maxMinutes` is the longest run, and
`takeMinutes` how long a run waits to be taken. `browser` names the kind HQ's browser harnesses send their renders to
(shared/browser/README.md, "Heavy renders"; `render` when it names none, left out when it isn't a kind's name, and the
harnesses stay on the worker). `kinds` maps each kind's name to its settings:

- `about`: a line on what the kind is for, shown in `hq run helper` and HQ's refusals;
- `image`: the kind's Docker image (default `node:24.22.1-slim`);
- `cpus`, `memoryGb` and `diskGb`: positive whole numbers for its container's caps (default 4, 8 and 16);
- `gpus`: `true` gives its container the machine's GPUs;
- `lentOnly`: `true` gives this server no helper of it: its runs wait for the lent machines alone;
- `serverAfterLent`: `true` keeps its runs off this server until a lent machine has finished one (above);
- `holdUntilLent`: org.yaml department ids whose work waits in the queue until then.

A name is `a-z`, `0-9` and `-`, starting with a letter, at most 24 characters. An image is a plain Docker reference
(`a-z`, `0-9` and `. _ / : @ -`, digests allowed), since its start command is pasted into PowerShell, cmd and sh
alike. A kind that breaks a rule is left out, and `hq run helper` says why. A company that declares no `kinds` has one,
`default`, with every default. In the platform: a bundle of 100 MB, 200 MB of files back, one MB of output, 4000
characters of command, one run at a time per helper.
A run's files on HQ go two days after it ends, its bundle as soon as it ends.
Files brought into a job are limited to 1 GiB unpacked and 100,000 entries.

## Adding a kind

1. Pick or build an image for x86-64 Linux with what the helper needs itself: node 22 or later, perl, tar, find and sh
   (any Debian-based node image has them). A helper whose image lacks one stops at its start and says which. Trust the
   image as well as the helper code: every kind can read its machine's key. Prefer an image pinned by digest
   (`name@sha256:...`) so an image update cannot silently change its programs.
2. Add the kind under `runs.kinds` in org.yaml, with its caps and, for work on a graphics card, `gpus: true`. Kinds run
   at the same time, so their CPU and memory caps must fit the machine's budget together, with headroom for its owner.
   Each kind also adds a 4-CPU, 3 GB helper on the server. Budget those helpers together with its other services.
3. Once that's on main, each machine's manager starts its helpers within a minute, with nobody at the machine. The
   next deploy starts this server's helper of the kind (none for `lentOnly` or `sockets`). Agents send its runs with
   `--kind <name>`.

The `tests` kind is the push's own: while a lent machine has a helper of it, the worker sends each push's tests and
gates there (shared/gates/tests.ts and gates.ts `--helper`, through lent.ts: the repo at the base and as pushed in a
git bundle, run by tests-on-helper.sh), with no turn, and runs them on the server only when no helper takes them in
time. The gates go only when their type check runs and the change has no `.render.json`. A render check needs files
and history outside the bundle. The tests that passed come back as the run's file, for the worker to count.

A render kind, for example, takes an image with ffmpeg, Chromium and the fonts the films use, and `gpus: true`.
Chromium inside a run's sandbox needs `--no-sandbox`: its own sandbox needs namespaces the container doesn't give. No
GPU kind has been declared yet, so `--gpus` is untested. This server's helper of the kind has its tools but no GPU, so
a run that needs one there fails with the command's own error, or renders on the CPU where the tool can.

## Checks

`node --test src/runs.test.ts` in platform/coordinator:

- with no lent helper, this server's takes a run that can't reach HQ's port or see the job's token. Its files come
  back once its processes ended, never from behind a link, and nothing is left behind;
- a key saved on a card for `RUN_HELPER_KEY` is the first machine's, and its helpers are still let in;
- the helper its own start command starts (the bootstrap as pasted, outside a container, as the test's own user, on the
  key its key command saved) takes a run that can't reach HQ's port, brings its file back and leaves nothing behind,
  and the board sees its machine live meanwhile: its speed, load, run and the run's output;
- a quiet lent helper hands its run to this server's, and a quiet server's helper loses it;
- this server's helper waits `takeMinutes` while the lent one asks for work;
- with two lent machines of different speeds and this server: the slower leaves a run while the faster is free, takes
  it after `takeMinutes` while that one is busy and at once once it stopped asking, and a paused one takes none;
- a machine's readings and its run's output reach `GET /api/machines` and the `machines` event: its load and its
  history, the last 100 lines as text, cut short, keys redacted, and none of it in what agents read;
- the board adds, renames, pauses and removes machines (a taken or empty name refused), and a removed machine's key
  stops working and its run goes to this server;
- of a kind with `serverAfterLent`, this server's helper takes nothing before the lent one has finished a run, a run
  the lent one lost waits for it again, and after its first finished run this server's takes the next as usual. The
  departments in `holdUntilLent` start no work, a fix round included, until then. When the lent helper takes a run
  again, its earlier take's bundle, beat, output and finish are refused, an upload under way included, and lift no hold;
- a helper's files come in only inside the paths named, never as links or through one, read as GNU tar reads them
  (a pax global header included);
- a run is its job's alone;
- with two kinds declared, a helper of one kind never takes the other's run, on the machine or this server, a run whose
  kind has no helper there goes to this server's of its kind at once while another kind's helper asks, and a helper
  that starts again loses only its kind's run;
- with the machine's helper of a kind away, a run needing a tool only that kind's image has (a stand-in for ffmpeg)
  completes on this server's helper of the kind, and fails on another kind's;
- a run or a helper naming no kind among several, or an unknown one, is refused, and the kinds are listed;
- each kind's start command has its image and caps, `--gpus all` only with `gpus: true`, and the shared key volume. A
  kind that breaks a rule is left out, and `hq run helper` says why;
- two kinds' helpers started on one volume before the key command wait for it, and both are let in;
- as root only, the runs as a uid and gid no account or process has: a run as another user can't signal a process
  outside it, and a detached process it started ends with it. The next run finds none of a run's IPC state, and a
  late "stop" for a run that ended doesn't reach it.

`python3 infra/test_products.py`: this server's helpers, one per kind the coordinator publishes (run-kinds.json in its
data volume, written by runs.ts from org.yaml, so it has one reader: with the coordinator's packages installed, the test
goes from org.yaml through it), each built on its kind's image with the server's caps, sandbox and network, and no GPUs.
