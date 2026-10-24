"""What the line takes with care calls and a board call at once: memory and
CPU, through the real Silero VAD, Parakeet, Pocket TTS and Piper, the brains scripted.

    VOICE_MODELS=/models taskset -c 0-3 python load_check.py [langs] [seconds]     (langs: the care callers', default nl,de;
                                                                                    150 s)

First a board call alone (the line's usual load, for comparison), then the care calls and a board call at once. Each
caller talks in real time (20 ms frames): a care call through phone_call as Twilio's stream (8 kHz mu-law, the care
ticket, the real Care brain against a stand-in care service on a local port), the board's through app_call as HQ's
(16 kHz, with the echo canceller), its brain a stand-in for the CLI. The callers' words are synthesised first (Piper for
Dutch, Pocket TTS for German and English) and said again and again, a reply's length of quiet between. The brains answer
at once, so the times are the line's own: from the end of a caller's words to the reply's first audio, and every gap
of more than 0.1 s once a reply's audio has started (the listener hears a stutter or a pause the reply didn't have).
Prints the process's memory (resident now and at its peak) and CPU (cores busy, on average and in the busiest second).
"""
import asyncio, base64, json, os, sys, tempfile, time
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np

from standins import CareService

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault('HQ_URL', 'http://127.0.0.1:9')
os.environ.setdefault('ORIGIN', 'https://hq.test')
os.environ.setdefault('VOICE_TOKEN', 'load-check')
if os.environ.get('LOAD_CHECK_NO_POCKET_DUTCH'):  # (a machine short of memory: Poppy's voice speaks Dutch through Piper)
    import pocket_tts
    load, loaded = pocket_tts.TTSModel.load_model, {}

    def load_once(language=None, **kwargs):
        language = 'english' if language in (None, 'dutch') else language  # (the Dutch slot gets the English model)
        if language not in loaded:
            loaded[language] = load(language=language, **kwargs)
        return loaded[language]
    pocket_tts.TTSModel.load_model = load_once
import server  # noqa: E402

RATE = server.RATE
CALLERS = {  # what each caller says, turn by turn
    'nl': ['Hallo, ik heb een vraag over mijn bestelling.', 'Wanneer wordt mijn pakket bezorgd?',
           'En kan ik de tekst nog veranderen?', 'Oké, dank je wel, dan wacht ik even af.'],
    'de': ['Guten Tag, ich habe eine Frage zu meiner Bestellung.', 'Wie lange dauert der Versand nach Deutschland?',
           'Und was mache ich, wenn das Paket beschädigt ankommt?', 'Alles klar, vielen Dank.'],
    'en': ['Can you check how the orders are doing this week?', 'And what about the invoices from last month?',
           'Okay, what should we do about the late parcel?', 'Sounds good, thanks.'],
}
REPLIES = {  # the brains' replies, three sentences each, streamed at once
    'nl': 'Goede vraag. Een bestelling wordt binnen drie werkdagen gedrukt en verstuurd. Je krijgt een mail met de track-and-trace zodra hij onderweg is.',
    'de': 'Gute Frage. Eine Bestellung wird innerhalb von drei Werktagen gedruckt und verschickt. Du bekommst eine Mail mit der Sendungsverfolgung, sobald sie unterwegs ist.',
    'en': "Sure, I'll check the orders now. Then I'll look at the invoices from last month. And after that, the parcels that are late.",
}


def synthesise(text, lang):
    """A caller's words at 16 kHz: Piper for Dutch, Pocket TTS (alba) for German and English."""
    if lang == 'nl':
        return np.concatenate([server.resample(np.frombuffer(c.audio_int16_bytes, np.int16).astype(np.float32) / 32768,
                                               c.sample_rate, RATE) for c in server.PIPERS['alex'].synthesize(text)])
    model = server.pockets[lang]
    state = model.get_state_for_audio_prompt('alba')
    return np.concatenate([server.resample(c.numpy().astype(np.float32), model.sample_rate, RATE)
                           for c in model.generate_audio_stream(state, text)])


class Stats:
    """A call's times: from the end of the caller's words to the reply's first audio, and the gaps in a reply's audio."""
    def __init__(self, name):
        self.name, self.firsts, self.gaps, self.spoke_at, self.play_end, self.replying = name, [], [], None, 0.0, False

    def sent(self, seconds):
        now = time.monotonic()
        if self.spoke_at is not None:
            self.firsts.append(now - self.spoke_at)
            self.spoke_at, self.replying = None, True
        elif self.replying and now - self.play_end > 0.1:
            self.gaps.append(now - self.play_end)
        self.play_end = max(self.play_end, now) + seconds


class Caller:
    """Says its lines in real time, 20 ms a frame, with quiet between (a reply's length, then a breath)."""
    def __init__(self, stats, lines, frame):
        self.stats, self.lines, self.frame = stats, lines, frame

    async def run(self, send, until, quiet_first):
        frame, t, n = int(0.02 * RATE), time.monotonic(), 0
        silence = np.zeros(frame, np.float32)
        script = [np.zeros(int(quiet_first * RATE), np.float32)]
        for line in self.lines:
            script += [line, np.zeros(int(15 * RATE), np.float32)]
        while time.monotonic() < until:
            for clip in script:
                for i in range(0, len(clip), frame):
                    if time.monotonic() >= until:
                        return
                    chunk = clip[i:i + frame]
                    await send(np.pad(chunk, (0, frame - len(chunk))) if len(chunk) < frame else chunk)
                    n += 1
                    if clip is not script[0] and len(clip) and i + frame >= len(clip) and np.abs(clip).max() > 0.01:
                        self.stats.spoke_at, self.stats.replying = time.monotonic(), False
                    await asyncio.sleep(max(0, t + n * 0.02 - time.monotonic()))
                if not len(clip):
                    await send(silence)


class PhoneSocket:
    """Twilio's media stream, standing in: what the caller sends comes in as media events; the line's media goes to Stats."""
    def __init__(self, stats):
        self.queue, self.stats, self.closed = asyncio.Queue(), stats, False

    async def put(self, x):
        payload = base64.b64encode(server.ulaw_encode(server.resample(x, RATE, 8000))).decode()
        self.queue.put_nowait(json.dumps({'event': 'media', 'media': {'payload': payload}}))

    async def send(self, message):
        e = json.loads(message)
        if e.get('event') == 'media':
            self.stats.sent(len(base64.b64decode(e['media']['payload'])) / 8000)

    async def close(self, *args):
        self.closed = True
        self.queue.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if (m := await self.queue.get()) is None:
            raise StopAsyncIteration
        return m


class AppSocket(PhoneSocket):
    """HQ's call screen, standing in: 16 kHz PCM frames in (no voice beside them), the line's PCM to Stats."""
    request = NS(headers={'Origin': os.environ['ORIGIN'], 'User-Agent': 'load-check'})

    async def put(self, x):
        self.queue.put_nowait((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())

    async def recv(self):
        return json.dumps({'agent': 'juno', 'lang': 'en'})

    async def send(self, message):
        if isinstance(message, bytes):
            self.stats.sent(len(message) / 2 / RATE)


class Board:
    """The CLI, standing in: answers each message with the English reply at once."""
    voice, tz, seat, token, call, key, pin_shots, recap, opening, objected, who, kind = ('alba', 'UTC', None, '', 0, '', [],
                                                                                       '', '', '', '', 'board')

    def __init__(self, *args, **kwargs):
        pass

    async def start(self):
        pass

    def moved(self):
        return False

    async def ask(self, text, pictures=()):
        yield server.DELIVERED
        for w in REPLIES['en'].split(' '):
            yield w + ' '

    def interrupt(self):
        pass

    def kill(self):
        pass

    def close(self):
        pass


def care_service():
    """care's phone port, standing in: a conversation per call (its number in the phase), each turn the reply in its
    caller's language, tagged as care tags it, a word a chunk."""
    def started(body):
        return 200, {'conversation': int(body['call'][2:]), 'langs': ['nl', 'de', 'en'], 'words': OPENINGS}

    def reply(body):
        lang = SPOKEN_IN[body['conversation']]
        return [{'lang': lang}] + [{'text': w + ' '} for w in REPLIES[lang].split(' ')] + [{'end': True}]
    return CareService(started, reply, token='load-check')


OPENINGS = {lang: {'ai': f"Hi, this is Poppy, Testco's AI assistant. ({lang})", 'transcript':
                   'I keep a written transcript of this call, never a recording, for up to a year.', 'objected': 'Fine.'}
            for lang in ('nl', 'de', 'en')}
OPENINGS['nl'].update(ai='Hoi, met Poppy, de AI-assistent van Testco.',
                      transcript='Ik maak een geschreven verslag van dit gesprek, nooit een opname, voor maximaal een jaar.')
OPENINGS['de'].update(ai='Hallo, hier ist Poppy, der KI-Assistent von Testco.',
                      transcript='Ich führe ein schriftliches Protokoll dieses Gesprächs, nie eine Aufnahme, bis zu einem Jahr.')


def status(field):
    return int(next(line for line in Path('/proc/self/status').read_text().splitlines() if line.startswith(field)).split()[1]) // 1024


SPOKEN_IN = []  # each care call's caller's language, by its number in the phase


async def phase(name, langs, seconds, voices):
    stats, tasks, until = [], [], time.monotonic() + seconds
    SPOKEN_IN[:] = langs
    cpu0, wall0, busiest, last = os.times(), time.monotonic(), 0.0, (sum(os.times()[:2]), time.monotonic())
    for i, lang in enumerate(langs):
        s = Stats(f'care {lang} {i + 1}')
        ws = PhoneSocket(s)
        ws.queue.put_nowait(json.dumps({'event': 'start', 'start': {'streamSid': f'MZ{i}', 'callSid': f'CA{i}',
                                                                    'customParameters': {'ticket': 't'}}}))
        tasks.append(asyncio.create_task(server.phone_call(ws)))
        tasks.append(asyncio.create_task(Caller(s, voices[lang], 0).run(ws.put, until, 14 + 3 * i)))
        stats.append(s)
        tasks.append(asyncio.create_task(close_at(ws, until)))
    s = Stats('board en')
    ws = AppSocket(s)
    tasks.append(asyncio.create_task(server.app_call(ws)))
    tasks.append(asyncio.create_task(Caller(s, voices['en'], 0).run(ws.put, until, 2)))
    tasks.append(asyncio.create_task(close_at(ws, until)))
    stats.append(s)
    peak_rss = 0
    while time.monotonic() < until:
        await asyncio.sleep(1)
        cpu, now = sum(os.times()[:2]), time.monotonic()
        busiest, last = max(busiest, (cpu - last[0]) / (now - last[1])), (cpu, now)
        peak_rss = max(peak_rss, status('VmRSS'))
    await asyncio.gather(*tasks, return_exceptions=True)
    cpu = sum(os.times()[:2]) - sum(cpu0[:2])
    print(f'\n== {name}: {seconds} s; memory now {status("VmRSS")} MB, peak in the phase {peak_rss} MB (process peak '
          f'{status("VmHWM")} MB); CPU {cpu / (time.monotonic() - wall0):.2f} cores on average, {busiest:.2f} in the busiest second')
    for s in stats:
        f = sorted(s.firsts)
        print(f'  {s.name}: {len(f)} replies, first audio after ' + (f'{f[0]:.2f} / {f[len(f) // 2]:.2f} / {f[-1]:.2f} s (min/median/max)' if f else '-')
              + f'; {len(s.gaps)} gaps in replies' + (f', longest {max(s.gaps):.2f} s, {sum(s.gaps):.1f} s in all' if s.gaps else ''))


async def close_at(ws, until):
    await asyncio.sleep(max(0, until - time.monotonic()) + 2)
    if not ws.closed:
        await ws.close()


async def main():
    langs = (sys.argv[1] if len(sys.argv) > 1 else 'nl,de').split(',')
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 150
    print(f'models loaded: memory {status("VmRSS")} MB', flush=True)
    # (care, the deployment the tickets name by default, taking every care caller at once)
    care = care_service()
    server.CARE_ENGINES['care'] = {'url': care.url, 'token': 'load-check', 'calls': max(len(langs), 2)}
    server.hq = lambda method, path, body=None: (
        {'agent': 'poppy', 'lang': 'nl', 'kind': 'care', 'langs': ['nl', 'en'], 'voice': 'bill_boerst',
         'voices': {'nl': 'alex', 'de': 'thorsten'}} if path == 'call-ticket' else {})
    server.Agent = Board
    server.LIVE.mkdir(parents=True, exist_ok=True)
    server.CALL_LOGS.mkdir(parents=True, exist_ok=True)
    voices = {lang: [synthesise(t, lang) for t in lines] for lang, lines in CALLERS.items()}
    print(f'callers synthesised: memory {status("VmRSS")} MB', flush=True)
    await phase('a board call alone', [], min(60, seconds), voices)
    await phase(f'care calls in {", ".join(langs)} and a board call at once', langs, seconds, voices)
    await asyncio.sleep(3)  # (the last sentences' synthesis stops)
    care.stop()


if __name__ == '__main__':
    server.CALL_LOGS = server.LIVE = Path(tempfile.mkdtemp())  # (the line's /data, here)
    asyncio.run(main())
