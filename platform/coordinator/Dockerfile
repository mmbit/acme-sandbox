# Debian slim, not Alpine: the search model runs on onnxruntime-node, whose prebuilt binary needs glibc (memory.ts).
FROM node:24.22.1-slim
# git, to read who committed the files a workflow writes for the server (src/committed.ts): the slim image has none.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
# Chromium, for print files a company's kit draws from a page of its own and for the watch-along's mirror, started
# headless over its DevTools pipe by shared/chromium/chromium.ts. APT_FRESH reruns this layer for a security fix:
# bookworm-security's chromium 156.0.8078.73-1~deb12u1 (Chrome 156.0.8078.73's four criticals).
ARG APT_FRESH=2026-10-30
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
# the browser itself, not Debian's launcher script, which adds its own flags and extensions
ENV CHROMIUM_PATH=/usr/lib/chromium/chromium
# Built from the repo's root (infra/compose.yaml, the root .dockerignore), laid out as in the repo: the platform's code here,
# the company's own parts in /app/kits, which import it by its path in the repo (src/kits.ts)
WORKDIR /app/platform/coordinator
COPY platform/coordinator/package.json platform/coordinator/package-lock.json ./
# No install scripts (onnxruntime-node's would fetch CUDA libraries). It ships every platform's binaries and its GPU
# providers: keep this machine's CPU build only (about 45 of 550 MB). transformers.js bundles what it needs of the web build.
RUN npm ci --omit=dev --ignore-scripts && cd node_modules/onnxruntime-node/bin/napi-v6 \
    && rm -rf darwin win32 linux/*/libonnxruntime_providers_cuda.so linux/*/libonnxruntime_providers_tensorrt.so \
    && find linux -mindepth 1 -maxdepth 1 ! -name "$(node -p 'process.arch')" -exec rm -rf {} + \
    && rm -rf /app/platform/coordinator/node_modules/onnxruntime-web
# The search model (about 120 MB), fetched once now, so the running server never needs the network. It runs inside the
# coordinator (secrets, payments, approvals), so like platform/stt it is pinned: one Hugging Face commit, and a sha256 for
# each file the pipeline loads (listed by a pinned build run), each checked before it is written. Then it is tried the way
# memory.ts loads it (remote downloads off). If anything fails (Hugging Face down, a changed file), the build still goes on
# without it: a deploy is never blocked by search, which then ranks by words only and says so (memory.ts). The layer cache
# would keep that build for good, so while the running coordinator has no model, each deploy tries again with a new
# MEMORY_MODEL_TRY (infra/sync.sh keeps it in a state file, and changes it only while the model is missing). A download never holds a deploy up for more than 10 minutes a file.
# A new revision or model means new sums: download the files at that commit and run sha256sum on them.
ENV MEMORY_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2 MEMORY_MODELS=/app/models
ARG MEMORY_MODEL_REVISION=2c4055b12046f11709e9df2c122e59ffbdc2f900
# (and at run time: memory.ts embeds everything again when the model or its revision changes)
ENV MEMORY_MODEL_REVISION=$MEMORY_MODEL_REVISION
ARG MEMORY_MODEL_TRY=
RUN node --input-type=module -e "import { createHash } from 'node:crypto'; import { mkdirSync, writeFileSync } from 'node:fs'; \
    const M = process.env.MEMORY_MODEL, dir = process.env.MEMORY_MODELS + '/' + M, rev = process.env.MEMORY_MODEL_REVISION; \
    const fail = m => { console.error('Search model: ' + m); process.exit(1); }; \
    const sums = { 'config.json': '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7', \
      'tokenizer_config.json': '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2', \
      'tokenizer.json': 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441', \
      'onnx/model_quantized.onnx': '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc' }; \
    for (const [file, sum] of Object.entries(sums)) { \
      const r = await fetch('https://huggingface.co/' + M + '/resolve/' + rev + '/' + file, { signal: AbortSignal.timeout(600000) }); \
      if (!r.ok) fail(file + ': HTTP ' + r.status); \
      const b = Buffer.from(await r.arrayBuffer()), got = createHash('sha256').update(b).digest('hex'); \
      if (got !== sum) fail(file + ': sha256 ' + got + ', expected ' + sum); \
      mkdirSync(dir + '/onnx', { recursive: true }); writeFileSync(dir + '/' + file, b); } \
    const { pipeline, env } = await import('@huggingface/transformers'); \
    Object.assign(env, { allowRemoteModels: false, localModelPath: process.env.MEMORY_MODELS, cacheDir: process.env.MEMORY_MODELS }); \
    const f = await pipeline('feature-extraction', M, { dtype: 'q8' }); await f(['test'], { pooling: 'mean' })" \
    || { rm -rf "$MEMORY_MODELS"; echo "Search model not fetched or not verified: search by words only until a deploy fetches it"; }
# the context as the root .dockerignore leaves it: the platform's src, HQ's card reader (src/server.ts runs it)
# and the company's kits/, if it has any
COPY . /app/
# /imports: a new volume takes this folder's owner
RUN mkdir /data /imports && chown node:node /data /imports
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
