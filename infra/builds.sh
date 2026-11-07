# Build services independently and keep a service whose build failed, and its partner, on their current image through
# every Compose up.
# Sourced by sync.sh (`. infra/builds.sh`), never run: needs $compose and jq, and makes $kept, a folder with one file for
# each service kept on its current image: its first line says why, and a failed build's output tail follows. The caller
# removes it.
kept=$(mktemp -d)
declare -A built=()
deploy_services=()

# Before each bring_up: a go-back builds its own checkout afresh.
reset_builds() { built=() deploy_services=(); rm -f "$kept"/*; }

is_kept() { [ -e "$kept/$1" ]; }

build_service() {
  local service=$1 log status
  [ -z "${built[$service]:-}" ] || return "${built[$service]}"
  log=$(mktemp)
  $compose build "$service" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  built[$service]=$status
  if [ "$status" != 0 ]; then
    # Keep diagnostics visible beside Docker's long failed RUN recipe in the report.
    { echo "its build failed (exit $status), its output ends:"; cut -c 1-500 "$log" | tail -c 2000; } > "$kept/$service"
    echo "$service: build failed (exit $status), keeping its current container and image"
  fi
  rm -f "$log"
  return "$status"
}

# The worker calls the coordinator's endpoints, so the two move together: one whose build failed keeps the other on its
# current container and image as well. Each one's tag goes back to the image it's running (the partner's own build moved
# its tag, and a build of the failed one that never reached its up may have moved that one's), so a recreate outside a
# deploy (sync.sh's new GitHub token) keeps the two together too.
keep_pair() {
  local service container image tag
  is_kept "$1" && ! is_kept "$2" || return 0
  echo "it moves with $1, whose build failed" > "$kept/$2"
  echo "$2: built, but kept on its current container and image with $1, whose build failed"
  for service in "$1" "$2"; do
    container=$($compose ps -q "$service") || return 1
    [ -n "$container" ] || continue
    image=$(docker inspect -f '{{.Image}}' "$container") || return 1
    tag=$(docker inspect -f '{{.Config.Image}}' "$container") || return 1
    docker tag "$image" "$tag" || return 1
  done
}

build_services() {
  local configuration service
  configuration=$($compose config --format json) || return 1
  for service in $(jq -r '.services | to_entries[] | select(.value.build) | .key' <<< "$configuration"); do
    build_service "$service" || true
  done
  keep_pair coordinator worker && keep_pair worker coordinator || return 1
  deploy_services=()
  for service in $(jq -r '.services | keys[]' <<< "$configuration"); do
    is_kept "$service" || deploy_services+=("$service")
  done
}

up() {
  local service
  local -a options=() services=()
  for service in "$@"; do
    if [[ $service == --* ]]; then options+=("$service")
    elif ! is_kept "$service"; then services+=("$service"); fi
  done
  # options alone (up --remove-orphans): every service not kept
  [ "$#" != "${#options[@]}" ] || services=("${deploy_services[@]}")
  [ "${#services[@]}" != 0 ] || return 0
  # Retry once: containers releasing ports can race with new ones claiming them.
  # Explicit services and --no-build prevent Compose from building or recreating a kept service implicitly.
  $compose up -d --no-deps --no-build "${options[@]}" "${services[@]}" ||
    { sleep 5; $compose up -d --no-deps --no-build "${options[@]}" "${services[@]}"; }
}
