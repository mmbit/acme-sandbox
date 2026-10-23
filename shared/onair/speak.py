#!/usr/bin/env python3
"""Speaks an episode's lines on the voice machine (the `voice` run kind: Dockerfile): <work>/lines.json in (each line
its voice and its sentences), <work>/speech.flac out, each sentence a clip of its own, its engine's silence trimmed
and all at one level, and <work>/speech.json beside it, where each clip starts and ends (seconds, a list per line),
which make.py lays out into the episode with its pauses and sounds. Each line in its speaker's
voice from the desk phone: English with Pocket TTS itself, another language with Chatterbox Multilingual copying that
voice from a sample Pocket TTS speaks, so a crew member sounds the same in every language.

  /opt/voice/bin/python shared/onair/speak.py <work>
"""
import json, os, sys
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 24000
# what each voice says for Chatterbox to copy it from: about ten seconds, plain and even
SAMPLE = ('Good morning, and welcome back. Today we have a few stories for you, so let us get straight into it. '
          'There is plenty to talk about this week.')
# (a clip per sentence: make.py lays them out)
GAP = 0.3  # between clips, only so each is cut out cleanly
PIECE = 0.2  # between the pieces of one long sentence
LEVEL = 0.06  # every sentence at the same speech level (RMS), so neither voice sits under the other


def pieces(sentence, longest=300):
    """A sentence in pieces the engines speak well: a long one cut at a comma or a space before `longest`."""
    out, s = [], sentence.strip()
    while len(s) > longest:
        cut = max(s.rfind(', ', 0, longest), s.rfind(' ', 0, longest))
        cut = cut + 1 if cut > 0 else longest
        out.append(s[:cut].strip())
        s = s[cut:].strip()
    return out + [s] if s else out


def resample(x, rate):
    return x if rate == RATE else np.interp(np.arange(0, len(x), rate / RATE), np.arange(len(x)), x).astype(np.float32)


def clip(parts):
    """One sentence's clip: its pieces with a short pause between them, the engine's own silence before and after
    trimmed (so the pauses are make.py's), at the speech level."""
    gap = np.zeros(int(PIECE * RATE), np.float32)
    x = np.concatenate([y for p in parts for y in (gap, p)][1:] or [np.zeros(1, np.float32)])
    loud = np.flatnonzero(np.abs(x) > 0.01)
    if len(loud):
        x = x[max(0, loud[0] - int(0.01 * RATE)):loud[-1] + int(0.06 * RATE)]
    rms = float(np.sqrt(np.mean(x ** 2)))
    return x * min(LEVEL / rms, 4.0) if rms > 0 else x


# sentences in, their clips' places out
def joined(spoken):
    """Every sentence's clip one after another, GAP apart. With it, each clip's [start, end] in seconds, a list per
    line."""
    gap = np.zeros(int(GAP * RATE), np.float32)
    out, at, spans = [], 0, []
    for line in spoken:
        spans.append([])
        for sentence in line:
            x = clip(sentence)
            spans[-1].append([round(at / RATE, 3), round((at + len(x)) / RATE, 3)])
            out += [x, gap]
            at += len(x) + len(gap)
    return np.concatenate(out or [np.zeros(1, np.float32)]), spans


def spoken(work, job):
    # the image's models, never the network (a run's environment is only PATH, HOME, TMPDIR and LANG)
    os.environ.update(HF_HOME='/models', HF_HUB_OFFLINE='1', PKUSEG_HOME='/models/pkuseg')
    import torch
    from pocket_tts import TTSModel

    torch.manual_seed(0)
    pocket, states = TTSModel.load_model(), {}

    def phone(voice, text):
        states.setdefault(voice, pocket.get_state_for_audio_prompt(voice))
        return resample(pocket.generate_audio(states[voice], text).numpy().astype(np.float32), pocket.sample_rate)

    if job['lang'] == 'en':
        return [[[phone(x['voice'], p) for p in pieces(s)] for s in x['sentences']] for x in job['lines']]
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')
    for voice in {x['voice'] for x in job['lines']}:
        sf.write(work / f'sample-{voice}.wav', phone(voice, SAMPLE), RATE)

    def copied(voice, text):
        # cfg_weight 0: the sample is English, and this keeps its accent out of the other language (the model card)
        wav = model.generate(text, language_id=job['lang'], audio_prompt_path=str(work / f'sample-{voice}.wav'),
                             cfg_weight=0)
        return resample(wav.squeeze(0).cpu().numpy().astype(np.float32), model.sr)

    return [[[copied(x['voice'], p) for p in pieces(s)] for s in x['sentences']] for x in job['lines']]


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    work = Path(sys.argv[1])
    speech, spans = joined(spoken(work, json.loads((work / 'lines.json').read_text())))
    sf.write(work / 'speech.flac', speech, RATE)
    (work / 'speech.json').write_text(json.dumps(spans))
