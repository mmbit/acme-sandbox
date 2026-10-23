"""The agent's own voice taken out of what the board's microphone hears, before the line listens to it (AEC3)."""
import numpy as np
from livekit import rtc

RATE = 16000
BLOCK = RATE // 100  # the canceller works in 10 ms blocks
PLAYING = 1e-6       # a block's mean square above this: the agent's voice was playing (-60 dBFS)
# The line hears what the canceller lets through once it has heard this many blocks of the agent's voice, and the
# microphone as it is before that. Until then AEC3 is settling, and it takes out most of the board's words along with
# the echo: on the AEC Challenge's real recordings it kept 4 of 54 words said 0-5 s into the voice with no echo at all,
# 30 of 39 at 6-8 s, and about as many as the raw microphone does over a speaker's echo after that.
SETTLED = 600        # 6 s
# AEC3 follows the delay from the speaker back to the microphone only up to about 400 ms, and ignores any delay it's
# told, so the line finds it itself and holds what played back by it. Finding the delay: every second, the last 6 s of
# the microphone against what played over them and up to 2 s before, at 4 kHz (the voice's echo is mostly below 2 kHz).
# Once at least 2 s of them had the voice, the clearest match (GCC-PHAT: how well the two line up, whatever their
# loudness at each pitch) is the delay, if it stands out.
DOWNSAMPLE = 4                                  # 16 kHz to 4 kHz
MAX_DELAY_DOWNSAMPLED = 2 * RATE // DOWNSAMPLE  # the longest delay looked for: 2 s, a Bluetooth speaker's
WINDOW_DOWNSAMPLED = 6 * RATE // DOWNSAMPLE     # the microphone's stretch matched
LOOK_EVERY_BLOCKS = 100                         # blocks between looks
MIN_VOICED_BLOCKS = 200                         # blocks with the voice playing in the stretch before a look counts
PEAK_RATIO = 12                                 # the match stands out: its peak this many times the average
# What played is held back to 100 ms short of the delay found, and again once that leaves 0-300 ms (AEC3's to follow).
LEFT_TO_AEC3_SAMPLES = RATE // 10
HOLD_TOLERANCE_SAMPLES = 3 * RATE // 10


class Echo:
    """One call's canceller, the delay it found, and how much of the agent's voice it heard and took out, for the
    hang-up line."""
    def __init__(self):
        self.apm = rtc.AudioProcessingModule(echo_cancellation=True)
        self.near = self.far = np.zeros(0, np.int16)    # what's left over, short of a block
        self.played_before = np.zeros(MAX_DELAY_DOWNSAMPLED * DOWNSAMPLE, np.int16)  # what played, to hold it back
        self.shift = 0                                   # samples it's held back by
        self.delay = None                                # the delay last found, in samples
        # The last stretch of the microphone, and of what played (not held back) with the longest delay more before it,
        # both at 4 kHz.
        self.mic_down = np.zeros(WINDOW_DOWNSAMPLED, np.float32)
        self.voice_down = np.zeros(WINDOW_DOWNSAMPLED + MAX_DELAY_DOWNSAMPLED, np.float32)
        self.voiced = np.zeros(WINDOW_DOWNSAMPLED * DOWNSAMPLE // BLOCK, bool)  # which blocks had the voice
        self.since = 0                                   # blocks since the last look
        self.blocks = 0                                  # 10 ms blocks with the agent's voice playing
        self.played = self.heard = self.left = 0.0       # their energy once settled: voice, microphone, what's left

    def cancel(self, mic, voice=None):
        """The microphone's samples (16 kHz float32) with the agent's voice taken out once the canceller has settled, a
        whole number of blocks: the rest comes with the next ones. voice: what played over the same samples, as HQ read
        it (none: nothing played)."""
        near = np.concatenate([self.near, pcm(mic)])
        far = np.concatenate([self.far, pcm(voice) if voice is not None else np.zeros(len(mic), np.int16)])
        whole = len(near) // BLOCK * BLOCK
        self.near, self.far, out = near[whole:], far[whole:], near[:whole].copy()
        for i in range(0, whole, BLOCK):
            mic_block, played = near[i:i + BLOCK], self.hold_back(far[i:i + BLOCK])
            self.track_delay(mic_block, far[i:i + BLOCK])
            self.apm.process_reverse_stream(rtc.AudioFrame(played.tobytes(), RATE, 1, BLOCK))
            self.apm.set_stream_delay_ms(0)  # (AEC3 ignores it: the delay is in what it's given)
            near_block = rtc.AudioFrame(mic_block.tobytes(), RATE, 1, BLOCK)
            self.apm.process_stream(near_block)
            if self.blocks >= SETTLED:
                out[i:i + BLOCK] = np.frombuffer(near_block.data, np.int16)
            if (energy := power(played)) > PLAYING:
                self.blocks += 1
                if self.blocks > SETTLED:
                    self.played += energy
                    self.heard += power(mic_block)
                    self.left += power(out[i:i + BLOCK])
        return out.astype(np.float32) / 32768

    def hold_back(self, block):
        """What played, `shift` samples earlier."""
        self.played_before = np.concatenate([self.played_before[BLOCK:], block])
        end = len(self.played_before) - self.shift
        return self.played_before[end - BLOCK:end]

    def track_delay(self, mic_block, played):
        """Keep the last stretch of both, look for the delay every second, and move `shift` when it has moved."""
        self.mic_down = np.concatenate([self.mic_down[BLOCK // DOWNSAMPLE:],
                                        mic_block.reshape(-1, DOWNSAMPLE).mean(1) / 32768])
        self.voice_down = np.concatenate([self.voice_down[BLOCK // DOWNSAMPLE:],
                                          played.reshape(-1, DOWNSAMPLE).mean(1) / 32768])
        self.voiced = np.append(self.voiced[1:], power(played) > PLAYING)
        self.since += 1
        if self.since < LOOK_EVERY_BLOCKS or self.voiced.sum() < MIN_VOICED_BLOCKS:
            return
        self.since = 0
        if (found := find_delay(self.mic_down, self.voice_down)) is None:
            return
        self.delay = found * DOWNSAMPLE
        if not 0 <= self.delay - self.shift <= HOLD_TOLERANCE_SAMPLES:
            self.shift = max(0, self.delay - LEFT_TO_AEC3_SAMPLES)

    def report(self, agent):
        """The hang-up line: when the agent's voice came back, and how loud in the microphone while it played, against
        what played, before and after the line took it out (once AEC3 had settled). Numbers only. The board talking over
        the voice counts in both."""
        if not self.blocks:
            return f'call: {agent} echo: none of the agent\'s voice came beside the microphone'
        over = f'call: {agent} echo: over {self.blocks / 100:.0f} s of the agent\'s voice'
        if self.delay is None:
            found = 'no delay found'
        else:
            found = f'it came back {self.delay * 1000 // RATE} ms after it played'
        if not self.played:
            return f'{over}, {found}, too short to settle'
        db = lambda x: f'{10 * np.log10(max(x, 1e-12) / self.played):.0f} dB'
        return (f'{over}, {found}; once settled the microphone had it at {db(self.heard)}, '
                f'{db(self.left)} once the line took it out')


def find_delay(mic, voice):
    """How many samples (at the downsampled rate) after it played the voice shows up in the microphone (GCC-PHAT), or
    None if nothing stands out. mic: the stretch heard; voice: what played over it and up to MAX_DELAY_DOWNSAMPLED
    before, ending at the same moment."""
    n = 1 << int(np.ceil(np.log2(len(voice) + len(mic))))
    cross = np.fft.rfft(mic, n) * np.conj(np.fft.rfft(voice, n))
    match = np.abs(np.fft.irfft(cross / (np.abs(cross) + 1e-12), n))
    # match[k]: the microphone against what played k samples earlier, the stretch's end lined up
    lags = match[np.arange(MAX_DELAY_DOWNSAMPLED + 1) - (len(voice) - len(mic))]
    best = int(np.argmax(lags))
    return best if lags[best] > PEAK_RATIO * np.mean(lags) else None


def pcm(x):
    return (np.clip(x, -1, 32767 / 32768) * 32768).astype(np.int16)


def power(block):
    return float(np.mean((block / 32768) ** 2))
