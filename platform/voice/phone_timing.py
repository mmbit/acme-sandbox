"""VOICE_MODELS=<models> python phone_timing.py [nl de en]   (a stranger's call on the phone line, timed: a check to run by
hand, not a unit test)

A care call through the real phone_call(), Call and Care brain, with the real Silero VAD, Parakeet, Pocket TTS and Piper,
in real time: Twilio's stream stands in (8 kHz mu-law both ways, audio played in the order it was sent), and so does
care's phone port (its words for the opening from products/care/src/texts.ts, each turn's reply after MODEL_SECONDS,
tagged with its language). The caller, in each language asked for (a Dutch number, a German one, a British one), waits
for the opening to finish (1.5 s of quiet after it), says one line (Piper's native voice for Dutch and German, Pocket TTS's alba for English),
and the call is timed:

  first words   pickup until the first of the line's audio plays (what the caller waits for after the ring)
  opening       how long the opening plays, and when its last ask "what can I help you with?" in the caller's language
                ended (from pickup), if there is one
  to the answer the caller's last word until the first words of the answer play (the line's own part, with the model's
                MODEL_SECONDS in it); what played between (a notice) is named
  voices        which speech engine and voice said each sentence

Outside the image: a venv with torch (CPU), pocket-tts, piper-tts, sherpa-onnx, numpy and websockets, and the models
the Dockerfile fetches in VOICE_MODELS (Parakeet in parakeet/, silero_vad.onnx, smart-turn-v3.2-cpu.onnx, the Piper
voices). Run it alone (the machine is shared), under taskset -c 0-3. It runs the server.py beside it, so a copy of
another version's folder times that version. Short of memory (the line with every model is 2.5 GB), ONE_POCKET=1
loads Pocket TTS's English model alone, in the other languages' places too: their sentences take as long to make, in
the wrong accent.
"""
import asyncio, base64, json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ.get('REPO', HERE.parent.parent))
MODEL_SECONDS = float(os.environ.get('MODEL_SECONDS', '0'))
CALLERS = {  # (the caller's number's country code, what they say, the reply)
    'nl': ('31', 'Hallo, ik wil graag weten waar mijn bestelling is.', 'Dat zoek ik voor je uit. Wat is je bestelnummer?'),
    'de': ('49', 'Hallo, ich möchte gern wissen, wo meine Bestellung ist.', 'Das schaue ich gern nach. Wie ist deine Bestellnummer?'),
    'en': ('44', "Hi, I'd like to know where my order is.", "I'll look that up for you. What's your order number?"),
}
LINE = yaml.safe_load((REPO / 'company/brand.yaml').read_text())['phoneLine']
LANGS = {code: LINE['languages'].get(int(code), LINE['languages']['default']) for code, _, _ in CALLERS.values()}
VOICES = LINE.get('voices') or {}  # (by language)

with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    PORT = s.getsockname()[1]
sys.path.insert(0, str(HERE))
os.environ.update({'HQ_URL': 'http://127.0.0.1:9', 'ORIGIN': 'https://hq.test', 'VOICE_TOKEN': 'timing',
                   'CARE_URL': f'http://127.0.0.1:{PORT}', 'CARE_PHONE_TOKEN': 'timing'})
texts = json.loads(subprocess.run(['node', '-e', "import('./products/care/src/texts.ts').then(m => console.log("
                                   "JSON.stringify(m.texts)))"], cwd=REPO, capture_output=True, text=True, check=True).stdout)
WORDS = {lang: {k: texts[lang][f'phone_{k}'] for k in ('ai', 'reply_ai', 'transcript', 'ask', 'objected', 'fine')
                if f'phone_{k}' in texts[lang]}
         for lang in ('nl', 'de', 'en')}
if os.environ.get('ONE_POCKET'):
    import pocket_tts
    english = pocket_tts.TTSModel.load_model()
    pocket_tts.TTSModel.load_model = lambda language=None, **kwargs: english
import server  # noqa: E402
from piper import PiperVoice  # noqa: E402

tmp = tempfile.TemporaryDirectory()
server.LIVE = server.CALL_LOGS = Path(tmp.name)
reply_lang = ['en']  # (the language the stand-in care answers in this call)


class Care(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        if self.path == '/phone/start':
            return self.json({'conversation': 1, 'helper': 'Poppy', 'langs': ['nl', 'de', 'en'], 'words': WORDS})
        if self.path == '/phone/end':
            return self.json({})
        time.sleep(MODEL_SECONDS)
        lang = reply_lang[0]
        self.send_response(200)
        self.send_header('content-type', 'application/x-ndjson')
        self.send_header('content-length', str(len(data := (json.dumps({'lang': lang}) + '\n' + json.dumps(
            {'text': CALLERS[lang][2]}) + '\n' + json.dumps({'end': True}) + '\n').encode())))
        self.end_headers()
        self.wfile.write(data)

    def json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


http = ThreadingHTTPServer(('127.0.0.1', PORT), Care)
threading.Thread(target=http.serve_forever, daemon=True).start()


class Twilio:
    """The stream: what the line sends is played in order from when it comes, each piece under the sentence it says."""
    def __init__(self, start):
        self.queue, self.closed, self.played, self.end = asyncio.Queue(), False, [], 0.0
        self.queue.put_nowait(json.dumps(start))
        self.sentence = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        m = await self.queue.get()
        if m is None:
            raise StopAsyncIteration
        return m

    async def send(self, data):
        e = json.loads(data)
        if e.get('event') == 'clear':
            self.end = time.monotonic()
        elif e.get('event') == 'media':
            seconds = len(base64.b64decode(e['media']['payload'])) / 8000
            now = time.monotonic()
            begin = max(now, self.end)
            self.end = begin + seconds
            self.played.append((begin, self.end, self.sentence))

    async def close(self, *args):
        self.closed = True
        self.queue.put_nowait(None)


def mulaw(x16k):
    return base64.b64encode(server.ulaw_encode(server.resample(x16k, server.RATE, 8000))).decode()


async def frames(ws, audio):
    """The caller's audio, 20 ms a frame, in real time."""
    step, t0 = 320, time.monotonic()
    for i in range(0, len(audio), step):
        ws.queue.put_nowait(json.dumps({'event': 'media', 'media': {'payload': mulaw(audio[i:i + step])}}))
        await asyncio.sleep(max(0, t0 + (i + step) / server.RATE - time.monotonic()))


async def call(lang):
    code, said, _ = CALLERS[lang]
    reply_lang[0] = lang
    ticket = {'agent': 'poppy', 'lang': LANGS[code][0], 'kind': 'care', 'langs': LANGS[code], 'voice': 'bill_boerst',
              'voices': VOICES, 'respell': {},
              'hello': {'nl': 'Hallo', 'de': 'Guten Tag', 'en': 'Hello'}}  # (hello: a line from before #16033 says it)
    server.hq = lambda method, path, body=None: ticket if path == 'call-ticket' else {}
    engines = []
    say = server.Call.say

    async def labelled(self, sentence, stop, turn, lang=None, **kept):
        ws.sentence = sentence
        engines.append((sentence, lang or self.lang))
        return await say(self, sentence, stop, turn, lang, **kept)
    server.Call.say = labelled
    ws = Twilio({'event': 'start', 'start': {'streamSid': 'MZ1', 'callSid': 'CA' + '1' * 32,
                                              'customParameters': {'ticket': 't'}}})
    if lang == 'en':
        pocket = server.pockets[lang]
        voice = np.concatenate([c.numpy() for c in pocket.generate_audio_stream(pocket.get_state_for_audio_prompt('alba'), said)])
        voice = server.resample(voice.astype(np.float32), pocket.sample_rate, server.RATE)
    else:
        piper = PiperVoice.load(str(server.MODELS / ('nl_NL-alex-medium.onnx' if lang == 'nl' else 'de_DE-thorsten-medium.onnx')))
        voice = np.concatenate([server.resample(np.frombuffer(c.audio_int16_bytes, np.int16).astype(np.float32) / 32768,
                                                c.sample_rate, server.RATE) for c in piper.synthesize(said)])
    t0 = time.monotonic()
    line = asyncio.create_task(server.phone_call(ws))
    quiet = np.zeros(int(0.2 * server.RATE), np.float32)
    while not ws.played or time.monotonic() < ws.end + 1.5:  # (the opening plays out; the caller waits 1.5 s more)
        await frames(ws, quiet)
    opening = ws.played[:]
    await frames(ws, voice)
    spoke = time.monotonic()
    while time.monotonic() < spoke + 25 and not any(s == CALLERS[lang][2] or s and CALLERS[lang][2].startswith(s)
                                                     for b, _, s in ws.played if b > spoke):
        await frames(ws, quiet)
    await frames(ws, np.zeros(server.RATE, np.float32))
    await ws.close()
    await line
    server.Call.say = say
    asks = [e for b, e, s in opening if s == WORDS[lang].get('ask')]
    after = [(b, s) for b, _, s in ws.played if b > spoke]
    answer = next((b for b, s in after if s and CALLERS[lang][2].startswith(s)), None)
    between = sorted({s for b, s in after if answer and b < answer and s})
    return {
        'first words': opening[0][0] - t0,
        'opening': opening[-1][1] - opening[0][0],
        'its ask in their language ended': asks[-1] - t0 if asks else None,
        'to the answer': answer - spoke if answer else None,
        'between': between,
        'pickup to the answer': answer - t0 if answer else None,
        'voices': [(s[:32], lang) for s, lang in engines],
    }


def warm():
    """The line as it runs once it has had a call: each language's model and Poppy's voice in it ready (voice_states)."""
    for lang, model in server.pockets.items():
        for voice in {'bill_boerst', VOICES.get(lang, 'bill_boerst')} - set(getattr(server, 'PIPERS', {})):
            state = server.voice_states.setdefault((lang, voice), model.get_state_for_audio_prompt(voice))
            for _ in model.generate_audio_stream(state, 'Hello there.'):
                pass
    for piper in getattr(server, 'PIPERS', {'alex': getattr(server, 'dutch', None)}).values():
        for _ in piper.synthesize('Hallo.') if piper else ():
            pass


async def main():
    warm()
    for lang in sys.argv[1:] or ['nl', 'de', 'en']:
        r = await call(lang)
        print(f'== {lang} caller (+{CALLERS[lang][0]})', flush=True)
        for k, v in r.items():
            print(f'  {k}: {round(v, 2) if isinstance(v, float) else v}', flush=True)


asyncio.run(main())
