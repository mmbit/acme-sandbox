#!/bin/bash
# Whether HQ is up after a deploy (sync.sh): its coordinator answers /health, and its page assembles (page, below). A coordinator that restarts meanwhile
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
# Then HQ's page in every look (platform/coordinator/src/pagecheck.ts), asked with the worker's token from inside the
# coordinator's container: /health answers all the same when the page's code doesn't load (a module that doesn't link, a
# script answered 404). Only its problems fail the deploy. Its notes (another page error, a slow start) go in the log; a
# check that didn't run (a coordinator from before it, no Chromium, no answer) says so and fails nothing.
page() {
  $COMPOSE exec -T coordinator node -e "
    fetch('http://localhost:'+(process.env.PORT||8080)+'/health/page', { redirect: 'manual',
      headers: { authorization: 'Bearer ' + process.env.WORKER_TOKEN }, signal: AbortSignal.timeout(300000) })
      .then(r => r.status === 200 ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(c => {
        for (const p of c.problems) console.log('HQ: ' + p);
        for (const n of c.notes) console.log('HQ (a note): ' + n);
        if (!c.problems.length) console.log(c.checked ? 'HQ: its page assembles in every look' : 'HQ: no page check (no Chromium)');
        process.exit(c.problems.length ? 1 : 0);
      }, e => console.log('HQ: no page check (' + e.message + ')'))"
}
for ((waited = 0; waited < limit; waited += 5)); do
  answers && { echo "HQ: up after ${waited} s"; page || { echo "HQ: its page doesn't assemble for the board"; exit 1; }; exit 0; }
  [ "$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null)" = "$restarts" ] ||
    { echo "HQ: the coordinator crashed at its start (it restarted)"; exit 1; }
  sleep 5
done
echo "HQ: no answer from the coordinator in ${limit} s"
exit 1
