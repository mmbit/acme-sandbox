"""Replays sounds over a reply through the real models (Silero VAD, Parakeet) and the real Call.hear(), in real time.

    VOICE_MODELS=/models python replay.py [phone] [clip.wav ...]     (phone: through the phone line's 8 kHz mu-law, as
                                                                       Twilio sends it; clips: these recorded sounds instead)
    VOICE_MODELS=/models python replay.py echo <folder> [ms]         (the agent's own voice coming back, recorded; ms:
                                                                       that much later again, as on a slower device)

The board's side is synthesised with Piper (en_US-lessac-medium.onnx next to the other models, else Pocket TTS for
English) and mixed into quiet room noise; the agent's side is a stand-in Claude session, and its reply is heard for
10 s. Each case says whether the reply was stopped, how long after the sound began, and what the agent was asked.
Outside the image: a venv with numpy sherpa-onnx piper-tts websockets livekit, and the models the Dockerfile fetches.

echo: the folder holds real recordings of a voice played through a device's speaker and picked up by its microphone,
as Microsoft's AEC Challenge records them (its datasets/blind_test_set_icassp2022/farend-singletalk on GitHub: X_mic.wav
is what the microphone heard, X_lpb.wav what played, and nearend-singletalk's X_mic.wav someone talking). Each pair is
heard over the reply as its echo, with what played beside it as HQ sends it: alone, it must play on and ask nothing;
with someone talking over it (a nearend X_mic.wav from the folder, else Piper), it must stop. The recordings come back
4-400 ms after they played; ms adds to that, as on a device whose echo comes back late.
"""
import asyncio, os, sys, tempfile, time, types, wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault('HQ_URL', 'http://127.0.0.1:9')
os.environ.setdefault('ORIGIN', 'https://hq.test')
os.environ.setdefault('VOICE_TOKEN', 'replay')
try:
    import pocket_tts  # noqa: F401
except ImportError:  # (the agent's voice doesn't matter here: 2 s of near silence a sentence)
    class Quiet:
        sample_rate = 16000

        # (a model per language)
        def __init__(self, language='english', temp=None):
            pass

        def get_state_for_audio_prompt(self, v):
            return v

        def generate_audio_stream(self, state, text, stop=None):
            yield types.SimpleNamespace(numpy=lambda: np.zeros(32000, np.float32))
    sys.modules['pocket_tts'] = types.SimpleNamespace(TTSModel=types.SimpleNamespace(load_model=Quiet))
import server  # noqa: E402
from piper import PiperVoice  # noqa: E402

RATE, rng = server.RATE, np.random.default_rng(7)
REPLY = ("Sure, I'll check the orders now. Then I'll look at the invoices. And after that, the parcels. "
         "Then the returns from last week. And I'll tell you what I find.")


def voice(lang, text):
    """The board saying `text`, trimmed."""
    path = server.MODELS / ('nl_NL-alex-medium.onnx' if lang == 'nl' else 'en_US-lessac-medium.onnx')
    if path.exists():
        v = PiperVoice.load(str(path))
        x = np.concatenate([np.frombuffer(c.audio_int16_bytes, np.int16) for c in v.synthesize(text)]).astype(np.float32) / 32768
        x = server.resample(x, v.config.sample_rate, RATE)
    else:
        x = np.concatenate([c.numpy() for c in server.pocket.generate_audio_stream(server.pocket.get_state_for_audio_prompt('eve'), text)])
        x = server.resample(x.astype(np.float32), server.pocket.sample_rate, RATE)
    loud = np.nonzero(np.abs(x) > 0.01)[0]
    return x[loud[0]:loud[-1]]


def footsteps(n=6, gap=0.55, gain=0.8):
    """Low thuds with a click, like steps on a wooden floor near the phone."""
    out, t = np.zeros(int(RATE * (n * gap + 0.3)), np.float32), np.arange(int(0.12 * RATE)) / RATE
    for i in range(n):
        s = np.sin(2 * np.pi * rng.uniform(50, 80) * t) * np.exp(-t * 35) + 0.3 * rng.standard_normal(len(t)) * np.exp(-t * 120)
        k = int(i * gap * RATE)
        out[k:k + len(t)] += gain * s
    return out


def noise(kind, sec):
    """Sounds Silero takes for speech (Parakeet hears "Mm.", "Yeah."): a creak, a cough, a breath into the phone."""
    t = np.arange(int(sec * RATE)) / RATE
    if kind == 'creak':  # a gliding buzz, like a chair
        ph = 2 * np.pi * np.cumsum(180 + 120 * np.sin(2 * np.pi * 1.3 * t)) / RATE
        x = sum(np.sin(k * ph) / k for k in range(1, 12)) * (0.6 + 0.4 * rng.random(len(t)))
        return (0.3 * x * np.hanning(len(t))).astype(np.float32)
    x = np.fft.rfft(rng.standard_normal(len(t)))
    f = np.fft.rfftfreq(len(t), 1 / RATE)
    x = np.fft.irfft(x * (np.exp(-((f - 700) / 500) ** 2) + 0.6 * np.exp(-((f - 1500) / 600) ** 2)), len(t))
    env = np.exp(-t * 9) * (1 - np.exp(-t * 200)) if kind == 'cough' else np.hanning(len(t)) ** 2 * 0.3
    return (0.5 * x / np.abs(x).max() * env).astype(np.float32)


# (clink, recorded clips, the 10 s reply, the stand-in's new attributes)
def clink(gain=0.6):
    """A glass bottle put down on a table: a thud, a bright ring that dies away, and a smaller second knock as it settles."""
    t = np.arange(int(0.6 * RATE)) / RATE
    ring = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * d) for f, a, d in ((1870, 1, 9), (3410, 0.6, 14), (5230, 0.4, 20)))
    hit = ring + np.sin(2 * np.pi * 110 * t) * np.exp(-t * 40) + 0.5 * rng.standard_normal(len(t)) * np.exp(-t * 300)
    knock = np.zeros(int(0.9 * RATE))
    knock[:len(hit)] += hit
    knock[int(0.18 * RATE):int(0.18 * RATE) + len(hit)] += 0.4 * hit
    return (gain * knock / np.abs(knock).max()).astype(np.float32)


def recorded(path):
    """A recorded sound (16-bit wav), trimmed to where it's loud."""
    with wave.open(path) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        x = server.resample(x[::w.getnchannels()], w.getframerate(), RATE)
    loud = np.nonzero(np.abs(x) > 0.01)[0]
    return x[loud[0]:loud[-1]] if len(loud) else x


def silence(sec):
    return np.zeros(int(sec * RATE), np.float32)


class Brain:
    def __init__(self):
        self.asked, self.busy, self.token, self.voice, self.respell = [], False, '', 'alba', {}
        self.tz, self.seat = 'UTC', None

    def moved(self):
        return False

    async def ask(self, text, pictures=()):
        self.asked.append(text)
        for w in REPLY.split(' '):
            yield w + ' '
            await asyncio.sleep(0)

    def interrupt(self):
        pass

    def kill(self):
        pass

    def close(self):
        pass


async def case(wiring, lang, sound, at, phone, played=None, earlier=None):
    """The board asks, and `at` s after the reply is first heard, makes `sound` over it (on a call wired to `wiring`: the
    line's files). played: what HQ played over
    `sound` (an echo case: `sound` holds it as the microphone heard it); earlier: the echo of earlier replies and what
    played then, which the call's canceller has heard already."""
    events, cut, heard = [], [], []

    async def event(e):
        events.append(e)

    async def clear():
        cut.append(time.monotonic())

    async def audio(x):
        heard.append(heard[0] if heard else time.monotonic())

    call = server.Call(audio, event, clear, 'ceo', lang, wiring=wiring)
    call.brain = brain = Brain()
    if earlier:
        for i in range(0, len(earlier[0]) - 319, 320):
            call.echo.cancel(earlier[0][i:i + 320], earlier[1][i:i + 320])
    # (the reply is first heard about 1.1 s after the board stops: the recogniser's pause, the wait, the first words)
    ask = 'Kun je vandaag nog even alle bestellingen nakijken?' if lang == 'nl' else 'Can you check the orders?'
    stream = [silence(0.5), voice(lang, ask), silence(1.1 + at)]
    start = sum(len(x) for x in stream) / RATE
    stream += [sound, silence(4)]
    x = np.concatenate(stream) + 0.003 * rng.standard_normal(sum(len(s) for s in stream)).astype(np.float32)
    voiced = np.zeros(len(x), np.float32)  # (what HQ played: an echo case's, where its sound is)
    if played is not None:
        voiced[round(start * RATE):round(start * RATE) + len(played)] = played
    t0, step = time.monotonic(), RATE // 50  # 20 ms pieces, in real time
    for i in range(0, len(x), step):
        piece = x[i:i + step]
        if phone:  # (phone_call: mu-law at 8 kHz, back to 16 kHz)
            piece = server.resample(server.ulaw_decode(server.ulaw_encode(server.resample(piece, RATE, 8000))), 8000, RATE)
        await call.hear(piece, voiced[i:i + step] if played is not None else None)
        await asyncio.sleep(max(0, t0 + (i + step) / RATE - time.monotonic()))
    await asyncio.sleep(0.5)
    if not heard:
        return f"no reply to talk over: the recogniser didn't hear the question; asked {brain.asked}"
    stopped = f'stopped {cut[0] - t0 - start:.2f} s after the sound began' if cut else 'played on'
    return f'{stopped}; reply heard from {heard[0] - t0:.1f} s, sound at {start:.1f} s; asked {brain.asked}'


def echoes(folder, later=0):
    """Echo cases from recordings: the agent's voice as the microphone heard it (`later` ms later than recorded), alone
    and with someone talking over it 3 s in, and what played (8 s from where it's loud), after the 8 s before them, as
    an earlier reply."""
    folder, out = Path(folder), []
    talkers = [recorded(str(f))[:3 * RATE] for f in sorted(folder.glob('*nearend*_mic.wav'))]
    for k, mic in enumerate(sorted(folder.glob('*farend*_mic.wav'))):
        heard, played = [recorded_as_is(str(f)) for f in (mic, mic.with_name(mic.name.replace('_mic', '_lpb')))]
        heard = np.concatenate([np.zeros(later * RATE // 1000, np.float32), heard])[:len(heard)]
        loud = np.nonzero(np.abs(played) > 0.01)[0]
        start = loud[0] if len(loud) else 0
        earlier = heard[start:start + 8 * RATE], played[start:start + 8 * RATE]
        heard, played = heard[start + 8 * RATE:start + 16 * RATE], played[start + 8 * RATE:start + 16 * RATE]
        heard[:later * RATE // 1000] = 0  # (the echo of the earlier reply's end is cut: its voice is not in `played`)
        talker = talkers[k % len(talkers)] if talkers else voice('en', "Hold on, that's not what I asked, I meant the invoices.")
        # (as recorded: a browser whose canceller took none of it out; 20 dB down: what one that took most of it leaves)
        for gain, level in ((1, ''), (0.1, ' -20 dB')):
            over = heard * gain
            over[3 * RATE:3 * RATE + len(talker)] += talker[:len(over) - 3 * RATE]
            out += [('en', f'{mic.name[:12]} echo{level}', heard * gain, played, (earlier[0] * gain, earlier[1])),
                    ('en', f'{mic.name[:12]} echo{level}, talked over', over, played, (earlier[0] * gain, earlier[1]))]
    return out


def recorded_as_is(path):
    """A recording, untrimmed (an echo and what played line up sample for sample)."""
    with wave.open(path) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        return server.resample(x[::w.getnchannels()], w.getframerate(), RATE)


async def main(phone, clips):
    wiring = server.Wiring(paths=server.Paths(calls=Path(tempfile.mkdtemp())))
    en = lambda t: voice('en', t)
    cases = [('en', 'a lone "okay"', en('Okay.'), 1.5), ('en', '"mhm"', en('Mhm.'), 1.5), ('en', '"okay, okay"', en('Okay, okay.'), 1.5),
             ('en', '"yeah, right, sure"', en('Yeah, right, sure.'), 1.5), ('en', 'footsteps', footsteps(), 1.5),
             ('en', 'a creak', noise('creak', 0.5), 1.5), ('en', 'a cough', noise('cough', 0.35), 1.5),
             ('en', 'two coughs', np.concatenate([noise('cough', 0.35), silence(0.2), noise('cough', 0.35)]), 1.5),
             ('en', 'a breath', noise('breath', 0.8), 1.5), ('en', 'a bottle put down', clink(), 1.5),
             ('en', 'a bottle put down, early', clink(), 0.2),
             ('nl', 'a lone "oké"', voice('nl', 'Oké.'), 1.5), ('nl', '"ja, precies"', voice('nl', 'Ja, precies.'), 1.5),
             ('en', '"okay", then more', np.concatenate([en('Okay.'), silence(0.5), en('So what about the invoices?')]), 1.5),
             ('en', 'a lone "Wait."', en('Wait.'), 1.5), ('en', '"Wait, stop."', en('Wait, stop.'), 1.5),
             ('en', 'a real interruption', en("Hold on, that's not what I asked, I meant the invoices from last week."), 1.5),
             ('nl', 'a real interruption', voice('nl', 'Nee wacht, ik bedoelde de facturen van vorige week.'), 1.5),
             ('en', 'carrying on as it starts', en('and the invoices from last week too, please.'), 0.2)]
    cases = [('en', Path(clip).name, recorded(clip), 1.5) for clip in clips] or cases
    for lang, name, sound, at in cases:
        print(f'{lang} {name:26s} {await case(wiring, lang, sound, at, phone)}', flush=True)


async def main_echo(folder, later):
    wiring = server.Wiring(paths=server.Paths(calls=Path(tempfile.mkdtemp())))
    for lang, name, sound, played, earlier in echoes(folder, later):
        print(f'{lang} {name:30s} {await case(wiring, lang, sound, 0.2, False, played, earlier)}', flush=True)


if __name__ == '__main__':
    if sys.argv[1:2] == ['echo']:
        asyncio.run(main_echo(sys.argv[2], int(sys.argv[3]) if sys.argv[3:] else 0))
    else:
        asyncio.run(main('phone' in sys.argv[1:], [a for a in sys.argv[1:] if a != 'phone']))
