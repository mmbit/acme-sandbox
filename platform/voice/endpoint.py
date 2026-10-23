"""Whether the board has finished its turn, heard from its voice.

Pipecat's Smart Turn v3 (BSD-2-Clause, a Whisper Tiny encoder with a classifier: pipecat-ai/smart-turn on GitHub)
listens to the last 8 s of the turn, up to the pause, and says how likely it is that the speaker has finished: the
intonation and the words of a sentence that trails off mid-thought ("so what I'd like is... ") sound different from
one that ends. The line asks it at each pause instead of reading the recogniser's full stop, which Parakeet writes at
almost every pause. Its input is Whisper's log-mel spectrogram (transformers' WhisperFeatureExtractor, chunk_length=8,
do_normalize), computed here with numpy so the image needs no transformers.
"""
import numpy as np
import onnxruntime as ort

RATE = 16000
SECONDS = 8
N_FFT, HOP, MELS = 400, 160, 80


def _mel_filters():
    """Slaney-style mel filters, as librosa's and transformers' (norm='slaney', mel_scale='slaney'): (201, 80)."""
    def mel(hz):
        hz = np.asarray(hz, np.float64)
        return np.where(hz >= 1000, 15 + np.log(np.maximum(hz, 1e-10) / 1000) * 27 / np.log(6.4), 3 * hz / 200)

    def hz(m):
        return np.where(m >= 15, 1000 * np.exp(np.log(6.4) / 27 * (m - 15)), 200 * m / 3)

    edges = hz(np.linspace(mel(0), mel(RATE / 2), MELS + 2))
    freqs = np.linspace(0, RATE / 2, N_FFT // 2 + 1)
    slopes = edges[np.newaxis, :] - freqs[:, np.newaxis]
    down = -slopes[:, :-2] / np.diff(edges)[:-1]
    up = slopes[:, 2:] / np.diff(edges)[1:]
    return np.maximum(0, np.minimum(down, up)) * (2 / (edges[2:] - edges[:-2]))


FILTERS = _mel_filters()
HANN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)  # (periodic)


def features(audio):
    """The model's input for 16 kHz float audio: its last 8 s, zeros before a shorter one, as (1, 80, 800)."""
    x = np.asarray(audio, np.float64)[-SECONDS * RATE:]
    x = np.pad(x, (SECONDS * RATE - len(x), 0))
    x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    x = np.pad(x, N_FFT // 2, mode='reflect')
    frames = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP][:-1]
    power = np.abs(np.fft.rfft(frames * HANN, axis=1)) ** 2
    spec = np.log10(np.maximum(power @ FILTERS, 1e-10)).T
    spec = np.maximum(spec, spec.max() - 8.0)
    return ((spec + 4.0) / 4.0).astype(np.float32)[np.newaxis]


class Endpoint:
    """The model, loaded once per process; finished() runs in a thread of its own, in parallel with other calls'."""

    def __init__(self, path):
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads, options.intra_op_num_threads = 1, 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])

    def finished(self, audio):
        """How likely the speaker has finished, from 0 to 1."""
        return float(self.session.run(None, {'input_features': features(audio)})[0].reshape(-1)[0])
