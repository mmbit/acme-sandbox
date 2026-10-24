#!/bin/bash
# Keeps the voice line's timing lines (the board's calls: which model, and how long each reply's first words took) in
# a file of their own, because the voice container's log starts afresh when a deploy recreates it. The timing lines
# only, nothing said on a call. Also how HQ played the voice, at hang-up (numbers only). sync.sh runs this before every
# deploy and report.sh before every status report, so a call between the last report and a deploy is kept too.
# And HQ's timeline of the playback (numbers only), to line a call that sounded wrong up with the replies'
# times. And each turn's tokens and thinking from the call agents' own session records (platform/voice/turns.py, numbers
# only), which the voice line logs as each session ends, then deletes (server.py forget).
# And the browser and system each call came from, and how loud the agent's own voice came back in the board's microphone
# (numbers only). And how late the board's audio reached the line, by HQ's pings, and how many of its pauses sounded
# finished. And, on a care call, where each reply's wait went and when the
# reply's language changed. And each time HQ's connection came back mid-call.
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
