"""cd platform/voice && python3 -m unittest test_dictate   (dictate.py on a WebSocket pair in memory, with stand-in
models; numpy and websockets are used where they're installed, as in the voice image, and stood in for where they
aren't, as in the test runner)

The VAD hears speech wherever the audio is loud and ends a phrase at the first quiet window, and the recogniser reads
each phrase's words back from its loudness (part of them for part of its audio, as a look mid-phrase does).
"""
import asyncio, contextlib, io, itertools, json, struct, sys, threading, types, unittest, unittest.mock
from pathlib import Path
from types import SimpleNamespace as NS


def stub(name, **attrs):
    sys.modules[name] = m = types.ModuleType(name)
    m.__dict__.update(attrs)
    return m


class Samples(list):
    """A float32 array, as far as dictate.py and the stand-ins here use one."""
    def __getitem__(self, i):
        got = super().__getitem__(i)
        return Samples(got) if isinstance(i, slice) else got

    def astype(self, dtype):
        return self

    def __truediv__(self, by):
        return Samples(x / by for x in self)


try:
    import numpy  # noqa: F401
except ImportError:
    stub('numpy', float32='float32', zeros=lambda n, dtype: Samples([0.0] * n), array=lambda xs, dtype: Samples(xs),
         concatenate=lambda parts: Samples(itertools.chain(*parts)),
         frombuffer=lambda data, dtype: Samples(x for (x,) in struct.iter_unpack('<h', data)))
try:
    import websockets.exceptions  # noqa: F401
except ImportError:
    stub('websockets'), stub('websockets.exceptions', ConnectionClosed=type('ConnectionClosed', (Exception,), {}))

sys.path.insert(0, str(Path(__file__).parent))
import dictate  # noqa: E402
from dictate import ConnectionClosed  # noqa: E402

TOKEN = 'line-token'
CLOCK = [100.0]


class Vad:
    """Speech wherever a window is loud (> 0.5); a phrase is pushed at the first quiet window, or at a flush."""
    def __init__(self):
        self.on, self.seg, self.done = False, [], []

    def accept_waveform(self, x):
        loud = max(abs(v) for v in x) > 0.5
        if loud:
            self.seg += list(x)
        elif self.on:
            self.flush()
        self.on = loud

    def flush(self):
        if self.seg:
            self.done.append(NS(samples=self.seg))
        self.seg = []

    def is_speech_detected(self):
        return self.on

    def empty(self):
        return not self.done

    @property
    def front(self):
        return self.done[0]

    def pop(self):
        self.done.pop(0)


CLOSED = object()  # (the end that closed the line puts this in the other's way)


class End:
    """One end of a WebSocket: what it sends goes into the other's inbox."""
    def __init__(self, inbox, outbox, headers, path):
        self.inbox, self.outbox, self.request = inbox, outbox, NS(headers=headers, path=path)
        self.close_code = self.close_reason = None

    async def recv(self):
        message = await self.inbox.get()
        if message is CLOSED:
            self.inbox.put_nowait(CLOSED)
            raise ConnectionClosed(None, None)
        return message

    async def send(self, message):
        if self.close_code is not None:
            raise ConnectionClosed(None, None)
        self.outbox.put_nowait(message)

    async def close(self, code=1000, reason=''):
        if self.close_code is None:
            self.close_code, self.close_reason = code, reason
            self.outbox.put_nowait(CLOSED)

    async def __aiter__(self):
        with contextlib.suppress(ConnectionClosed):
            while True:
                yield await self.recv()


class Coordinator(End):
    """The coordinator's end: its close codes are the ones the line closed with."""
    def __init__(self, line, *args):
        super().__init__(*args)
        self.line = line

    close_code = property(lambda self: self.line.close_code, lambda self, v: None)
    close_reason = property(lambda self: self.line.close_reason, lambda self, v: None)

    def drop(self):
        """Gone without a word, as a closed tab is."""
        self.outbox.put_nowait(CLOSED)


class Dictation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.words, self.level = {}, 0.6  # what each phrase says, by its loudness

    def transcribe(self, samples):
        said = []
        for level, (text, n) in self.words.items():
            if got := sum(abs(x - level) <= 1e-4 for x in samples):
                words = text.split()
                said += words[:max(1, round(len(words) * got / n))] if got < n else words
        return ' '.join(said)

    def written(self, text, lang):
        return f'{lang}: {text}'

    def phrase(self, text, seconds):
        """PCM of the board saying `text` for this long."""
        self.level = round((self.level + 0.01) * 32768) / 32768
        n = int(seconds * 16000)
        self.words[self.level] = (text, n)
        return struct.pack('<h', round(self.level * 32768)) * n

    def quiet(self, seconds):
        return bytes(int(seconds * 16000) * 2)

    @contextlib.asynccontextmanager
    async def line(self, token=TOKEN, lang='en', limit=dictate.LIMIT_SECONDS):
        """A dictation on the voice line, from the coordinator with this token, of at most `limit` seconds."""
        up, down = asyncio.Queue(), asyncio.Queue()
        line = End(up, down, {'Authorization': f'Bearer {token}'}, f'/voice/dictate?lang={lang}')
        ws = Coordinator(line, down, up, {}, '')
        task = asyncio.create_task(dictate.dictation(line, TOKEN, Vad, self.transcribe, self.written, limit, lambda: CLOCK[0]))
        await asyncio.sleep(0)
        try:
            yield ws
        finally:
            up.put_nowait(CLOSED)
            await task

    async def say(self, ws, pcm, chunk=3200):
        """The microphone's frames, 100 ms each."""
        for i in range(0, len(pcm), chunk):
            await ws.send(pcm[i:i + chunk])
            await asyncio.sleep(0)

    async def heard(self, ws):
        return json.loads(await asyncio.wait_for(ws.recv(), 5))

    async def test_a_dictation_without_the_line_token_is_refused(self):
        for token in ('wrong', ''):
            async with self.line(token) as ws:
                with self.assertRaises(ConnectionClosed):
                    await ws.recv()
                self.assertEqual(ws.close_code, 1008)

    async def test_each_phrase_comes_as_it_ends_with_the_words_so_far(self):
        async with self.line() as ws:
            await self.say(ws, self.phrase('The button is too pale.', 0.5) + self.quiet(0.3))
            self.assertEqual(await self.heard(ws),
                             {'type': 'heard', 'text': 'en: The button is too pale.', 'partial': False})
            await self.say(ws, self.phrase('Make it blue.', 0.5) + self.quiet(0.3))
            self.assertEqual(await self.heard(ws),
                             {'type': 'heard', 'text': 'en: The button is too pale. Make it blue.', 'partial': False})

    async def test_a_phrase_still_being_spoken_shows_its_words_so_far(self):
        async with self.line() as ws:
            await self.say(ws, self.phrase('Done.', 0.3) + self.quiet(0.2))
            await self.heard(ws)
            pcm = self.phrase('The header should stay put when I scroll down the page', 3.0)
            await self.say(ws, pcm[:len(pcm) // 2])  # 1.5 s in: a look has gone
            look = await self.heard(ws)
            self.assertTrue(look['partial'])
            self.assertTrue(look['text'].startswith('en: Done. The header'), look)
            self.assertNotIn('page', look['text'])
            await self.say(ws, pcm[len(pcm) // 2:] + self.quiet(0.2))
            while (event := await self.heard(ws))['partial']:
                pass
            self.assertEqual(event['text'], 'en: Done. The header should stay put when I scroll down the page')

    async def test_the_end_writes_down_the_last_phrase_then_closes(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            async with self.line() as ws:
                await self.say(ws, self.phrase('Pumpernickel crumbs everywhere.', 1.0))
                await ws.send(json.dumps({'type': 'end'}))
                events = [json.loads(m) async for m in ws]
                self.assertEqual(ws.close_code, 1000)
                await asyncio.sleep(0.05)  # (the line logs once it has closed)
        last = {'type': 'heard', 'text': 'en: Pumpernickel crumbs everywhere.', 'partial': False}
        self.assertEqual(events[-2:], [last, {'type': 'done'}])
        self.assertTrue(all(e['partial'] for e in events[:-2]))
        self.assertIn('dictation: ended after 1 s, 1 phrases', out.getvalue())
        self.assertNotIn('Pumpernickel', out.getvalue())  # (never the words)

    async def test_a_dictation_ends_at_the_limit_with_its_words(self):
        async with self.line() as ws:
            await self.say(ws, self.phrase('Too long.', 1.0))
            self.assertTrue((await self.heard(ws))['partial'])  # (the line has heard it)
            CLOCK[0] += dictate.LIMIT_SECONDS
            await self.say(ws, self.quiet(0.1))
            events = [json.loads(m) async for m in ws]
        self.assertEqual(events[-2:], [{'type': 'heard', 'text': 'en: Too long.', 'partial': False},
                                       {'type': 'done', 'limit': True}])

    async def test_a_dictation_takes_in_five_minutes_of_audio_at_most_however_fast_it_comes(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            async with self.line(limit=3) as ws:
                await ws.send(self.phrase('Say it again.', 1.0) + self.quiet(1.0) + self.phrase('And again.', 2.0))
                events = [json.loads(m) async for m in ws]
        self.assertEqual(events[-2:], [{'type': 'heard', 'text': 'en: Say it again. And', 'partial': False},
                                       {'type': 'done', 'limit': True}])
        self.assertIn('dictation: cut at the limit after 3 s', out.getvalue())

    async def test_a_dictation_counts_until_its_recognition_is_over(self):
        gate, transcribe = threading.Event(), self.transcribe
        self.transcribe = lambda samples: gate.wait(5) and transcribe(samples)
        async with self.line() as ws:
            pcm = self.phrase('Hold that thought for a little while', 3.0)
            await self.say(ws, pcm[:len(pcm) // 2])  # (a look is under way, and waits)
            ws.drop()
            await asyncio.sleep(0.1)
            self.assertEqual(len(dictate.dictating), 1)
            gate.set()
        self.assertEqual(len(dictate.dictating), 0)

    async def test_a_dictation_without_a_language_writes_the_words_as_heard(self):
        async with self.line(lang='') as ws:
            await self.say(ws, self.phrase('Er, the logo.', 0.5) + self.quiet(0.3))
            self.assertEqual(await self.heard(ws), {'type': 'heard', 'text': 'Er, the logo.', 'partial': False})

    async def test_a_third_dictation_at_once_is_busy(self):
        async with self.line() as first, self.line() as second:
            await first.send(self.quiet(0.1))
            await second.send(self.quiet(0.1))
            await asyncio.sleep(0.05)
            async with self.line() as third:
                with self.assertRaises(ConnectionClosed):
                    await third.recv()
                self.assertEqual((third.close_code, third.close_reason), (1013, 'busy'))
        await asyncio.sleep(0.05)
        async with self.line() as again:  # (both over: there's room again)
            await again.send(json.dumps({'type': 'end'}))
            self.assertEqual([json.loads(m)['type'] async for m in again], ['heard', 'done'])


if __name__ == '__main__':
    unittest.main()
