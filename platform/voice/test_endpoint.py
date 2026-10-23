"""cd platform/voice && python3 -m unittest test_endpoint   (endpoint.py's input: numpy and onnxruntime; the model
itself with VOICE_MODELS set to a folder holding smart-turn-v3.2-cpu.onnx)

features() matches transformers' WhisperFeatureExtractor(chunk_length=8) with padding='max_length' and do_normalize,
on clips of 1 to 12.5 s, to within 5e-6.
"""
import os, unittest
from pathlib import Path

try:
    import numpy as np
    import endpoint
except ImportError:  # (numpy or onnxruntime: the voice image has both; elsewhere, see test_server.py)
    np = endpoint = None


@unittest.skipIf(endpoint is None, 'numpy or onnxruntime is not installed')
class Features(unittest.TestCase):
    def test_the_last_8_s_with_zeros_before_a_shorter_clip(self):
        rng = np.random.default_rng(1)
        clip = rng.standard_normal(3 * 16000).astype(np.float32)
        self.assertEqual(endpoint.features(clip).shape, (1, 80, 800))
        padded = np.concatenate([np.zeros(5 * 16000), clip])
        np.testing.assert_allclose(endpoint.features(clip), endpoint.features(padded), atol=1e-6)
        long = rng.standard_normal(12 * 16000).astype(np.float32)
        np.testing.assert_allclose(endpoint.features(long), endpoint.features(long[-8 * 16000:]), atol=1e-6)

    def test_the_spectrogram_is_whispers(self):
        """2 s of two tones (220 and 1800 Hz): its bands and the padding's floor as WhisperFeatureExtractor gives them."""
        t = np.arange(2 * 16000) / 16000
        clip = (0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * np.sin(2 * np.pi * 1800 * t)).astype(np.float32)
        got = endpoint.features(clip)[0]
        # (mel band, frame): 220 Hz, 1800 Hz and a band between them, in the tones; the zeros before them
        expected = {(5, 700): 1.7776244, (41, 700): 1.5222237, (10, 700): 0.5844526, (5, 100): -0.2223685}
        for (band, frame), value in expected.items():
            self.assertAlmostEqual(float(got[band, frame]), value, delta=1e-4, msg=(band, frame))


MODEL = Path(os.environ.get('VOICE_MODELS', '/models')) / 'smart-turn-v3.2-cpu.onnx'


@unittest.skipUnless(endpoint and MODEL.exists(), 'no model, or numpy or onnxruntime is not installed')
class Model(unittest.TestCase):
    def test_it_answers_a_probability(self):
        model = endpoint.Endpoint(MODEL)
        p = model.finished(np.zeros(16000, np.float32))
        self.assertTrue(0 <= p <= 1)


if __name__ == '__main__':
    unittest.main()
