# Speech-to-text for the intercom: whisper.cpp's own server with a small multilingual model.
# Reachable only on the internal network (no published ports); audio is never stored on disk.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG WHISPER_TAG=v1.9.4
RUN git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# Built for any x86-64 server with AVX2, not for the building machine's own CPU (ggml's default): a server resized to
# another CPU type keeps a working image.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF \
      -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
    && cmake --build build -j --target whisper-server
# Multilingual "small" model, quantised (about 190 MB), verified by checksum.
ARG MODEL=ggml-small-q5_1.bin
ARG MODEL_SHA256=ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb
RUN curl -fsSL -o /model.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL" \
    && echo "$MODEL_SHA256  /model.bin" | sha256sum -c -
# Voice activity detection (Silero, under 1 MB): only stretches with speech reach whisper, which otherwise makes up
# words from silence and noise ("Thank you.", "Thanks for watching"). Tested with v1.9.4: noise and silence give "",
# a board saying just "Thank you." gives "Thank you." (the Library note "What the platform cuts").
ARG VAD_MODEL=ggml-silero-v5.1.2.bin
ARG VAD_SHA256=29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf
RUN curl -fsSL -o /vad.bin "https://huggingface.co/ggml-org/whisper-vad/resolve/main/$VAD_MODEL" \
    && echo "$VAD_SHA256  /vad.bin" | sha256sum -c -

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=build /model.bin /models/model.bin
COPY --from=build /vad.bin /models/vad.bin
RUN useradd -m stt
# whisper-server writes each clip to --tmp-dir for ffmpeg, and keeps it when the conversion fails (v1.9.4's
# convert_to_wav returns before deleting it, and so does its caller). So clips go to /clips, a size-capped tmpfs
# (infra/compose.yaml), never to disk, and a sweep deletes any older than a minute. A clip is only there while it
# converts: requests wait for the model's lock before writing theirs.
RUN mkdir -m 1777 /clips
USER stt
WORKDIR /home/stt
CMD while sleep 20; do find /clips -type f -mmin +1 -delete; done & \
    exec whisper-server --host 0.0.0.0 --port 8080 -m /models/model.bin --convert --tmp-dir /clips -t 3 \
      --vad --vad-model /models/vad.bin
