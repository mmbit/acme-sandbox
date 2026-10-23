# The `voice` run kind (platform/helper/README.md): On Air's speech (speak.py) and video (below) on a machine with a
# graphics card. A run has no network, so every model is in the image: Pocket TTS with the desk phone's voices (as
# platform/voice/Dockerfile fetches them) and Chatterbox Multilingual. What the helper needs itself comes with the node
# image (node, perl, tar, find, sh). PyTorch's wheels bring CUDA; the machine brings its driver (`--gpus all`).
# Built and published by .github/workflows/onair-voice.yml; org.yaml's kind names it by digest.
FROM node:24.22.1-bookworm-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
# Python 3.13: the one where both take NumPy 2 (Chatterbox pins NumPy 1 below it), on Chatterbox's PyTorch 2.6
ENV UV_PYTHON_INSTALL_DIR=/opt/python HF_HOME=/models PKUSEG_HOME=/models/pkuseg PATH=/opt/voice/bin:$PATH
# (a run sees none of these: speak.py names the models' folders itself. Chatterbox's watermark imports pkg_resources,
# which Python 3.13 no longer brings and setuptools 81 dropped; its tokenizer fetches pkuseg's data on first use.)
RUN uv venv --python 3.13 /opt/voice \
    && uv pip install --python /opt/voice --no-cache pocket-tts==3.3.0 chatterbox-tts==0.1.7 soundfile==0.13.1 setuptools==80.9.0
# (caro_davy to daan: org.yaml's bigger pool)
RUN python -c "from pocket_tts import TTSModel; m = TTSModel.load_model(); [m.get_state_for_audio_prompt(v) for v in ('alba', 'jane', 'paul', 'michael', 'eve', 'bill_boerst', 'caro_davy', 'mary', 'eponine', 'george', 'peter_yearsley', 'daan')]" \
    && python -c "from chatterbox.mtl_tts import ChatterboxMultilingualTTS as M; M.from_pretrained(device='cpu')" \
    && chmod -R a+rX /models /opt/python /opt/voice
ENV HF_HUB_OFFLINE=1
# The episode's video (video.py: the demo kit's present.mjs) is drawn here too: Chromium through Playwright, as the
# worker has them, and ffmpeg. Last, so a machine that has the speech's layers pulls only these.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu fonts-noto-color-emoji \
    && npm install -g playwright@1.63.0 && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-playwright
