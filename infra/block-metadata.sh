#!/bin/sh
# Containers must not reach the cloud metadata service: it serves user_data to anyone who asks (H5).
# Installed as /usr/local/sbin/<SERVER_NAME>-block-metadata and run by docker.service before and after Docker
# starts (infra/docker-metadata.conf), so the rule exists at every boot and Docker restart before any
# container runs. DOCKER-USER only sees forwarded (container) traffic, so the host keeps its access.
# Idempotent: creates the chain if Docker hasn't yet, inserts the rule only when it's missing.
set -e
iptables -w -N DOCKER-USER 2>/dev/null || true
iptables -w -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null ||
  iptables -w -I DOCKER-USER -d 169.254.169.254/32 -j DROP
