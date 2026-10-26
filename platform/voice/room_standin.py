"""The voice line's real join route (server.py's route, room.py, Call) on a local port, around stand-ins: a VAD that hears
speech wherever the audio is loud, a recogniser that hears "Can you hear me?", an agent that answers from a script,
a voice that hums its syllables, and a coordinator whose every link is open. For the join page's browser check against
the real line rather than its own stand-in.

    python room_standin.py <port> [origin]    (numpy and websockets; prints "ready" once it listens, then each call-end;
                                               origin: HQ's, the only page the line lets in; none: any page)


"""
import asyncio, functools, os, sys
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.update(HQ_URL='http://127.0.0.1:9', ORIGIN='', VOICE_TOKEN='stand-in')
import test_server  # noqa: E402 (its stand-ins for the models: no model is loaded)
import server  # noqa: E402

RATE = 16000
OPENING = "Hi, this is Ada from Testco. I'm an AI assistant, calling about our parcel."


class Loud:
    """The VAD: speech wherever a 32 ms window is loud enough for a voice, a quarter of a second at least."""
    def __init__(self, cfg, buffer_size_in_seconds):
        self.on, self.seg, self.done, self.n = False, [], [], 0

    def accept_waveform(self, x):
        self.on = float(np.sqrt(np.mean(x ** 2))) > 0.02
        if self.on:
            self.seg += list(x)
        else:
            # (its start counted in samples heard before this window, as Silero's: Call.hear reads it)
            if len(self.seg) > RATE // 4:
                self.done.append(NS(samples=self.seg, start=self.n - len(self.seg)))
            self.seg = []
        self.n += len(x)

    def is_speech_detected(self):
        return self.on

    def empty(self):
        return not self.done

    @property
    def front(self):
        return self.done[0]

    def pop(self):
        self.done.pop(0)


def hum(text):
    """The agent's voice: a 140 Hz hum, four syllables a second, as long as the words would take."""
    t = np.arange(int(max(1.0, len(text.split()) * 0.3) * RATE)) / RATE
    return (0.25 * np.sin(2 * np.pi * 140 * t) * np.abs(np.sin(2 * np.pi * 2 * t))).astype(np.float32)


class Agent(test_server.Brain):
    def __init__(self):
        super().__init__()
        self.opening, self.token, self.reply = OPENING, 'stand-in', "Yes, I hear you. Let me check that for you."


def coordinator(method, path, body=None):
    if path == 'join-ticket':
        return {'agent': 'ada', 'lang': 'en', 'callout': 1, 'name': 'Ada'}
    if path == 'call-end':
        print(f"call-end: {len(body['lines'])} lines, {len(body.get('notes') or [])} notes", flush=True)


async def main(port):
    server.sherpa_onnx.VoiceActivityDetector = Loud
    server.ORIGIN = sys.argv[2] if len(sys.argv) > 2 else ''  # (after test_server, which sets its own)
    if not server.ORIGIN:  # (any page: the coordinator's every link is open too)
        room_call = server.room_call

        async def any_page(ws, *given):
            server.ORIGIN = ws.request.headers.get('Origin')
            return await room_call(ws, *given)
        server.room_call = any_page
    server.Call.transcribe = lambda self, seg: 'Can you hear me?'
    server.pocket.generate_audio_stream = lambda state, text, stop=None: iter([NS(numpy=lambda: hum(text))]) (the route is given its call maker and what the line is wired to, which it
    # hands to its calls)
    files = Path(os.environ.get('TMPDIR', '/tmp'), f'room-standin-{os.getpid()}')
    files.mkdir(parents=True, exist_ok=True)
    wiring = server.Wiring(hq=coordinator, paths=server.Paths(calls=files, live=files))
    make_call = lambda *args, **kwargs: server.Call(*args, **kwargs, brain=Agent())
    route = functools.partial(server.route, make_call=make_call, wiring=wiring)
    async with server.serve(route, '127.0.0.1', port, max_size=1 << 20):
        print('ready', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main(int(sys.argv[1])))
