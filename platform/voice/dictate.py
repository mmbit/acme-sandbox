"""Review mode's live dictation: a note's words written down while the board says them (the README's "Dictation")."""
import asyncio, hmac, json, time
from urllib.parse import parse_qs, urlsplit

import numpy as np
from websockets.exceptions import ConnectionClosed

RATE = 16000
WINDOW = 512  # the VAD's window, in samples
# The audio a look takes from before the VAD called it speech, which it does 0.25 s in (server.py ONSET)
LEAD = int(0.4 * RATE)
# A look at the words of the phrase still being spoken, every this much of it (one at a time: a slow one skips the next)
LOOK = int(0.8 * RATE)
# A review note holds 4,000 characters (shared/review/review.js), about four and a half minutes of speech
LIMIT_SECONDS = 5 * 60
# Two dictations at once, a third is busy: each runs Parakeet every LOOK beside the calls' turns, on the same cores
AT_ONCE = 2
dictating = set()


async def dictation(ws, token, vad, transcribe, written, limit_seconds=LIMIT_SECONDS, monotonic=time.monotonic):
    """One dictation on its WebSocket, from the coordinator with the line's token. vad() makes a VAD as calls use it,
    transcribe(samples) gives the words in them, written(text, lang) the words as they're written down; limit_seconds:
    its length, and monotonic() the clock it's timed on, the line's unless a test gives its own."""
    if not hmac.compare_digest(ws.request.headers.get('Authorization', '').encode(), f'Bearer {token}'.encode()):
        return await ws.close(1008, 'token')
    if len(dictating) >= AT_ONCE:
        return await ws.close(1013, 'busy')
    lang = (parse_qs(urlsplit(ws.request.path).query).get('lang') or [''])[0]
    # (an outside reviewer has no language of ours: their words stay as heard, never cleaned up as another language's)
    d = Dictation(ws, vad(), transcribe, (lambda text: written(text, lang)) if lang else (lambda text: text), limit_seconds, monotonic)
    dictating.add(d)
    try:
        await d.run()
    finally:
        dictating.discard(d)


class Dictation:
    """The VAD cuts the board's words into phrases, each written down as it ends, with looks at the one still being
    spoken. Every heard event has all the words so far."""
    def __init__(self, ws, vad, transcribe, written, limit_seconds=LIMIT_SECONDS, monotonic=time.monotonic):
        self.ws, self.vad, self.transcribe, self.written, self.limit_seconds = ws, vad, transcribe, written, limit_seconds
        self.monotonic = monotonic
        self.began, self.limited = monotonic(), False
        self.pending = np.zeros(0, np.float32)  # what the VAD hasn't heard yet: less than a window
        self.n = 0  # the samples the VAD has heard
        # the audio since LEAD before the phrase being spoken (or before now), and where it starts
        self.chunks, self.kept = [], 0
        self.phrases = []  # the finished phrases' words
        self.phrase = 0  # how many phrases have ended, the one being spoken's number
        self.start, self.looked = None, 0  # where the phrase being spoken started (None: quiet), and its last look
        self.ended_at = 0  # where the last phrase ended: a look's lead never reaches back into it
        self.look = None  # the look under way

    async def run(self):
        how = 'ended'
        try:
            while (message := await self.next_message()) is not None:
                if isinstance(message, str):
                    if ended(message):
                        break
                    how = 'refused'
                    return await self.ws.close(1003, 'end is the only text message')
                if len(message) % 2:
                    how = 'refused'
                    return await self.ws.close(1003, '16-bit samples')
                # (what comes past its limit of audio isn't heard, however fast it came)
                await self.hear(np.frombuffer(message[:2 * self.room()], '<i2').astype(np.float32) / 32768)
            if message is None:
                self.limited, how = True, 'cut at the limit'
            await self.finish()
        except ConnectionClosed:
            how = 'dropped'
        finally:
            # (counted in dictating until its recognition is over: a thread can't be cancelled)
            if self.look:
                await asyncio.gather(self.look, return_exceptions=True)
            print(f'dictation: {how} after {self.n / RATE:.0f} s, {len(self.phrases)} phrases', flush=True)

    async def next_message(self):
        """The next frame, or None once the dictation has run its limit or taken in that much audio."""
        left = self.began + self.limit_seconds - self.monotonic()
        if not self.room():
            return None
        try:
            return await asyncio.wait_for(self.ws.recv(), max(left, 0))
        except TimeoutError:
            return None

    def room(self):
        """The samples still to be taken in."""
        return RATE * self.limit_seconds - self.n - len(self.pending)

    async def hear(self, samples):
        self.chunks.append(samples)
        self.pending = np.concatenate([self.pending, samples])
        phrases_ended = []
        while len(self.pending) >= WINDOW:
            self.vad.accept_waveform(self.pending[:WINDOW])
            self.pending, self.n = self.pending[WINDOW:], self.n + WINDOW
            phrases_ended += self.ended_phrases()
            if self.start is None and self.vad.is_speech_detected():
                self.start = self.looked = max(self.kept, self.ended_at, self.n - LEAD)
        for phrase_samples in phrases_ended:
            await self.write_down(phrase_samples)
            await self.send()
        if self.start is None:
            self.forget_before(self.n - LEAD)
        elif not self.look and self.n - self.looked >= LOOK:
            self.looked = self.n
            self.look = asyncio.create_task(self.peek(self.phrase, self.audio_since(self.start)))

    def ended_phrases(self):
        """The phrases the VAD has ended, taken off it: the next one starts afresh."""
        out = []
        while not self.vad.empty():
            out.append(np.array(self.vad.front.samples, np.float32))
            self.vad.pop()
            self.phrase, self.start, self.ended_at = self.phrase + 1, None, self.n
        return out

    async def write_down(self, samples):
        words = await asyncio.to_thread(self.transcribe, samples)
        if len(words) > 1:  # (a cough comes back as "." or nothing)
            self.phrases.append(words)

    async def peek(self, phrase, audio):
        """The words of the phrase being spoken so far, sent unless it has ended since (its own words went then)."""
        words = await asyncio.to_thread(self.transcribe, audio)
        self.look = None
        if phrase == self.phrase and len(words) > 1:
            await self.send(words)

    async def finish(self):
        """The mic stopped (or the limit came): the last phrase ends where the audio did, its words go, then done."""
        if self.look:
            await self.look
        if len(self.pending):
            self.vad.accept_waveform(np.concatenate([self.pending, np.zeros(WINDOW - len(self.pending), np.float32)]))
        self.vad.flush()
        for samples in self.ended_phrases():
            await self.write_down(samples)
        await self.send()
        await self.ws.send(json.dumps({'type': 'done', **({'limit': True} if self.limited else {})}))
        await self.ws.close()

    async def send(self, partial=''):
        text = ' '.join([*self.phrases, partial]).strip()
        heard = {'type': 'heard', 'text': self.written(text) if text else '', 'partial': bool(partial)}
        await self.ws.send(json.dumps(heard))

    def audio_since(self, start):
        return np.concatenate(self.chunks)[start - self.kept:]

    def forget_before(self, upto):
        while self.chunks and self.kept + len(self.chunks[0]) <= upto:
            self.kept += len(self.chunks.pop(0))


def ended(message):
    """Whether a text frame is the mic's end."""
    try:
        return json.loads(message).get('type') == 'end'
    except (ValueError, AttributeError):
        return False
