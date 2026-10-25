#!/bin/bash
# Runs a company's own hq command, kits/<kit>/hq-<command>.sh (kits.ts), in bash with the helpers it may use:
#   get <route>, api <route> <json>    /api/agent/<route>, failing on an answer of 400 or more
#   post <route>                       the JSON body on stdin; prints the answer and, on its last line, the HTTP status
#   get_unless_refused <var> <route>   a read HQ may refuse: a refusal stops with HQ's reason
#   uri <text>                         the text for a URL
#   auth                               curl's config with the job's token, for a call of its own: curl -K <(auth)
# The token never goes on a command line (any uid can read /proc/<pid>/cmdline): printf is a builtin, and curl reads
# it as a config on a pipe. Usage: kit.sh <file> <command> [arguments...], where the command is $1 to the file.
set -euo pipefail
auth() { printf 'header = "authorization: Bearer %s"\n' "$HQ_TOKEN"; }
api() { curl -sf -K <(auth) -X POST "$HQ_URL/api/agent/$1" -H "content-type: application/json" --data-binary @- <<<"$2"; }
get() { curl -sf -K <(auth) "$HQ_URL/api/agent/$1"; }
post() {
  curl -s --max-time 30 -K <(auth) -w '\n%{http_code}' -X POST "$HQ_URL/api/agent/$1" \
    -H "content-type: application/json" -H "x-hq-wait-ms: 30000" --data-binary @-
}
get_unless_refused() {
  local answer
  answer=$(curl -s -K <(auth) -w '\n%{http_code}' "$HQ_URL/api/agent/$2") || return 1
  case "${answer##*$'\n'}" in
    2??) printf -v "$1" '%s' "${answer%$'\n'*}" ;;
    403) echo "HQ refused it: $(jq -r '.error // "not allowed"' <<<"${answer%$'\n'*}" 2>/dev/null)." >&2; exit 1 ;;
    *) return 1 ;;
  esac
}
uri() { jq -rn --arg q "$1" '$q | @uri'; }
own=$1
shift
# shellcheck source=/dev/null
. "$own"
