# The worker: runs agent jobs with Claude Code, Codex and the other CLIs a seat can run, plus the tools agents need to build,
# test and make media (ffmpeg, Playwright + Chromium, ImageMagick, Python, SQLite).
FROM node:24.22.1-bookworm
# (python3-yaml: infra's tests, which the worker runs on every push: shared/gates/tests.ts)
# APT_FRESH reruns this layer for a security fix; libbrotli1 comes with the base image, so it's named to take
# bookworm-security's 1.0.9-2+deb12u1 (CVE-2026-111497, a Brotli decoder overflow behind curl and git, DLA-4855-1).
ARG APT_FRESH=2026-10-24
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq ripgrep ffmpeg imagemagick python3 python3-pip python3-venv python3-yaml sqlite3 curl ca-certificates \
      fonts-dejavu fonts-noto-color-emoji util-linux libbrotli1 \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright DISABLE_AUTOUPDATER=1 CI=1
# Pinned: a rebuild installs exactly what was reviewed (bump deliberately).
# (codex 0.157.1 to 0.160.1: the first that knows GPT-6.1 Sol)
RUN npm install -g @anthropic-ai/claude-code@2.1.283 @openai/codex@0.160.1 playwright@1.63.0 \
    && playwright install --with-deps chromium
# The other CLIs a seat can run (src/clis/), root's so no job replaces them: Mistral's Vibe (Python 3.12, which uv
# brings, as Debian 12 has 3.11) and Google's Antigravity CLI (a Go binary, checked against its manifest's sha512; it
# also never updates itself: AGY_CLI_DISABLE_AUTO_UPDATE, clis/agy.ts).
ENV UV_TOOL_DIR=/opt/uv/tools UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_TOOL_BIN_DIR=/usr/local/bin
# uv 0.13.5's own store leaves out emSign's compromised root (GHSA-hq85-5cpj-mr62). Vibe pins its certifi exactly
# to a bundle that still trusts it, so the override installs certifi 2026.10.19, the first without it
# (GHSA-6q48-6c7w-9gw2), which Vibe reads through certifi.where().
RUN python3 -m pip install --break-system-packages --no-cache-dir uv==0.13.5 \
    && echo 'certifi==2026.10.19' > /tmp/vibe-overrides.txt \
    && uv tool install --python 3.12 --overrides /tmp/vibe-overrides.txt mistral-vibe==2.26.1 \
    && rm -f /tmp/vibe-overrides.txt && chmod -R a+rX /opt/uv
RUN curl -fsSL -o /tmp/agy.tar.gz https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.5-6164039479459840/linux-x64/cli_linux_x64.tar.gz \
    && echo "0fa5ff7ca8661ef6379da219dd30552327b0deaf112ea896882daaba8bd6abff76ff097ef7b38211bffb78be6871f7494a1739b7160b483cb68481a24d435c47  /tmp/agy.tar.gz" | sha512sum -c - \
    && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity && install -m 755 /tmp/antigravity /usr/local/bin/agy \
    && rm -f /tmp/agy.tar.gz /tmp/antigravity
# infra's tests' own tools, from their GitHub releases, checked against their sha256: age and versitygw for
# test_backup.py, Caddy for test_caddy.sh, which skips without one. The worker sends its copies along to a lent machine's
# tests helper (shared/gates/tests.ts TOOLS: the same list).
RUN curl -fsSL -o /tmp/age.tar.gz https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz \
    && curl -fsSL -o /tmp/vgw.tar.gz https://github.com/versity/versitygw/releases/download/v1.9.0/versitygw_v1.9.0_Linux_x86_64.tar.gz \
    && curl -fsSL -o /tmp/caddy.tar.gz https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz \
    && printf '%s  %s\n' cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 /tmp/age.tar.gz \
         0c28ccda3452451d7c71a0427f6aa7d0db5cac5e2b98a8e4dd2970967e1aadc1 /tmp/vgw.tar.gz \
         727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b /tmp/caddy.tar.gz | sha256sum -c - \
    && tar -xzf /tmp/age.tar.gz -C /usr/local/bin --strip-components=1 age/age age/age-keygen \
    && tar -xzf /tmp/vgw.tar.gz -C /usr/local/bin --strip-components=1 versitygw_v1.9.0_Linux_x86_64/versitygw \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy \
    && chown root:root /usr/local/bin/age /usr/local/bin/age-keygen /usr/local/bin/versitygw /usr/local/bin/caddy \
    && rm -f /tmp/age.tar.gz /tmp/vgw.tar.gz /tmp/caddy.tar.gz
# Compose resolves deployment limits in infra/test_limits.py without a Docker daemon.
RUN curl -fsSL -o /tmp/docker-compose https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-x86_64 \
    && echo "7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4  /tmp/docker-compose" | sha256sum -c - \
    && install -m 755 /tmp/docker-compose /usr/local/bin/docker-compose \
    && rm -f /tmp/docker-compose
# The worker process runs as root and holds the tokens. Each worker slot runs its jobs as its own user, slot1..slot16
# (uid and gid 1501..1516), which owns only the folders of the job it runs (src/slots.ts); uid 1500 (worker) keeps
# the seat sign-ins in /seats and runs no job. Every slot may clone from the root-owned mirror. slottest1 and slottest2
# (1517, 1518) are the slot isolation test's alone (slots.ts TEST_IDS).
RUN useradd -m -u 1500 worker \
    && for i in $(seq 1 16); do groupadd -g $((1500 + i)) slot$i && useradd -M -d /nonexistent -s /bin/bash -u $((1500 + i)) -g slot$i slot$i; done \
    && for i in 1 2; do groupadd -g $((1516 + i)) slottest$i && useradd -M -d /nonexistent -s /bin/bash -u $((1516 + i)) -g slottest$i slottest$i; done \
    && mkdir -p /work /seats && git config --system --add safe.directory /work/mirror.git
# The gates' tools (shared/gates), pinned at the repo's root, and the coordinator's packages for the type check, laid
# out as the repo: a job's clone links them in. No install scripts, and none of the search model's runtime (types only).
# Built from the repo's root (infra/compose.yaml, Dockerfile.dockerignore).
COPY package.json package-lock.json /opt/gates/
COPY platform/coordinator/package.json platform/coordinator/package-lock.json /opt/gates/platform/coordinator/
# The worker parses shell inputs with a pinned Bash parser.
COPY platform/worker/package.json platform/worker/package-lock.json /opt/gates/platform/worker/
RUN cd /opt/gates && npm ci --ignore-scripts \
    && cd platform/worker && npm ci --omit=dev --ignore-scripts \
    && cd /opt/gates \
    && cd platform/coordinator && npm ci --omit=dev --ignore-scripts \
    && rm -rf node_modules/onnxruntime-node node_modules/onnxruntime-web
# The worker's own code isn't in the image: infra/sync.sh stages it in the work volume (/work/code/current, root's), so a
# deploy that changes only that code reloads the worker's process, not the container, and the jobs' processes go on.
# supervise.py, the container's first process, runs it and outlives it.
COPY platform/worker/supervise.py /usr/local/lib/worker/supervise.py
# hq: the launcher and, beside it as in the repo (bin/../hq), the TypeScript it runs, both from the code the worker runs
# (code/running: never newer than the coordinator deployed with it)
RUN ln -s /work/code/running/bin/hq /usr/local/bin/hq && ln -s /work/code/running/hq /usr/local/hq
WORKDIR /work
CMD ["python3", "/usr/local/lib/worker/supervise.py"]
