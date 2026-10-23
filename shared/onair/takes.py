"""An episode's speech by its sentences' takes (make.py): a take is a sentence's clip, 16-bit mono at the speech's
rate, by (voice, sentence as spoken), so speaking again keeps the takes of the sentences still said alike.
"""
import json, subprocess

RATE, APART = 24000, 0.3  # the speech's samples a second, and the silence between its clips (speak.py)


def pcm(file):
    """A sound's samples, 16-bit mono at the speech's rate."""
    return subprocess.run(['ffmpeg', '-v', 'error', '-i', str(file), '-f', 's16le', '-ac', '1', '-ar', str(RATE), '-'],
                          check=True, capture_output=True).stdout


def write(speech, out):
    """The samples as a WAV file."""
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(RATE), '-ac', '1', '-i', '-',
                    '-c:a', 'pcm_s16le', str(out)], input=speech, check=True)


def cut(speech, said, clips):
    """Each sentence's take in a speech, by (voice, sentence as spoken)."""
    return {(x['voice'], s): speech[offset(a):offset(b)] for x, spans in zip(said, clips)
            for s, (a, b) in zip(x['sentences'], spans)}


def offset(seconds):
    """Where a time falls in the samples, in bytes."""
    return 2 * round(seconds * RATE)


def kept(wav, spoken):
    """The kept speech's takes (cut()), from its WAV and its speech.json; none when there's no kept speech."""
    if not (wav.exists() and spoken.exists()):
        return {}
    old = json.loads(spoken.read_text())
    return cut(pcm(wav), old['lines'], old['clips'])


def joined(said, have):
    """The lines' takes one after another, APART apart, and each turn's sentences' [start, end] in seconds."""
    gap, out, at, clips = bytes(offset(APART)), [], 0, []
    for x in said:
        clips.append([])
        for s in x['sentences']:
            take = have[(x['voice'], s)]
            clips[-1].append([round(at / 2 / RATE, 3), round((at + len(take)) / 2 / RATE, 3)])
            out += [take, gap]
            at += len(take) + len(gap)
    return b''.join(out), clips
