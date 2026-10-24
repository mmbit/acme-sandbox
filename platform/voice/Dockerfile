# The voice line (server.py), built from platform/ (it borrows the worker's hq command): Silero VAD and Parakeet (sherpa-onnx) for the board's words,
# Smart Turn for when it has finished, Pocket TTS (English, Dutch and German, in each agent's own voice) and Piper (native Dutch and German voices: for a voice Pocket TTS garbles
# Dutch in, and a care call's voice per language thorsten or kerstin) for the agent's, and the Claude CLI for the agent's side of the call. Internal only; audio
# is never stored. Every model is fetched at build time, so a call never waits for a download.
FROM node:24.22.1-bookworm-slim
# (tzdata: the line says when a seat's limit ends on the company's clock, company.timeZone.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv curl bzip2 ca-certificates jq tzdata \
    && rm -rf /var/lib/apt/lists/*
# Pinned like the worker's: a rebuild installs exactly what was reviewed (bump deliberately).
RUN npm install -g @anthropic-ai/claude-code@2.1.283
# This container holds the line's token and a seat's sign-in, so its Python packages and models are pinned too, like
# platform/stt's and the coordinator's: every package by version and sha256 (requirements.txt: pip refuses any other
# file), every model by sha256, and Pocket TTS's weights and voices at the Hugging Face commits its pinned version
# names, each file checked. A new version or model means new sums (requirements.txt says how).
COPY voice/requirements.txt /venv-requirements.txt
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir --require-hashes -r /venv-requirements.txt
ENV PATH=/venv/bin:$PATH HF_HOME=/models/hf
WORKDIR /models
ARG SHERPA_MODELS=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models
ARG PARAKEET_SHA256=5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf
ARG SILERO_SHA256=9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6
ARG PIPER_VOICES=https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/nl/nl_NL/alex/medium
ARG PIPER_SHA256=22f0497c4d895a09fbc6a469459aa8954ea0955d3c6e19dbcc2e23acbb93e30b
ARG PIPER_JSON_SHA256=9ea643871742c038511b6aaf20e6fc098a78a11968122d2f6ca3e50403423f95
ARG PIPER_DE=https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/de/de_DE/thorsten/medium
ARG PIPER_DE_SHA256=7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819
ARG PIPER_DE_JSON_SHA256=974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85
# (kerstin: a woman's German voice, CC0, 16 kHz).
ARG PIPER_DE_F=https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/de/de_DE/kerstin/low
ARG PIPER_DE_F_SHA256=d352a7641892cebf2903859af94e9ba81a141110215fe3943bcda7f7da401b7a
ARG PIPER_DE_F_JSON_SHA256=56e708556b7b9b7a53c4f8957e021421e69f11a600962bba554cffbe72cf2d47
RUN curl -fsSL -o parakeet.tar.bz2 "$SHERPA_MODELS/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2" \
    && curl -fsSL -o silero_vad.onnx "$SHERPA_MODELS/silero_vad.onnx" \
    && curl -fsSL -o nl_NL-alex-medium.onnx "$PIPER_VOICES/nl_NL-alex-medium.onnx" \
    && curl -fsSL -o nl_NL-alex-medium.onnx.json "$PIPER_VOICES/nl_NL-alex-medium.onnx.json" \
    && curl -fsSL -o de_DE-thorsten-medium.onnx "$PIPER_DE/de_DE-thorsten-medium.onnx" \
    && curl -fsSL -o de_DE-thorsten-medium.onnx.json "$PIPER_DE/de_DE-thorsten-medium.onnx.json" \
    && curl -fsSL -o de_DE-kerstin-low.onnx "$PIPER_DE_F/de_DE-kerstin-low.onnx" \
    && curl -fsSL -o de_DE-kerstin-low.onnx.json "$PIPER_DE_F/de_DE-kerstin-low.onnx.json" \
    && printf '%s  %s\n' "$PARAKEET_SHA256" parakeet.tar.bz2 "$SILERO_SHA256" silero_vad.onnx \
         "$PIPER_SHA256" nl_NL-alex-medium.onnx "$PIPER_JSON_SHA256" nl_NL-alex-medium.onnx.json \
         "$PIPER_DE_SHA256" de_DE-thorsten-medium.onnx "$PIPER_DE_JSON_SHA256" de_DE-thorsten-medium.onnx.json \
         "$PIPER_DE_F_SHA256" de_DE-kerstin-low.onnx "$PIPER_DE_F_JSON_SHA256" de_DE-kerstin-low.onnx.json | sha256sum -c - \
    && tar xjf parakeet.tar.bz2 && rm parakeet.tar.bz2 \
    && mv sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 parakeet && rm -rf parakeet/test_wavs
# (pocket-tts 3.3.0 names the commits: each language's model and tokenizer, and the voices' embeddings; bill_boerst: a
# third man's voice for org.yaml; caro_davy to daan: org.yaml's bigger pool,
# Dutch and German: Their configs try a gated repository first, then fall back to these files.)
RUN python -c "from pocket_tts import TTSModel; [[m.get_state_for_audio_prompt(v) for v in ('alba', 'jane', 'paul', 'michael', 'eve', 'bill_boerst', 'caro_davy', 'mary', 'eponine', 'george', 'peter_yearsley', 'daan')] for m in (TTSModel.load_model(language=l) for l in ('english', 'dutch', 'german'))]" \
    && cd /models/hf/hub/models--kyutai--pocket-tts-without-voice-cloning/snapshots \
    && printf '%s  %s\n' \
      916ccd2686e9311cb40054893a3c4284393d658825ffc714a276f3e9b152344f e7205b6ee50e654a5ea19f0e9df2b0813b05e921/languages/english/model.safetensors \
      f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687 00eac05ed3d16bdc3f6b5d598874019c34a89214/languages/english/tokenizer.json \
      d291428b416d6c36a1de7835e51dbe1e334b75e5af512bb18dd23a1047fe8f3b 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/alba.safetensors \
      fe0e73c3a01f9d3b344ce19c912654df1464cb4077393e188d54f6cff990c05f 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/jane.safetensors \
      400ea75cecbe796e6adab3526264acd7ca3f3cb39f9785f531f194bdc3b26007 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/paul.safetensors \
      401711f60394aa6085627f7050c1b3f97b31aa7138784811bc6c6ec7d7eaad0c 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/michael.safetensors \
      ec2bf13d4ac4bcee200ee7aec1deae8132bb5bd60233f815e12a4d8efe56b8c6 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/eve.safetensors \
      b4fb8f505ba23d5ace1b86210a4a26dd9da735463faf213c8b1f16dfd597debd 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/bill_boerst.safetensors \
      6361bef0343a04a1c9947d624c21b1ee3d0f430a332a50c2f32a992e55b2922b 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/caro_davy.safetensors \
      8eaed3701d6ba5602393b50876f6639d3ed5d7aacc356a3ee6337957a7cbe9d2 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/mary.safetensors \
      0bcc4878ad3183ef8bfdbaf9224c5a71f1d18fe944fb494818c37e1f8ea6c7d0 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/eponine.safetensors \
      9cee0daccb0eda1631b73f8b35f6f8cb195885d55d2e1e20fc711f9e4456ceb0 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/george.safetensors \
      bbaf032c5887c5620f46e3d9dd213d97c9d3277a687d2944107eaa535e1d3483 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/peter_yearsley.safetensors \
      fe84a4e36ecfefc5d629f4f56e82b77a3428f6447f59698a8fc987920ad44991 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/daan.safetensors \
      0de1e5b074458de1330a264d0de39649a51eedf001cc30d181b80c7b0d00e61d 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/model.safetensors \
      e6f610b98c427641b4ab0e1024dca7843e3d6b620871a14b204932e42c5a1736 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/tokenizer.json \
      f13840d3c6ebafc4d0f93f4b5cee08760f0491f171ccde013ac73b7506a88762 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/alba.safetensors \
      1a7b795399c1f57e628b972639b4d4d849842f37172bb1ee288c8dfc2ebd956c 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/jane.safetensors \
      95a36b95bf9956680432cfe075e36671bef2d582c37f7bd56f0a45fc98656dd4 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/paul.safetensors \
      bec6346cae7fa74f347f3ce0123a2a73c7eb84fa3e7238ac97d3046e0698e23d 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/michael.safetensors \
      4fdaf98ce586380979c07c49f892127545e9f46d8a044f9023f40a19312c9201 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/eve.safetensors \
      1aa661a84ca700915a332251f3c8d89b1a2cbaa84b4821b38b7c00a659338217 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/bill_boerst.safetensors \
      eb149d9ef8a602298cd00970ea28ab2bfef9b987989bb9b2f785a055baefac53 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/caro_davy.safetensors \
      659770d2af1d0188dbd1cb2d5a882c3dc2509a1cbc5252e858ff4383a5f69eaf 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/mary.safetensors \
      f9e55c4299e6a4205041b80c4d73b74d3ae25e805865d9ccfb3d55cc2096dd5e 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/eponine.safetensors \
      5888908fbe3de03f526b36736d7f957fb96a46c7fb4982c5bbd12cc3fba97f34 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/george.safetensors \
      26f8b1d5e4de2631955a97b4f34f89bc347819fb962a997506ef14fe03e3837b 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/peter_yearsley.safetensors \
      a84d8ad16a34548f91098a9cc364f433b20f0400d95fad7475e481b5b085a023 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/dutch/embeddings/daan.safetensors \
      d2fabbc2c383d30ee29fcd374f8281406cc501b1d963fe687691f8573de3252b 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/model.safetensors \
      2d77849811e3d1b6ae80e5b11b203f57e1847901104d8a0573b34f46f8dddb53 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/tokenizer.json \
      b65ba9d7ffeb98dcef6b4d61498623125144078ae8caebe1e9e9f92b7c8cafec 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/alba.safetensors \
      c3993c4a4562ea95d5c46ab080dad6497084464d808a9a2d832082dcd283eb1b 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/jane.safetensors \
      4d6b08d98acd81aff9cb2c0408c4442b9b10f9d5f55f1ec6fffc1890e421a813 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/paul.safetensors \
      04652331d115da987fbac0fbcd2ca7c39bca6bca643015c6b2cc954107c61061 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/michael.safetensors \
      fc9e4e0d6dfd929a9cd2faa8c923edb1853f3e74c556b42cefe7991eab55a064 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/eve.safetensors \
      5a604135f13ecf9c6be37b5bac214849a9ce3a8b94e8a0fa8a335b503be50cb5 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/bill_boerst.safetensors \
      0dd324feaa3aaa692804d7034ba5151ab9f74883eac925e127c2e3284b233729 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/caro_davy.safetensors \
      b9168821d97b51ec61286994916e669f77cd1d25c918184518869159cc39104c 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/mary.safetensors \
      4be1fb0ab8903d0f672c19b9b03280c88cd7750ea3c8f14c479ec0275689d9e2 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/eponine.safetensors \
      6f63ade48bc4047d7fcba77e075c8dfd3f4d5b1dbcd18971ac040b8c934830e0 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/george.safetensors \
      0e0d68be471574a2faa8d7465ebf5c50d228a066099a0253d50cc3fff1ce0ae3 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/peter_yearsley.safetensors \
      547ca37f269ccfa3daaf203ae5db8747f5298b95f20100dbe23e09d0c0cff41a 4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/embeddings/daan.safetensors \
    | sha256sum -c -
# Smart Turn v3.2 (Pipecat's, BSD-2-Clause: endpoint.py), which hears whether the board has finished its turn, at its
# Hugging Face commit
ARG SMART_TURN=https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93
ARG SMART_TURN_SHA256=2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f
RUN curl -fsSL -o smart-turn-v3.2-cpu.onnx "$SMART_TURN/smart-turn-v3.2-cpu.onnx" \
    && printf '%s  %s\n' "$SMART_TURN_SHA256" smart-turn-v3.2-cpu.onnx | sha256sum -c -
# turns.py too (server.py logs each call's numbers from it, then forgets the session), echo.py, aloud.py (numbers in
# words, shared with On Air), room.py (a call out's room on the join page) and endpoint.py
COPY voice/server.py voice/aloud.py voice/guard.py voice/hq_tools.py voice/turns.py voice/echo.py voice/room.py \
     voice/endpoint.py /app/
# (and the TypeScript it runs, beside it as in the repo)
COPY worker/bin/hq /usr/local/bin/hq
COPY worker/hq /usr/local/hq
# uid 1500, like the worker's keeper that writes the Claude token it reads (/seat, a volume of its own); this
# container sees no other seat. The call agent runs as this uid too: guard.py keeps the line's token from it.
RUN useradd -m -u 1500 caller && mkdir -p /data && chown caller /data
USER caller
ENV HF_HUB_OFFLINE=1
CMD ["python", "/app/server.py"]
