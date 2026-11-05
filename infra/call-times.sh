#!/bin/bash
# Keeps the voice line's call timing lines (models, reply waits, playback, echo, the board's audio, each session's turns)
# in a file of their own, because the voice container's log starts afresh when a deploy recreates it. Never what was
# said on a call. sync.sh runs it before every deploy and report.sh before every status report.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)   # the server's checkout
# company/infra.env read as data (infra-env.sh), never sourced
. "$root/infra/infra-env.sh"
compose="docker compose -f $root/infra/compose.yaml -f $root/infra/generated/products.yaml"
times=/var/lib/$SERVER_NAME/call-times.log; touch "$times"
{ $compose logs --no-color --timestamps voice 2>/dev/null |
    grep -E -e ' call: [a-z]+ (on [^ ]+ \([a-z]+ effort\)(, briefing [0-9]+ bytes)?$|\([a-z]+\) dialled( from [A-Za-z ]+)?$|picked up in |replied(, first words after | with no words, done after )|reply timed: |hung up; HQ played [0-9]+ frames |playback, timed: |echo: |line: the board.s (audio came |pauses: )|reconnected$)' \
      -e ' [0-9TZ:.-]+ call: session [0-9a-f]+ turn ' -e ' call: [a-z]+: the reply is in [a-z]+' |
    sed -E -e 's/^[^|]*\| //' -e 's/^[0-9TZ:.-]+ ([0-9TZ:.-]+ call: session )/\1/'   # (a turn's line goes by its own time)
  true   # (no new line must not stop the kept ones being written back: pipefail)
} | sort -u - "$times" > "$times.new" && mv "$times.new" "$times"
