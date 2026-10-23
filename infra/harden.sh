#!/bin/bash
# Server hardening. Idempotent; runs on every deploy via sync.sh.
# Network: the Hetzner cloud firewall "web" (provision.sh) only lets in 80, 443 and ping.
set -euo pipefail
here=$(dirname "$0")
. "$here/infra-env.sh"   # SERVER_NAME: the server's name for its folders and services
# company/infra.env read as data (infra-env.sh), never sourced

# No SSH at all. Changes arrive through git; emergencies go through the Overseer's fixed actions (infra/shell.py: status,
# logs, restart, deploy, tests, for GitHub's overseer workflow on main) or the
# Hetzner web console.
systemctl disable --now ssh.socket ssh.service 2>/dev/null || true

# Security updates install automatically, with a reboot at night when needed.
if [ ! -f /etc/apt/apt.conf.d/52$SERVER_NAME ]; then
  apt-get install -y -qq unattended-upgrades
  cat > /etc/apt/apt.conf.d/52$SERVER_NAME <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
CONF
fi

# Containers can't reach the metadata service (H5), at every boot and Docker restart, not only on deploy.
# Installed before the daemon.json restart below, so a first install applies to that restart too.
# The files say @SERVER_NAME@ where they name the server's folders and services (provision.sh fills them in the same
# way for cloud-init).
changed= rendered=$(mktemp)
install_if_changed() {
  sed "s|@SERVER_NAME@|$SERVER_NAME|g" "$1" > "$rendered"
  cmp -s "$rendered" "$2" || { install -D -m "$3" "$rendered" "$2"; changed=1; }
}
install_if_changed "$here/block-metadata.sh" /usr/local/sbin/$SERVER_NAME-block-metadata 0755
install_if_changed "$here/docker-metadata.conf" /etc/systemd/system/docker.service.d/$SERVER_NAME-metadata.conf 0644
# The worker's parent keeps swap off before its first process starts, across container and host restarts.
install_if_changed "$here/worker.slice" /etc/systemd/system/$SERVER_NAME-worker.slice 0644
# The nightly off-site backup (infra/backup.py): encrypted here with age to the board's public key, then to R2.
install_if_changed "$here/backup.service" /etc/systemd/system/$SERVER_NAME-backup.service 0644
install_if_changed "$here/backup.timer" /etc/systemd/system/$SERVER_NAME-backup.timer 0644
# The Overseer's way in when HQ is down (infra/shell.py): fixed actions for GitHub's overseer workflow on main.
install_if_changed "$here/shell.service" /etc/systemd/system/$SERVER_NAME-shell.service 0644
rm -f "$rendered"
[ -z "$changed" ] || systemctl daemon-reload
/usr/local/sbin/$SERVER_NAME-block-metadata   # now, without restarting Docker
systemctl is-enabled -q $SERVER_NAME-backup.timer || systemctl enable --now $SERVER_NAME-backup.timer
# started once, and again whenever its unit or code changed (their fingerprint, kept beside the unit)
shell_stamp=/etc/systemd/system/$SERVER_NAME-shell.stamp
shell_now=$(cat "$here/shell.py" /etc/systemd/system/$SERVER_NAME-shell.service | sha256sum)
[ "$(cat "$shell_stamp" 2>/dev/null)" = "$shell_now" ] ||
  { systemctl enable -q $SERVER_NAME-shell.service && systemctl restart $SERVER_NAME-shell.service && echo "$shell_now" > "$shell_stamp"; } ||
  echo "the Overseer's shell service did not start: systemctl status $SERVER_NAME-shell" >&2
# age (Ubuntu's package): a failed install mustn't stop the deploy; the backup's status then says age is missing.
command -v age >/dev/null || apt-get install -y -qq age || { apt-get update -qq && apt-get install -y -qq age; } ||
  echo "could not install age: the off-site backup waits for it" >&2

# Container logs can't fill the disk (the default for a container compose doesn't start).
# and Docker's own build-cache garbage collection is off, so sync.sh's prune
# after each deploy is the only thing that drops build steps. Left on, it trims the cache to about 10% of the disk,
# below what the running images stand on, so the next deploy builds an unchanged image again and recreates its
# container (the voice line, the worker).
# New networks are small: Docker's default pools give about 31 bridge networks (/16s and /20s), and every product
# container has a network of its own (products.py), so the 27th product network fails with "all predefined address
# pools have been fully subnetted". /24s from 10.200.0.0/16 give 256; the networks made before keep their addresses.
# The default bridge stays at 172.17.0.1, where the Overseer's shell listens (shell.py) and host.docker.internal
# points, on a new server too.
# On a server that has the file already, the settings are added to it, and Docker restarts once (every container with
# it; sync.sh checks for a live call right before).
daemon='{"builder":{"gc":{"enabled":false}},"bip":"172.17.0.1/16","default-address-pools":[{"base":"10.200.0.0/16","size":24}]}'
if [ ! -f /etc/docker/daemon.json ]; then
  jq -n --argjson want "$daemon" '{"log-driver":"local","log-opts":{"max-size":"20m","max-file":"3"}} * $want' > /etc/docker/daemon.json
  systemctl restart docker
elif ! jq -e --argjson want "$daemon" '. * $want == .' /etc/docker/daemon.json >/dev/null 2>&1; then
  jq --argjson want "$daemon" '. * $want' /etc/docker/daemon.json > /etc/docker/daemon.json.new &&
    mv /etc/docker/daemon.json.new /etc/docker/daemon.json && systemctl restart docker
fi

# Containers log to the journal (compose.yaml, products.py), which keeps them for a time, not a size: at most 14 days.
cmp -s "$here/journald.conf" /etc/systemd/journald.conf.d/$SERVER_NAME.conf ||
  { install -D -m 0644 "$here/journald.conf" /etc/systemd/journald.conf.d/$SERVER_NAME.conf && systemctl restart systemd-journald; }

# The deploy timer runs sync.sh from the checkout, and a `git reset` the disk cut short can leave it half written: on
# 2026-10-07 it was one line long, so every run stopped at once without deploying or reporting. Before each run the
# file is put back as the checked-out commit has it.
repair=/etc/systemd/system/$SERVER_NAME-sync.service.d/repair.conf
want="[Service]
ExecStartPre=-/usr/bin/git -C /opt/$SERVER_NAME checkout -q HEAD -- infra/sync.sh"
[ "$(cat "$repair" 2>/dev/null)" = "$want" ] || { mkdir -p "$(dirname "$repair")" && echo "$want" > "$repair" && systemctl daemon-reload; }

# Swap, so builds don't get killed on memory spikes. Only with 20 GB free: on a full disk its 4 GB are the room the
# jobs and the next build need (on 2026-10-07 the board deleted it to get a stalled server going again).
if [ ! -f /swapfile ] && [ "$(df --output=avail -k / | tail -1)" -ge $((20 << 20)) ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Basic kernel network hardening.
cat > /etc/sysctl.d/90-$SERVER_NAME.conf <<'CONF'
net.ipv4.conf.all.rp_filter=1
net.ipv4.conf.all.accept_redirects=0
net.ipv6.conf.all.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.tcp_syncookies=1
CONF
sysctl -q --system
