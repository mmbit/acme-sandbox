#!/usr/bin/env python3
"""Write the inference runtime's Dockerfile from a company manifest: one self-contained file to build anywhere."""

import argparse
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
# CUDA 12.8 is what llama.cpp's own CUDA image builds with; a driver for CUDA 12.8 or later runs it
BUILD = 'nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66'
RUN = 'nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867'
NODE = 'node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205'
# Parallel compiles: nvcc takes up to about 2 GB each, so 16 stay well inside a 32 GB build machine
JOBS = 16


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    arguments = parser.parse_args()
    manifest = json.loads(arguments.manifest.read_text())
    text = dockerfile(manifest, arguments.manifest)
    arguments.out.write_text(text)
    digest = hashlib.sha256(text.encode()).hexdigest()
    print(json.dumps({'dockerfile': str(arguments.out), 'sha256': digest, 'tag': f'hq-inference:{digest[:12]}',
                      'weightBytes': sum(model['bytes'] for model in manifest['models'])}, indent=2))


def dockerfile(manifest, source):
    runtime = manifest['runtime']
    commit, architecture = runtime['commit'], runtime['cudaArchitecture']
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'The runtime commit must be a full llama.cpp commit')
    require(re.fullmatch(r'[0-9]{2,3}', architecture), 'The CUDA architecture must be a number like 89')
    require(runtime['repository'] == 'https://github.com/ggml-org/llama.cpp', 'The runtime is llama.cpp')
    lines = [
        f'# The confined inference runtime for {source.name} (shared/inference/runtime/README.md): llama.cpp',
        f'# {commit} for CUDA architecture {architecture}, its stdio front end, and each weight',
        '# file checked as it downloads. Written by recipe.py: build it with `docker build --tag <tag> - < <this file>`.',
        f'FROM {BUILD} AS build',
        'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make \\',
        '    && rm -rf /var/lib/apt/lists/*',
        'WORKDIR /src',
        f'RUN git init -q llama.cpp && git -C llama.cpp fetch -q --depth 1 {runtime["repository"]} {commit} \\',
        f'    && git -C llama.cpp checkout -q FETCH_HEAD && test "$(git -C llama.cpp rev-parse HEAD)" = {commit}',
        *embedded('stdio.cpp', '/src/llama.cpp/tools/server/stdio.cpp'),
        *embedded('stdio.cmake', '/src/stdio.cmake'),
        *embedded('fetch.mjs', '/src/fetch.mjs'),
        'RUN cat /src/stdio.cmake >> llama.cpp/tools/server/CMakeLists.txt \\',
        f'    && cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES={architecture} \\',
        '       -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \\',
        f'       -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_OPENSSL=OFF -DRUNTIME_COMMIT={commit} \\',
        f'    && cmake --build build --target llama-stdio -j {JOBS}',
        '',
        f'FROM {RUN}',
        '# libgomp1 for ggml\'s OpenMP threads (the devel image has it, the runtime image not), python3 for the',
        '# acceptance caller (shared/inference/smoke.py), which runs beside the runtime',
        'RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 python3 && rm -rf /var/lib/apt/lists/* \\',
        '    && echo /usr/local/cuda/lib64 > /etc/ld.so.conf.d/zz-cuda.conf && ldconfig',
        f'COPY --from={NODE} /usr/local/bin/node /usr/local/bin/node',
        'COPY --from=build /src/build/bin/llama-stdio /opt/inference/bin/chat',
        '# (a run has none of the image\'s variables, LD_LIBRARY_PATH included. libcuda comes with the driver at run time.)',
        'RUN missing="$(env -u LD_LIBRARY_PATH ldd /opt/inference/bin/chat | grep \'not found\' | grep -v libcuda || true)" \\',
        '    && test -z "$missing" || { echo "$missing"; exit 1; }',
    ]
    # One layer per model, last, so a changed model leaves the runtime's layers and the other models' as they were
    for model in manifest['models']:
        require(re.fullmatch(r'[0-9a-f]{40}', model['revision']), 'Each model needs its exact revision')
        require(re.fullmatch(r'[0-9a-f]{64}', model['sha256']), 'Each model needs its SHA-256')
        require(re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]*', model['file']), 'A model file is a plain name')
        require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', model['repository']), 'A model is a Hub repository')
        url = f'https://huggingface.co/{model["repository"]}/resolve/{model["revision"]}/{model["file"]}'
        lines += [
            'RUN --mount=type=bind,from=build,source=/src/fetch.mjs,target=/opt/fetch.mjs \\',
            f'    node /opt/fetch.mjs {url} \\',
            f'    {model["bytes"]} {model["sha256"]} /opt/inference/models/{model["file"]}',
        ]
    return '\n'.join(lines) + '\n'


def embedded(name, destination):
    text = (HERE / name).read_text()
    delimiter = name.replace('.', '_').upper() + '_END'
    require(delimiter not in text.splitlines(), f'{name} holds its own heredoc delimiter')
    return [f'COPY <<"{delimiter}" {destination}', *text.rstrip('\n').split('\n'), delimiter]


def require(condition, message):
    if not condition:
        raise ValueError(message)


if __name__ == '__main__':
    main()
