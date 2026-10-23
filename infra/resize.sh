#!/bin/bash
# Resizes the server to the first available type listed in infra/server-type (the board approves each
# change: it costs money). Types that would cost more than MAX_EUR a month (gross) are skipped, so the hosting
# cap in company/BUDGET.md holds. Shuts the server down cleanly, changes the type (keeping the disk as it is, so
# a later downgrade stays possible) and starts it again: a few minutes offline. Running jobs pick up where they
# left off. A disk kept smaller than its type includes grows to that size once infra/server-disk says "grow" (the
# board approves it too: no smaller type fits afterwards); the type and its price stay. Needs: HCLOUD_TOKEN.
set -euo pipefail
# company/infra.env read as data (infra-env.sh), never sourced
. "$(dirname "$0")/infra-env.sh"
API=https://api.hetzner.cloud/v1 NAME=$SERVER
TYPES=$(cat "$(dirname "$0")/server-type") DISK=$(cat "$(dirname "$0")/server-disk" 2>/dev/null || true) MAX_EUR=${MAX_EUR:-35}
api() { curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" ${3:+-d "$3"}; }
wait_for() { # action id
  for _ in $(seq 1 120); do
    status=$(api GET "/actions/$1" | jq -r '.action.status')
    [ "$status" = success ] && return 0
    [ "$status" = error ] && { api GET "/actions/$1" | jq -c '.action.error'; return 1; }
    sleep 5
  done
  echo "Timed out waiting for action $1"; return 1
}

# shuts the server down cleanly (off by force after five minutes)
stop() {
  wait_for "$(api POST "/servers/$id/actions/shutdown" | jq -r '.action.id')"
  for _ in $(seq 1 60); do [ "$(api GET "/servers/$id" | jq -r '.server.status')" = off ] && break; sleep 5; done
  if [ "$(api GET "/servers/$id" | jq -r '.server.status')" != off ]; then wait_for "$(api POST "/servers/$id/actions/poweroff" | jq -r '.action.id')"; fi
}

server=$(api GET "/servers?name=$NAME" | jq '.servers[0]')
id=$(echo "$server" | jq -r '.id') current=$(echo "$server" | jq -r '.server_type.name') loc=$(echo "$server" | jq -r '.location.name // .datacenter.location.name')
disk=$(echo "$server" | jq -r '.primary_disk_size') full=$(api GET "/server_types?name=$current" | jq -r '.server_types[0].disk')
echo "$NAME is a $current in $loc with a $disk GB disk (the type includes $full GB); wanted, in order: $TYPES (at most EUR $MAX_EUR a month)"
for t in $TYPES; do
  [ "$current" = "$t" ] || continue
  # (only on a run someone started: one Hetzner refused isn't tried again every night, offline each time)
  if [ "$DISK" = grow ] && [ "$disk" -lt "$full" ] && [ "${GITHUB_EVENT_NAME:-}" != schedule ]; then
    echo "Growing the disk to the $full GB a $t includes (its type and price stay)"
    stop
    resp=$(api POST "/servers/$id/actions/change_type" "$(jq -n --arg t "$t" '{server_type:$t, upgrade_disk:true}')")
    action=$(echo "$resp" | jq -r '.action.id // empty')
    [ -n "$action" ] && wait_for "$action" || echo "Hetzner didn't grow it: $(echo "$resp" | jq -c '.error // .')"
    wait_for "$(api POST "/servers/$id/actions/poweron" | jq -r '.action.id')"
    now=$(api GET "/servers/$id" | jq -r '.server.primary_disk_size')
    echo "$NAME is running with a $now GB disk."
    [ "$now" -gt "$disk" ] || exit 1
    exit 0
  fi
  echo "Already a $t: nothing to do."; exit 0
done

stopped=0
for TYPE in $TYPES; do
  price=$(api GET "/server_types?name=$TYPE" | jq -r --arg l "$loc" '.server_types[0].prices[] | select(.location == $l) | .price_monthly.gross' | head -1)
  if [ -z "$price" ] || awk -v p="$price" -v m="$MAX_EUR" 'BEGIN { exit !(p > m) }'; then echo "$TYPE: not offered here or over the cap (${price:-n/a})"; continue; fi
  echo "$TYPE: EUR $price a month"
  if [ $stopped = 0 ]; then stop; stopped=1; fi
  resp=$(api POST "/servers/$id/actions/change_type" "$(jq -n --arg t "$TYPE" '{server_type:$t, upgrade_disk:false}')")
  action=$(echo "$resp" | jq -r '.action.id // empty')
  if [ -n "$action" ] && wait_for "$action"; then break; fi
  echo "$TYPE: $(echo "$resp" | jq -c '.error // .')"
done
[ $stopped = 1 ] && wait_for "$(api POST "/servers/$id/actions/poweron" | jq -r '.action.id')"
now=$(api GET "/servers/$id" | jq -r '.server.server_type.name')
echo "$NAME is now a $now and running."
[ "$now" != "$current" ] || { echo "No wanted type was available."; exit 1; }
