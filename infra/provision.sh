#!/bin/bash
# Creates the company's server on Hetzner Cloud if it doesn't exist yet. Idempotent.
# Needs: HCLOUD_TOKEN, SERVER_GITHUB_TOKEN, REPO, BRANCH.
set -euo pipefail
infra=$(dirname "$0")
# company/infra.env read as data (infra-env.sh), never sourced
. "$infra/infra-env.sh"
NAME=$SERVER
. "$infra/hetzner.sh"   # api, wait_for

# Hetzner's reply listing the firewalls of that name: an error reply stops the run rather than read as none.
firewalls() { # name
  local reply
  reply=$(api GET "/firewalls?name=$1")
  echo "$reply" | jq -e '.firewalls | arrays' > /dev/null ||
    { echo "::error::Could not look up the firewall $1: $(echo "$reply" | jq -r '.error.message')" >&2; exit 1; }
  echo "$reply"
}

server=$(api GET "/servers?name=$NAME" | jq '.servers[0] // empty')
# The firewall is looked up first because an existing server needs it too, not only a new one. It's named for the
# server (SERVER_NAME), so two companies in one Hetzner project each keep their own.
fw=$(firewalls "$SERVER_NAME" | jq '.firewalls[0].id // empty')
if [ -z "$fw" ] && [ -n "$server" ]; then
  # A server provisioned before job #8519 has the firewall "web": when it guards this server alone, it's renamed and keeps
  # its rules. One shared with another server stays as it is, and this server gets its own beside it.
  web=$(firewalls web | jq --argjson id "$(echo "$server" | jq '.id')" \
    '.firewalls[0] // empty | select([.applied_to[]? | .server.id] == [$id]) | .id')
  if [ -n "$web" ]; then
    fw=$(api PUT "/firewalls/$web" "$(jq -n --arg n "$SERVER_NAME" '{name:$n}')" | jq '.firewall.id // empty')
    [ -n "$fw" ] || { echo "::error::Could not rename the firewall web to $SERVER_NAME"; exit 1; }
    echo "Firewall web renamed $SERVER_NAME"
  fi
fi
if [ -z "$fw" ]; then
  rules='[{"direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]},
          {"direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]},
          {"direction":"in","protocol":"icmp","source_ips":["0.0.0.0/0","::/0"]}]'
  fw=$(api POST /firewalls "$(jq -n --arg n "$SERVER_NAME" --argjson r "$rules" '{name:$n,rules:$r}')" | jq '.firewall.id // empty')
  [ -n "$fw" ] || { echo "::error::Could not create the firewall $SERVER_NAME"; exit 1; }
fi
if [ -n "$server" ] && ! echo "$server" | jq -e --argjson fw "$fw" '[.public_net.firewalls[]?.id] | index($fw) != null' > /dev/null; then
  # A server moved in from another project or account arrives without this project's firewall: put it back.
  server_id=$(echo "$server" | jq '.id')
  apply_body=$(jq -n --argjson id "$server_id" '{apply_to:[{type:"server",server:{id:$id}}]}')
  actions=$(api POST "/firewalls/$fw/actions/apply_to_resources" "$apply_body" | jq -e '.actions | arrays | .[].id') ||
    { echo "::error::Could not apply the firewall $SERVER_NAME to $NAME"; exit 1; }
  while read -r action; do wait_for "$action" "apply the firewall $SERVER_NAME to $NAME" 5 || exit 1; done <<< "$actions"
  echo "Firewall $SERVER_NAME applied"
fi
if [ -z "$server" ]; then
  # user_data is served unauthenticated at 169.254.169.254, so the token never goes in: only a one-time key
  # that seals it for the server's first-boot listener (infra/github_token.py), and the files that listener
  # and the metadata block need before the repo can be cloned.
  export BOOT_KEY=$(openssl rand -hex 288)
  echo "::add-mask::$BOOT_KEY"
  export GITHUB_TOKEN_PY_B64=$(base64 -w0 "$infra/github_token.py") BLOCK_METADATA_B64=$(base64 -w0 "$infra/block-metadata.sh") \
    DOCKER_METADATA_B64=$(sed "s|@SERVER_NAME@|$SERVER_NAME|g" "$infra/docker-metadata.conf" | base64 -w0) SERVER_NAME
  payload=$(python3 "$infra/github_token.py" seal)
  user_data=$(envsubst '${REPO} ${BRANCH} ${BOOT_KEY} ${GITHUB_TOKEN_PY_B64} ${BLOCK_METADATA_B64} ${DOCKER_METADATA_B64} ${SERVER_NAME}' \
    < "$infra/cloud-init.yaml")
  # Try a few sizes and EU locations in case one is unavailable.
  for type in cx33 cx32 cpx31; do
    for loc in nbg1 fsn1 hel1; do
      body=$(jq -n --arg n "$NAME" --arg app "$SERVER_NAME" --arg t "$type" --arg l "$loc" --arg u "$user_data" --argjson fw "$fw" \
        '{name:$n,server_type:$t,location:$l,image:"ubuntu-24.04",user_data:$u,
          firewalls:[{firewall:$fw}],labels:{app:$app}}')
      resp=$(api POST /servers "$body")
      server=$(echo "$resp" | jq '.server // empty')
      [ -n "$server" ] && break 2
      echo "::notice::$type in $loc unavailable: $(echo "$resp" | jq -r '.error.message')"
    done
  done
  [ -n "$server" ] || { echo "::error::Could not create server"; exit 1; }
  echo "Created $NAME"
  # Hand over the sealed token once the server is up and listening (it installs packages first).
  ip=$(echo "$server" | jq -r '.public_net.ipv4.ip')
  delivered=
  for _ in $(seq 120); do   # up to 20 minutes
    printf %s "$payload" | curl -sf --max-time 5 --data-binary @- "http://$ip/" > /dev/null && { delivered=1; break; }
    sleep 10
  done
  [ -n "$delivered" ] || { echo "::error::The server never took the token. Delete $NAME in the Hetzner console and run this again."; exit 1; }
  echo "Token delivered"
fi

# Daily Hetzner backups (7 kept, about 20% of the server price).
if [ "$(echo "$server" | jq -r '.backup_window // empty')" = "" ]; then
  api POST "/servers/$(echo "$server" | jq '.id')/actions/enable_backup" > /dev/null && echo "Backups enabled"
fi

ip=$(echo "$server" | jq -r '.public_net.ipv4.ip')
echo "$NAME: $(echo "$server" | jq -r '.server_type.name') in $(echo "$server" | jq -r '.datacenter.location.name // .location.name // "?"'), http://$ip"
echo "ip=$ip" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "**Server:** $NAME at http://$ip" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
