# Hetzner Cloud's API for infra's server scripts (provision.sh, resize.sh). Sourced, never run. Needs HCLOUD_TOKEN.

# One call, Hetzner's JSON reply on stdout. A call with no answer in 30 seconds fails with curl's words on stderr, so a
# connection Hetzner or the network accepted and never answered can't hold the run until the runner's own limit.
api() { # method path [json]
  curl -sS --connect-timeout 10 --max-time 30 -X "$1" "https://api.hetzner.cloud/v1$2" \
    -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" ${3:+-d "$3"}
}

# Hetzner runs an action in the background: waits for it to end, and says why when it doesn't succeed (Hetzner's own
# error where there is one). Returns 1 when Hetzner failed the action: the caller decides whether that ends the run.
# Returns 2 when its outcome is unknown: the lookup got no reply twice, or a reply with no state, or the action is still
# running after the minutes given. What it acts on may still be changing, so the caller stops rather than act on it.
wait_for() { # action id, what it does, minutes
  local reply try
  for ((try = 0; try < $3 * 12; try++)); do
    reply=$(api GET "/actions/$1") || reply=$(api GET "/actions/$1") ||
      { echo "::error::Could not $2: no reply about action $1" >&2; return 2; }
    case $(echo "$reply" | jq -r '.action.status') in
      running) sleep 5 ;;
      success) return 0 ;;
      error) echo "::error::Could not $2: $(echo "$reply" | jq -r '.action.error.message')" >&2; return 1 ;;
      *) echo "::error::Could not $2: no state for action $1: $(echo "$reply" | jq -r '.error.message')" >&2; return 2 ;;
    esac
  done
  echo "::error::Could not $2: still running after $3 minutes" >&2; return 2
}
