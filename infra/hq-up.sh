#!/bin/bash
# Whether HQ is up after a deploy (sync.sh): its coordinator answers /health. A coordinator that restarts meanwhile
# crashed at its start, and one that answers nothing for HQ_UP_S hangs: either way the deploy didn't bring HQ up, and
# sync.sh goes back to the last good one. HQ_UP_S is ten minutes, far longer than a start takes (a minute or two for a
# deploy's migrations and the search model), as a hang keeps HQ down as surely as a crash. COMPOSE: the stack's compose
# command.
set -uo pipefail
limit=${HQ_UP_S:-600}
id=$($COMPOSE ps -q coordinator 2>/dev/null)
[ -n "$id" ] || { echo "HQ: no coordinator container"; exit 1; }
restarts=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null)
answers() {
  $COMPOSE exec -T coordinator node -e \
    "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
    >/dev/null 2>&1
}
for ((waited = 0; waited < limit; waited += 5)); do
  answers && { echo "HQ: up after ${waited} s"; exit 0; }
  [ "$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null)" = "$restarts" ] ||
    { echo "HQ: the coordinator crashed at its start (it restarted)"; exit 1; }
  sleep 5
done
echo "HQ: no answer from the coordinator in ${limit} s"
exit 1
