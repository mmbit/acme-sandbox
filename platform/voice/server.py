"""The voice line: live calls with the team, streamed both ways.

One call is one WebSocket: from HQ's call screen (/voice/ws, behind the board's login, 16 kHz PCM both ways)
or from the phone line (/voice/twilio, Twilio's media stream, 8 kHz mu-law, admitted with a one-time ticket).
The loop: speech detection cuts the board's words at pauses (Silero VAD), Parakeet transcribes each piece, and
once the board sounds finished (at once when its voice says so, a longer wait mid-thought) a warm Claude
session answers (streamed), each sentence spoken as it arrives (Pocket TTS in English, Piper in Dutch). Talking
over the agent stops it once it's clearly the board (real words, or 2 s of talking): a cough or a lone "okay"
lets the reply carry on. Carrying on before hearing much of the reply takes the reply back, and the agent
answers the whole message instead. During the call the agent can read the company's files and hand
work on (hq job), putting the board on hold for a moment, and end the call once the board has said goodbye
(hang_up); after the call the coordinator hands the transcript to them to follow up.

A call we placed to a partner (a call out: the ticket says so) comes in on the same phone route, or as a room of up to
six people on the join link's page (/voice/join, room.py). On it the agent speaks first, in the company's fixed words
(the opening), has the partner tools (note, no_transcript and hang_up: no look-ups), and keeps only its notes once
the other side would rather we kept no transcript.
"""
import asyncio, base64, functools, hashlib, http.client, itertools, json, logging, os, re, secrets, shutil, socket
import threading, time, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, NamedTuple
from zoneinfo import ZoneInfo

import numpy as np
import sherpa_onnx
import websockets
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from aloud import DAYS, aloud, number, respelt
from drawing import ASK_WORDS, INK_SECONDS, INK_WORDS, Drawing, note_said, notes_lost, one_line
from driving import DRIVE_WORDS, OPEN_WORDS, Driving
from echo import Echo
from endpoint import Endpoint
from guard import PARTNER, TOOLS, agent_env, hq_tools_work, sign_in_pipe, take_token
import dictate  #.
import hq_tools
import room
import turns

HQ, TOKEN, ORIGIN = os.environ['HQ_URL'], take_token(os.environ), os.environ['ORIGIN']  # (guard.py: who can read what)
MODELS = Path(os.environ.get('VOICE_MODELS', '/models'))  # (replay.py runs the real models outside the image)
# The call agent hands work on with hq_tools.py (guard.py). If it can't start here, calls still work without hand-on,
# and the log says so (the transcript still reaches the agent after the call).
# (add)
print(f'Call tools (job, add, reach, promise, replace): {"on" if hq_tools_work() else "OFF (hq_tools.py did not start): calls work, with nothing queued or noted during them"}', flush=True)
# The model and effort come from the coordinator with each call (company/models.yaml `calls`: Opus, the model that runs
# the company, as the board asked); these are only for a coordinator that doesn't send them yet.
MODEL, EFFORT = os.environ.get('VOICE_MODEL', 'claude-opus-5-5'), os.environ.get('VOICE_EFFORT', 'low')
PICK = re.compile(r'[a-z0-9][a-z0-9.\-\[\]]{0,63}')  # a model id or alias, an effort level: nothing that reads as a flag


class Paths(NamedTuple):
    """Where the line keeps and finds its files: these, unless a test gives its own."""
    seat: Path = Path('/seat/token')  # a Claude seat's token, kept here by the worker (its keeper), never the seats themselves
    repo: Path = Path('/repo')  # the server's checkout of main, mounted read only
    calls: Path = Path('/data/calls')  # each call's transcript so far (Call.file)
    # A file per call that's on: a deploy waits while there is one (infra/sync.sh on_call), as recreating this container
    # ends every call on it.
    live: Path = Path('/data/live')
    cli_config: Path = Path('/data/claude')  # the call agents' CLI config (guard.agent_env's CLAUDE_CONFIG_DIR)
    work: Path = Path('/data/call')  # the line's working folder: the CLI's (and its HOME), where there's no repo

    @property
    def sessions(self):
        """The call agents' session records, in their CLI config."""
        return self.cli_config / 'projects'

    @property
    def screen_socket(self):
        """The screen tool's way to the line (SCREENS), in work."""
        return self.work / 'screen.sock'


# The CLI keeps a copy of every picture a session is sent, /tmp/claude-<uid>/<its folder>/<session>/images/<n>.jpg (the
# environment it gets has no TMPDIR): they go with the session's records
PICTURE_COPIES = Path('/tmp')
RATE = 16000  # what the recogniser hears and what HQ plays
FRAME = 320   # HQ's microphone frame, 20 ms (platform/hq/shell/mic-worklet.js)
WINDOW = 512 / RATE  # the VAD's window: 32 ms
# The VAD calls it speech this long after it starts (min_speech_duration), and ends it PAUSE s after its last sound
# (min_silence_duration).
ONSET, PAUSE = 0.25, 0.45
TRAIL = 0.2  # the quiet after the words Smart Turn hears with them (endpoint.py)
# Only words stop a reply: the VAD hears a knock, a clink, a pour or a breath as talking (for 2 s and more), and the
# recogniser hears no words in it, or only "Yeah."/"Okay." (board, call #77).
PEEK = 8       # VAD windows of talking over a reply before a first look at the words so far (then every 8 more)
RESUMED = 4    # VAD windows of talking that cancel a reply that's about to start: the board isn't finished
AGAIN = 1.0    # a sound over the reply that was let go counts again if the board carries on within this long
# Seconds to wait, after the recogniser's 0.45 s pause and counted from its end (the transcription runs in it), before
# answering: none once the board sounds finished (endpoint.py: Smart Turn hears it in the voice, not in the recogniser's
# full stop, which comes at almost every pause), as the model takes over a second to speak and words the board adds
# before that take the reply back (cut_in); mid-thought, long enough that a thinking pause rarely outlasts it
WAIT_SECONDS = {'done': 0, 'open': 1.5}
TAKE_BACK = 1.2  # the board carries on before hearing this much of the reply: it was one message
# HQ pings the line twice a second beside the microphone's frames, and the line answers each as it reads it. On a weak
# connection the frames back up and come late, in a burst (nothing is lost on the way): the line is behind while a ping
# comes LATE s later than the quickest one, or none has come for SILENT s. Behind, it doesn't answer what it has heard:
# the board's words since are still on their way. HQ shows how late from the pongs.
LATE, SILENT = 1.0, 1.5
VOICE = 'alba'  # the Pocket TTS voice for an agent without one of its own (org.yaml's voice, sent with the call's context)
# A tool step (a job's brief takes the model seconds to write) is never silence: while it runs, a soft two-note tick
# plays whenever the line has been quiet for QUIET s, until the agent's words come. What the agent wrote before the
# step is said as it starts. The wait for a reply's first words is held by a softer sound of its own, thinking(), the
# same way. Neither plays until the board has been quiet for HUSH s since its
# last words, and never while it talks: the line asks the model sooner, and a pause mid-sentence is no wait to mask.
# These are the line's only hold sounds: a spoken hold line
# of the line's own ("One moment, I'll queue that.") replaced the tick for a while, and a tick was preferred.
QUIET, HUSH = 2.0, 1.5
# Pictures the board shares on HQ's call screen go to the agent with the board's next words, at most PICTURES at once.
# With nothing said, they go on their own once the line has been quiet for SHOWN_SECONDS. The session sends every picture
# it has seen again with each turn, and the API takes 32 MB a request: a call shows at most SESSION_BYTES of them, as
# base64.
PICTURES, SHOWN_SECONDS, SESSION_BYTES = 6, 2.0, 20 << 20
PICTURE_TYPES = {'image/jpeg': b'\xff\xd8', 'image/png': b'\x89PNG'}  # (what the bytes start with)
# A walk-through: the caller shows our pages, and the coordinator keeps a live mirror of their screen (its watch-along
# routes for the line, screen-turn and screen). Each of their turns asks screen-turn for the moments since the agent's
# last turn and a picture of the screen if it changed, within SCREEN_TURN_SECONDS: it sits between the caller's last
# word and the model: a picture of an open mirror takes about 0.2 s (measured), and the rest is room for a busy
# coordinator before the caller waits on it. Screen pictures share SESSION_BYTES with shared ones, and a call has at most
# SCREEN_PICTURES of them, the screen tool's included (the walk-through brief's 40): each is about 1,000 tokens, sent
# again with every turn, so a full call's turns carry about 40,000 tokens of them. The agent's screen tool
# (hq_tools.py) asks through the line's own socket (Paths.screen_socket, 0600), by its session's key (SCREENS), so the line
# keeps the budget and its token.
SCREEN_TURN_SECONDS, SCREEN_PICTURES = 1.5, 40
SCREENS = {}  # each live session's screen key, to its Call
SCREEN_WORDS = {
    'lines': 'Their screen since your last turn:',
    'picture': 'The last picture is their screen as they finished speaking, their last tap ringed.',
    'paused': ("They've paused showing their screen: you see nothing of it, and the screen tool shows nothing, until "
               'they show it again.'),
    'full': ('No more pictures of their screen on this call: it has had all the pictures it can hold. The moments go '
             'on, and the screen tool still lists them (since).'),
    'none': "There's no screen on this call: nobody is showing our pages.",
    'unread': "Their screen couldn't be read for this turn: what they did comes with your next turn.",
    'gone': 'This session has no screen any more: the call ended, or its session was restarted.',
    'failed': "The screen couldn't be read just now",
}
# The agent's sketch tool (hq_tools.py, through the same socket): one of the board's sketches, by its number or the
# words of its label (the coordinator's sketch route), on the board's own calls only. Its picture counts against
# SESSION_BYTES, as a screen's and a shared one's do.
SKETCH_WORDS = {
    'none': "Sketches can't be shown on this call: only on the board's own calls.",
    'full': 'No more pictures on this call: it has had all the pictures it can hold.',
    'gone': 'This session has no sketches any more: the call ended, or its session was restarted.',
    'failed': "The sketch couldn't be fetched just now",
}
# The agent ends the call with its hang_up tool, once the board has clearly said goodbye (hq_tools.py): the line hangs
# up when the goodbye has played on the board's side and it has been quiet GOODBYE_QUIET_SECONDS since. The board's
# words before then keep the call open. HQ hangs up as its own button does (or the line ends the call itself after
# HANG_UP_WAIT_SECONDS).
HANG_UP_TOOL = 'mcp__hq__hang_up'
GOODBYE_QUIET_SECONDS = 1.5
HANG_UP_WAIT_SECONDS = 5.0
# after the hang-up tone, so the hang-up doesn't cut it (browser start delay, Bluetooth lag)
TONE_TAIL_SECONDS = 0.5
# A call out: the line says the opening once the other side's first words have
# ended, or after this much quiet from pickup (OPENING_QUIET_SECONDS on the phone; in a room, where the page said it all
# before they joined, sooner). The agent's note and no_transcript run nothing: the line acts on them from the stream.
OPENING_QUIET_SECONDS, ROOM_OPENING_QUIET_SECONDS = 3.0, 1.5
NOTE_TOOL, NO_TRANSCRIPT_TOOL = 'mcp__hq__note', 'mcp__hq__no_transcript'
# The objection's answer when the coordinator sends none (a company's own words come with call-context)
OBJECTED = {'en': "No problem, I won't keep one.", 'nl': 'Geen probleem, dan houd ik er geen bij.',
            'de': 'Kein Problem, dann behalte ich keins.'}


@functools.cache
def tick():
    """Two soft wooden notes, about a third of a second: the line is working, not gone."""
    t = np.arange(int(0.09 * RATE)) / RATE
    note = lambda f: (np.sin(2 * np.pi * f * t) + 0.2 * np.sin(2 * np.pi * 4 * f * t)) * np.exp(-t * 40)
    gap = np.zeros(int(0.06 * RATE))
    return (0.08 * np.concatenate([note(784), gap, note(659), gap * 2])).astype(np.float32)


@functools.cache
def thinking(phone=False):
    """One soft, low swell without an edge, about a third of a second, quieter than the tick: thinking. On the phone
    a fifth higher and 12 dB up, about as loud as the tick (-30 dBFS against speech's -20): a phone's earpiece and a
    mobile network's codec lose the swell at -42 dBFS under 500 Hz, and a caller heard nothing over a wait
."""
    t = np.arange(int(0.36 * RATE)) / RATE
    swell = np.sin(np.pi * t / t[-1]) ** 2
    level, f = (0.07, 523) if phone else (0.018, 392)
    return (level * swell * (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 1.5 * f * t))).astype(np.float32)


@functools.cache
def hang_up_tone():
    """Three short beeps of the phone network's 425 Hz, about three quarters of a second: the other side has hung up, as
    a phone call ends. Its partials stay under the phone line's 4 kHz."""
    t = np.arange(int(0.17 * RATE)) / RATE
    fade = np.minimum(1, np.minimum(t, t[-1] - t) / 0.008)  # (no click at either end)
    beep = (np.sin(2 * np.pi * 425 * t) + 0.1 * np.sin(2 * np.pi * 850 * t)) * fade
    gap = np.zeros(int(0.13 * RATE))
    return (0.14 * np.concatenate([beep, gap, beep, gap, beep])).astype(np.float32)


class Step:
    """What Agent.ask yields when the agent starts a tool step (its name, e.g. mcp__hq__job)."""
    def __init__(self, name):
        self.name = name


class Used:
    """What Agent.ask yields once a tool step's input is whole (its name and input, e.g. mcp__hq__note, {'what': ...})."""
    def __init__(self, name, tool_input):
        self.name, self.input = name, tool_input


class Language(str):
    """What Care.ask yields when a reply's language is said (care's tag, the model's: nl, de or en)."""


class Unanswered(Exception):
    """What Agent.ask raises when the turn ended in an error the CLI itself reports, never the model's words: the seat
    at its usage limit ('limit': the CLI's rejected rate_limit_event, its error message rate_limit, HTTP 429), signed out
    ('signin': authentication_failed, 401) or any other failed request ('error'). until: when a limited seat's window
    resets (ms, from the rate_limit_event), or 0. The CLI writes its limit message ("You've hit your session limit") as
    the model's (<synthetic>): read as a reply it would be logged and dropped, and the board would hear silence."""
    def __init__(self, why, until=0):
        super().__init__(why)
        self.why, self.until = why, until


def seat_token(seat):
    """The token the worker keeps at `seat` now ('' once every seat is signed out: it removes the file)."""
    try:
        return seat.read_text().strip()
    except OSError:
        return ''


def now_ms():
    """The server's clock (ms since the epoch, the coordinator's clock too): the one a call is given unless a test gives
    its own (Call's now)."""
    return datetime.now(timezone.utc).timestamp() * 1000


def clock(ms, tz, lang='en', now=now_ms):
    """A time as the line says it: on the company's clock (company.timeZone), or in UTC, said so, without one; with the
    day when it isn't today (tomorrow, a weekday within the week, else the date), today by the clock `now` (the
    server's unless given)."""
    try:
        zone, utc = ZoneInfo(tz), ''
    except Exception:
        zone, utc = timezone.utc, ' UTC'
    at, today = (datetime.fromtimestamp(t / 1000, zone) for t in (ms, now()))
    time_of_day, days = at.strftime('%H:%M') + utc, (at.date() - today.date()).days
    words = DAYS.get(lang, DAYS['en'])
    if days < 1:
        return time_of_day
    if days == 1:
        return words['tomorrow'].format(t=time_of_day)
    if days < 7:
        return words['on'].format(d=words['days'][at.weekday()], t=time_of_day)
    return words['date'].format(n=at.day, m=words['months'][at.month - 1], t=time_of_day)


# The line's own words when the agent can't answer: fixed, never the model's, said in the agent's voice so the board
# hears the line is up. The first time in full; again (the same reason, a later turn) shorter.
CANT = {
    'en': {'limit': 'our Claude seat is at its limit', 'until': 'our Claude seat is at its limit until {t}',
           'signin': 'our Claude seat is signed out', 'error': 'the call agent ran into an error',
           'first': "{name} can't answer right now: {why}. What you say is still written down, and {name} follows up after the call.",
           'again': "{name} still can't answer: {why}. What you say is written down."},
    'nl': {'limit': 'ons Claude-abonnement zit aan zijn limiet', 'until': 'ons Claude-abonnement zit tot {t} aan zijn limiet',
           'signin': 'ons Claude-abonnement is uitgelogd', 'error': 'de agent liep tegen een fout aan',
           'first': '{name} kan nu niet antwoorden: {why}. Wat je zegt wordt wel opgeschreven, en {name} komt er na het gesprek op terug.',
           'again': '{name} kan nog steeds niet antwoorden: {why}. Wat je zegt wordt opgeschreven.'},
    'de': {'limit': 'unser Claude-Abo ist an seinem Limit', 'until': 'unser Claude-Abo ist bis {t} an seinem Limit',
           'signin': 'unser Claude-Abo ist abgemeldet', 'error': 'der Agent ist auf einen Fehler gestoßen',
           'first': '{name} kann gerade nicht antworten: {why}. Was du sagst, wird trotzdem aufgeschrieben, und {name} meldet sich nach dem Gespräch.',
           'again': '{name} kann immer noch nicht antworten: {why}. Was du sagst, wird aufgeschrieben.'},
}


def cant_answer(name, why, until=0, tz='UTC', lang='en', again=False, now=now_ms):
    words = CANT.get(lang, CANT['en'])
    reason = words['until'].format(t=clock(until, tz, lang, now)) if why == 'limit' and until else words.get(why, words['error'])
    return words['again' if again else 'first'].format(name=name, why=reason)


# What Agent.ask yields once the model has the message: its first request started
DELIVERED = object()
# What it yields as each later response in the same turn starts (the model's answer to its tool steps' results)
RESPONSE = object()

# ---- models, loaded once ----
asr = sherpa_onnx.OfflineRecognizer.from_transducer(
    tokens=str(MODELS / 'parakeet/tokens.txt'), encoder=str(MODELS / 'parakeet/encoder.int8.onnx'),
    decoder=str(MODELS / 'parakeet/decoder.int8.onnx'), joiner=str(MODELS / 'parakeet/joiner.int8.onnx'),
    model_type='nemo_transducer', feature_dim=128, decoding_method='greedy_search', num_threads=3)
turn_end = Endpoint(MODELS / 'smart-turn-v3.2-cpu.onnx')
from pocket_tts import TTSModel  # noqa: E402 (after the recogniser: torch is slow to import)
from piper import PiperVoice  # noqa: E402
import torch  # noqa: E402
pocket = TTSModel.load_model()
# Pocket TTS speaks every language in the agent's own voice (org.yaml's: each language's model has the same voice
# names). One voice garbles Dutch (it dropped a sentence's end and made seconds of noise of another, 3 runs in 3, where
# alba, jane, paul and eve read back through the phone as clearly as Piper): Piper speaks Dutch for it. Dutch runs at
# temperature 0.7, not the default 0.3: a little cleaner through the phone, read back as well and as fast.
pockets = {'en': pocket, 'nl': TTSModel.load_model(language='dutch', temp=0.7),
           'de': TTSModel.load_model(language='german')}
NOT_IN_DUTCH = {'bill_boerst'}
voice_states = {}  # by language and voice
# Pocket TTS says the same words differently each time (its noise from torch's one generator): fixed words kept in SAID
# are made from a seed, so the take every caller hears after a restart is the same one, a known take rather than a
# chance bad one. Another call's speech at that moment draws from the generator too, and only then is the take another.
# A care call's ticket can name the seed per language (`seeds`: one heard read back right in its voice);
# this one where it names none.
SEED = 8
# The audio of fixed words said before (a care call's opening), by language, voice, text and seed: played at once the
# next time, as synthesis can't start the first words sooner than its first piece
SAID = {}
# Piper's voices, by speaker, each a native speaker of its language (all CC0): alex speaks Dutch for a voice Pocket TTS
# garbles it in, and any speaks its language on a care call whose ticket names it (the voice there:
# `voices`, which may name one of Pocket TTS's voices instead). kerstin: a woman's German.
PIPERS = {name: PiperVoice.load(str(MODELS / f'{model}.onnx'))
          for name, model in (('alex', 'nl_NL-alex-medium'), ('thorsten', 'de_DE-thorsten-medium'),
                              ('kerstin', 'de_DE-kerstin-low'))}
# Letters Pocket TTS reads as a word of the language: "AI" was "een ei" in Dutch and "eine Key" in German, KI "Key"
# too. Spelled as said, read back right through the phone 6 times in 6 ("aa-ie") and 5 in 6 ("Ka-I"); never with dots
# ("A.I."), where it stops as at a sentence's end. Piper reads "AI" right as it is.
SPELLED = {'nl': [('AI', 'aa-ie')], 'de': [('AI', 'Ka-I'), ('KI', 'Ka-I')]}
# Each sentence is synthesised in a thread of its own, calls at once in parallel.
# One lock for every synthesis made overlapping replies on three calls wait for each other: 3 to 8 s of gaps in 150 s,
# 0.1 to 0.5 s without it (load_check.py). Parallel synthesis on one model gives the same audio as serial: Pocket TTS
# copies the voice's state per stream and runs torch on 1 thread (2 per synthesis, with its decoder); Piper's
# onnxruntime session takes concurrent runs (sample for sample with its noise off). Parakeet decodes on 3 threads.


def hq(method, path, body=None):
    req = Request(f'{HQ}/api/voice/{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
                  headers={'authorization': f'Bearer {TOKEN}', 'content-type': 'application/json'})
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read() or 'null')


def takes(picture, kind=None):
    """Whether a picture from the coordinator ({type, data}: a shared one, a screen's or a sketch's) is one the
    model can take: a JPEG or PNG (`kind`, when given) whose data decodes as one. All the data is decoded, not only its
    start: the model's API refuses a whole turn for an image whose base64 breaks further on, so such a picture is
    dropped here instead (a picture of a few MB decodes in milliseconds, once)."""
    if not isinstance(picture, dict) or not isinstance(picture.get('data'), str):
        return False
    start = PICTURE_TYPES.get(picture.get('type'))
    if not start or kind and picture['type'] != kind:
        return False
    try:
        return base64.b64decode(picture['data'], validate=True).startswith(start)
    except ValueError:
        return False


def fetch_picture(hq, picture_id, call):
    """A picture the board shared on this live call (the coordinator's pictures.ts), or None if it isn't a JPEG or PNG
    whose data decodes as one. Raises if the coordinator (hq) refuses it."""
    picture = hq('GET', f'picture?id={picture_id}&call={call}')
    return {'id': picture_id, 'type': picture['type'], 'data': picture['data']} if takes(picture) else None


def fetch_note(hq, note_id, call):
    """A note the board drew on this live call (the coordinator's note route): an entry for the call's pictures, its
    number on the call's page, words and page under 'note', and its picture (the page around it) if it has one. None if
    the note or its picture is unreadable. Raises if the coordinator (hq) refuses it."""
    got = hq('GET', f'note?id={note_id}&call={call}')
    picture = got.get('picture') if isinstance(got, dict) else None
    if not isinstance(got, dict) or type(got.get('n')) is not int or got['n'] < 1 or picture is not None and not takes(picture):
        return None
    return {'id': f"note {got['n']}", 'note': {'n': got['n'], 'words': one_line(got.get('words')), 'url': one_line(got.get('url'))},
            'type': picture and picture['type'], 'data': picture and picture['data']}


def picture_as(picture, kind):
    """A picture from the coordinator (a screen's from the watch-along routes, image/jpeg; a sketch's, image/png), as
    the agent can take it (of that type, whose data decodes as one), or None."""
    return {'type': kind, 'data': picture['data']} if takes(picture, kind) else None


def screen_lines(got):
    """The coordinator's moment lines, each kept to one line."""
    return [' '.join(str(line).split()) for line in got.get('lines') or []]


def refusal(err):
    """The coordinator's own words in a refusal ({error}), or ''."""
    try:
        return str(json.loads(err.read() or 'null').get('error') or '')
    except (ValueError, AttributeError, TypeError, OSError):  # (no body, or not the coordinator's JSON)
        return ''


async def serve_screens(path):
    """The line's screen socket, for the call agents' screen tool (hq_tools.py): only the line's own user reaches it.
    Each connection asks once (one JSON line with its session's key, SCREENS) and gets one answer."""
    path.unlink(missing_ok=True)
    screens = await asyncio.start_unix_server(screen_asked, path=str(path))
    path.chmod(0o600)
    return screens


# Each tool's ask on the line's socket, by the key it carries (the screen tool's has none of these), and the tool's words
# (ask_to_see and draw; open_work and drive)
ASKED_WORDS = {'sketch': SKETCH_WORDS, 'ask_to_see': ASK_WORDS, 'draw': INK_WORDS, 'open_work': OPEN_WORDS, 'drive': DRIVE_WORDS}


async def screen_asked(reader, writer):
    kind = 'screen'
    try:
        asked = json.loads(await reader.readline())
        kind = next((k for k in ASKED_WORDS if isinstance(asked, dict) and k in asked), 'screen')
        call = SCREENS.get(asked.get('key')) if isinstance(asked, dict) and isinstance(asked.get('key'), str) else None
        tool = call and {'screen': call.screen_tool, 'sketch': call.sketch_tool, 'ask_to_see': call.drawing.ask_tool,
                         'draw': call.drawing.ink_tool, 'open_work': call.driving.open_tool,
                         'drive': call.driving.drive_tool}[kind]
        answer = await tool(asked) if tool else {'error': ASKED_WORDS.get(kind, SCREEN_WORDS)['gone']}
    except Exception as err:  # (the coordinator failed, or a request of another shape: the agent hears so)
        print(f'{kind} tool: {err!r}', flush=True)
        answer = {'error': f"{ASKED_WORDS.get(kind, SCREEN_WORDS)['failed']} ({type(err).__name__})."}
    writer.write((json.dumps(answer) + '\n').encode())
    await writer.drain()
    writer.close()


def resample(x, src, dst):
    if src == dst or not len(x):
        return x
    n = int(len(x) * dst / src)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


# mu-law (the phone line's 8 kHz audio)
def ulaw_decode(b):
    u = ~np.frombuffer(b, dtype=np.uint8)
    sign, exp, mant = u & 0x80, (u >> 4) & 0x07, u & 0x0F
    x = ((mant.astype(np.int32) << 3) + 0x84) << exp
    return np.where(sign, 0x84 - x, x - 0x84).astype(np.float32) / 32768


def ulaw_encode(x):
    s = np.clip(x * 32768, -32635, 32635).astype(np.int32)
    sign = np.where(s < 0, 0x80, 0)
    s = np.abs(s) + 0x84
    exp = np.clip(np.floor(np.log2(s)).astype(np.int32) - 7, 0, 7)
    mant = (s >> (exp + 3)) & 0x0F
    return (~(sign | (exp << 4) | mant) & 0xFF).astype(np.uint8).tobytes()


# ---- the line's outside parts: the care deployments, and what the line is wired to ----
# The care deployments' phone routes: CARE_ENGINES, infra's map of each deployment's name (its product's slug) to its
# internal address (url) and the most of its calls on at once (calls, 2 when it says none: measured with two and a board
# call, the README), each behind its own token only the line and that deployment hold (in the variable its `token`
# names, as infra made it), taken out of the environment children inherit, as VOICE_TOKEN. The ticket's engine picks the
# deployment (care when it names none). An unknown one, one without its address or token, or one at its calls: a care
# call is refused, and HQ plays its recorded message. Each call at most CARE_CALL_SECONDS, past which the line closes
# the stream and HQ plays the message too.
def care_engines(listed, env):
    """CARE_ENGINES read: each deployment's name to its url, token and calls, its token taken out of env (the variable
    its entry names). A malformed entry is left out, with a line (never its token)."""
    try:
        listed = json.loads(listed or '{}')
    except ValueError:
        listed = None
    if not isinstance(listed, dict):
        print('care: CARE_ENGINES is not a JSON object: no care calls', flush=True)
        return {}
    engines = {}
    for slug, e in listed.items():
        calls = e.get('calls', 2) if isinstance(e, dict) else None
        if (not isinstance(e, dict) or not isinstance(e.get('url', ''), str) or type(calls) is not int or calls < 1
                or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', str(e.get('token', '')))):
            print(f'care: CARE_ENGINES: {slug!r} left out (not {{"url": ..., "calls": n, "token": NAME}})', flush=True)
            continue
        engines[slug] = {'url': e.get('url', '').rstrip('/'), 'calls': calls, 'token': env.pop(e['token'], '')}
    return engines


CARE_ENGINES = care_engines(os.environ.get('CARE_ENGINES'), os.environ)


# (the line's outside parts given to each route and call, so a test's line is given its own)
class Wiring(NamedTuple):
    """What the line is wired to: the coordinator it talks to (hq), its files, its clocks (now: ms since the epoch, when
    each transcript line was said; monotonic: its own seconds), how a session's CLI starts and the care deployments. A
    route hands its own to the calls it makes, so they read the coordinator from one place: these, unless a test gives
    its own."""
    hq: Callable = hq
    paths: Paths = Paths()
    now: Callable = now_ms
    monotonic: Callable = time.monotonic
    start_cli: Callable = asyncio.create_subprocess_exec
    care_engines: dict = CARE_ENGINES


# ---- the agent: a warm Claude session for the whole call, answering in streamed text ----
def spent(usage, step, thinking, thought):
    """The end of a reply's timing line: where its first seconds went. The tool
    a step before the words ran, the turn's first request's tokens (a first reply writes the briefing to the cache, a
    later one reads it), and how long the model thought before its first words. Numbers and names only: nothing said."""
    out = f'; step {step}' if step else ''
    if usage is None:  # (no message_start: stopped before the model answered, or a stream without one)
        return f'{out}; tokens unknown'
    fields = (('in', 'input_tokens'), ('cache read', 'cache_read_input_tokens'),
              ('cache write', 'cache_creation_input_tokens'))
    tokens = ', '.join(f'{name} {int(usage.get(field) or 0)}' for name, field in fields)
    return f'{out}; tokens {tokens}; ' + (f'thought {thought:.1f} s from {thinking:.1f} s' if thinking is not None
                                          else 'no thinking')


class Agent:
    """The call's brain: who answers. Call (the speech) talks to it only through this surface, so another brain can
    take its place:
    - start(): get ready for the call (and again for a fresh session mid-call: recap then holds the call so far, and
      goes in front of the next message).
    - ask(text, pictures): an async iterator over the reply, for one message: its text as it's written, a Step as a tool
      step starts and Used once its input is whole, DELIVERED once the brain has the message and RESPONSE as each later
      response in the turn starts. It raises Unanswered when the brain can't answer (in its own signals, never its words).
    - interrupt() stops the reply being written; kill() stops the session for a restart; close() ends it for good.
    - moved(): whether a restart would now find room it didn't have (here: the worker put another seat's token in).
    - The call's settings, read after start(): voice (the TTS voice), tz (the company's clock), seat (whether the
      brain has room, said at pickup), token and call (the coordinator's, for the hand-over and pictures), key (HQ's
      screen only), and on a call out opening and objected (the
      company's fixed words) and who (the other side, for the transcript).
    This one is the Claude CLI on a seat, briefed by the coordinator (call-context). The second is Care: a stranger's call on the shop's number, answered by the care service, whose words care
    keeps (kind 'care': the line keeps no transcript, says the opening and the language's words care gives it)."""
    kind = 'board'
    def __init__(self, agent, lang, request=0, phone=False, callout=0, walk=False, wiring=Wiring()):
        self.agent, self.lang, self.request, self.busy, self.token, self.call = agent, lang, request, False, '', 0
        self.walk = walk  # a walk-through of the request's work (call-context)
        self.wiring = wiring  # what the call is wired to (Call's)
        self.phone = phone  # on the phone line: no screen, so no pictures
        # a call out: its number, and from call-context the fixed words and the other side's name
        self.callout, self.opening, self.objected, self.who = callout, '', '', ''
        self.key = ''  # the call's key for HQ's picture uploads (pictures.ts)
        self.screen = None  # the line's screen socket and this session's key, on a call with a screen (Call.screen_key)
        self.voice = VOICE
        self.respell = {}  # the company's words respelt for the speech engines, by language (brand.yaml speech.respell)
        self.recap = ''  # a restarted session's first message carries the call so far (Call.answer)
        # whether a Claude seat has room (the coordinator's reading, said at pickup: Call.greet), the company's clock, and
        # the seat token this session signed in with (the worker may move the line to another: moved)
        self.seat, self.tz, self.signed = None, 'UTC', ''
        # when the seat's window resets, as the session last read it: a later turn the CLI turns away itself (it knows it's
        # limited) sends no request and gets no rate_limit_event, only the error
        self.resets = 0
        self.closed = False  # the call ended (close()): no session starts after it

    async def start(self):
        if self.closed:
            return
        # (a restart mid-call sends the call's token: the coordinator goes on with the same call, and what was promised
        # on it, and keeps whether it's a walk-through on the call's row: walk)
        # (a call about review pins went with HQ's waiting notes)
        asked = {'agent': self.agent, 'lang': self.lang, 'request': self.request, 'token': self.token, 'phone': self.phone,
                 **({'callout': self.callout} if self.callout else {}),
                 **({'walk': True} if self.walk and not self.token else {})}
        ctx = await asyncio.to_thread(self.wiring.hq, 'POST', 'call-context', asked)
        if self.closed:  # (hung up while the coordinator answered: Call.end handed the token over already)
            return
        prompt, self.token, self.call = ctx['prompt'], ctx.get('token', ''), int(ctx.get('call') or 0)
        self.key = str(ctx.get('key') or '')
        self.voice = v if isinstance(v := ctx.get('voice'), str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', v) else VOICE
        self.respell = ctx.get('respell') or {}
        model, effort = (v if isinstance(v, str) and PICK.fullmatch(v) else d for v, d in ((ctx.get('model'), MODEL), (ctx.get('effort'), EFFORT)))
        words = lambda key, most: ' '.join(str(ctx.get(key) or '').split())[:most]  # (one line)
        self.opening, self.objected, self.who = words('opening', 600), words('objected', 300), words('who', 60)
        partner = self.callout or ctx.get('tools') == 'partner'  # (the partner tools)
        # (the briefing's size: the whole of it is the first reply's prompt to write to the cache)
        print(f'call: {self.agent} on {model} ({effort} effort), briefing {len(prompt.encode())} bytes', flush=True)
        self.seat, self.tz = ctx.get('seat'), ctx.get('timeZone') if isinstance(ctx.get('timeZone'), str) else 'UTC'
        # (no token: every seat signed out; the CLI then fails its first turn as signed out, and the line says so. Maybe
        # another seat's: the last session's reset isn't this one's)
        paths = self.wiring.paths
        self.signed, self.resets = seat_token(paths.seat), 0
        session = str(uuid.uuid4())  # (its records go when it ends: watch)
        signs = sign_in_pipe(self.signed)  # (on a pipe, not in its env: guard.py)
        try:
            # (self.tz: the call's company.timeZone, for hq's times)
            env = agent_env(os.environ, HQ, signs, self.token, self.agent, self.screen, self.tz, work=paths.work,
                            cli_config=paths.cli_config)
            # It can read the company's files (main, read only) and hand work on with hq; nothing else (guard.TOOLS).
            self.proc = await self.wiring.start_cli(
                'claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
                '--include-partial-messages', '--model', model, '--effort', effort, '--session-id', session,
                *(PARTNER if partner else TOOLS),
                '--system-prompt', prompt, cwd=paths.repo if paths.repo.is_dir() else paths.work, env=env, pass_fds=(signs,),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=1 << 22)
        finally:
            os.close(signs)
        if self.closed:  # (hung up while it launched: close() didn't see this one; Call.end runs in a thread)
            self.kill()  # (watched all the same, so its records go once it has ended)
        asyncio.create_task(self.watch(self.proc, session))

    async def watch(self, proc, session):
        """What the call agent says on stderr, and how it ends, go to the voice line's log (keys blanked). Then its
        session's records go (forget)."""
        n = 0
        while line := await proc.stderr.readline():
            if (n := n + 1) <= 30:
                print('call agent:', re.sub(r'sk-[\w-]{8,}', '[redacted]', line.decode(errors='replace').rstrip())[:300], flush=True)
        code = await proc.wait()
        if code not in (0, -9):
            print(f'call agent ({self.agent}) exited with {code}', flush=True)
        await asyncio.to_thread(forget, self.wiring.paths.sessions, session)

    def moved(self):
        """The worker has put another seat's token here since this session started (one with room: worker.ts voiceSeat)."""
        return seat_token(self.wiring.paths.seat) != self.signed

    async def ask(self, text, pictures=()):
        """Yields the reply's text as it's written, until the turn ends, a Step as each tool step starts and RESPONSE as
        each later model response starts (DELIVERED for the first). Pictures
        (fetch_picture's) go in the same message, before the words. A turn the CLI ends in an error raises Unanswered,
        from its own signals (outcome.ts in the worker reads the same ones)."""
        if self.recap:
            text, self.recap = f'{self.recap}\n\n{text}', ''
        images = [{'type': 'image', 'source': {'type': 'base64', 'media_type': p['type'], 'data': p['data']}} for p in pictures]
        msg = {'type': 'user', 'message': {'role': 'user', 'content': [*images, {'type': 'text', 'text': text}]}}
        if self.proc.returncode is not None:
            raise RuntimeError(f'the call agent is gone (exit {self.proc.returncode})')
        self.proc.stdin.write((json.dumps(msg) + '\n').encode())
        await self.proc.stdin.drain()
        self.busy, t0, first, tool = True, self.wiring.monotonic(), None, None
        # Where the first seconds go: the turn's first request's tokens (input,
        # cache read, cache write: message_start), and the thinking before the first words (when it began, how long
        # it ran)
        usage, named, thinking, thought, since = None, '', None, 0.0, None
        rejected, error = None, None  # the CLI's own: a usage window that turned the request away (its reset), its error
        steps = {}  # each tool step's name and input so far, by its block's index (Used)
        while True:
            # silence for 90 s (not even a tool step or a keep-alive) means it's stuck: the caller restarts it
            line = await asyncio.wait_for(self.proc.stdout.readline(), 90)
            if not line:
                raise RuntimeError(f'the call agent ended mid-reply (exit {await self.proc.wait()})')
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('type') == 'stream_event':
                ev = e.get('event', {})
                d, block = ev.get('delta', {}), ev.get('content_block', {})
                if ev.get('type') == 'message_start' and usage is None:
                    usage = ev.get('message', {}).get('usage') or {}
                    yield DELIVERED
                elif ev.get('type') == 'message_start':
                    yield RESPONSE
                elif (ev.get('type') == 'content_block_start' and first is None
                      and block.get('type') in ('thinking', 'redacted_thinking')):
                    since = self.wiring.monotonic() - t0
                    thinking = since if thinking is None else thinking
                elif ev.get('type') == 'content_block_stop' and since is not None:  # (blocks never overlap in a stream)
                    thought, since = thought + self.wiring.monotonic() - t0 - since, None
                if d.get('type') == 'text_delta':
                    if first is None:
                        first = self.wiring.monotonic() - t0
                    yield d['text']
                elif ev.get('type') == 'content_block_start' and block.get('type') == 'tool_use':
                    # (the model starts writing the tool's input: a job's whole brief comes before the tool runs)
                    if first is None and tool is None:
                        tool, named = self.wiring.monotonic() - t0, str(block.get('name') or '')
                    steps[ev.get('index')] = {'name': str(block.get('name') or ''), 'json': ''}
                    yield Step(str(block.get('name') or ''))
                elif d.get('type') == 'input_json_delta' and ev.get('index') in steps:
                    steps[ev['index']]['json'] += str(d.get('partial_json') or '')
                elif ev.get('type') == 'content_block_stop' and ev.get('index') in steps:
                    step = steps.pop(ev['index'])
                    try:
                        tool_input = json.loads(step['json'] or '{}')
                    except ValueError:
                        tool_input = None
                    yield Used(step['name'], tool_input if isinstance(tool_input, dict) else {})
            elif e.get('type') == 'rate_limit_event' and (e.get('rate_limit_info') or {}).get('status') == 'rejected':
                reset = e['rate_limit_info'].get('resetsAt')
                rejected = self.resets = int(reset * 1000) if isinstance(reset, (int, float)) and reset > 0 else 0
            elif e.get('type') == 'assistant' and not e.get('parent_tool_use_id'):
                error = str(e['error']) if e.get('error') else None  # (the session's last message decides, as in outcome.ts)
            elif e.get('type') == 'system' and e.get('subtype') == 'init':
                if [s for s in e.get('mcp_servers', []) if s.get('status') != 'connected']:
                    print(f'call agent ({self.agent}): hand-on tools not connected: {e["mcp_servers"]}', flush=True)
            elif e.get('type') == 'result':
                self.busy = False
                if e.get('is_error') and e.get('subtype') != 'error_during_execution':  # (that one is an interrupt)
                    print(f'call agent ({self.agent}): {e.get("subtype")}: {str(e.get("result"))[:200]}', flush=True)
                # a turn stopped before its first words has no first-words time: it says so, so it isn't counted as one
                # a tool step before the first words says when it started: its time isn't the model's time to speak
                step = f' (after a tool step at {tool:.1f} s)' if tool is not None else ''
                words = f', first words after {first:.1f} s{step}' if first is not None else ' with no words'
                done = self.wiring.monotonic() - t0
                thought += done - since if since is not None else 0  # (stopped while thinking)
                tail = (step if first is None else '') + spent(usage, named, thinking, thought)
                print(f'call: {self.agent} replied{words}, done after {done:.1f} s{tail}', flush=True)
                if e.get('is_error') and e.get('subtype') != 'error_during_execution':
                    status = e.get('api_error_status')
                    why = ('limit' if error == 'rate_limit' or status == 429 or rejected is not None else
                           'signin' if error == 'authentication_failed' or status == 401 else 'error')
                    # (a turn the CLI turned away itself has no rate_limit_event: the reset it last read, if still ahead)
                    until = rejected or (self.resets if self.resets > self.wiring.now() else 0)
                    raise Unanswered(why, until if why == 'limit' else 0)
                return

    def interrupt(self):
        """Stops the reply being written (the session keeps what it heard)."""
        if self.busy:
            self.proc.stdin.write((json.dumps({'type': 'control_request', 'request_id': f'stop-{time.monotonic()}',
                                               'request': {'subtype': 'interrupt'}}) + '\n').encode())

    def kill(self):
        """Stops the session, for a restart: the call goes on."""
        if getattr(self, 'proc', None) and self.proc.returncode is None:
            self.proc.kill()

    def close(self):
        """The call ended: the session stops, and none starts again."""
        self.closed = True
        self.kill()


def forget(sessions, session='*'):
    """A call agent's session records (its every word, and the pictures it saw), gone once its CLI has ended: at the
    hang-up, or at a restart mid-call, whose new session starts afresh from the call so far. The transcript HQ has is the
    only copy then, under HQ's own rules (audit 2026-10-04, P19). Each turn's numbers stay, in the log (turns.py, kept by
    infra/call-times.sh). sessions: the folder of their records (Paths.sessions); '*': every session a crash or
    restart left behind."""
    for path in sessions.glob(f'*/{session}.jsonl'):
        try:
            for stamp, line in turns.turns(path):
                print(stamp, line, flush=True)
        except (KeyError, TypeError, ValueError, AttributeError, IndexError) as error:  # (a record of another shape)
            print(f'turns: {path.name}: {error!r}', flush=True)
        path.unlink(missing_ok=True)
        shutil.rmtree(path.with_suffix(''), ignore_errors=True)  # (the CLI's folder for the session: big tool results)
    for folder in PICTURE_COPIES.glob(f'claude-*/*/{session}'):  #.
        shutil.rmtree(folder, ignore_errors=True)


# ---- A care call: a stranger's call, answered by the care service ----
# (CARE_ENGINES, the care deployments' phone routes: with the line's outside parts, Wiring)
CARE_CALL_SECONDS = 600
CARE_LIVE = {}  # the CallSids of the care calls on now, to the deployment each is on
# care's names for the two steps the line acts on, as the CLI's
CARE_STEPS = {'hang_up': HANG_UP_TOOL, 'no_transcript': NO_TRANSCRIPT_TOOL}
CARE_READ_SECONDS = 90  # a turn's stream silent this long is care gone (the CLI's 90 s, Agent.ask)


def care_post(deployment, path, body):
    """One of a care deployment's JSON routes (start, end). Raises on anything but a 200 (a 503's HTTPError too)."""
    req = Request(f"{deployment['url']}{path}", method='POST', data=json.dumps(body).encode(),
                  headers={'authorization': f"Bearer {deployment['token']}", 'content-type': 'application/json'})
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read() or 'null')


def modelled(timed):
    """Care's account of a turn's model calls, after the reply's line: how many, when its first words came, and the
    prompt's tokens read from the model's cache and written to it (a big write: the cache was cold). Numbers only
."""
    if not timed:
        return ''
    n = lambda k: int(timed[k]) if isinstance(timed.get(k), (int, float)) else 0
    first = timed.get('first')
    words = f'first words after {first:.1f} s, ' if isinstance(first, (int, float)) else ''
    calls = f"{n('rounds')} call{'s' if n('rounds') != 1 else ''}"
    return f"; care's model: {calls}, {words}cache read {n('read')}, written {n('written')}"


class Care:
    """The second brain (Agent's surface): a stranger on the shop's number, answered
    by the care service's phone conversation (platform/care: its instructions, knowledge, phone tools, ledger and caps).
    start() posts /phone/start and keeps the words care gives in each language (ai, transcript, ask, objected); ask() posts
    a turn and reads its NDJSON (the reply's language, text, a step as a tool starts, used once it ran, then end or
    unanswered); interrupt() closes
    that request (care keeps what it wrote); close() posts /phone/end with how the call ended (ended, the line's). No CLI,
    no seat, no pictures: care keeps the words, so the line keeps no transcript (kind 'care')."""
    kind = 'care'

    def __init__(self, agent, sid, lang, langs=(), voice=None, voices=None, respell=None, seeds=None, deployment=None):
        self.agent, self.sid, self.lang = agent, sid, lang
        # the care deployment the call is on (CARE_ENGINES's: its url and token)
        self.deployment = deployment or {'url': '', 'token': ''}
        # the opening's languages, in order (HQ's, by the caller's number), and the voice in a language where the company
        # names one of the line's own
        self.opened = [x for x in dict.fromkeys(langs or ()) if x in ('nl', 'de', 'en')]
        # (a Piper voice's name or Pocket TTS's)
        self.voices = {k: v for k, v in (voices or {}).items()
                       if k in ('nl', 'de', 'en') and isinstance(v, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', v)}
        self.voice = voice if isinstance(voice, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', voice) else VOICE
        # the seed of the fixed words in a language where the company names one (SEED)
        self.seeds = {k: v for k, v in (seeds or {}).items() if k in ('nl', 'de', 'en') and type(v) is int and v >= 0}
        self.respell = respell or {}
        self.conversation, self.words, self.langs = None, {}, []
        # Agent's settings that a care call has none of
        self.busy, self.token, self.call, self.key, self.seat, self.tz = False, '', 0, '', None, 'UTC'
        self.opening = self.objected = self.who = self.recap = ''
        self.ended = 'caller'  # how the call ended, for /phone/end: the line sets it when it ends the call itself
        # the languages the caller has been informed in so far (their notice heard whole), with each turn and the end:
        # care keeps their words only after (the call sets it: Call.informed)
        self.informed = lambda: []
        self.closed, self.request, self.stopped = False, None, False

    async def start(self):
        """The care conversation, once a call (a restart mid-call has none to go on with: it raises, and the line ends the
        call). Raises if care refuses (503: off, cap, down) or answers something else."""
        if self.conversation is not None or self.closed:
            raise RuntimeError('a care call has one conversation')
        # (the opening's first language: care reads its prompt into the model's cache in it while the opening plays;
        first = (self.opened or [self.lang])[0]
        got = await asyncio.to_thread(care_post, self.deployment, '/phone/start', {'call': self.sid, 'lang': first})
        words = got.get('words') if isinstance(got, dict) else None
        if not isinstance(got.get('conversation'), (str, int)) or not isinstance(words, dict):
            raise ValueError('care answered /phone/start without a conversation and its words')
        line = lambda v: ' '.join(str(v or '').split())[:400]
        keys = ('ai', 'transcript', 'ask', 'objected', 'fine', 'reply_ai')
        self.words = {lang: {k: line(w.get(k)) for k in keys} for lang, w in words.items()
                      if lang in ('nl', 'de', 'en') and isinstance(w, dict) and line(w.get('ai'))
                      and line(w.get('transcript'))}
        if not self.words:
            raise ValueError('care gave no words for the opening')
        self.langs = [lang for lang in got.get('langs') or [] if lang in self.words] or list(self.words)
        self.conversation = got['conversation']
        self.speak(self.lang if self.lang in self.words else self.langs[0])

    def speak(self, lang):
        """The call goes on in this language (the reply's, as care tagged it): its turns and objection words."""
        self.lang = lang
        self.objected = (self.words.get(lang) or {}).get('objected') or OBJECTED.get(lang, OBJECTED['en'])

    def moved(self):
        return False

    def post_turn(self, text, loop):
        """The turn's request, in a thread of its own (http.client reads the chunks). Returns the queue the thread puts
        to (DELIVERED once the request is sent, the status, each line of the body as it comes, then None at its end, or
        the error that cut it) and stop(), which cuts the request."""
        url = urlsplit(self.deployment['url'])  #.
        body = json.dumps({'conversation': self.conversation, 'text': text, 'lang': self.lang,
                           'informed': self.informed()}).encode()
        got, sock, cut = asyncio.Queue(), [], threading.Event()

        def put(item):
            try:
                loop.call_soon_threadsafe(got.put_nowait, item)
            except RuntimeError:
                pass  # (the loop has closed: nobody reads the turn any more)

        def stop():  # (from the loop or Call.end's thread: a socket shut down ends the read under way in post at once)
            cut.set()
            for s in sock:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass  # (closed already: post has ended)

        def post():
            conn, resp = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=15), None
            try:
                conn.connect()
                sock.append(conn.sock)
                if cut.is_set():  # (stopped while connecting: checked after the append, so stop sees one or the other)
                    return put(None)
                conn.sock.settimeout(CARE_READ_SECONDS)
                conn.request('POST', f'{url.path.rstrip("/")}/phone/turn', body, {
                    'Authorization': f"Bearer {self.deployment['token']}", 'Content-Type': 'application/json',
                    'Connection': 'close'})
                put(DELIVERED)
                resp = conn.getresponse()
                put(resp.status)
                while resp.status == 200 and (line := resp.readline()):
                    put(line)
                put(None)
            except Exception as err:  # (handed to the turn, which raises it)
                put(err)
            finally:
                if resp:
                    resp.close()
                conn.close()

        self.request = stop  # (before the thread starts: Call.end cuts the turn from its own thread)
        threading.Thread(target=post, name=f'care turn {self.agent}', daemon=True).start()
        return got, stop

    async def ask(self, text, pictures=()):
        """A turn: Yields DELIVERED once the request is sent, then the reply's text as care writes it, a Step as a tool
        starts and Used once it ran (the line acts on hang_up and no_transcript, named as the CLI's). Raises Unanswered
        when care answers so (cap, down, error) or is gone (closed, silent, not a 200)."""
        self.stopped = False
        got, stop = self.post_turn(text, asyncio.get_running_loop())
        self.busy, t0, first, timed = True, time.monotonic(), None, None
        try:
            while (item := await got.get()) is not None:
                if isinstance(item, Exception):
                    raise item
                if item is DELIVERED:
                    yield DELIVERED
                    continue
                if isinstance(item, int):
                    if item == 200:
                        continue
                    if self.stopped:
                        return
                    raise Unanswered('down' if item == 503 else 'error')
                try:
                    e = json.loads(item)
                except ValueError:
                    continue
                if not isinstance(e, dict):
                    continue
                if isinstance(e.get('text'), str):
                    first = first if first is not None or not e['text'].strip() else time.monotonic() - t0
                    yield e['text']
                elif e.get('lang') in self.words:
                    yield Language(e['lang'])
                elif isinstance(e.get('step'), str):
                    yield Step(CARE_STEPS.get(e['step'], e['step']))
                elif isinstance(e.get('used'), str):
                    yield Used(CARE_STEPS.get(e['used'], e['used']), {})
                elif e.get('unanswered'):
                    raise Unanswered(str(e['unanswered']))
                elif e.get('end'):
                    timed = e.get('model') if isinstance(e.get('model'), dict) else None
                    return
            if not self.stopped:  # (ended without its end: care went away mid-reply)
                raise Unanswered('down')
        except (OSError, http.client.HTTPException) as err:  # (silent: a timeout, an OSError; cut: an HTTPException)
            if not self.stopped:
                print(f'call: {self.agent}: care turn failed: {err!r}', flush=True)
                raise Unanswered('down') from err
        finally:
            self.busy, self.request = False, None
            stop()
            # (as the CLI's turns log theirs: the call's timeline in the status report)
            words = f', first words after {first:.1f} s' if first is not None else ' with no words'
            print(f'call: {self.agent} replied{words}, done after {time.monotonic() - t0:.1f} s{modelled(timed)}',
                  flush=True)

    def interrupt(self):
        """Stops the reply: the turn's request is closed, and care stops writing (it keeps what it had)."""
        if (stop := self.request) is not None:
            self.stopped = True
            stop()

    def kill(self):
        self.interrupt()

    def close(self):
        """The call ended (in Call.end's thread): the turn's request closes, and care hears how (/phone/end), once."""
        if self.closed:
            return
        self.closed = True
        self.interrupt()
        if self.conversation is not None:
            try:
                care_post(self.deployment, '/phone/end', {'conversation': self.conversation, 'ended': self.ended,
                                                          'informed': self.informed()})
            except Exception as err:
                print(f'call: {self.agent}: care did not take the end of the call: {err!r}', flush=True)


def spelled(text, lang):
    """The text with the letters Pocket TTS misreads in this language spelled as they're said (SPELLED)."""
    for written, said in SPELLED.get(lang, ()):
        text = re.sub(rf'(?<![\w.]){written}\b', said, text)
    return text


# (a full stop after a digit at the end of what's come so far waits for the next words: "€29." may go on "95")
SENTENCE = re.compile(r'(.+?[.!?…])(\s+|(?<!\d\.)$)', re.S)
CLAUSE = re.compile(r'(.{24,}?[,;:—])\s+', re.S)  # the reply's first words can start at a comma: the board hears sooner


def spoken(text):
    """Markdown and links out: this is read aloud."""
    text = re.sub(r'https?://\S+', '', text)
    # (a "#90" stays: aloud() says "number ninety".)
    return re.sub(r'[*_`>\[\]]|#(?!\d)', '', text).strip()


# (every number, not only euros)
# Words that don't interrupt a reply by themselves: backchannel, filler, little words, and what the recogniser makes of
# a noise ("And they can." on the phone line, from a hum). Backchannel of more than one word counts as one ("thank you",
# "wat mooi"), so its words don't count as filler anywhere else ("Can you see that?"). English counts on a Dutch call
# too ("oké", "sure"); a word that means stop does interrupt, alone or not.
FILLER = {'en': set('ok okay yeah yes yep yup ya yah mhm mm mmm hmm hm uh um uhm er erm ah oh huh aha right sure alright '
                    'fine good great nice cool true exactly perfect lovely wow thanks '
                    'and the an so but they we he she can then that this is'.split()),
          'nl': set('oké oke ja jaja jawel jep nou eh ehm uhm hè goed prima precies klopt top mooi zeker inderdaad tuurlijk '
                    'natuurlijk fijn leuk bedankt hoor zo en de het een dat die maar dan ik'.split()),
          'de': set('okay ok ja jaja jo genau gut prima super klar stimmt richtig toll schön danke aha achso hm mhm äh ähm '
                    'naja na und der die das ein eine es ich dann also'.split())}
PHRASES = {'en': ['thank you', 'i see', 'got it', 'all right', 'all good'],
           'nl': ['dank je wel', 'dank u wel', 'dank je', 'wat mooi', 'wat leuk', 'wat fijn', 'o ja'],
           'de': ['danke schön', 'vielen dank', 'alles klar', 'ach so', 'na gut', 'ach ja']}
# English and Dutch words that mean stop count on any call (the board mixes them); a German call adds its own
STOP = {'en': {'stop', 'wait', 'no', 'nope', 'don', 'cancel', 'scratch', 'enough', 'sorry', 'pardon', 'what'},  # ("don't")
        'nl': {'wacht', 'nee', 'niet', 'wat'},
        'de': {'stopp', 'halt', 'warte', 'warten', 'nein', 'moment', 'was', 'wie', 'entschuldigung'}}


def stray(text, lang='en'):
    """A sound over the agent's reply that isn't an interruption: nothing heard, one word, only backchannel ("okay",
    "mhm", "oké, prima", "thank you") and loose letters ("M H M."), or two words that aren't a finished sentence of two
    real words ("so the", "yeah, pretty."; a short answer too: "Yes, please.", "Sounds good.", "Ja, graag."). An
    interruption: a word that means stop, a question of two words or more ("Is that all?", "En dan?"), a finished
    sentence of two real words ("Hold on."), or three words or more that aren't all filler ("Yes, do it.")."""
    phrases = PHRASES['en'] + PHRASES.get(lang, [])
    words = re.findall('|'.join(rf'\b{p}\b' for p in phrases) + r'|\w+', text.lower())
    filler = [len(w) == 1 or w in FILLER['en'] | FILLER.get(lang, set()) | set(phrases) for w in words]
    finished = re.search(r'[.?!]["”’]?$', text)
    if len(words) >= 2 and re.search(r'\?["”’]?$', text) or (STOP['en'] | STOP['nl'] | STOP.get(lang, set())) & set(words):
        return False
    return all(filler) or len(words) < 2 or (len(words) == 2 and (any(filler) or not finished))


# Sounds the board makes to hold the floor, which say nothing: they keep the agent from answering (stray), and
# go from what's written down once that's done (unhesitating). Each language its own: "er" is a word in Dutch, "eh" a
# question in English; "mhm", "uh-huh", "hmm" and "ah" (a reaction, or amp-hours) say something and stay.
HESITATION = {'en': 'uh um uhm er erm', 'nl': 'eh ehm uh um uhm', 'de': 'äh ähm öh öhm eh ehm'}


def unhesitating(text, lang='en'):
    """The board's words as they're written down: without its "uh"s and "um"s (the recogniser's "Uhh", repeats too),
    with the commas around them (one stays where it sat between two), and a sentence that started with one starting with
    the next word ("Uh, keep it simple." is "Keep it simple."). Only hesitation: nothing left, and it's the words as
    heard."""
    # (drawn out too: "Uhh", "Ummm", "Eer", but never into a word: "err" stays; capitalised only on its first letter, so
    # an acronym such as "ER" stays)
    sounds = '|'.join(f"[{w[0]}{w[0].upper()}]{w[0]}*{w[1:]}{'' if w.endswith('r') else '+'}"
                      for w in HESITATION.get(lang, HESITATION['en']).split())
    sound = rf"(?<![\w'’@./\\-])(?:{sounds})(?![\w'’/\\-]|[.@]\w)"  # (a word of its own: not "uh.com", "uh/notes")
    opening = rf"(?:^|(?<=[.?!…]\s))(?:{sound}[,.?!…]*(?:\s+|$))+(\w?)"
    out = re.sub(opening, lambda m: m[1].upper(), text)
    # (between two commas or dashes, the first stays: "Wait, um, what?" is "Wait, what?", "Wait — um — what" "Wait — what")
    within = rf"(,|\s[—–-])?(?:\s+{sound}(,|\s[—–-])?)+"
    out = re.sub(within, lambda m: m[1] if m[1] and m[2] else '', out).strip()
    return out or text


def listener():
    """A VAD as the line listens with it: speech ONSET s in, over PAUSE s after its last sound."""
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(MODELS / 'silero_vad.onnx')
    cfg.silero_vad.threshold, cfg.silero_vad.min_silence_duration, cfg.silero_vad.min_speech_duration = 0.5, PAUSE, ONSET
    cfg.sample_rate = RATE
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)


def transcribe(seg):
    s = asr.create_stream()
    s.accept_waveform(RATE, seg)
    asr.decode_stream(s)
    return s.result.text.strip()


# ---- one call ----
class Limits(NamedTuple):
    """What one call may hold, how long it waits on the board and HQ, and how long a care call may last: the line's are
    these defaults (each one's comment at the top; drawing.py's INK_SECONDS); a test gives its call smaller ones."""
    session_bytes: int = SESSION_BYTES
    screen_turn_seconds: float = SCREEN_TURN_SECONDS
    screen_pictures: int = SCREEN_PICTURES
    ink_seconds: float = INK_SECONDS
    wait_seconds: dict = WAIT_SECONDS
    hang_up_wait_seconds: float = HANG_UP_WAIT_SECONDS
    care_call_seconds: float = CARE_CALL_SECONDS


class Call:
    def __init__(self, send_audio, send_event, clear, agent, lang, request=0, phone=False, hang_up=None, callout=0,
                 speakers=None, brain=None, walk=False, limits=Limits(), wiring=Wiring()):
        self.send_audio, self.send_event, self.clear = send_audio, send_event, clear
        # What it may hold and how long it waits (Limits) and what it's wired to: the coordinator, the line's files, its
        # clocks and how its session's CLI starts (Wiring)
        self.limits, self.wiring = limits, wiring
        self.hang_up = hang_up  # how the line ends the call when the agent hangs up (HANG_UP_TOOL): HQ's or the phone's
        self.agent, self.lang, self.request, self.lines = agent, lang, request, []
        # when each line was said (wall_ms), beside it: the turn's start for the board's words and the agent's reply, so a
        # walk-through's recording lines up with them.
        self.times = []
        self.file = self.wiring.paths.calls / f'{secrets.token_hex(6)}.json'  # the transcript so far, in case the line crashes
        # (the brain: Agent's docstring; walk)
        self.brain = brain or Agent(agent, lang, request, phone, callout, walk, wiring=wiring)
        self.vad = listener()  #.
        # the agent's voice taken out of HQ's microphone (a phone's handset takes out its own, a room each person's: room.py).
        self.echo = None if phone or speakers else Echo()
        self.phone = phone  # (the phone's hold sound: thinking)
        # A call out: its number, how the transcript names the other side (the
        # partner, from call-context; in a room, each piece's speaker: speakers(start, end) names who was loudest over
        # those samples), the opening still to say, the agent's notes, and whether the other side asked for no transcript
        self.callout, self.speakers, self.them = callout, speakers, 'Board'
        self.opening, self.opening_quiet = None, OPENING_QUIET_SECONDS
        self.notes, self.objected = [], False
        self.speaker = None  # in a room: who said the draft's last piece
        self.pending = np.zeros(0, np.float32)
        self.recent, self.n = np.zeros(0, np.float32), 0  # the last 8 s heard, and how many samples in all
        # How many of the board's samples have come, all call: HQ keeps what it sent until the line says it has it, and
        # sends the rest again on a new connection (app_call: pong and call).
        self.got = 0
        self.draft = []       # what the board has said since the last answer, piece by piece
        self.draft_at = None  # when its first piece started (wall_ms).
        self.sounded_finished = True  # whether the board sounded finished after the draft's last piece (endpoint.py)
        self.pauses = [0, 0]  # the board's pauses after words, all call: how many sounded finished, how many in all
        self.waiting = None   # the timer that answers the draft once the board sounds finished
        self.again = False    # the draft includes a message whose reply was taken back
        self.speaking = None  # threading.Event that stops the current reply
        self.turn = None      # the current reply's task; the Claude session answers in order
        self.last = None      # the current reply: what it answers, where it starts in the transcript, when it was first heard
        self.voiced = self.quiet = 0  # how long the board has been talking, or quiet, in VAD windows
        self.over = None      # the board talking over a reply, not (yet) an interruption: since when, and what went before
        self.kept = None      # a sound over the reply that was let go: it counts again if the board carries on
        self.until = 0        # when the reply's audio sent so far ends (it goes out ahead of playback)
        self.live_at = None   # when HQ first heard the line pick up (wall clock): HQ's timeline counts from there
        self.ping = None      # HQ's last ping: when it came, the quickest ping's delay so far (ms, the baseline), and
        # how much audio the line had heard by then (samples)
        self.late = 0.0       # how late the last ping came against that baseline (s)
        self.latest, self.waited = 0.0, 0  # the latest it came all call, and how many answers waited (the hang-up line)
        self.noticed = None   # why the agent couldn't answer, as the line last said it (until a reply gets through)
        # Hung up: after end(), no turn or agent starts and the transcript isn't written
        self.ended = False
        self.writing = threading.Lock()  # a transcript write, from its check of ended to its last byte (end() runs in a thread)
        self.pictures = []    # pictures the board shared that haven't gone to the agent yet, in the order it shared them
        self.known = set()    # the number of every picture HQ sent: HQ sends one again until it hears back (show)
        self.picture_bytes = 0  # what the session has seen and what waits for it, as base64 (SESSION_BYTES)
        self.held = []        # the numbers of the pictures the session has seen: a restarted one has none of them
        # Pictures whose turn stopped before its request started: their message stays in the session and goes with its
        # next request, which is when the model has them
        self.unsent = []
        self.firsts = {}      # each picture the line has, by its bytes' hash: the same picture shared again isn't sent again
        self.copies = {}      # the numbers of those shared again, by the first one's: HQ hears the same about them
        self.told = {}        # each picture's last event to HQ, by its number: a resumed connection hears them again
        self.showing = None   # the wait for a quiet moment to show them with nothing said
        self.leaving = None   # the agent hung up: the wait for its goodbye to play before the line ends the call (leave)
        # A walk-through's screen (SCREEN_TURN_SECONDS): the last moment the agent has had, the version of the last
        # screen picture its session has (0: none), how many screen pictures the call has had, what of SCREEN_WORDS its
        # session has heard ('brief' is the coordinator's briefing), and whether the caller has paused showing it
        self.screen = {'after': 0, 'seen': 0, 'pictures': 0, 'heard': set(), 'paused': False}
        self.screen_key = ''  # the session's key on the line's screen socket (SCREENS)
        # The board drawing on its HQ call (drawing.py): its notes go with the
        # pictures above (note), with entries of their own ('note'), and the agent's asks and rings wait here. On the
        # last screen-turn the screen was on (screen['on']); away: HQ's connection dropped and it hasn't come back yet.
        self.screen['on'], self.away = False, False
        self.drawing = Drawing(self)
        # The agent driving a piece of work on the board's screen (driving.py)
        self.driving = Driving(self)
        # A stranger's call answered by care: care keeps the words, so the line keeps no transcript file. The opening is
        # said at pickup (care_opening); the caller's first words are kept here (first) until they have heard its notice
        # (the AI line and the transcript line) whole in each of its languages (care_first), and a reply in another
        # language says its AI line first and its transcript line after its words (speak). notices: the turns that said
        # notice lines, each with when each line
        # ends playing ('ends') and when it was cut ('cut'), if it was. drop: how the line ends the call without the
        # care agent's goodbye (a turn care can't answer: HQ plays its message).
        self.care = getattr(self.brain, 'kind', '') == 'care'
        self.first, self.notices, self.drop = None, [], None
        # settled: a second reply to the caller has played in a language they've heard the notice in (one short first
        # reply can't show which they understand); from then on no notice line plays again, whatever language a reply
        # is in (care settles the call's language the same way: phonelang.ts). replies: the caller's turns answered in
        # each language until then
        self.settled, self.replies = False, {}
        self.spoke = None  # when the caller's last words ended, for the reply's timing line (care calls)
        if self.care:
            self.them = 'Caller'
            self.brain.informed = self.informed

    async def start(self):
        live = self.wiring.paths.live / self.file.stem  # (live while it's set up too)
        live.touch()
        self.new_screen_key()  #.
        try:
            await self.brain.start()
        except BaseException:
            live.unlink(missing_ok=True)
            raise
        if self.callout:
            self.them = self.brain.who or 'Partner'
        await self.send_event({'type': 'state', 'state': 'listening'})

    async def greet(self):
        """At pickup, before the board starts talking: when no Claude seat has room (the coordinator's reading of the
        worker's seats), the line says so at once, as a turn of its own the board can talk over. On a call out the agent
        speaks first, in the opening's fixed words, once the other side has picked up (opened)."""
        if self.callout and self.brain.opening:
            self.opening = {'said': False}
            return
        if self.care:
            self.first = []
            self.turn = asyncio.create_task(self.care_opening())
            return
        seat = self.brain.seat
        if isinstance(seat, dict) and seat.get('room') is False:
            self.turn = asyncio.create_task(self.seatless(str(seat.get('why') or 'limit'), seat.get('until') or 0))

    def open(self, greeting, at=None):
        """A call out: the other side has picked up and said its first words (greeting), or nothing for a while: the
        agent's opening, said once, as a turn of its own they can talk over like any reply."""
        self.opening['said'] = True
        self.turn = asyncio.create_task(self.say_opening(greeting, at))

    async def say_opening(self, greeting, at=None):
        """The opening in the company's fixed words, never the model's, in the agent's voice and the transcript as the
        agent's line. The model hears it was said with the next message, and goes on from the other side's answer."""
        greeting = unhesitating(greeting, self.lang)
        for line in self.heard_lines(greeting) if greeting else ():
            self.write(line, at)
        turn = self.last = {'text': '', 'n': len(self.lines), 'heard': None, 'back': False}
        stop = self.speaking = threading.Event()
        words = self.brain.opening
        print(f'call: {self.agent} said the opening on call out {self.callout}', flush=True)
        await self.say(words, stop, turn)
        self.write(f'{self.agent.capitalize()}: {words}' + (' (interrupted)' if stop.is_set() else ''), self.heard_at(turn))
        self.keep()
        answered = f' They picked up and said: "{greeting}"' if greeting else ' They picked up'
        over = ', and they talked over it' if stop.is_set() else ''
        self.brain.recap = (f'(The call is live.{answered}. The line has said your opening for you, in these words: '
                            f'"{words}"{over}. Go on from what they say next.)')
        if not stop.is_set():
            await self.send_event({'type': 'state', 'state': 'listening'})

    async def care_opening(self):
        """A care call's opening, in the care agent's voice for each language: in the first of the ticket's languages
        (HQ's, by the caller's number) the AI line, the transcript line and the ask, then in each other only the AI line
        and care's `fine` ("English is fine too."), one flow the caller can talk over like any reply, with no pause for
        them to wonder whether to speak. What they say goes to care once they've heard its notice lines whole
        (care_first); a reply in a language whose notice they haven't heard says it around its words (speak)."""
        turn = self.last = {'text': '', 'n': len(self.lines), 'heard': None, 'back': False, 'ends': {}}
        self.notices.append(turn)
        stop = self.speaking = threading.Event()
        words = self.brain.words
        said = []
        for lang, key in self.opening_lines():
            if not stop.is_set():
                said.append(words[lang][key])
                await self.say(words[lang][key], stop, turn, lang, keep=True)
                if not stop.is_set():  # (its audio goes out ahead of playback: heard whole once that has played)
                    turn['ends'][(lang, key)] = self.until
        cut = ' (interrupted)' if stop.is_set() else ''
        self.write(f'{self.agent.capitalize()}: ' + ' '.join(said) + cut)
        if not stop.is_set():
            await self.send_event({'type': 'state', 'state': 'listening'})

    def opening_languages(self):
        return [lang for lang in self.brain.opened if lang in self.brain.words] or self.brain.langs

    def opening_lines(self):
        """The opening's lines as (language, key), in order: in its first language the AI line, the transcript line and
        the ask, in each after it the AI line and care's `fine`, where care has them."""
        words = self.brain.words
        return [(lang, key) for n, lang in enumerate(self.opening_languages())
                for key in (('ai', 'transcript', 'ask') if n == 0 else ('ai', 'fine')) if words[lang].get(key)]

    def missed(self, lang, by=float('inf')):
        """What of the notice in this language (the AI line, the transcript line) the caller hasn't heard: a line counts
        once its audio has gone out whole, and only while nothing cut it before it ended playing (by: and it had ended
        playing by then). Once they'd rather we kept no transcript (object), no transcript line is owed: one would say
        we keep it."""
        words = self.brain.words.get(lang) or {}
        heard = {key for turn in self.notices for (said, key), end in turn['ends'].items()
                 if said == lang and end <= by and turn.get('cut', float('inf')) >= end}
        owed = ('ai',) if self.objected else ('ai', 'transcript')
        return [key for key in owed if words.get(key) and key not in heard]

    def informed(self):
        """The languages whose AI and transcript lines (the AI line alone once they objected) the caller has heard played
        whole by now, for care, which keeps their words only once their reply's language is one of them."""
        now = self.wiring.monotonic()
        return [lang for lang in self.brain.words if not self.missed(lang, now)]

    async def care_first(self, text, before):
        """The caller's words on a care call before they've heard the opening's notice whole in each of its languages:
        kept here, not sent to care, while the line says what of it they missed and it plays out; then they go as the
        first turn. Talked over again, their words so far go with what they say next."""
        if before and not before.done():
            self.last.setdefault('cut', self.wiring.monotonic())
            self.speaking.set()
            self.until = 0
            await asyncio.gather(before, return_exceptions=True)
        if self.ended or self.first is None:
            return
        self.first.append(text)
        # what of the opening's notice lines they missed (an AI line with its "English is fine too.", as it was said)
        missing = lambda: [(lang, key) for lang, key in self.opening_lines() if key in self.missed(lang)]
        missed = [(lang, key) for lang, key in self.opening_lines()
                  if key in self.missed(lang) or key == 'fine' and 'ai' in self.missed(lang)]
        stop = self.speaking = threading.Event()
        if missed:
            turn = self.last = {'text': '', 'n': len(self.lines), 'heard': None, 'back': False, 'ends': {}}
            self.notices.append(turn)
            for lang, key in missed:
                if not stop.is_set():
                    await self.say(self.brain.words[lang][key], stop, turn, lang, keep=True)
                    if not stop.is_set():
                        turn['ends'][(lang, key)] = self.until
            self.write(f'{self.agent.capitalize()}: ' + ' '.join(self.brain.words[lang][key] for lang, key in missed)
                       + (' (interrupted)' if stop.is_set() else ''))
        while not stop.is_set() and not self.ended and self.wiring.monotonic() < self.until:  # (heard: played out)
            await asyncio.sleep(0.05)
        if stop.is_set() or self.ended or missing():
            return
        heard, self.first = ' '.join(self.first), None
        await self.answer(heard, None)

    async def speak(self, lang, stop, turn):
        """A reply in this language (its tag): the call goes on in it, and on a care call whose caller hasn't heard the
        notice whole in it (a language the opening didn't have, or a notice talked over), what of it they missed goes
        around the reply: the AI line first, in care's short words for a reply (`reply_ai`) where it has them, and the
        transcript line once the reply's words are out (notice_after), so the reply answers them straight away. Care
        keeps their words only once both have played uncut. Once a second reply to the caller has played in a language
        they were informed in, the call has settled, and the notice is never said again."""
        if lang != self.lang:
            settled = ' (settled: no notice again)' if self.settled else ''
            print(f'call: {self.agent}: the reply is in {lang}{settled}', flush=True)
        self.lang = lang
        self.brain.speak(lang)
        if lang not in turn.setdefault('counted', set()):  # (a turn counts once in each language: as care counts)
            turn['counted'].add(lang)
            self.replies[lang] = self.replies.get(lang, 0) + 1
        missed = self.missed(lang) if self.care and not self.settled else []
        # (settled by what has played by now: a notice still queued or playing isn't heard yet)
        self.settled = self.settled or self.care and not self.missed(lang, self.wiring.monotonic()) and self.replies[lang] >= 2
        if missed and turn not in self.notices:
            turn.setdefault('ends', {})
            self.notices.append(turn)
        # (the AI line first, the transcript line after)
        words = self.brain.words[lang] if missed else {}
        if 'ai' in missed and not stop.is_set():
            await self.say(words.get('reply_ai') or words['ai'], stop, turn, keep=True)
            if not stop.is_set():
                turn['ends'][(lang, 'ai')] = self.until
        if 'transcript' in missed and lang not in turn.setdefault('after', []):
            turn['after'].append(lang)

    async def notice_after(self, stop, turn):
        """The transcript lines a reply's languages still owe the caller (speak), once its words are out: none once
        they've said they'd rather we kept none in the reply (missed)."""
        for lang in turn.get('after', ()):
            if not stop.is_set() and 'transcript' in self.missed(lang):
                await self.say(self.brain.words[lang]['transcript'], stop, turn, lang, keep=True)
                if not stop.is_set():
                    turn['ends'][(lang, 'transcript')] = self.until

    async def seatless(self, why, until):
        turn = self.last = {'text': '', 'n': len(self.lines), 'heard': None, 'back': False}
        stop = self.speaking = threading.Event()
        await self.unanswered(why, until, stop, turn)
        if not stop.is_set():
            await self.send_event({'type': 'state', 'state': 'listening'})

    async def unanswered(self, why, until, stop, turn):
        """The agent can't answer: the line says why in its own fixed words, HQ's call screen shows them until a reply
        gets through, and the transcript notes it, so the follow-up knows what the board heard."""
        if self.drop:  # (a care call, the line closes the stream, and HQ's message says where to go)
            print(f'call: {self.agent} can\'t answer ({why}): the line ends the call, HQ plays its message', flush=True)
            return await self.drop('error')
        name, until = self.agent.capitalize(), until if isinstance(until, (int, float)) and until > 0 else 0
        words = cant_answer(name, why, until, self.brain.tz, self.lang, again=self.noticed == why, now=self.wiring.now)
        self.noticed = why
        at = f", until {datetime.fromtimestamp(until / 1000, timezone.utc).strftime('%H:%M')} UTC" if until else ''
        print(f'call: {self.agent} can\'t answer ({why}{at}): the line says so', flush=True)
        self.write(f'(The line, not {name}: {words})')
        self.keep()
        await self.send_event({'type': 'notice', 'text': words})
        await self.say(words, stop, turn)

    async def restart(self, lines, shown=(), resent=()):
        """A fresh session for the call (on the seat the line has now), whose first message carries the call so far. It
        has none of the pictures the stopped one saw or was being shown (lose_pictures), except those its first message
        sends again (resent: the turn asked again on the line's new seat)."""
        again = {picture['id'] for picture in resent}
        self.held = [picture_id for picture_id in self.held if picture_id not in again]
        self.brain.kill()
        lost = await self.lose_pictures([picture for picture in shown if picture['id'] not in again])
        self.picture_bytes += sum(len(picture['data'] or '') for picture in resent)
        so_far = ('The call so far, from speech recognition:\n' + '\n'.join(lines) if not self.objected else
                  "They asked us to keep no transcript, so there is none. Your notes so far: " + ('; '.join(self.notes) or 'none'))
        self.brain.recap = f'(Your session on this call stopped and was restarted. {so_far})' + lost
        self.screen['heard'].clear()  # (the new session has heard none of it, nor the coordinator's briefing)
        self.new_screen_key()
        await self.brain.start()

    async def hear(self, samples, voice=None):
        """Audio from the board, 16 kHz float32, and the agent's voice as it played over the same samples on HQ's side
        (none: nothing played)."""
        self.got += len(samples)
        if self.echo:
            samples = self.echo.cancel(samples, voice)
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= 512:
            self.vad.accept_waveform(self.pending[:512])
            self.recent, self.n = np.concatenate([self.recent[-8 * RATE:], self.pending[:512]]), self.n + 512
            self.pending = self.pending[512:]
            talking = self.vad.is_speech_detected()
            self.voiced, self.quiet = (self.voiced + 1, 0) if talking else (0, self.quiet + 1)
            now = self.wiring.monotonic()
            if self.voiced == 1 and self.kept:  # carrying on right after a sound that was let go: it counts after all
                if now - self.kept['at'] < AGAIN:
                    self.over = {**self.kept, 'held': self.on(), 'from': self.n - 512 - int(ONSET * RATE)}
                self.kept = None
            since, heard = now - self.voiced * WINDOW - ONSET, self.last and self.last['heard']
            if self.voiced and not self.over and self.speaking and not self.speaking.is_set():
                # Talking over a reply the board has started hearing: it plays on until the words make it clear (held).
                # Carrying on before hearing it: the reply is taken back once there's a word (not held).
                held = self.on() and since >= heard
                if held or not heard or since < heard:
                    self.over = {'since': since, 'text': '', 'held': held, 'from': self.n - self.voiced * 512 - int(ONSET * RATE)}
            if self.voiced == RESUMED and self.waiting:  # not finished after all: wait for the rest
                self.waiting.cancel()
                self.waiting = None
            if ((over := self.over) and not over.get('in') and self.voiced >= PEEK and (self.voiced - PEEK) % 8 == 0
                    and not over.get('look')):  # still talking over the reply: a look at the words so far, beside the audio
                over['look'] = asyncio.create_task(self.look(over, self.recent[over['from'] - self.n:]))
            if self.quiet == 25 and self.draft and not self.waiting:  # a cough cancelled the wait: pick it up again
                self.schedule()
            if (self.opening and not self.opening['said'] and not self.draft and not self.waiting
                    and self.quiet * WINDOW >= self.opening_quiet):  # (picked up, and nobody says anything)
                self.open('')
        while not self.vad.empty():
            seg = np.array(self.vad.front.samples, np.float32)
            # (the turn's last 8 s up to TRAIL s after its words: Smart Turn learnt on a short quiet after the voice)
            upto = len(self.recent) - (self.n - self.vad.front.start - len(seg)) + int(TRAIL * RATE)
            self.vad.pop()
            ended = self.wiring.monotonic()
            text, finish_chance = await asyncio.gather(asyncio.to_thread(self.transcribe, seg),
                                                       asyncio.to_thread(self.finish_chance, self.recent[:max(0, upto)]))
            if over := self.over:
                self.over, text = None, f"{over['text']} {text}".strip()
                if not over.get('in') and not (over['held'] and not self.playing()):  # (played out since: a normal turn)
                    if over['held'] and not self.speaking.is_set() and stray(text, self.lang):  # a footstep, an "okay": it plays on
                        self.kept = text and {'since': over['since'], 'text': text, 'at': self.wiring.monotonic()}
                        print(f'call: {self.agent} talked on over a short sound ({len(text.split())} words)', flush=True)
                        continue
                    if over['held'] or len(text) > 1:  # (not held: a sound with no words takes nothing back)
                        await self.cut_in(over)
            if len(text) > 1:
                self.spoke = ended - PAUSE  # (their last sound: the VAD ends a segment PAUSE s after it)
                self.sounded_finished = finish_chance > 0.5
                self.pauses = [self.pauses[0] + self.sounded_finished, self.pauses[1] + 1]
                if not self.draft:  # (the words began about as long before their last sound as they lasted)
                    self.draft_at = self.wall_ms(self.spoke - len(seg) / RATE)
                self.draft.append(self.labelled(text, len(seg)))
                self.keep()  # (each piece as it's heard)
                await self.send_event({'type': 'heard', 'text': unhesitating(self.so_far(), self.lang)})
                self.schedule(ended)

    async def look(self, over, audio):
        """The words so far, while the board talks over a reply: it stops once they read as an interruption (held), or
        once there's a word at all (not held: the board hadn't heard it yet). Cut off mid-word, the recogniser still ends
        with a full stop and mishears ("Make chin." for a hum on the phone line), so two words so far count as a finished
        sentence only once two looks in a row hear them ("Hold on.")."""
        text = f"{over['text']} {await asyncio.to_thread(self.transcribe, audio)}".strip()
        over['look'], seen, over['seen'] = None, over.get('seen'), text
        interrupts = (not stray(text.rstrip('.?!…'), self.lang) or (text == seen and not stray(text, self.lang))
                      if over['held'] else len(text) > 1)
        if self.over is over and not over.get('in') and interrupts:
            await self.cut_in(over)

    def transcribe(self, seg):
        return transcribe(seg)  #.

    def finish_chance(self, audio):
        return turn_end.finished(audio)  # (endpoint.py)

    def schedule(self, since=None):
        """Answer once the board sounds finished: at once when its voice says so, later mid-thought (counted from since,
        when its last words ended)."""
        if self.waiting:
            self.waiting.cancel()
        waited = self.wiring.monotonic() - since if since else 0
        wait = self.limits.wait_seconds['done' if self.sounded_finished else 'open'] - waited
        self.waiting = asyncio.create_task(self.commit(max(0, wait)))

    async def commit(self, wait):
        await asyncio.sleep(wait)
        if self.behind():  # (a late chunk isn't answered as if just said: the answer waits until the rest has come)
            self.waited += 1
            # (or at most until the audio of every moment up to now has: an uplink that never catches up, still late
            # with the quiet after the words, is answered once that quiet is in)
            upto = self.n + int(self.owed() * RATE)
            while self.behind() and self.n < upto and not self.ended:
                await asyncio.sleep(0.1)
        self.waiting = None
        text, again, at = self.so_far(), self.again, self.draft_at
        self.draft, self.again, self.speaker, self.draft_at = [], False, None, None
        if self.opening and not self.opening['said']:  # (the other side's first words: the opening answers them)
            return self.open(text, at)
        if self.first is not None:  # (a care call's words before its notice was heard: kept until it has been)
            self.turn = asyncio.create_task(self.care_first(text, self.turn))
            return
        self.turn = asyncio.create_task(self.answer(text, self.turn, again, at))

    def pinged(self, sent):
        """HQ's ping, sent at `sent` (its performance.now(), ms) after the frames before it: how late they reached the
        line, against the quickest ping so far (the two clocks' difference and the network's own delay). Both clocks
        are monotonic, so setting either changes nothing; the baseline creeps up 10 ms a second, so their drift never
        adds up."""
        now = self.wiring.monotonic()
        delay = now * 1000 - sent
        base = min(self.ping[1] + 10 * (now - self.ping[0]), delay) if self.ping else delay
        self.ping, self.late = (now, base, self.n), (delay - base) / 1000
        self.latest = max(self.latest, self.late)

    def owed(self):
        """How many seconds of the board's audio are still on their way at most: as late as the last ping came, and
        the time since it, less what the line has heard since."""
        at, _, heard = self.ping
        return self.late + self.wiring.monotonic() - at - (self.n - heard) / RATE

    def behind(self):
        """The board's audio is reaching the line late, or HQ's pings have stopped coming: what it said since is still
        on its way. (No pings at all: a phone or a room, or an older HQ.)"""
        return bool(self.ping) and (self.late > LATE or self.wiring.monotonic() - self.ping[0] > SILENT)

    def lateness(self):
        """The hang-up line on how late the board's audio came (HQ's pings): numbers only."""
        if not self.ping:
            return ''
        answers = f"{self.waited} answer{'s' if self.waited != 1 else ''}"
        waited = f'; {answers} waited for it to catch up' if self.waited else ''
        return f'call: {self.agent} line: the board\'s audio came up to {self.latest:.1f} s late{waited}'

    def paused(self):
        """The hang-up line on the board's pauses (Smart Turn's verdicts): numbers only."""
        return f"call: {self.agent} line: the board's pauses: {self.pauses[0]} of {self.pauses[1]} sounded finished"

    def on(self):
        """The board has started hearing a reply, and it's still on its way, still playing (as far as the line can tell),
        or was heard only just now. (While the agent is still thinking, turns work as before.)"""
        last = self.last
        return bool(self.speaking) and not self.speaking.is_set() and bool(last and last['heard']) and (
            self.playing() or self.wiring.monotonic() < last['heard'] + TAKE_BACK)

    def playing(self):
        """The reply is still on its way or still playing (as far as the line can tell)."""
        return not self.turn.done() or self.wiring.monotonic() < self.until

    def reconnected(self):
        """HQ came back on a new connection: it dropped the audio it had queued, so none of it is still to play. The
        ping baseline stays (the same two clocks): HQ first sends again the board's audio the line hasn't had, with
        pings from when it was said, so it reads as late and the answer waits for all of it (behind, owed)."""
        self.until, self.away = 0, False  # (away)

    # ---- pictures the board shares on HQ's call screen
    async def show(self, picture_id):
        """A picture the board just shared: fetched from the coordinator, it waits for the board's next words. HQ hears
        that the line has it ('received'), or why not ('failed'). HQ sends a picture again on a new connection until it
        hears back, so a number the line knows is let be: its word reaches HQ when it's there (or came again with
        retell). The picture takes its place in line before it's fetched: the agent sees the pictures in the order HQ
        sent them, which is the order the board picked them in, whichever fetch ends first."""
        if picture_id in self.known:
            return
        self.known.add(picture_id)
        if len(self.pictures) >= PICTURES:
            return await self.tell(picture_id, 'failed', 'too many')
        picture = {'id': picture_id, 'type': None, 'data': None}  # (no data: still on its way)
        self.pictures.append(picture)
        try:
            fetched = await asyncio.to_thread(fetch_picture, self.wiring.hq, picture_id, self.brain.call)
        except Exception as err:
            print(f'call: {self.agent} could not fetch picture #{picture_id}: {err}', flush=True)
            fetched = None
        if self.ended:  # (hung up while it was on its way)
            return
        digest = fetched and hashlib.sha256(fetched['data'].encode()).hexdigest()
        if (first := self.firsts.get(digest)) is not None:  # the same picture again: HQ hears what it heard about the first
            self.pictures.remove(picture)
            self.copies.setdefault(first, []).append(picture_id)
            self.told[picture_id] = {**self.told[first], 'id': picture_id}
            await self.send_event(self.told[picture_id])
        elif fetched is None or self.picture_bytes + len(fetched['data']) > self.limits.session_bytes:
            self.pictures.remove(picture)  # (the pictures after it go without it)
            await self.tell(picture_id, 'failed', 'too many' if fetched else 'unreadable')
        else:
            picture.update(fetched)
            self.picture_bytes += len(picture['data'])
            self.firsts[digest] = picture_id
            await self.tell(picture_id, 'received')
        if not self.ended and self.ready():
            self.nudge()

    def nudge(self):
        """Something waits for the agent (pictures, notes, the board's answer to an ask): it goes with the board's next
        words, or once the line has been quiet SHOWN_SECONDS (unprompted). The quiet moment counts from the last one:
        pictures shared together go together."""
        if self.showing:
            self.showing.cancel()
        self.showing = asyncio.create_task(self.unprompted())

    async def note(self, note_id):
        """A note the board just drew on this call's page in its book: fetched
        from the coordinator, it takes its place with the pictures (show), its picture the page around it, which counts
        against SESSION_BYTES: one that doesn't fit goes without it, and the agent hears so. HQ hears that the line has
        it ('received'), or why not ('failed'), and sends it again until it does: a known id is let be."""
        if ('note', note_id) in self.known:
            return
        self.known.add(('note', note_id))
        if len(self.pictures) >= PICTURES:
            return await self.tell_note(note_id, 'failed', 'too many')
        entry = {'id': None, 'note': None, 'type': None, 'data': None}  # (no note: still on its way)
        self.pictures.append(entry)
        try:
            fetched = await asyncio.to_thread(fetch_note, self.wiring.hq, note_id, self.brain.call)
        except Exception as err:
            print(f'call: {self.agent} could not fetch note {note_id}: {err}', flush=True)
            fetched = None
        if self.ended:
            return
        if fetched is None:
            self.pictures.remove(entry)
            await self.tell_note(note_id, 'failed', 'unreadable')
        else:
            if fetched['data'] and self.picture_bytes + len(fetched['data']) > self.limits.session_bytes:
                fetched.update(type=None, data=None, note={**fetched['note'], 'full': True})
            entry.update(fetched)
            self.picture_bytes += len(entry['data'] or '')
            await self.tell_note(note_id, 'received')
        if not self.ended and self.ready():
            self.nudge()

    async def tell_note(self, note_id, state, why=None):
        """HQ hears how far a note got, as a picture's word (tell), kept for a resumed connection (retell)."""
        event = self.told[('note', note_id)] = {'type': 'note', 'id': note_id, 'state': state, **({'why': why} if why else {})}
        await self.send_event(event)

    def ready(self):
        """The pictures that can go to the agent now: those at the front of the line that are here (a note without a
        picture too). One still on its way holds back the ones after it."""
        return list(itertools.takewhile(lambda picture: picture['data'] or picture.get('note'), self.pictures))

    async def unprompted(self):
        """Pictures shared with nothing said: once the line has been quiet for SHOWN_SECONDS (no reply on its way or
        playing, the board not talking, nothing waiting to be answered), they go to the agent in a turn of their own. If
        the board talks first, they go with its words instead (answer)."""
        calm = self.wiring.monotonic()
        while True:
            await asyncio.sleep(0.1)
            if self.ended or not (self.pictures or self.answers()):  # (they went with the board's words)
                return
            if not self.idle() or not (self.ready() or self.answers()):
                calm = self.wiring.monotonic()
            elif self.wiring.monotonic() - calm >= SHOWN_SECONDS:
                self.turn = asyncio.create_task(self.answer('', self.turn))
                return

    def answers(self):
        """Whether the board has answered the agent's asks or suggestions since its last turn (drawing.py, driving.py.)."""
        return bool(self.drawing.answered or self.driving.answered)

    def idle(self):
        """Nothing going on. The board's words count until it has been quiet for a second: its last words may still be
        on their way to the draft (the recogniser's pause, then the transcription)."""
        replying = self.turn is not None and not self.turn.done()
        talking = self.quiet * WINDOW < 1
        return not (replying or self.wiring.monotonic() < self.until or talking or self.draft or self.waiting)

    async def seen(self, shown):
        """The session's request started: the model has the turn's pictures, and those of turns that stopped before
        theirs started (unsent: the session keeps a message whose turn was interrupted or turned away, and sends it with
        this request). HQ hears it once for each."""
        shown, self.unsent = [*self.unsent, *shown], []
        for picture in shown:
            if picture['id'] not in self.held and picture['data']:  # (a note's picture too, which HQ hears nothing of)
                self.held.append(picture['id'])
                if 'note' not in picture:
                    await self.tell(picture['id'], 'seen')

    async def lose_pictures(self, shown):
        """The session stopped: the next one has none of the pictures it saw or was being shown. HQ hears that each is
        lost (the board can share it again), and the restarted session's recap says which ones. Pictures still waiting
        for a turn go to the new session."""
        lost = self.held + [picture['id'] for picture in [*self.unsent, *shown] if picture['id'] not in self.held
                            and picture['data']]
        self.held, self.unsent = [], []
        self.screen['seen'] = 0  # (the next turn brings the screen's picture again)
        self.picture_bytes = sum(len(picture['data'] or '') for picture in self.pictures)
        # (a note's id is 'note <n>': it's named in the recap, and HQ hears nothing)
        notes = [picture_id.split()[1] for picture_id in lost if str(picture_id).startswith('note ')]
        lost = [picture_id for picture_id in lost if not str(picture_id).startswith('note ')]
        for picture_id in lost:
            await self.tell(picture_id, 'failed', 'lost')
        numbers = ', '.join(f'#{picture_id}' for picture_id in lost)
        return (f"\n(You can't see {'picture' if len(lost) == 1 else 'pictures'} {numbers} any more: they were in the "
                'stopped session. Ask the board to share them again if you need them.)' if lost else '') + notes_lost(notes)

    async def tell(self, picture_id, state, why=None):
        """HQ hears how far a picture got. The line keeps the last word on each, as an event sent while HQ was away is
        lost: the call's resume sends them all again (retell)."""
        if state == 'failed':  # (shared again after this, it's a new picture.)
            self.firsts = {digest: first for digest, first in self.firsts.items() if first != picture_id}
        for number in (picture_id, *self.copies.get(picture_id, ())):
            event = {'type': 'picture', 'id': number, 'state': state, **({'why': why} if why else {})}
            self.told[number] = event
            await self.send_event(event)

    async def retell(self):
        """A resumed connection hears where every picture is now."""
        for picture_id in list(self.told):
            await self.send_event(self.told[picture_id])  # (read as it's sent: no newer word on it goes out first)
        await self.drawing.retell()
        await self.driving.retell()

    # ---- a walk-through's screen (SCREEN_TURN_SECONDS)
    def watched(self):
        """The purpose and ref the coordinator's watch-along routes know this call by: a call out's room by its call
        out, the board's HQ call by its call. None on the phone (a care call too): there's no screen."""
        if self.phone:
            return None
        if self.callout:
            return 'callout', str(self.callout)
        return ('call', str(self.brain.call)) if self.brain.call else None

    def new_screen_key(self):
        """A new key on the line's screen socket for the session about to start, on a call with a screen: the last
        session's answers nothing from now."""
        SCREENS.pop(self.screen_key, None)
        self.screen_key = '' if self.phone else secrets.token_urlsafe(24)
        if self.screen_key:
            SCREENS[self.screen_key] = self
        self.brain.screen = (str(self.wiring.paths.screen_socket), self.screen_key) if self.screen_key else None

    async def screen_turn(self):
        """What the caller's screen adds to their turn (the coordinator's screen-turn): the coordinator's briefing while
        the session hasn't had it, the moments since the agent's last turn, and a picture of the screen if it changed
        and the call's budget has room, as words in front of theirs, a picture and the transcript's line. Paused, the
        agent hears it once and gets nothing more until it's on again. Nothing counts as had until screen_sent. A
        coordinator that fails or can't say in time leaves the turn as it was, and an agent that has seen the screen
        on this session hears it couldn't be read: its moments come with the next turn."""
        look = {'text': '', 'pictures': [], 'line': '', 'heard': set(), 'after': self.screen['after'],
                'version': self.screen['seen']}
        if not (watched := self.watched()):
            return look
        heard = self.screen['heard']
        # (past the call's count, no picture is made for it)
        full = self.screen['pictures'] >= self.limits.screen_pictures
        asked = {'purpose': watched[0], 'ref': watched[1], 'after': self.screen['after'], 'seen': self.screen['seen'],
                 'briefed': 'brief' in heard, 'picture': not full}
        try:
            got = await asyncio.wait_for(asyncio.to_thread(self.wiring.hq, 'POST', 'screen-turn', asked), self.limits.screen_turn_seconds)
        except Exception as err:  # (TimeoutError: no answer in time)
            print(f'call: {self.agent}: no screen with this turn: {err!r}', flush=True)
            # (a call nobody has shown a screen on hears nothing of it)
            return {**look, 'text': f"({SCREEN_WORDS['unread']})"} if 'brief' in heard else look
        on = self.screen['on'] = isinstance(got, dict) and got.get('on') is True  # (on)
        self.screen['paused'] = paused = on and got.get('paused') is True
        if not paused:
            heard.discard('paused')  # (paused again later, the agent hears it again)
        if not on:
            return look
        if paused and 'paused' in heard:  # (told already: nothing more until it's on again)
            lines, picture, told = [], None, set()
        else:
            lines = screen_lines(got)
            picture = None if paused else picture_as(got.get('picture'), 'image/jpeg')
            told = {'paused'} if paused else set()
        changed = not paused and got.get('version') != self.screen['seen']
        if (picture and self.picture_bytes + len(picture['data']) > self.limits.session_bytes) or (full and changed):
            picture = None
            told.add('full')
        told -= heard
        brief = str(got.get('brief') or '').strip() if 'brief' not in heard else ''
        framed = [*([SCREEN_WORDS['lines'], *lines] if lines else []), *([SCREEN_WORDS['picture']] if picture else []),
                  *(SCREEN_WORDS[word] for word in ('paused', 'full') if word in told)]
        noted = [*lines, *(['a picture of the screen went with it'] if picture else [])]
        look.update(text='\n\n'.join(filter(None, (brief, '(' + '\n'.join(framed) + ')' if framed else ''))),
                    pictures=[{'id': 'screen', **picture}] if picture else [],
                    line=f"{self.them}: (on screen: {'; '.join(noted)})" if noted else '',
                    heard=told | ({'brief'} if brief else set()),
                    after=got['last'] if type(got.get('last')) is int else self.screen['after'],
                    version=got['version'] if picture and type(got.get('version')) is int else self.screen['seen'])
        return look

    def screen_sent(self, look):
        """The turn's message went to the session with what the screen added (screen_turn): the agent has those
        moments, words and picture, and the picture counts against the call's budget (once, if a restart sends it
        again)."""
        self.screen['after'] = look['after']
        if look['pictures']:  # (a retry's look with none must not undo the restart's reset of seen)
            self.screen['seen'] = look['version']
        self.screen['heard'] |= look['heard']
        if look['pictures'] and not look.get('counted'):
            look['counted'] = True
            self.screen['pictures'] += 1
            self.picture_bytes += len(look['pictures'][0]['data'])

    async def screen_tool(self, asked):
        """The agent's screen tool (hq_tools.py, through the line's socket): the coordinator's screen route for this
        call, the moment list since a time, or a picture (now, at a past moment, a region zoomed), counted against
        the call's budget. Refused on a call with no screen, while paused and past the budget."""
        if not (watched := self.watched()):
            return {'error': SCREEN_WORDS['none']}
        if self.screen['paused']:
            return {'error': SCREEN_WORDS['paused']}
        since = asked.get('since')
        wanted = {'since': since} if isinstance(since, str) else {k: asked[k] for k in ('at', 'region') if k in asked}
        if 'since' not in wanted and self.screen['pictures'] >= self.limits.screen_pictures:
            return {'error': SCREEN_WORDS['full']}
        try:
            got = await asyncio.to_thread(self.wiring.hq, 'POST', 'screen', {'purpose': watched[0], 'ref': watched[1], **wanted})
        except HTTPError as err:
            if err.code not in (400, 404, 409):
                raise
            words = {404: SCREEN_WORDS['none'], 409: SCREEN_WORDS['paused']}
            return {'error': refusal(err) or words.get(err.code, "The screen couldn't be read.")}
        if 'since' in wanted:
            return {'lines': screen_lines(got)}
        if not (picture := picture_as(got.get('picture'), 'image/jpeg')):
            raise ValueError('the coordinator sent no JPEG of the screen')
        if self.picture_bytes + len(picture['data']) > self.limits.session_bytes:
            return {'error': SCREEN_WORDS['full']}
        self.screen['pictures'] += 1
        self.picture_bytes += len(picture['data'])
        return {'picture': picture, 'line': ' '.join(str(got.get('line') or '').split())}

    async def sketch_tool(self, asked):
        """The agent's sketch tool (hq_tools.py, through the line's socket): one of the board's sketches by its number
        or the words of its label, from the coordinator's sketch route, its picture counted against the call's bytes.
        Refused on a call out (its partner's words could steer a look-up: house rule 9) and past the budget."""
        if self.callout or not self.brain.call or not isinstance(asked.get('sketch'), str):
            return {'error': SKETCH_WORDS['none']}
        if self.picture_bytes >= self.limits.session_bytes:
            return {'error': SKETCH_WORDS['full']}
        try:
            got = await asyncio.to_thread(self.wiring.hq, 'POST', 'sketch', {'call': self.brain.call, 'sketch': asked['sketch']})
        except HTTPError as err:
            if err.code not in (400, 404, 409):
                raise
            return {'error': refusal(err) or "That sketch couldn't be found."}
        if not (picture := picture_as(got.get('picture'), 'image/png')):
            raise ValueError('the coordinator sent no PNG of the sketch')
        if self.picture_bytes + len(picture['data']) > self.limits.session_bytes:
            return {'error': SKETCH_WORDS['full']}
        self.picture_bytes += len(picture['data'])
        return {'picture': picture, 'line': ' '.join(str(got.get('line') or '').split())}

    async def cut_in(self, over):
        """The board talks over a reply (since over['since']), and it's clear it's them: stop it. If they started
        before hearing much of it, they weren't finished: take the reply back and answer everything as one message. If
        it has played out since, they heard it all: their words are a normal turn."""
        over['in'] = True
        last = self.last
        if not self.speaking or self.speaking.is_set() or not self.playing():  # (Skip stopped it already, or it's over)
            return
        await self.interrupt()
        if last and last['text'] and (last['heard'] is None or over['since'] - last['heard'] < TAKE_BACK):  # (a notice at pickup answers nothing)
            last['back'] = True
            self.lines, self.times = self.lines[:last['n']], self.times[:last['n']]
            if last['text']:  # (pictures shown with nothing said have no words to take back)
                self.draft.insert(0, last['text'])
                self.draft_at = last.get('at') or self.draft_at  # (said when they were first said)
            self.again = True
            # (shown without its "um"s; back: HQ's transcript writes it over the turn's line, which the reply had closed.
            await self.send_event({'type': 'heard', 'text': unhesitating(self.so_far(), self.lang) + ' …', 'back': True})

    async def interrupt(self):
        if self.last is not None:  # (when: a care call's opening counts as heard up to there)
            self.last.setdefault('cut', self.wiring.monotonic())
        self.speaking.set()
        self.until = 0  # (the reply's audio still to play is cleared)
        self.brain.interrupt()
        await self.clear()
        await self.send_event({'type': 'state', 'state': 'listening'})

    async def answer(self, text, before, again=False, at=None):
        if before and not before.done():
            if self.last is not None:  # (a care call's opening counts as heard up to here)
                self.last.setdefault('cut', self.wiring.monotonic())
            self.speaking.set()  # the board moved on: the reply before this one ends unspoken
            self.until = 0
            self.brain.interrupt()
            await asyncio.gather(before, return_exceptions=True)
        if self.ended:  # (the board's last words, or a quiet moment's pictures, after the hang-up)
            return
        # The pictures the board shared go with its words, or alone (no text), and the transcript says where. A restarted
        # session's recap has that line, not the picture.
        shown = self.ready()
        del self.pictures[:len(shown)]
        # (notes)
        shared, notes = [p for p in shown if 'note' not in p], [p for p in shown if 'note' in p]
        if shared:
            numbers = ', '.join(f"#{picture['id']}" for picture in shared)
            self.write(f"Board: (shared {'picture' if len(shared) == 1 else 'pictures'} {numbers} on screen)")
        for note in notes:
            self.write(f"Board: (drew note {note['note']['n']} on {note['note']['url']})")
        turn = self.last = {'text': text, 'n': len(self.lines), 'heard': None, 'back': False, 'sounds': 0, 'at': at}
        spoke, asked, worded_at = self.spoke, self.wiring.monotonic(), None  # (the reply's timing line: timed())
        # (what's written down and what the agent reads; taken back, it's as heard)
        text = unhesitating(text, self.lang)
        if text:
            for line in self.heard_lines(text):
                self.write(line, at)
        self.keep()
        if text:
            await self.send_event({'type': 'heard', 'text': text})
        await self.send_event({'type': 'state', 'state': 'thinking'})
        stop = self.speaking = threading.Event()
        said, buf, worded = '', '', False  # (worded: this model response has words: its tool steps come after them)
        # a tool step is running, or the reply's first words haven't come (wait), and no words since
        step = {'on': True, 'wait': True}
        hum = asyncio.create_task(self.hum(stop, step, turn))
        ask = text if not again else ("(I wasn't finished, and I didn't hear your reply to the first part: "
                                      f"answer my whole message instead.) {text}")
        if shared and not ask:
            ask = f"(I've shared {'a picture' if len(shared) == 1 else f'{len(shared)} pictures'} on screen.)"
        # (the board's answers to the agent's asks first, then the screen's words, then the notes' before the words)
        # (driving)
        ask = '\n\n'.join(filter(None, ('\n'.join(map(note_said, notes)), ask)))
        answered = '\n'.join(filter(None, (self.drawing.told(), self.driving.told())))
        delivered = False  # the model has the message: its first request started
        earlier = self.lines[:turn['n']]  # (the call so far, for a fresh session: this message goes as its own)
        try:
            # the line couldn't answer last time, and the worker has since put a seat with room here: a fresh session on it
            if self.noticed and self.brain.moved():
                await self.restart(earlier)
            # (the screen's words go in front, its picture after the shared ones, its line before the caller's words)
            look = await self.screen_turn()
            ask = '\n\n'.join(filter(None, (answered, look['text'], ask)))
            pictures = [*(picture for picture in shown if picture['data']), *look['pictures']]
            if look['line'] and not self.objected:
                self.lines.insert(turn['n'], look['line'])
                self.times.insert(turn['n'], self.wall_ms())  #.
                turn['n'] += 1
                self.keep()
            for retry in (False, True):
                try:
                    self.screen_sent(look)  #.
                    async for delta in self.brain.ask(ask, pictures):
                        if delta is DELIVERED:  # (the pictures are seen only once the model has them)
                            delivered = True
                            await self.seen(shown)
                            continue
                        if delta is RESPONSE:
                            worded = False
                            continue
                        if isinstance(delta, Language):  # (the reply's language, from here: kept even if talked over)
                            if buf.strip() and not stop.is_set():  # (what came before it is said in the one before)
                                line, buf = buf.strip(), ''
                                said += line + ' '
                                await self.say(line, stop, turn)
                            await self.speak(delta, stop, turn)
                            continue
                        if isinstance(delta, Used):  # (kept even if talked over: the model noted it)
                            if delta.name == NOTE_TOOL:
                                self.noted(delta.input)
                            continue
                        if isinstance(delta, Step) and delta.name == NO_TRANSCRIPT_TOOL:  # (honoured even if talked over)
                            if buf.strip() and not stop.is_set():
                                line, buf = buf.strip(), ''
                                said += line + ' '
                                await self.say(line, stop, turn)
                            await self.object(stop, turn)
                            continue
                        if stop.is_set() or turn.get('gone'):
                            continue  # talked over, or hung up after the goodbye: let the turn finish quietly
                        if isinstance(delta, Step):  # what the agent wrote before the step is said now; the tick holds the rest
                            if delta.name == HANG_UP_TOOL:
                                turn['bye'] = True  # (the call ends once the goodbye is said: leave)
                            if buf.strip():
                                line, buf = buf.strip(), ''
                                said += line + ' '
                                await self.say(line, stop, turn)
                            # (hung up in the goodbye's own response, the model writes it again on the tools'
                            # answers: never said)
                            if delta.name == HANG_UP_TOOL and worded:
                                turn['gone'] = True
                                continue
                            # (once those words are out: before their first audio, the tick could beat them)
                            step.update(on=True, wait=False)
                            continue
                        step['on'] = False
                        worded_at = worded_at or (self.wiring.monotonic() if delta.strip() else None)
                        buf, worded = buf + delta, worded or bool(delta.strip())
                        while (m := SENTENCE.match(buf) or (not said and CLAUSE.match(buf))) and not stop.is_set():
                            sentence, buf = m.group(1), buf[m.end():]
                            said += sentence + ' '
                            await self.say(sentence, stop, turn)
                    break
                except Unanswered as err:  # the seat or the request failed (the CLI's own signals): never silence
                    step['on'] = False
                    turn['bye'] = False  # (the line's own words aren't a goodbye: the call stays open)
                    if not retry and not said.strip() and not stop.is_set() and self.brain.moved():
                        # the worker has moved the line to a seat with room since this session started: ask again there
                        print(f'call: {self.agent} hit {err.why} on its seat; asking again on the line\'s new one', flush=True)
                        buf, worded = '', False  # (what the failed turn wrote and nobody heard: the new session's reply is said alone)
                        await self.restart(earlier, pictures, resent=pictures)  #.
                        continue
                    if said.strip() and not turn['back']:
                        self.write(f'{self.agent.capitalize()}: {said.strip()} (cut off)', self.heard_at(turn))
                    buf, said = '', ''
                    if not stop.is_set():
                        await self.unanswered(err.why, err.until, stop, turn)
                    break
        except Exception as err:  # the call agent died or hung: say so, and start a fresh one that knows the call so far
            print(f'call: {self.agent} lost the reply: {err!r}', flush=True)
            step['on'] = False
            turn['bye'] = False
            if said.strip() and not turn['back']:  # what the board already heard stays in the transcript, marked
                self.write(f'{self.agent.capitalize()}: {said.strip()} (cut off: the call agent stopped)', self.heard_at(turn))
            buf, said = '', ''
            self.brain.kill()
            # It stopped because the board hung up: no new session for an ended call
            if self.ended:
                return
            try:
                await self.restart(self.lines, shown)
                said = "Sorry, I lost my train of thought there. Could you say that again?"
            except Exception as again:  # (the coordinator refused: the call has ended, or its token expired)
                print(f'call: {self.agent} could not restart the call agent: {again!r}', flush=True)
            if self.ended:  # (hung up while it started: Agent.start launched nothing)
                return
            if said:
                await self.say(said, stop, turn)
            else:  # it doesn't start again either: the line says so, never silence
                await self.unanswered('error', 0, stop, turn)
        else:
            if not delivered:  # (HQ keeps 'received' for them: the model has them with the next request)
                self.unsent += shown
        finally:
            hum.cancel()
        if buf.strip() and not stop.is_set():
            said += buf
            await self.say(buf, stop, turn)
        await self.notice_after(stop, turn)
        if said.strip() and self.noticed and not stop.is_set():  # a reply got through: the call screen's notice goes
            self.noticed = None
            await self.send_event({'type': 'notice', 'text': ''})
        if said.strip() and not turn['back']:
            self.write(f'{self.agent.capitalize()}: {said.strip()}' + (' (interrupted)' if stop.is_set() else ''), self.heard_at(turn))
        self.keep()
        if self.care and spoke is not None and turn['heard']:
            self.timed(turn, spoke, asked, worded_at)
        if not stop.is_set():
            await self.send_event({'type': 'state', 'state': 'listening'})
            if turn.get('bye') and not self.ended:
                self.leaving = asyncio.create_task(self.leave(turn))

    def timed(self, turn, spoke, asked, worded_at):
        """Where a care call's reply's wait went, counted from the caller's last word (numbers only, for call-times.sh):
        the line hearing them finish and writing them down (the VAD's PAUSE, the transcription, the wait for more),
        care's first words (its model), the first audio sent (the sentence written whole, then synthesised), and the
        hold sounds over the wait."""
        at = lambda t: f'{t - spoke:.1f} s' if t else 'none'
        sounds = f'{turn["sounds"]} hold sound{"s" if turn["sounds"] != 1 else ""}'
        print(f'call: {self.agent} reply timed: asked after {at(asked)}, first words after {at(worded_at)}, first audio'
              f' after {at(turn["heard"])}, {sounds}', flush=True)

    async def leave(self, turn):
        """The agent hung up in this reply (HANG_UP_TOOL): the line ends the call once the goodbye has played on the
        board's side and the line has been quiet for GOODBYE_QUIET_SECONDS after it, as the board's own hang-up would.
        The board's words before then keep the call open: talking over the goodbye (an interruption, never a lone "bye"
        or "okay"), Interrupt, or anything said after it, which is the agent's next turn as always, up to the end of
        the hang-up tone that closes the call and its tail. A sound without words
        only waits for quiet."""
        def board_spoke():
            return self.last is not turn or self.speaking.is_set() or self.draft or self.waiting

        while True:
            await asyncio.sleep(0.1)
            if self.ended:
                return
            if board_spoke():
                print(f'call: {self.agent} hung up, but the board spoke before the line did: the call stays open', flush=True)
                return
            gone_quiet = self.wiring.monotonic() >= self.until + GOODBYE_QUIET_SECONDS
            if not self.over and gone_quiet and self.quiet * WINDOW >= GOODBYE_QUIET_SECONDS:
                break
        if self.hang_up:
            sound = hang_up_tone()
            tone_seconds = len(sound) / RATE
            self.until = self.wiring.monotonic() + tone_seconds
            await self.send_event({'type': 'tick'})  # (HQ counts it as it does the tick: a start of its own, not the voice)
            await self.send_audio(sound)
            await asyncio.sleep(tone_seconds + TONE_TAIL_SECONDS)
            while self.over and not self.ended:  # (the board still talking over the tone: what it says decides)
                await asyncio.sleep(0.1)
            if self.ended:  # (the board hung up during the tone)
                return
            if board_spoke():  # (Interrupt, or the board's words over the tone)
                print(f'call: {self.agent} hung up, but the board spoke over the hang-up tone: the call stays open', flush=True)
                return
        print(f'call: {self.agent} ended the call after its goodbye', flush=True)
        self.write(f'({self.agent.capitalize()} ended the call.)')
        self.keep()
        if self.hang_up:
            await self.hang_up()

    async def hum(self, stop, step, turn):
        """While a tool step runs (a job's brief being written, a search) the tick, and while the agent hasn't said its
        first words yet the softer thinking(), whenever the line has been quiet for QUIET s and the board for HUSH s,
        until the agent's words come or the reply stops. A step's tick is the reply being heard, as words would be: the
        board talking over it is talking over the reply (a lone "okay" lets the step carry on). The thinking sound isn't:
        the board carrying on over it wasn't finished, and the reply is taken back as before."""
        while not stop.is_set():
            await asyncio.sleep(0.1)
            now = self.wiring.monotonic()
            hushed = self.quiet * WINDOW + PAUSE >= HUSH  # (the VAD's quiet starts PAUSE s in)
            if step['on'] and hushed and not stop.is_set() and now >= self.until + QUIET:
                if not step['wait']:
                    turn['heard'] = turn['heard'] or now
                sound = thinking(self.phone) if step['wait'] else tick()
                turn['sounds'] = turn.get('sounds', 0) + 1
                self.until = now + len(sound) / RATE
                await self.send_event({'type': 'tick'})  # (not a sentence: HQ doesn't count the gap before it as a stutter)
                await self.send_audio(sound)

    async def say(self, sentence, stop, turn, lang=None, keep=False):
        """A sentence in the agent's voice, in the call's language or another (lang: a care call's opening). keep: fixed
        words, whose audio is kept (SAID) and played from there the next time, with no wait for the synthesis."""
        lang = lang or self.lang
        text = spoken(sentence)
        if not text:
            return
        await self.send_event({'type': 'state', 'state': 'speaking'})
        await self.send_event({'type': 'said', 'text': text})
        q = asyncio.Queue()
        loop = asyncio.get_running_loop()
        # (HQ shows "€4", "06" and "Acme", the board hears "four euros", "oh six" and "Ak-mee")
        text = aloud(respelt(text, self.brain.respell.get(lang, {})), lang)
        named = getattr(self.brain, 'voices', {}).get(lang)  # (the company's, in the language: Piper's or Pocket's)
        named = named or ('alex' if lang == 'nl' and self.brain.voice in NOT_IN_DUTCH else None)
        piper = PIPERS.get(named)
        voice = named or self.brain.voice
        seed = getattr(self.brain, 'seeds', {}).get(lang, SEED)
        kept = (lang, voice, text, seed)
        if keep and kept in SAID:
            for x in SAID[kept]:
                if stop.is_set():
                    return
                now = self.wiring.monotonic()
                turn['heard'] = turn['heard'] or now
                self.until = max(self.until, now) + len(x) / RATE
                await self.send_audio(x)
            return
        pieces = []

        def synth():  # (in a thread of its own, in parallel with other calls': the note under SPELLED)
            try:
                model = pockets.get(lang, pocket)
                if piper:
                    for c in piper.synthesize(text):
                        if stop.is_set():
                            break
                        x = np.frombuffer(c.audio_int16_bytes, np.int16).astype(np.float32) / 32768
                        loop.call_soon_threadsafe(q.put_nowait, resample(x, c.sample_rate, RATE))
                else:
                    if (lang, voice) not in voice_states:
                        voice_states[lang, voice] = model.get_state_for_audio_prompt(voice)
                    if keep:
                        torch.manual_seed(seed)
                    for c in model.generate_audio_stream(voice_states[lang, voice], spelled(text, lang), stop=stop):
                        loop.call_soon_threadsafe(q.put_nowait, resample(c.numpy().astype(np.float32), model.sample_rate, RATE))
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)

        threading.Thread(target=synth, daemon=True).start()
        while (x := await q.get()) is not None:
            pieces.append(x)
            if not stop.is_set():
                now = self.wiring.monotonic()
                turn['heard'] = turn['heard'] or now
                self.until = max(self.until, now) + len(x) / RATE
                await self.send_audio(x)
        if keep and not stop.is_set():
            SAID[kept] = pieces

    def keep(self, last=False):  # (with the call's token, so the coordinator revokes it at the hand-over, even after a crash)
        # Handed over at the end: a turn finishing after it doesn't write it again
        with self.writing:
            if self.ended and not last or self.care:  # (a care call: care keeps the words, the line no file)
                return
            # The board's words not answered yet go too: while it talks on, a pause that sounds finished sends them and its
            # next words take them back (cut_in), so a long message may live only here until the board stops, and a
            # restart mid-call hands it over from here.
            heard = self.heard_lines(unhesitating(self.so_far(), self.lang)) if self.draft else []  # (written down like a turn's)
            lines = [] if self.objected else self.lines + heard
            record = {'agent': self.agent, 'lines': lines, 'request': self.request, 'token': self.brain.token}
            if self.callout:  # (on a call out, the agent's notes too: all that's kept once they objected)
                record.update(callout=self.callout, notes=self.notes, objected=self.objected)
            else:  # (a call with the board: when each line was said.)
                record['times'] = [] if self.objected else self.times + [self.draft_at or self.wall_ms()] * len(heard)
            self.file.write_text(json.dumps(record))

    def wall_ms(self, mono=None):
        """A moment on the line's own clock (self.wiring.monotonic()) on the call's wall clock (now), or now: when each
        transcript line was said."""
        return round(self.wiring.now() - (0 if mono is None else (self.wiring.monotonic() - mono) * 1000))

    def heard_at(self, turn):
        """When a reply started being heard (wall_ms), or None: not heard (now, then)."""
        return self.wall_ms(turn['heard']) if turn.get('heard') else None

    def write(self, line, at=None):
        """A line of the transcript, unless the other side asked for none (object), and when it was said (wall_ms; now
        unless given)."""
        if not self.objected:
            self.lines.append(line)
            self.times.append(at or self.wall_ms())

    def heard_lines(self, text):
        """The other side's words as the transcript's lines: the board's, the partner's, or in a room each speaker's."""
        return text.split('\n') if self.speakers else [f'{self.them}: {text}']

    def labelled(self, text, samples):
        """A piece of what the line heard, for the draft: in a room it starts on a new line with its speaker's name when
        the speaker changes (the one loudest over its samples and the VAD's pause after them)."""
        if not self.speakers:
            return text
        name = self.speakers(self.n - samples - int(0.45 * RATE), self.n)
        if self.draft and name == self.speaker:
            return text
        self.speaker = name
        return f'\n{name}: {text}'

    def so_far(self):
        """What the board (or the other side) has said since the last answer, as one message."""
        return re.sub(r' *\n *', '\n', ' '.join(self.draft)).strip()

    def noted(self, tool_input):
        """The agent's note (NOTE_TOOL), kept in order with the call, even once the transcript isn't. One hq_tools.py
        refuses isn't kept either."""
        what = str(tool_input.get('what', '')).strip()
        if hq_tools.plain(what):
            return
        self.notes.append(what)
        self.keep()

    async def object(self, stop, turn):
        """The other side would rather we kept no transcript (NO_TRANSCRIPT_TOOL): the line drops what it has, keeps no
        more lines, only the agent's notes (the file on disk too), and says so in the company's fixed words."""
        if self.objected:
            return
        self.objected, self.lines, self.times = True, [], []
        self.keep()
        print(f'call: {self.agent}: no transcript kept, at their wish', flush=True)
        if not stop.is_set():
            await self.say(self.brain.objected or OBJECTED.get(self.lang, OBJECTED['en']), stop, turn)

    def end(self):
        # First: a turn that loses its agent to the close below sees it, and a write under way finishes before the
        # hand-over below, which no write comes after
        with self.writing:
            self.ended = True
        self.brain.close()
        SCREENS.pop(self.screen_key, None)  # (its key answers nothing from now)
        self.pictures = []
        self.drawing.end()
        self.driving.end()
        if self.speaking:
            self.speaking.set()
        if self.brain.token:
            self.keep(last=True)  # (a call where nobody spoke still hands its token back)
        (self.wiring.paths.live / self.file.stem).unlink(missing_ok=True)
        if not self.care:
            hand_over(self.file, self.wiring.hq)


def hand_over(file, hq):
    """The transcript goes to the coordinator (hq); the file stays until it's there (a crash or restart hands it over
    later)."""
    try:
        call = json.loads(file.read_text())
        if call['lines'] or call.get('token') or call.get('callout'):  # (a silent call still ends its token, a call out itself)
            hq('POST', 'call-end', call)
        file.unlink()
    except FileNotFoundError:
        pass
    except Exception as err:
        print('Could not hand over the transcript yet:', err, flush=True)


# ---- HQ's call screen: JSON events and 16 kHz PCM16 frames both ways ----
# A call outlives its connection: when the phone switches networks, the app reconnects to the same call (its id)
# within HOLD seconds and carries on. Hanging up says so ('bye'); otherwise the call ends once HOLD runs out.
HOLD = 30
CALLS = {}  # call id -> {'call', 'line', 'timer'}


class Line:
    """Where a call's audio and events go: the current connection. A dropped one loses them quietly."""
    def __init__(self, ws):
        self.ws = ws

    async def send(self, data):
        try:
            await self.ws.send(data)
        except ConnectionClosed:
            pass


async def hang_up_later(cid):
    await asyncio.sleep(HOLD)
    if e := CALLS.pop(cid, None):
        print(f'call: {e["call"].agent} never came back, hanging up', flush=True)
        await asyncio.to_thread(e['call'].end)


def played(agent, p):
    """How the agent's voice played on the board's side, as HQ tells it at hang-up: the way it went out (a MediaStream
    through an <audio> element, or straight out), the sample rate, how many frames, how many came after the one
    before in the same sentence had already run out (a stutter), how often the phone took the audio away (iOS
    "interrupted"), and how often the audio context's clock stopped while the call was up (a stall: HQ pauses the
    <audio> element then, which Safari would otherwise loop on). Numbers only, never anything said;
    infra/call-times.sh keeps the line, so a call that sounded wrong can be read afterwards."""
    if not isinstance(p, dict):
        return ''
    n = lambda k: int(v) if isinstance(v := p.get(k), (int, float)) and 0 <= v < 1e7 else 0
    via = p.get('via') if p.get('via') in ('stream', 'direct') else 'unknown'
    return (f'call: {agent} hung up; HQ played {n("frames")} frames via {via} at {n("rate")} Hz, '
            f'{n("stutters")} stutters, {n("interrupted")} interruptions, {n("stalls")} stalls')


# What a User-Agent says about the browser and system, first match wins: iPadOS's Safari says Macintosh, Chrome on iOS
# says CriOS, and every Chromium browser says Safari too.
SYSTEMS = (('iPhone', 'an iPhone'), ('iPad', 'an iPad'), ('Android', 'Android'), ('Windows', 'Windows'), ('CrOS', 'ChromeOS'),
           ('Macintosh', 'a Mac or an iPad'), ('Linux', 'Linux'))
BROWSERS = (('CriOS', 'Chrome'), ('FxiOS', 'Firefox'), ('EdgiOS', 'Edge'), ('Edg/', 'Edge'), ('Firefox/', 'Firefox'),
            ('Chrome/', 'Chrome'), ('Safari/', 'Safari'))


def device(user_agent):
    """The browser and system HQ calls from: whose echo canceller the board's microphone went through first."""
    name = lambda table: next((label for key, label in table if key in user_agent), 'unknown')
    return f'{name(BROWSERS)} on {name(SYSTEMS)}'


# HQ's timeline of the call's playback, in plain words: what each kind is, and what its numbers say.
# Anything else HQ sends is left out. HQ keeps a call's last 300, with a count of the ones before.
TIMELINE_MAX = 300


def said_as(words):
    """A kind that carries no numbers: an event with any is dropped as malformed."""
    return lambda: words


TIMED = {
    'voice': lambda queued, sources: f'voice ({queued:.1f} s queued, {sources:.0f} sources)',
    'tick': lambda queued, sources: f'tick ({queued:.1f} s queued)',
    'dry': said_as('ran dry'), 'cut': said_as('cut'), 'reconnecting': said_as('reconnecting'),
    'stall': lambda seconds=None: 'stall' + (f' {seconds:.2f} s' if seconds is not None else ' (to the end)'),
    'slow': lambda ratio, seconds: f'clock at {ratio:.2f}x for {seconds:.1f} s',
    'dropped': lambda count: f'{count:.0f} earlier left out',
    **{state: said_as(f'context {state}') for state in ('running', 'suspended', 'interrupted', 'closed')},
    **{f'audio {ev}': said_as(f'audio {ev}') for ev in ('pause', 'playing', 'waiting', 'stalled', 'ended', 'error', 'emptied')},
    **{f'track {ev}': said_as(f'track {ev}') for ev in ('mute', 'unmute', 'ended')},
    # (the board's microphone, and the screen's wake lock; 'silent')
    **{f'mic {ev}': said_as(f'mic {ev}') for ev in ('mute', 'unmute', 'ended', 'silent', 'restarted')},
    **{f'wake lock {ev}': said_as(f'wake lock {ev}') for ev in ('held', 'refused', 'released')},
    'no wake lock': said_as('no wake lock'),
    # (the line running behind, by HQ's pings, and how far at most once caught up)
    'lagging': said_as('lagging'), 'caught up': lambda seconds: f'caught up ({seconds:.1f} s behind at most)',
}


def timeline(agent, events, live_at):
    """When things happened to the agent's voice on the board's side, as HQ tells it at hang-up, at UTC times that line
    up with this log's own (from when HQ heard the line pick up): each sentence and tick as it started playing (and
    how much audio was queued then), when the queued voice ran dry, a cut (the board talked over it, or Skip), the
    audio context's state, a stall (the clock stopped) and how long, any second its clock ran slower than real time,
    and what the <audio> element and the stream's track did, and the board's microphone (muted, ended, silent,
    restarted) and the screen's wake lock (held, refused, let go, or none). Numbers only, never anything said; at most
    TIMELINE_MAX (and HQ's count of the earlier ones it let go)."""
    if not isinstance(events, list) or not live_at:
        return ''
    out = []
    for e in events[:TIMELINE_MAX + 1]:
        if not (isinstance(e, list) and len(e) >= 2 and isinstance(e[0], (int, float)) and -60 < e[0] < 86400
                and isinstance(e[1], str) and e[1] in TIMED and all(isinstance(v, (int, float)) and -1e6 < v < 1e6 for v in e[2:])):
            continue
        try:
            what = TIMED[e[1]](*e[2:])
        except TypeError:  # (the wrong count of numbers for its kind)
            continue
        out.append(datetime.fromtimestamp(live_at + e[0], timezone.utc).strftime('%H:%M:%S.%f')[:10] + ' ' + what)
    return f'call: {agent} playback, timed: ' + '; '.join(out) if out else ''


# (each route is given its call maker and what the line is wired to, which it hands
# to the calls it makes, so a test's line is given its own; room.join is given them the same way)
async def app_call(ws, make_call=Call, wiring=Wiring()):
    if ws.request.headers.get('Origin') != ORIGIN:  # a preview page is the same site: only HQ itself may call
        return await ws.close(1008, 'origin')
    first = json.loads(await ws.recv())
    if cid := first.get('resume'):
        e = CALLS.get(str(cid))
        if not e:
            return await ws.close(4000, 'gone')
        if e['timer']:
            e['timer'].cancel()
            e['timer'] = None
        old, e['line'].ws = e['line'].ws, ws
        if old is not ws:
            asyncio.create_task(old.close())
        call, line = e['call'], e['line']
        call.reconnected()
        print(f'call: {call.agent} reconnected', flush=True)
    else:
        t0 = time.monotonic()
        agent, lang = re.sub(r'[^a-z0-9-]', '', str(first.get('agent') or '')), language(first.get('lang'))
        if not agent:  # HQ always says whom the board calls
            return await ws.close(1008, 'agent')
        pcm = lambda x: (np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()
        line = Line(ws)
        print(f'call: {agent} ({lang}) dialled from {device(ws.request.headers.get("User-Agent", ""))}', flush=True)
        cid = secrets.token_urlsafe(9)

        async def hang_up():
            """The agent ended the call: HQ hangs up as its button does (and says how the voice played, 'bye'). An HQ
            that doesn't within the call's hang_up_wait_seconds (an older page, or away reconnecting) is told the call is
            gone."""
            await line.send(json.dumps({'type': 'hangup'}))
            await asyncio.sleep(call.limits.hang_up_wait_seconds)
            if (e := CALLS.get(cid)) and e['call'] is call:
                CALLS.pop(cid)
                if e['timer']:
                    e['timer'].cancel()
                await asyncio.to_thread(call.end)
                await line.ws.close(4000, 'gone')
        # walk: HQ calls about a card's work to walk the board through it
        request = int(first.get('request') or 0)
        walk = first.get('walk') is True and request > 0
        call = make_call(lambda x: line.send(pcm(x)), lambda e: line.send(json.dumps(e)),
                         lambda: line.send(json.dumps({'type': 'clear'})), agent, lang, request, hang_up=hang_up,
                         walk=walk, wiring=wiring)
        CALLS[cid] = {'call': call, 'line': line, 'timer': None}
        await call.start()
        print(f'call: {agent} picked up in {time.monotonic() - t0:.1f} s', flush=True)
    call.live_at = call.live_at or call.wiring.now() / 1000
    # id: the line's, to reconnect; call: HQ's calls row; key: HQ's picture uploads for that call carry it; heard: the
    # board's samples the line has (HQ sends the rest again)
    await ws.send(json.dumps({'type': 'call', 'id': cid, 'call': call.brain.call, 'key': call.brain.key, 'heard': call.got}))
    await call.retell()  # (what happened to its pictures while HQ was away)
    if not first.get('resume'):
        await call.greet()
    bye = False
    try:
        async for m in ws:
            if line.ws is not ws:  # (the call moved to a new connection, which counts from what the line has: heard)
                break
            if isinstance(m, bytes):
                # (with the agent's voice playing, the frame carries it after the microphone's samples)
                pcm16 = np.frombuffer(m, '<i2').astype(np.float32) / 32768
                mic, voice = np.split(pcm16, 2) if len(pcm16) == 2 * FRAME else (pcm16, None)
                await call.hear(mic, voice)
                continue
            e = json.loads(m)
            kind = e.get('type')
            if kind == 'interrupt' and call.speaking and not call.speaking.is_set():
                await call.interrupt()
            elif kind == 'ping' and type(e.get('t')) in (int, float):  # (answered as read: after the frames before it)
                call.pinged(e['t'])
                await line.send(json.dumps({'type': 'pong', 'late': round(call.late, 1), 'heard': call.got}))
            elif kind == 'picture' and isinstance(e.get('id'), int):  # (beside the audio)
                asyncio.create_task(call.show(e['id']))  # (tasks start in the order they're made: so do their places)
            # (note, asked, inked)
            elif kind == 'note' and isinstance(e.get('id'), int):  # (a note's place among the pictures, as theirs)
                asyncio.create_task(call.note(e['id']))
            elif kind == 'asked' and isinstance(e.get('id'), int):
                call.drawing.asked(e['id'], e.get('answer'))
            elif kind == 'inked' and isinstance(e.get('id'), int):
                call.drawing.inked(e)
            # (opened, driven)
            elif kind == 'opened' and isinstance(e.get('id'), int):
                call.driving.opened(e)
            elif kind == 'driven' and isinstance(e.get('id'), int):
                call.driving.driven(e)
            elif kind == 'bye':
                if line_heard := played(call.agent, e.get('played')):
                    print(line_heard, flush=True)
                if line_timed := timeline(call.agent, e.get('timeline'), call.live_at):
                    print(line_timed, flush=True)
                print(call.echo.report(call.agent), flush=True)
                if line_late := call.lateness():
                    print(line_late, flush=True)
                print(call.paused(), flush=True)
                bye = True
                break
    except ConnectionClosed:
        pass
    finally:
        if line.ws is ws and cid in CALLS:  # (else the call moved to a new connection)
            if bye:
                CALLS.pop(cid)
                await asyncio.to_thread(call.end)
            else:
                CALLS[cid]['timer'] = asyncio.create_task(hang_up_later(cid))
                call.away = True  # (until it comes back: reconnected)


# ---- the phone line: Twilio's media stream (8 kHz mu-law), admitted with a one-time ticket from HQ ----
async def phone_call(ws, make_call=Call, wiring=Wiring()):
    sid, call, care_sid, limit = None, None, None, None
    try:
        async for m in ws:
            e = json.loads(m)
            if e.get('event') == 'start':
                sid, params = e['start']['streamSid'], e['start'].get('customParameters', {})
                ok = await asyncio.to_thread(wiring.hq, 'POST', 'call-ticket', {'ticket': params.get('ticket', '')})
                if not ok or not ok.get('agent'):
                    return await ws.close(1008, 'ticket')
                send = lambda x: ws.send(json.dumps({'event': 'media', 'streamSid': sid,
                                                     'media': {'payload': base64.b64encode(ulaw_encode(resample(x, RATE, 8000))).decode()}}))
                if ok.get('kind') == 'care':  # a stranger, for the care deployment the ticket names (else care)
                    engine = ok.get('engine', 'care')
                    care = wiring.care_engines.get(engine) if isinstance(engine, str) else None
                    on = list(CARE_LIVE.values()).count(engine)
                    if not care or not care['url'] or not care['token'] or on >= care['calls']:
                        why = ('no such deployment' if not care else 'no url or token' if not care['url'] or
                               not care['token'] else f'{on} on')
                        print(f'call: a care call on {engine!r} refused ({why}): HQ plays its message', flush=True)
                        return await ws.close()
                    care_sid = str(e['start'].get('callSid') or sid)
                    CARE_LIVE[care_sid] = engine
                    clear = lambda: ws.send(json.dumps({'event': 'clear', 'streamSid': sid}))
                    call, limit = await care_call(ws, send, clear, ok, care_sid, care, make_call, wiring)
                    if not call:
                        return
                    continue
                # (the agent hung up: closing the stream ends the phone call, as Twilio goes on to the TwiML after its
                # <Connect>, and there is none: phone.ts)
                # (a call we placed: the ticket says which call out)
                callout = ok.get('callout') if type(ok.get('callout')) is int and ok['callout'] > 0 else 0
                call = make_call(send, lambda ev: asyncio.sleep(0), lambda: ws.send(json.dumps({'event': 'clear', 'streamSid': sid})),
                                 ok['agent'], language(ok.get('lang')), phone=True, hang_up=ws.close, callout=callout,
                                 wiring=wiring)
                await call.start()
                await call.greet()
            elif e.get('event') == 'media' and call:
                await call.hear(resample(ulaw_decode(base64.b64decode(e['media']['payload'])), 8000, RATE))
            elif e.get('event') == 'stop':
                break
    finally:
        if limit:
            limit.cancel()
        if call:
            await asyncio.to_thread(call.end)
        CARE_LIVE.pop(care_sid, None)


async def care_call(ws, send, clear, ticket, call_sid, deployment, make_call, wiring):
    """A care call on the phone line: the care brain, the opening, and the call's
    ends. The care agent's hang_up tells HQ (phone-done) before the stream closes, so HQ hangs up; every other end closes the stream
    alone, and HQ plays its recorded message (care refused the start, a turn care can't answer, the time limit). Returns
    the call and its time limit's task, or no call (refused: the stream is closed)."""
    langs, voices, seeds = ticket.get('langs'), ticket.get('voices'), ticket.get('seeds')
    brain = Care(ticket['agent'], call_sid, language(ticket.get('lang')), langs if isinstance(langs, list) else (),
                 ticket.get('voice'), voices if isinstance(voices, dict) else {}, ticket.get('respell'),
                 seeds if isinstance(seeds, dict) else {}, deployment)

    async def hang_up():
        brain.ended = 'hung_up'
        try:
            await asyncio.to_thread(wiring.hq, 'POST', 'phone-done', {'call': call_sid})
        except Exception as err:
            print(f'call: {brain.agent}: HQ did not take phone-done: {err!r}', flush=True)
        await ws.close()

    async def drop(why):
        brain.ended = why
        await ws.close()

    async def time_limit():
        seconds = call.limits.care_call_seconds
        await asyncio.sleep(seconds)
        print(f'call: {brain.agent}: a care call reached {seconds} s: the line ends it, HQ plays its message', flush=True)
        await drop('limit')

    call = make_call(send, lambda ev: asyncio.sleep(0), clear, brain.agent, brain.lang, phone=True, hang_up=hang_up, brain=brain,
                     wiring=wiring)
    call.drop = drop
    try:
        await call.start()
    except Exception as err:  # (503: off, cap or down; or care unreachable)
        print(f'call: {brain.agent}: care did not start the call ({err!r}): HQ plays its message', flush=True)
        await ws.close()
        return None, None
    limit = asyncio.create_task(time_limit())
    await call.greet()
    return call, limit


def language(lang):
    """A call's language: one the line speaks, else English."""
    return lang if lang in ('en', 'nl', 'de') else 'en'


async def room_call(ws, make_call=Call, wiring=Wiring()):
    """The join link's page: one person in a call out's room (room.py). The page
    is on HQ's host (the coordinator serves it), and the link's token is the gate."""
    if ws.request.headers.get('Origin') != ORIGIN:
        return await ws.close(1008, 'origin')
    def make_room_call(send_audio, send_event, clear, ticket, hang_up, speakers):
        call = make_call(send_audio, send_event, clear, ticket['agent'], language(ticket.get('lang')), hang_up=hang_up,
                         callout=ticket['callout'], speakers=speakers, wiring=wiring)
        call.opening_quiet = ROOM_OPENING_QUIET_SECONDS
        return call
    await room.join(ws, lambda token: wiring.hq('POST', 'join-ticket', {'token': token}), make_room_call)


async def route(ws, make_call=Call, wiring=Wiring()):
    path = ws.request.path
    if path == '/voice/ws':
        return await app_call(ws, make_call, wiring)
    if path == '/voice/twilio':
        return await phone_call(ws, make_call, wiring)
    if path == '/voice/join':
        return await room_call(ws, make_call, wiring)
    # review mode's notes, from the coordinator only (dictate.py).
    if path.split('?')[0] == '/voice/dictate':  # (its clock the line's)
        return await dictate.dictation(ws, TOKEN, listener, transcribe, unhesitating, monotonic=wiring.monotonic)
    await ws.close(1008, 'path')


async def main():
    logging.basicConfig(level=logging.WARNING)  # a failing call shows up in the logs
    wiring = Wiring()
    paths = wiring.paths
    paths.work.mkdir(parents=True, exist_ok=True)
    paths.calls.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(paths.live, ignore_errors=True)  # (the calls a crash or restart cut off are over.)
    paths.live.mkdir(parents=True)
    forget(paths.sessions)
    for f in paths.calls.glob('*.json'):  # calls a crash or restart cut off: their transcripts still count
        await asyncio.to_thread(hand_over, f, wiring.hq)
    async with await serve_screens(paths.screen_socket), serve(functools.partial(route, wiring=wiring), '0.0.0.0', 8080, max_size=1 << 20, ping_interval=20):
        print('Voice line ready', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
