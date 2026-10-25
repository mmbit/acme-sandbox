#!/bin/bash
# Runs every minute on the server: pull the deploy branch and redeploy when it changed.
set -uo pipefail
cd "$(dirname "$0")/.."   # the server's checkout, /opt/<SERVER_NAME>
# The company's names on the server (company/infra.env), exported: compose.yaml finds the env file by SERVER_NAME
# company/infra.env read as data (infra-env.sh), never sourced
. infra/infra-env.sh
[ -n "${SERVER_NAME:-}" ] && [ -n "${AGENT_EMAIL_DOMAIN:-}" ] && [ -n "${AGENTS_EMAIL:-}" ] ||
  { echo "company/infra.env lacks SERVER_NAME, AGENT_EMAIL_DOMAIN or AGENTS_EMAIL; not deploying" >&2; exit 1; }
. /etc/$SERVER_NAME/env
state=/var/lib/$SERVER_NAME/deployed
mkdir -p "$(dirname "$state")"
compose="docker compose -f infra/compose.yaml -f infra/generated/products.yaml"

stack_env() { # what compose.yaml needs besides /etc/$SERVER_NAME/env; $1 = the commit it runs
  # HQ's address comes from infra/host. Without one, fall back to <ip-with-dashes>.sslip.io (maps to the IP).
  ip=$(curl -sf http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
  export PUBLIC_HOST=$(cat infra/host 2>/dev/null || echo "${ip//./-}.sslip.io") GIT_COMMIT=$1
  # Shared secrets between the coordinator and the worker, the voice line and this server's run helper (each only its
  # own), generated once on the server.
  for t in worker voice runs; do [ -f /etc/$SERVER_NAME/$t-token ] || (umask 077; openssl rand -hex 32 > /etc/$SERVER_NAME/$t-token); done
  export WORKER_TOKEN=$(cat /etc/$SERVER_NAME/worker-token) VOICE_TOKEN=$(cat /etc/$SERVER_NAME/voice-token) \
    RUNS_TOKEN=$(cat /etc/$SERVER_NAME/runs-token)
  # Each care deployment's phone token, the voice line's and that deployment's alone (its phone routes, products.py), as
  # the variable care_engines.py names: the deployments as products.py reads them
  local slug name token
  while read -r slug name; do
    token=/etc/$SERVER_NAME/care-phone-$slug-token
    [ -f "$token" ] || (umask 077; openssl rand -hex 32 > "$token")
    export "$name=$(cat "$token")"
  done < <(python3 infra/care_engines.py)
}

# Between deploys, the status report every 10 minutes so seats and requests stay visible. $1: the commit HQ runs.
report_between() {
  local stamp=/var/lib/$SERVER_NAME/reported log
  [ -z "$(find "$stamp" -mmin -10 2>/dev/null)" ] || return 0
  # report.sh's compose calls need the stack's variables too, or each one warns 7 times that they're unset.
  stack_env "$1"
  log=$(mktemp); echo "periodic report (no deploy); deployed $1" > "$log"; ./infra/report.sh "$log"; touch "$stamp"
}

# The coordinator's data volume: the board's keys (platform/coordinator/src/secrets.ts), its approval records
# (approvals.ts) and the payments signing key. Found by name, so also while the coordinator is stopped.
export HQ_DATA=$(docker volume inspect -f '{{.Mountpoint}}' infra_hqdata 2>/dev/null)
if [ -z "$HQ_DATA" ] && [ -s "$state" ]; then
  # Docker isn't answering, or the volume is gone: deploying now would read that as "no approvals" and take every
  # live product down to a preview. Wait for the next run.
  echo "coordinator data volume not found; not deploying" >&2
  exit 0
fi

# The coordinator's RUN_DIR (compose.yaml), its user's: the data volume's owner. A boot can start the coordinator before
# this runs, and Docker then makes the folder root's.
[ -z "$HQ_DATA" ] || { mkdir -p "/run/$SERVER_NAME-hq" && chown "$(stat -c %u:%g "$HQ_DATA")" "/run/$SERVER_NAME-hq" &&
  chmod 700 "/run/$SERVER_NAME-hq"; }

# A new server GitHub token from the desk phone (C1) goes into the env file and out of the key store. The two
# containers that use it are recreated, since env_file is only read at creation. Runs before the fetch, which
# may already need the new token. The value is never printed.
if [ -n "$HQ_DATA" ] && SERVER_ENV=/etc/$SERVER_NAME/env python3 infra/github_token.py adopt "$HQ_DATA/secrets/SERVER_GITHUB_TOKEN"; then
  . /etc/$SERVER_NAME/env
  stack_env "$(cat "$state" 2>/dev/null)"
  log=$(mktemp)
  { echo "new server GitHub token from the desk phone installed; recreating coordinator and worker"
    $compose up -d --no-deps --force-recreate coordinator worker; } > "$log" 2>&1
  ./infra/report.sh "$log"
fi

# The off-site backup's first run (infra/backup.py): minutes after the board's four keys are in, not the next night.
# Only while no backup has ever succeeded, and at most once an hour.
backup=/var/lib/$SERVER_NAME/backup/status.json
if [ -n "$HQ_DATA" ] && [ "$(ls "$HQ_DATA/secrets" 2>/dev/null | grep -cxE 'BACKUP_(R2_ENDPOINT|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|AGE_RECIPIENT)')" = 4 ] &&
   ! grep -qs '"ok_at"' "$backup" && [ -z "$(find "$backup" -mmin -60 2>/dev/null)" ]; then
  systemctl start --no-block $SERVER_NAME-backup.service 2>/dev/null
fi

# Each product's server errors for HQ's daily error scan (infra/app_errors.py, the coordinator's triage.ts): kinds only,
# never the logs' text, at most once an hour (the stamp is set first, so a failing run waits an hour too).
errors_tried="/var/lib/$SERVER_NAME/app-errors.tried"
if [ -n "$HQ_DATA" ] && [ -z "$(find "$errors_tried" -mmin -60 2>/dev/null)" ]; then
  touch "$errors_tried"
  timeout 300 python3 infra/app_errors.py "$HQ_DATA" >/dev/null || echo "app_errors.py failed: its next run, in an hour, reads from the same point" >&2
fi

# The stack's containers' states and restart counts for HQ's crash watch (infra/containers.py, the coordinator's
# crashes.ts), every minute
[ -z "$HQ_DATA" ] || timeout 60 python3 infra/containers.py "$HQ_DATA" || echo "containers.py failed" >&2

# No token in any URL or .git/config: git asks infra/git-credential.sh, which reads the env file at call time.
# Idempotent; also moves the first clone's token URL out of an older checkout.
git remote set-url origin "https://github.com/$REPO.git"
git config credential.https://github.com.helper "$PWD/infra/git-credential.sh"
# When the fetch began, for HQ's record of the deploy (infra/deploys.py): it has every merge from before then (taken
# after the fetch, a merge that landed while it ran would count as deployed).
fetched=${SYNC_FETCHED:-$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)}
git fetch -q origin "$BRANCH" || exit 1
# A rerun (below) deploys the commit the first run fetched, not a newer one its script never saw.
commit=${SYNC_RERUN:-$(git rev-parse FETCH_HEAD)}
# A commit whose deploy didn't bring HQ up (infra/hq-up.sh, below) isn't tried again: HQ stays on the last good one until
# a newer commit comes.
failed=/var/lib/$SERVER_NAME/failed
if [ "$(cat "$failed" 2>/dev/null)" = "$commit" ]; then report_between "$(cat "$state" 2>/dev/null)"; exit 0; fi

# Free-plan stand-in for branch protection: agents commit only on job branches, which reach main
# through merged pull requests. An agent commit directly on main's first-parent line is not deployed.
# Checked before the working tree changes: the timer runs this very file from the checkout, and the
# coordinator reads the checkout live, so a refused commit must never reach it.
last=$(cat "$state" 2>/dev/null)
if [ -n "$last" ] && git cat-file -e "$last" 2>/dev/null &&
   git log --first-parent --format='%ae%n%ce' "$last..$commit" | grep -q -E "(@${AGENT_EMAIL_DOMAIN//./\\.}|^${AGENTS_EMAIL//./\\.})\$"; then
  stack_env "$last"   # (report.sh runs below, and compose.yaml needs these variables)
  log=$(mktemp); echo "REFUSED $commit: agent commit pushed directly to $BRANCH (not via a pull request)" > "$log"
  [ "$(cat /var/lib/$SERVER_NAME/refused 2>/dev/null)" = "$commit" ] || { ./infra/report.sh "$log"; echo "$commit" > /var/lib/$SERVER_NAME/refused; }
  exit 0
fi
running=$(git rev-parse -q --verify HEAD:infra/sync.sh)
git reset -q --hard "$commit" || exit 1
# The timer runs this very file, and bash goes on reading the copy it opened, not the one the reset wrote: a deploy that
# changes sync.sh starts it again, once, so its own new steps run now.
[ -n "${SYNC_RERUN:-}" ] || [ "$running" = "$(git rev-parse HEAD:infra/sync.sh)" ] || SYNC_RERUN=$commit SYNC_FETCHED=$fetched exec bash infra/sync.sh
# The new checkout's company/infra.env, so this run's compose sees a value it changes (SEATS) rather than the one before
# the reset.
# company/infra.env read as data (infra-env.sh), never sourced
. infra/infra-env.sh
# Renders aren't in git (shared/demo/renders.mjs): each .render.json's file goes back into this checkout, from what jobs
# pushed (the worker's store, in the work volume) or git's history, before anything reads it. Every run: one pushed
# since the last can arrive without a new commit.
work=$(docker volume inspect -f '{{.Mountpoint}}' infra_work 2>/dev/null)
python3 infra/renders.py . "${work:-/nonexistent}/renders" "/var/lib/$SERVER_NAME/renders.json" || echo "renders.py failed: the renders stay as they were" >&2

# The worker's own code isn't in its image (platform/worker/supervise.py): it's staged in the work volume, code/<revision>
# named by its worker tree and capacity settings, with code/current pointing at the deployed one before the stack
# comes up. A deploy that changes only code or capacity settings reloads the worker's process (SIGUSR2 to the
# supervisor), not its container, and the jobs' processes go on: no render, test run or build is cut. The supervisor points code/running at the code it runs (hq
# follows that link, so a job's hq matches its worker and the coordinator deployed with it).
# The staged worker uses the image's pinned runtime packages.
# Rollback below can reset to a commit without infra/worker.sh.
# Load its staging function now so bring_up can use it on that checkout.
. infra/worker.sh

# (code/running is the supervisor's: a worker without one is older than it, and SIGUSR2 would end it)
worker_behind() { [ -n "$work" ] && [ -L "$work/code/current" ] && [ -L "$work/code/running" ] && [ "$(readlink "$work/code/running")" != "$(readlink "$work/code/current")" ]; }

# The branch to deploy is itself configured in git (infra/deploy-branch). Switch over when it changes.
# It ends up in a root-owned env file through sed, so only plain branch names are accepted.
want=$(cat infra/deploy-branch 2>/dev/null || echo "$BRANCH")
if [ "$want" != "$BRANCH" ] && [[ $want =~ ^[A-Za-z0-9._/-]+$ ]] && git ls-remote --exit-code -q origin "$want" >/dev/null; then
  sed -i "s|^BRANCH=.*|BRANCH=$want|" /etc/$SERVER_NAME/env
  exit 0   # the next run deploys from the new branch
fi

# Starting the company over (infra/reset.py): once for each id in infra/reset, and only when the board's own commit set
# it. The stack is stopped, the old data and job branches go to /var/lib/$SERVER_NAME/archive/<id>/, and the deploy
# below starts everything again on a new database. A run that fails leaves the data where it was and is tried again at
# the next run.
volume() { docker volume inspect -f '{{.Mountpoint}}' "infra_$1" 2>/dev/null; }
restarted=
reset=$(python3 infra/reset.py due); case $? in
  0) stack_env "$commit"; restarted=1; log=$(mktemp)
     { echo "starting the company over ($reset)"
       $compose stop worker voice coordinator &&
         HQ_DATA=$HQ_DATA WORK_DATA=$(volume work) VOICE_DATA=$(volume voice) SEATS_DATA=$(volume seats) \
         SERVER_ENV=/etc/$SERVER_NAME/env python3 infra/reset.py run "$reset"; } > "$log" 2>&1
     ./infra/report.sh "$log" ;;
  2) stack_env "$commit"; log=$(mktemp); echo "$reset" > "$log"; ./infra/report.sh "$log" ;;
esac
# The board's approval records take effect through products.py, so a new, changed or deleted one redeploys too,
# within a minute and without waiting for a commit. So do the support chat's keys, the Print API keys and the test model
# key (names, sizes and times only), which products.py puts in their containers'
# env, and company/infra.env's content: its new SEATS reach the worker only through a run of this file that reads it
# after the reset, and the run that brings the change is still the old sync.sh, already loaded: the changed fingerprint
# makes the next run deploy again. So do the kinds of run HQ takes (run-kinds.json, which the coordinator writes when
# org.yaml's kinds change: this server's run helpers are made from it, infra/run_helpers.py).
# (the Print API keys)
approved=/var/lib/$SERVER_NAME/approvals
approvals=$({ find "$HQ_DATA/approvals" -type f -printf '%f %s %T@\n'
  find "$HQ_DATA/secrets" -maxdepth 1 \( -name 'CARE_*' -o -name 'PRINTAPI_*' -o -name 'ANTHROPICEVAL_*' \) -printf '%f %s %T@\n'
  sha256sum company/infra.env "$HQ_DATA/run-kinds.json"; } 2>/dev/null |
  sort | sha256sum | cut -c1-64)
if [ -z "$restarted" ] && [ "$(cat "$state" 2>/dev/null)" = "$commit" ] && [ "$(cat "$approved" 2>/dev/null)" = "$approvals" ]; then
  report_between "$commit"
  exit 0
fi

# The office's records (platform/coordinator/src/office.paths: profiles and their archives, the decision log, briefs,
# the knowledge base's notes) run nothing, and the coordinator reads them from this checkout: a commit that changes only
# those since the last deploy is recorded as deployed, with no build, restart or report.
if [ -z "$restarted" ] && [ "$(cat "$approved" 2>/dev/null)" = "$approvals" ] && git cat-file -e "$last" 2>/dev/null &&
   ! git diff --no-renames --name-only "$last" "$commit" | grep -qvEf platform/coordinator/src/office.paths; then
  echo "$commit" > "$state"
  stack_env "$commit"; containers=$(mktemp)
  [ -z "$HQ_DATA" ] || { $compose ps -a --format '{{.Service}} {{.ID}}' > "$containers" 2>/dev/null &&
    python3 infra/deploys.py "$HQ_DATA/deploys" "$commit" "$fetched" 0 "$containers" < "$containers" >/dev/null; } ||
    echo "deploys.py failed: HQ hasn't heard of the deploy of $commit" >&2
  rm -f "$containers"
  exit 0
fi

stack_env "$commit"
# a deploy never cuts a live call. Recreating the voice container ends every call
# on it, so while the voice line has a call on (platform/voice/server.py keeps a file per live call in /data/live), the
# deploy waits: this runs again a minute later.
# A file over 3 hours old (a call's longest) doesn't count, so a line that hung can't hold deploys back for good.
# (never while going back to the last good deploy: HQ is down then, and every call with it)
on_call() { [ -z "${rolling_back:-}" ] && [ -n "$($compose exec -T voice find /data/live -type f -mmin -180 2>/dev/null)" ]; }
if on_call; then echo "deploy of $commit waits: a call is live on the voice line"; exit 0; fi
# The search model (platform/coordinator/Dockerfile): a build that couldn't fetch it goes on without it, and the layer
# cache would keep that for good (MEMORY_MODEL_TRY is part of its key). So while the running coordinator has no model,
# each deploy stores a new value, which fetches it again. Once it has one the value stays put, so the layer that
# fetched it stays cached: going back to an old value could hit a model-less layer from an earlier failed fetch.
tried=/var/lib/$SERVER_NAME/model-try
$compose exec -T coordinator test -d /app/models 2>/dev/null || date +%s > "$tried"
export MEMORY_MODEL_TRY=$(cat "$tried" 2>/dev/null)
# Without this every build gets a fresh provenance attestation, so unchanged images count as new
# and containers (including a busy worker) are restarted on every deploy.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
# Retry once: containers releasing ports can race with new ones claiming them.
up() { $compose up -d --no-deps "$@" || { sleep 5; $compose up -d --no-deps "$@"; }; }
# Each container's memory as compose.yaml declares it (mem_limit, memswap_limit), put on the running container as well:
# the kernel held "max" for the worker's swap on both servers although its memswap_limit has always matched mem_limit.
# Docker's cgroup is a systemd scope, and systemd writes its own value for swap (none set: "max") over Docker's whenever
# it re-applies the scope's settings, within minutes. So the limit goes to systemd too (set-property, for the scope's
# life), after docker update: both live, without a restart.
# Swap is taken away only when what the container holds itself (anon), swapped pages included, fits in its memory with
# 512 MiB to spare: otherwise those pages coming back in could end a job, and a later deploy tries again.
keep_limits() {
  local s mem swap id cg was held
  $compose config --format json | jq -r '.services | to_entries[] | select(.value.mem_limit and .value.memswap_limit)
    | "\(.key) \(.value.mem_limit) \(.value.memswap_limit)"' | while read -r s mem swap; do
    id=$($compose ps -q "$s") && [ -n "$id" ] || continue
    cg=/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$(docker inspect -f '{{.State.Pid}}' "$id")/cgroup")
    was=$(cat "$cg/memory.swap.max") && [ "$was" != $((swap - mem)) ] || continue
    held=$(( $(awk '$1 == "anon" { print $2 }' "$cg/memory.stat") + $(cat "$cg/memory.swap.current") ))
    if [ $((held + (512 << 20))) -gt "$mem" ]; then
      echo "$s: swap limit $was, not yet compose.yaml's: it holds $((held >> 20)) MiB of its $((mem >> 20)) MiB"
    else
      docker update --memory "$mem" --memory-swap "$swap" "$id" >/dev/null &&
        { [[ $cg != *.scope ]] || systemctl set-property --runtime "${cg##*/}" MemorySwapMax=$((swap - mem)); } &&
        echo "$s: swap limit $was, now $(cat "$cg/memory.swap.max") (compose.yaml's) with $((held >> 20)) MiB held"
    fi
  done
  return 0
}

# the containers before, so HQ's record of the deploy says which it recreated (infra/deploys.py).
# (a snapshot that failed leaves no file: deploys.py then records nothing, never every container as recreated)
before=$(mktemp); $compose ps -a --format '{{.Service}} {{.ID}}' > "$before" 2>/dev/null || rm -f "$before"
reloaded=
bring_up() {
  # harden.sh can restart Docker (a daemon.json setting it adds), which cuts a
  # call too, so a call that started since the check above makes the deploy wait as well
  { ! on_call || { echo "a call started on the voice line: the deploy waits for it to end"; false; }; } &&
  ./infra/harden.sh &&
    # a skipped SEATS or SEAT_MOVES line mustn't fall back to compose.yaml's default seats
    { [[ $INFRA_ENV_SKIPPED != *' SEATS '* && $INFRA_ENV_SKIPPED != *' SEAT_MOVES '* ]] ||
      { echo "company/infra.env: SEATS or SEAT_MOVES isn't a plain KEY=value line; not deploying"; false; }; } &&
    # the company's clock as HQ reads it, which products.py gives the products: published by this checkout's coordinator,
    # so the deploy that brings a change to it (or the clock itself) has it before any product does. A checkout from
    # before has no clock.ts, and its products.py reads none.
    { [ -z "$HQ_DATA" ] || [ ! -f platform/coordinator/src/clock.ts ] ||
      { $compose build coordinator && $compose run --rm --no-deps -T coordinator node src/clock.ts; }; } &&
    python3 infra/products.py --build-shared &&   # with HQ_DATA (above).
    # a call that started during the build waits too (on_call, above)
    $compose build &&
    { ! on_call || { echo "a call started on the voice line during the build: the deploy waits for it to end"; false; }; } &&
    # staged only now, so a worker restarting while the deploy waits keeps the code deployed with the coordinator
    stage_worker_code && worker_was=$($compose ps -q worker) &&
    # compose's up replaces every changed container before it starts any, so one slow stop (the worker's, up to 30 s)
    # keeps HQ and the shop down. The coordinator starts first, on its own, then the products, then the rest. Caddy holds
    # their requests meanwhile (infra/Caddyfile).
    products=$($compose config --services | { grep -E '^(product|preview)-' || true; } | tr '\n' ' ') &&
    up coordinator && { [ -z "$products" ] || up $products; } && up --remove-orphans &&
    # A changed Caddyfile is a new file, which the container's single-file mount doesn't see: recreate Caddy
    # then. Otherwise reload it for new or changed product sites (its generated/ folder is mounted whole).
    { $compose exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - infra/Caddyfile || $compose up -d --force-recreate caddy; } &&
    $compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile &&
    { [ -n "$work" ] || { work=$(volume work) && stage_worker_code; }; } &&
    # a worker whose container up kept (its image and settings the same) and whose code changed: its process reloads. A new
    # container started from the staged code already (and may not be listening for the signal yet).
    { [ "$($compose ps -q worker)" != "$worker_was" ] || ! worker_behind ||
      { echo "worker: new code, reloading its process (its jobs go on)"; reloaded=worker; $compose kill -s SIGUSR2 worker; }; } &&
    keep_limits
}
log=$(mktemp)
{
  echo "deploy $commit at $(date -Is)"
  ./infra/call-times.sh   # the board's call timings, before a recreated voice container starts its log afresh
  bring_up
} > "$log" 2>&1
deployed=$?
# A deploy that didn't bring HQ up (infra/hq-up.sh: the coordinator crashed at its start, or answers nothing) goes back
# to the last good deploy by itself, so a bad merge never keeps HQ down: that commit isn't tried again (above), and the
# report says so. One that stopped before the coordinator changed (a build that failed, a call that started) finds HQ
# up as it was, and is tried again at the next run, as before.
up=0; COMPOSE="$compose" ./infra/hq-up.sh >> "$log" 2>&1 || up=1
if [ "$up" != 0 ] && [ -n "$last" ] && [ "$last" != "$commit" ] && git cat-file -e "$last" 2>/dev/null; then
  echo "$commit" > "$failed"
  echo "HQ didn't come up on $commit: back to the last good deploy, $last" >> "$log"
  rolling_back=1
  { git reset -q --hard "$last" && . infra/infra-env.sh && stack_env "$last" && bring_up &&
      COMPOSE="$compose" ./infra/hq-up.sh; } >> "$log" 2>&1
  echo "back on $last: exit $?" >> "$log"
  deployed=1
elif [ "$deployed" = 0 ] && [ "$up" = 0 ]; then
  echo "$commit" > "$state" && echo "$approvals" > "$approved"
  deployed=$?
fi
echo "exit $deployed at $(date -Is)" >> "$log"
# The images a rebuild replaced go after every deploy, whether it worked or not.
# The build cache keeps the steps this deploy used, and loses the rest only past a budget, least recently used first.
# Every deploy builds every image ($compose build, above), so the steps today's
# images stand on are the ones used since this run started ($SECONDS), and keeping them costs the next deploy nothing:
# it builds only what changed. Pruning them too flipped every deploy (24 Oct, 13:25-13:59 UTC): the whole cache went
# under 15 GB free, the rebuild filled it straight back (15 GB), free space fell under the line again, and each deploy
# rebuilt every image and recreated every container, the worker included.
# The budget is a quarter of the disk, the cache's share, less whatever would leave under 10 GB free; under 10 GB the
# unused images go too. Only under 5 GB free, where HQ refuses outside files (storage.ts FLOOR) and a build may not
# fit, does the prune reach the steps this deploy used, oldest first, all of them if it must.
# Docker's own cache GC is off (harden.sh): it trims to about 10% of the disk, under what today's images stand on.
# The status report's "== disk" says what holds the rest.
# (buildx's builder prune says "Total:", the classic one "Total reclaimed space:")
cacheSize=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | sed -n 's/^Build Cache //p')
cacheSizeUpper=$(echo "$cacheSize" | tr a-z A-Z)
cacheBytes=$(numfmt --from=si "${cacheSizeUpper%B}" 2>/dev/null || echo 0)
freeBytes=$(($(df --output=avail -k / | tail -1) * 1024))
floorBytes=$((10 << 30))
cacheBudget=$(($(df --output=size -k / | tail -1) * 1024 / 4))
budgetReason="a quarter of the disk"
if [ $((cacheBytes + freeBytes - floorBytes)) -lt "$cacheBudget" ]; then
  cacheBudget=$((cacheBytes + freeBytes - floorBytes))
  budgetReason="$((floorBytes >> 30)) GB free"
fi
# (--keep-storage 0 is no budget at all)
[ "$cacheBudget" -ge $((1 << 20)) ] || cacheBudget=$((1 << 20))
oldImages=-f
[ "$freeBytes" -ge "$floorBytes" ] || oldImages=-af
keepUsed="--filter until=${SECONDS}s" keptNote="the steps this deploy used kept"
[ "$freeBytes" -ge $((5 << 30)) ] || keepUsed= keptNote="under 5 GB free: the steps this deploy used too"
oldImagesFreed=$(docker image prune $oldImages 2>&1 | sed -n 's/^Total reclaimed space: //p')
if [ "$cacheBytes" -le "$cacheBudget" ]; then
  echo "pruned after the deploy: old images $oldImagesFreed, build cache 0B (kept whole: ${cacheSize:-?})" >> "$log"
else
  cacheFreed=$(docker builder prune -af $keepUsed --keep-storage "$((cacheBudget >> 20))mb" 2>&1 |
    sed -n 's/^Total\( reclaimed space\)\{0,1\}:[[:space:]]*//p')
  echo "pruned after the deploy: old images $oldImagesFreed, build cache $cacheFreed (oldest first, of ${cacheSize:-?}," \
    "toward $((cacheBudget >> 20)) MB, $budgetReason; $keptNote)" >> "$log"
fi
./infra/report.sh "$log"
# HQ's record of the deploy, for the jobs that wait for one (hq job --when): after the report, so a job it starts finds
# this deploy's in hq report.
[ -z "$HQ_DATA" ] || $compose ps -a --format '{{.Service}} {{.ID}}' 2>/dev/null |
  python3 infra/deploys.py "$HQ_DATA/deploys" "$commit" "$fetched" "$deployed" "$before" $reloaded >/dev/null ||
  echo "deploys.py failed: HQ hasn't heard of the deploy of $commit" >&2
rm -f "$before"
