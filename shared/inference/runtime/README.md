# The confined inference runtime

One image that runs a local model inside a GPU helper's run, with no network: llama.cpp built for the machine's
cards, a front end that speaks the stdio contract of `shared/inference/README.md`, and the weight files themselves
as read-only layers. A company's manifest names the llama.cpp commit, the CUDA architecture and the models. Nothing
here names a company or a model.

## The front end

`stdio.cpp` is llama-server's own chat route, called in its process instead of over HTTP. So templates, tool calls
and reasoning are parsed exactly as llama-server parses them, and the run opens no socket (the helper's filter
refuses `connect` anyway). The image installs it as `/opt/inference/bin/chat`:

```sh
/opt/inference/bin/chat --manifest <absolute-json-path> --model <name>
```

It refuses to start (exit 2, a line on stderr, nothing on stdout) when the manifest asks for another llama.cpp
commit than the one it was built from, more than one request at a time, or a model whose file in
`/opt/inference/models` is missing or has another SHA-256. Then it loads the model with llama-server's options:

- every layer on the cards with a share in `gpuSplit` (`--gpu-layers 999`, `--split-mode layer`, `--tensor-split`
  from the shares), numbered in PCI order as `nvidia-smi` numbers them;
- the manifest's whole `contextTokens` and one slot, with llama.cpp's fitting turned off, so a model that doesn't
  fit fails to load rather than loading smaller;
- the GGUF's embedded chat template through Jinja, reasoning returned apart in `reasoning_content`, no prompt cache.

Its ready line reads back what loaded, from llama.cpp rather than the options: the file's digest, the embedded
commit, `general.architecture`, the template's SHA-256, the backend and CUDA devices the model's layers went to,
the context allocated, and `buffers`, each backend buffer's model, context and compute MiB. `hashSeconds` and
`loadSeconds` time the digest and the load. `gpuLayers` is llama.cpp's own count of offloaded layers out of
`totalLayers` (repeating layers, any next-token layers and the output layer). A request line gets llama-server's
non-streamed answer with the request's `id`. A line that fails gets `{"id", "error"}`, and the next line is read.
EOF stops the loop and frees the context and model, and the process exits 0, which ends its CUDA contexts. Every
other line llama.cpp prints goes to stderr.

## The image

`recipe.py` writes the whole build as one Dockerfile, the sources inside it, from a company manifest:

```sh
python3 shared/inference/runtime/recipe.py --manifest <manifest.json> --out <file.Dockerfile>
```

It prints the file's SHA-256 and a tag made from it. The build fetches llama.cpp at the manifest's commit (checked
with `git rev-parse`), compiles `llama-stdio` alone for the manifest's CUDA architecture on NVIDIA's CUDA 12.8.1
devel image, and copies it onto the matching runtime image with node (the helper's), python3 (the caller's) and
libgomp1 (ggml's OpenMP threads). Every base image is pinned by digest. A build-time `ldd` fails it when a library is
missing (libcuda comes with the driver). Then each model downloads in a layer of its own, from the Hub at its revision, through `fetch.mjs`, which
checks its size and SHA-256 as the bytes arrive and fails the build on any difference. The compile runs before any
download, so a build that can't compile downloads no weights.

The weights make a registry a poor fit: tens of GB of private packages cost money, and GitHub's registry refuses
layers over 10 GB. So the image is built on the machine that runs it, from a stdin Dockerfile with no context:

```sh
docker build --tag <tag> - < <file.Dockerfile>
docker image inspect --format {{.Id}} <tag>
```

The second line prints the image's id (`sha256:...`), which pins it: the run kind names it as its image, and the
manager finds it locally and pulls nothing. The manifest's `runtime.image` names the same id for the caller.

**Storage, on Docker's classic store** (overlay2: each layer once, unpacked). The weights' layers are their files'
size. The devel image is about 5.2 GB to download and roughly twice that unpacked. Its runtime base (2.2 GB to
download) is shared with the final image, so it adds nothing. The build tree adds 1 to 2 GB. Peak is about the
weights plus 12 to 15 GB. What stays is the weights plus about 5 GB. `docker builder prune` frees the build's cache
after it. On Docker Desktop, Docker's disk is a file on the Windows drive that grows to the peak and may not shrink
back by itself, so it's the Windows drive's free space that counts. A run inside a container sees Docker's disk
(`df /`) and, through the driver mount, the Windows drive (`df /usr/bin/nvidia-smi`).

## The run kind

Declared in org.yaml once the image is built, by its id:

```yaml
inference:
  about: a local model on the graphics cards (shared/inference/runtime)
  image: sha256:<the id the build printed>
  gpus: true
  lentOnly: true
  cpus: 8
  memoryGb: 16
  diskGb: 4
```

`lentOnly` keeps it off our server, which has no cards. It keeps the no-network filter (no `sockets`). The weights
are in the image, so `/work` holds only a run's own files. 16 GB covers llama.cpp's host-side buffers and the
caller: the weights go to the cards, and their file pages are page cache the container can drop.

## Checks

The CUDA build and the models are checked on the machine itself, in the acceptance run (`shared/inference/smoke.py`
in an `inference` run). Before that, a CPU build of `llama-stdio` at the same commit was driven over stdio with a
1 MB test model carrying a Jinja template: ready line, an answer with its request's id, an error line for a bad
line, exit 0 at EOF with nothing more on stdout, and refusals for a wrong digest and a path outside the store.
That proves the front end's plumbing against this llama.cpp, not CUDA, a real model's template or its tool calls.
