"""cd platform/voice && python3 -m unittest test_server   (server.py's barge-in: stray() and the hold, a tool step's
tick, the timing line and how HQ played the voice; no models)

The call runs for real (Call.hear, answer, say, cut_in) around stand-ins: a VAD that hears speech wherever the audio is
loud, a recogniser that reads each utterance's words back from its audio (part of them for part of the audio, as a look
mid-sentence does), a Claude session that answers from a script, speech synthesis that makes 2 s of audio a sentence,
and a clock that moves with the audio (32 ms a VAD window). The Call tests need numpy (the voice image has it; elsewhere
`python3 -m venv /tmp/v && /tmp/v/bin/pip install numpy`, then run this with /tmp/v/bin/python); without it only stray()
is tested. replay.py runs the same kind of call through the real models.
"""
import asyncio, base64, contextlib, io, json, os, re, sys, tempfile, threading, types, unittest, unittest.mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace as NS
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parent))
try:
    import numpy as np
except ImportError:  # (stray() needs none of it)
    np = None
    sys.modules['numpy'] = types.ModuleType('numpy')

SPOKEN = []  # what the speech engines were given, sentence by sentence
VOICED = []  # Pocket TTS's language and voice for each
SEEDED = []  # torch's seed, each time the line set it (for fixed words: SAID)
CLOCK = [100.0]  # the call's time.monotonic(): each VAD window moves it on 32 ms
NOW = 1909173600000  # (the line's wall clock in these tests: 2030-07-01 22:00 UTC, midnight in Amsterdam; resets come 10 min on)


class Vad:
    """Speech wherever a window is loud (> 0.5); a segment is pushed at the first quiet window, as Silero's would be."""
    def __init__(self, cfg, buffer_size_in_seconds):
        self.on, self.seg, self.done, self.n = False, [], [], 0

    def accept_waveform(self, x):
        CLOCK[0] += len(x) / 16000
        loud = float(abs(x).max()) > 0.5
        if loud:
            self.seg += list(x)
        elif self.on:
            self.done.append(NS(samples=self.seg, start=self.n - len(self.seg)))
            self.seg = []
        self.on = loud
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


class Pocket:
    sample_rate = 16000

    def __init__(self, language='english', temp=None):
        self.language = language

    def get_state_for_audio_prompt(self, v):
        return self.language, v

    def generate_audio_stream(self, state, text, stop=None):  # 2 s a sentence, in four pieces
        SPOKEN.append(text)
        VOICED.append(state)
        for _ in range(4):
            yield NS(numpy=lambda: np.full(8000, 0.01, np.float32))


class Piper:
    __hash__ = None  # (as piper's PiperVoice, a dataclass)

    def synthesize(self, text):  # (Dutch: 2 s a sentence too, at 16 kHz)
        SPOKEN.append(text)
        for _ in range(4):
            yield NS(audio_int16_bytes=np.full(8000, 300, np.int16).tobytes(), sample_rate=16000)


def stub(name, **attrs):
    sys.modules[name] = m = types.ModuleType(name)
    m.__dict__.update(attrs)
    return m


stub('endpoint', Endpoint=lambda path: NS(finished=lambda audio: 1.0))  # (Smart Turn: Juno's own stand-in, finished())
stub('sherpa_onnx', OfflineRecognizer=NS(from_transducer=lambda **k: None), VoiceActivityDetector=Vad,
     VadModelConfig=lambda: NS(silero_vad=NS(), sample_rate=0))
class Canceller:
    """WebRTC's echo canceller, perfect: what played comes out of the microphone's samples exactly."""
    def __init__(self, echo_cancellation):
        self.played = None

    def process_reverse_stream(self, frame):
        self.played = frame.data.copy()

    def set_stream_delay_ms(self, delay):
        pass

    def process_stream(self, frame):
        frame.data -= self.played


stub('livekit').rtc = stub('livekit.rtc', AudioProcessingModule=Canceller,
                           AudioFrame=lambda data, rate, channels, samples: NS(data=np.frombuffer(bytearray(data), np.int16)))
stub('pocket_tts', TTSModel=NS(load_model=Pocket))
stub('torch', manual_seed=lambda seed: SEEDED.append(seed))
stub('piper', PiperVoice=NS(load=lambda path: Piper()))
try:
    import websockets.asyncio.server  # noqa: F401
except ImportError:
    stub('websockets'), stub('websockets.asyncio'), stub('websockets.asyncio.server', serve=None)
    stub('websockets.exceptions', ConnectionClosed=Exception)
os.environ.update(HQ_URL='http://127.0.0.1:9', ORIGIN='https://hq.test', VOICE_TOKEN='test')
import server  # noqa: E402
from server import aloud, stray, unhesitating  # noqa: E402
import limit_model  # noqa: E402
import guard  # noqa: E402
import room  # noqa: E402
import echo  # noqa: E402
import drawing  # noqa: E402

server.time = NS(monotonic=lambda: CLOCK[0], time=lambda: NOW / 1000)  # (time: when a call went live, app_call)
REPLY = "Sure, I'll check the orders now. Then I'll look at the invoices. And after that, the parcels."  # 3 sentences: 6 s


class Brain:
    """The call's Claude session: answers every message with REPLY."""
    def __init__(self):
        self.asked, self.busy, self.token, self.stopped, self.voice = [], False, '', 0, 'alba'
        self.respell = {}  # the company's words respelt, by language (brand.yaml speech.respell)
        self.shown, self.call, self.key = [], 7, 'key-of-7'  # each message's pictures (their ids), HQ's calls row, its key
        self.thinking = None  # an asyncio.Event to hold the first word back until it's set: the agent is still thinking
        self.reply = REPLY
        self.tz, self.seat = 'Europe/Amsterdam', None
        self.pin_shots = []  # the pins' screenshots from call-context
        self.opening = self.objected = self.who = self.recap = ''  # (a call out's, from call-context)

    def moved(self):  # (the worker never moves this one to another seat)
        return False

    async def start(self):
        pass

    async def ask(self, text, pictures=()):
        self.asked.append(text)
        self.shown.append([p['id'] for p in pictures])
        self.busy = True
        yield server.DELIVERED  # (its request started: the model has the message)
        if self.thinking:
            await self.thinking.wait()
        # (a list: what the session streams, a server.Step for a tool step, an asyncio.Event it waits for: the tool, and an
        # exception it raises: server.Unanswered, the CLI's error result)
        for w in [w + ' ' for w in self.reply.split(' ')] if isinstance(self.reply, str) else self.reply:
            if isinstance(w, Exception):
                self.busy = False
                raise w
            if isinstance(w, asyncio.Event):
                await w.wait()
                continue
            yield w
            await asyncio.sleep(0)
        self.busy = False

    def interrupt(self):
        self.stopped += 1

    def kill(self):
        pass

    def close(self):
        pass


class Stray(unittest.TestCase):
    def test_short_sounds_and_backchannel_are_stray(self):
        for text in ('', '.', 'Okay.', 'okay', 'Yeah.', 'Mhm.', 'M H M', 'N H M.', 'Uh-huh.', 'Mm-hmm.', 'Right.', 'Oh.', 'Hm.', 'Sure.',
                     'Okay, okay.', 'Okay okay okay.', 'Yeah, right.', 'Oh, nice.', 'Thank you.', 'I see.', 'Got it.', 'The',
                     'So', 'Invoices.', 'so the', 'and then', 'Yeah, pretty.', 'Thanks, Juno.', 'Neighbor.',
                     'And they can.', 'Hey.', 'Hello.', 'So the.', 'All right.', 'Thank you, thank you.', 'Okay, got it.',
                     'Yes, please.', 'Sounds good.'):  # (a short answer too: the board was told, see the Gazette post)
            self.assertTrue(stray(text, 'en'), text)
        for text in ('Oké.', 'Ja.', 'Ja, precies.', 'Yeah, precies.', 'Nou.', 'Ja ja.', 'Oké, prima.', 'Klopt.', 'Dank je wel.', 'Ehm.', 'Wat mooi.',
                     'Wat leuk.', 'Oh, wat leuk.', 'Ja, dank je.', 'Ja, graag.'):
            self.assertTrue(stray(text, 'nl'), text)

    def test_real_interruptions_are_not(self):
        for text in ('Stop.', 'Wait.', 'No.', 'Wait, stop.', 'Hold on.', 'Hang on.', 'Okay, stop.', 'okay wait',
                     "That's wrong.", 'What about the invoices', 'Okay. So what about the invoices?', 'no no no', 'Sorry?',
                     'yeah but the parcels', 'Is that all?', 'Is that right?', 'Can you see that?', 'Thank you, that is all.',
                     'Okay, stop?', 'Yes, do it.', "Don't.", 'Cancel that.', 'Scratch that.', 'Enough.'):
            self.assertFalse(stray(text, 'en'), text)
        for text in ('Nee.', 'Wacht.', 'Nee, wacht.', 'Ja, maar de facturen.', 'Wat zei je?', 'Dat klopt niet.', 'Ik bedoelde de facturen', 'Is dat het?',
                     'En dan?', 'Wat?', 'Ja, doe maar.', 'Klopt niet.'):
            self.assertFalse(stray(text, 'nl'), text)

    def test_dutch_filler_only_counts_on_a_dutch_call(self):
        self.assertTrue(stray('Ja, precies.', 'nl'))
        self.assertFalse(stray('Ja, precies.', 'en'))  # (two words, a finished sentence: on an English call, words)
        self.assertTrue(stray('Okay, sure.', 'nl'))    # English backchannel counts on a Dutch call too


class Unhesitating(unittest.TestCase):
    def test_hesitation_goes_from_what_is_written_down(self):
        for heard, written in (
                ('Uh, send the parcel today.', 'Send the parcel today.'),
                ('So uh the mug could go uh Uh in the box.', 'So the mug could go in the box.'),
                ('the blue one, um, and the green one', 'the blue one, and the green one'),
                ("Thanks. Um, and there's a uh uh uh lid too.", "Thanks. And there's a lid too."),
                ('Fine. Uh when I press it I hear um, a click.', 'Fine. When I press it I hear a click.'),
                ('Wait, um, what?', 'Wait, what?'),
                ('Wait — um — what', 'Wait — what'),
                ('Eer, the blue one. Ummm, yes.', 'The blue one. Yes.'),
                ("That's it. Umm. Erm, what about it?", "That's it. What about it?"),
                ('We should, um.', 'We should.'),
                ('Can you check the orders? Uhh', 'Can you check the orders?')):
            self.assertEqual(unhesitating(heard, 'en'), written, heard)

    def test_words_that_say_something_stay(self):
        for text in ('Uh-huh, ok, yeah, right.', 'Mhm. Hmm, like the umbrella ahead of her.',
                     'See uh.com, er.md and um@example.test.', 'Open uh/notes.txt.', 'Open um\\notes.txt.',
                     'Use 10 Ah batteries.', 'Check the ER diagram.', 'We went to the ER yesterday.', 'Ah, I see.',
                     'UH, and UM too.', 'To err is human.', "Don't err on the side of caution.",
                     'Um.', 'Uh, uh, um.'):  # (only hesitation: as heard)
            self.assertEqual(unhesitating(text, 'en'), text)
        self.assertEqual(unhesitating('Er is eh een ding, ehm, ja.', 'nl'), 'Er is een ding, ja.')  # ("er" is Dutch)
        self.assertEqual(unhesitating('Right, eh?', 'en'), 'Right, eh?')


class Euros(unittest.TestCase):
    def test_amounts_are_said_in_words_in_either_language(self):
        for written, en, nl in [
            ('€4', 'four euros', 'vier euro'), ('€1', 'one euro', 'één euro'), ('€ 4,-', 'four euros', 'vier euro'),
            ('€29.95', 'twenty-nine euros ninety-five', 'negenentwintig euro vijfennegentig'),
            ('€29,95', 'twenty-nine euros ninety-five', 'negenentwintig euro vijfennegentig'),
            ('29,95 €', 'twenty-nine euros ninety-five', 'negenentwintig euro vijfennegentig'),
            ('€22.5', 'twenty-two euros fifty', 'tweeëntwintig euro vijftig'),
            ('€0.50', 'fifty cents', 'vijftig cent'), ('€1.05', 'one euro and five cents', 'één euro en vijf cent'),
            ('€121', 'one hundred and twenty-one euros', 'honderdeenentwintig euro'),
            ('€3,330', 'three thousand three hundred and thirty euros', 'drieduizend driehonderddertig euro'),
            ('€1.250,50', 'one thousand two hundred and fifty euros fifty', 'duizend tweehonderdvijftig euro vijftig'),
            ('€1,000,000', 'one million euros', 'een miljoen euro'),
            ('€1.5m', 'one point five million euros', 'één komma vijf miljoen euro'),
            ('€2 million', 'two million euros', 'twee miljoen euro'),
            ('€1 250,50', 'one thousand two hundred and fifty euros fifty', 'duizend tweehonderdvijftig euro vijftig'),
            ('1 250,50 €', 'one thousand two hundred and fifty euros fifty', 'duizend tweehonderdvijftig euro vijftig'),
            ('€10 000', 'ten thousand euros', 'tienduizend euro'),
            ('€0.125 per kWh', 'zero point one two five euros per kWh', 'nul komma één twee vijf euro per kWh'),
            ('€0,075', 'zero point zero seven five euros', 'nul komma nul zeven vijf euro'),
            ('€0.125m', 'zero point one two five million euros', 'nul komma één twee vijf miljoen euro'),
            ('€1.125m', 'one point one two five million euros', 'één komma één twee vijf miljoen euro'),
            ('€10 000 million', 'ten thousand million euros', 'tienduizend miljoen euro'),
            ('€-4', 'minus four euros', 'min vier euro'), ('€ -4,00', 'minus four euros', 'min vier euro'),
            ('-€4', 'minus four euros', 'min vier euro'), ('−4,50 €', 'minus four euros fifty', 'min vier euro vijftig')]:
            self.assertEqual(aloud(f'It is {written}.', 'en'), f'It is {en}.', written)
            self.assertEqual(aloud(f'It is {written}.', 'nl'), f'It is {nl}.', written)

    def test_the_numbers_around_an_amount(self):
        for text in ['The € sign.', '€uro', 'No numbers here.']:
            self.assertEqual(aloud(text), text)
        # (the 3 isn't an amount before a €)
        self.assertEqual(aloud('About 3 €4 mugs.'), 'About three four euros mugs.')
        self.assertEqual(aloud('From €4-€6, 3-4 €.'), 'From four to six euros, three to four euros.')
        for written in ['4€-6€', '4 €-6 €']:  # (a dash between amounts isn't a minus)
            self.assertEqual(aloud(f'From {written}.'), 'From four to six euros.', written)
            self.assertEqual(aloud(f'Van {written}.', 'nl'), 'Van vier tot zes euro.', written)
        # (an amount stays on its line: the next line's number isn't its €'s)
        self.assertEqual(aloud('1. Small mug: 4 €\n2. Large mug: 6 €.'),
                         'one. Small mug: four euros\ntwo. Large mug: six euros.')
        self.assertEqual(aloud('1. Kleine mok: 4 €\n2. Grote mok: 6 €.', 'nl'),
                         'één. Kleine mok: vier euro\ntwee. Grote mok: zes euro.')
        self.assertEqual(aloud('Total: €\n2 mugs, 3 million\n€ left.'),
                         'Total: €\ntwo mugs, three million\n€ left.')
        # (a sign, - or +, is said; a + is a phone number's only with a country code and eight digits or more)
        for written, en, nl in [
                ('a +4 000 € change', 'a plus four thousand euros change', 'a plus vierduizend euro change'),
                ('bonus +1 000 000 €', 'bonus plus one million euros', 'bonus plus een miljoen euro'),
                ('+€4', 'plus four euros', 'plus vier euro'), ('€+4', 'plus four euros', 'plus vier euro')]:
            self.assertEqual(aloud(written), en, written)
            self.assertEqual(aloud(written, 'nl'), nl, written)
        for gap in ' \t\u00a0\u202f':  # (a € and its amount apart: a leading zero there isn't a phone number's)
            self.assertEqual(aloud(f'It is €{gap}06.'), 'It is six euros.', repr(gap))

    def test_a_range_says_its_euros_once(self):
        # (the speech engine repeats a repeated unit: "thirty-five euros to forty euros" can end twice)
        for written in ['€35–40', '€35-40', '€35–€40', '€35-€40', '€35 – €40', '€35 - €40', '€35 – 40', '€35 to €40',
                        '€35 tot €40', '€ 35–40', '35–40 €', '35€–40€', '35 € – 40 €', '35 € to 40 €',
                        '35€–€40', '35€–40', '€35–40€', '€35—40', '€35—€40']:
            self.assertEqual(aloud(f'It costs {written} a month.'), 'It costs thirty-five to forty euros a month.',
                             written)
            self.assertEqual(aloud(f'Het blijft {written}.', 'nl'), 'Het blijft vijfendertig tot veertig euro.', written)
        for written, en, nl in [
                ('€1–2', 'one to two euros', 'één tot twee euro'),
                ('€35–40.50', 'thirty-five to forty euros fifty', 'vijfendertig tot veertig euro vijftig'),
                ('€1,250–1,500', 'one thousand two hundred and fifty to one thousand five hundred euros',
                 'duizend tweehonderdvijftig tot duizend vijfhonderd euro'),
                ('€1–2 million', 'one to two million euros', 'één tot twee miljoen euro'),
                ('€1m–€2m', 'one million to two million euros', 'één miljoen tot twee miljoen euro'),
                ('€1.250m–€1.500m', 'one point two five zero million to one point five zero zero million euros',
                 'één komma twee vijf nul miljoen tot één komma vijf nul nul miljoen euro'),
                ('€1,250 million to €1,500 million',
                 'one point two five zero million to one point five zero zero million euros',
                 'één komma twee vijf nul miljoen tot één komma vijf nul nul miljoen euro'),
                # (each amount its own euros: cents first, cents alone second, a sign, a bare number that counts
                # something else, a time, a percentage, a scale on one end only)
                ('€29.95–€34.95', 'twenty-nine euros ninety-five to thirty-four euros ninety-five',
                 'negenentwintig euro vijfennegentig tot vierendertig euro vijfennegentig'),
                ('From €1 to €0.50.', 'From one euro to fifty cents.', 'From één euro to vijftig cent.'),
                ('€1–€0.50', 'one euro to fifty cents', 'één euro tot vijftig cent'),
                ('-€5 to €5', 'minus five euros to five euros', 'min vijf euro to vijf euro'),
                ('€5 to 3 people', 'five euros to three people', 'vijf euro to drie people'),
                ('€5 to 10 people', 'five euros to ten people', 'vijf euro to tien people'),
                ('It takes €5–10 minutes', 'It takes five euros to ten minutes', 'It takes vijf euro tot tien minutes'),
                ('€20-30 mugs', 'twenty euros to thirty mugs', 'twintig euro tot dertig mugs'),
                ('Give €5 to 10 of the volunteers.', 'Give five euros to ten of the volunteers.',
                 'Give vijf euro to tien of the volunteers.'),
                ('Give €5 to 10 or more people.', 'Give five euros to ten or more people.',
                 'Give vijf euro to tien or more people.'),
                ('€5 tot 10 voor de vrijwilligers', 'five euros tot ten voor de vrijwilligers',
                 'vijf euro tot tien voor de vrijwilligers'),
                ('€100 to 150 people', 'one hundred euros to one hundred and fifty people',
                 'honderd euro to honderdvijftig people'),
                ('€5 to 10:00', "five euros to ten o'clock", 'vijf euro to tien uur'),
                ('€5–10:00', "five euros to ten o'clock", 'vijf euro tot tien uur'),
                ('€2 million to €500', 'two million euros to five hundred euros',
                 'twee miljoen euro to vijfhonderd euro'),
                ('€35-40%', 'thirty-five euros to forty percent', 'vijfendertig euro tot veertig procent'),
                ('€35–40.5%', 'thirty-five euros to forty point five percent',
                 'vijfendertig euro tot veertig komma vijf procent'),
                ('€500 to €2 million', 'five hundred euros to two million euros',
                 'vijfhonderd euro to twee miljoen euro'),
                ('9:00–17:00 for €35–40', "nine o'clock to five PM for thirty-five to forty euros",
                 'negen uur tot zeventien uur for vijfendertig tot veertig euro')]:
            self.assertEqual(aloud(written), en, written)
            self.assertEqual(aloud(written, 'nl'), nl, written)
        for written, rest in [('€35–40 a month', ' a month'), ('€35 to 40 per mug', ' per mug'),
                              ('€35–40, or more', ', or more'), ('€35–40, or €45', ', or forty-five euros'),
                              ('€35–40 each', ' each')]:  # (nothing it could count follows)
            self.assertEqual(aloud(written), f'thirty-five to forty euros{rest}', written)
        for written in ['€35–40 euros', '€35 to 40 euros']:  # (a unit written out is the second amount's)
            self.assertEqual(aloud(written), 'thirty-five to forty euros', written)
        self.assertEqual(aloud('€1–2 million euros'), 'one to two million euros')
        self.assertEqual(aloud('€35–40 euro', 'nl'), 'vijfendertig tot veertig euro')
        aloud('€5 to ' + '1' * 5000)  # (a long run of digits is never an amount)
        self.assertEqual(aloud('€35 — 40 of them'), 'thirty-five euros — forty of them')  # (a pause, not a range)

    def test_a_decimal_amount_cut_by_the_stream_waits_for_the_rest(self):
        self.assertIsNone(server.SENTENCE.match('It costs €29.'))
        self.assertEqual(server.SENTENCE.match('It costs €29.95. And').group(1), 'It costs €29.95.')
        self.assertEqual(server.SENTENCE.match('Sure.').group(1), 'Sure.')


class Numbers(unittest.TestCase):
    """Every number in words before it's spoken (the board, call #90: "06" was swallowed with the words after it,
    "310" came out "three ten")."""
    def test_numbers_are_said_in_words_in_either_language(self):
        for written, en, nl in [
            ('310', 'three hundred and ten', 'driehonderdtien'), ('1', 'one', 'één'), ('0', 'zero', 'nul'),
            ('21', 'twenty-one', 'eenentwintig'), ('1000', 'one thousand', 'duizend'),
            ('12500', 'twelve thousand five hundred', 'twaalfduizend vijfhonderd'),
            ('1 250 000', 'one million two hundred and fifty thousand', 'een miljoen tweehonderdvijftigduizend'),
            ('-4', 'minus four', 'min vier'), ('−3', 'minus three', 'min drie'),
            ('42%', 'forty-two percent', 'tweeënveertig procent'), ('100 %', 'one hundred percent', 'honderd procent'),
            ('#90', 'number ninety', 'nummer negentig'), ('# 7', 'number seven', 'nummer zeven'),
            ('2–3', 'two to three', 'twee tot drie'), ('2-3', 'two to three', 'twee tot drie'),
            ('2026', 'twenty twenty-six', 'tweeduizend zesentwintig'),
            ('1995', 'nineteen ninety-five', 'negentienhonderdvijfennegentig'),
            ('2005', 'two thousand and five', 'tweeduizend vijf'), ('1900', 'nineteen hundred', 'negentienhonderd'),
            ('2024-25', 'twenty twenty-four to twenty-five', 'tweeduizend vierentwintig tot vijfentwintig'),
            ('1.2.3', 'one point two point three', 'één punt twee punt drie'),
            ('A4', 'A four', 'aa vier'), ('3D', 'three D', 'drie D'), ('COVID-19', 'COVID-nineteen', 'COVID-negentien'),
            # one digit at a time: a leading zero, a phone number, an order reference or a code, a postcode's digits
            ('06', 'oh six', 'nul zes'), ('020', 'oh two oh', 'nul twee nul'),
            ('06-12345678', 'oh six one two three four five six seven eight',
             'nul zes één twee drie vier vijf zes zeven acht'),
            ('+31 6 1234 5678', 'plus three one six one two three four five six seven eight',
             'plus drie één zes één twee drie vier vijf zes zeven acht'),
            ('+31612345678', 'plus three one six one two three four five six seven eight',
             'plus drie één zes één twee drie vier vijf zes zeven acht'),
            ('+12', 'plus twelve', 'plus twaalf'), ('+5%', 'plus five percent', 'plus vijf procent'),
            ('+120 000', 'plus one hundred and twenty thousand', 'plus honderdtwintigduizend'),
            ('40213876', 'four oh two one three eight seven six', 'vier nul twee één drie acht zeven zes'),
            ('1012 AB Amsterdam', 'one oh one two A B Amsterdam', 'één nul één twee aa bee Amsterdam'),
            # times
            ('22:00', 'ten PM', 'tweeëntwintig uur'),
            ('00:00', 'midnight', 'nul uur'), ('00:30', 'twelve thirty AM', 'nul uur dertig'),
            ('14:05', 'two oh five PM', 'veertien uur vijf'), ('3pm', 'three PM', 'vijftien uur'),
            ('9:30 am', 'nine thirty AM', 'negen uur dertig'), ('22:00 uur', 'ten PM', 'tweeëntwintig uur'),
            ('09:30', 'nine thirty AM', 'negen uur dertig'),  # (AM or PM only when the text or the hour says so)
            ('9:30', 'nine thirty', 'negen uur dertig'), ('3:30', 'three thirty', 'drie uur dertig'),
            ('12:00', "twelve o'clock", 'twaalf uur'),
            ('10:00-11:00', "ten o'clock to eleven o'clock", 'tien uur tot elf uur'),
            ('9:00–17:00', "nine o'clock to five PM", 'negen uur tot zeventien uur'),
            ('50%-60%', 'fifty percent to sixty percent', 'vijftig procent tot zestig procent'),
            # dates
            ('2026-10-07', 'the seventh of October twenty twenty-six', 'zeven oktober tweeduizend zesentwintig'),
            ('7-10-2026', 'the seventh of October twenty twenty-six', 'zeven oktober tweeduizend zesentwintig'),
            ('7/10/2026', 'the seventh of October twenty twenty-six', 'zeven oktober tweeduizend zesentwintig')]:
            self.assertEqual(aloud(f'It is {written}, really.', 'en'), f'It is {en}, really.', written)
            self.assertEqual(aloud(f'It is {written}, really.', 'nl'), f'It is {nl}, really.', written)

    def test_as_the_language_writes_them(self):
        for written, en in [('1,250', 'one thousand two hundred and fifty'),
                            ('1,250,000', 'one million two hundred and fifty thousand'),
                            ('1,250.5', 'one thousand two hundred and fifty point five'), ('2.5', 'two point five'),
                            ('0.75', 'zero point seven five'), ('2.5%', 'two point five percent'),
                            ('2,5', 'two point five'),
                            ('1st', 'first'), ('2nd', 'second'), ('3rd', 'third'), ('12th', 'twelfth'),
                            ('21st', 'twenty-first'), ('40th', 'fortieth'), ('100th', 'one hundredth'),
                            ('7 October', 'the seventh of October'), ('8 Oct', 'the eighth of October'),
                            ('the 1st of May', 'the first of May'), ('October 7th', 'October seventh'),
                            ('Sept 3, 2026', 'September third twenty twenty-six')]:
            self.assertEqual(aloud(f'It is {written}, really.', 'en'), f'It is {en}, really.', written)
        for written, nl in [('1.250', 'duizend tweehonderdvijftig'),
                            ('1.250.000', 'een miljoen tweehonderdvijftigduizend'),
                            ('1.250,5', 'duizend tweehonderdvijftig komma vijf'), ('2,5', 'twee komma vijf'),
                            ('2,5%', 'twee komma vijf procent'), ('2.5', 'twee komma vijf'),
                            ('1e', 'eerste'), ('2e', 'tweede'), ('3de', 'derde'), ('8ste', 'achtste'),
                            ('19e', 'negentiende'),
                            ('20ste', 'twintigste'), ('21e', 'eenentwintigste'), ('100ste', 'honderdste'),
                            ('7 oktober', 'zeven oktober'), ('8 okt', 'acht oktober'),
                            ('1 Mei 2026', 'één mei tweeduizend zesentwintig')]:
            self.assertEqual(aloud(f'Het is {written}, echt.', 'nl'), f'Het is {nl}, echt.', written)

    def test_what_isnt_one_number(self):
        self.assertEqual(aloud('Job #6995 at 20:00, 3 mugs, version 1.2.'),
                         'Job number six thousand nine hundred and ninety-five at eight PM, three mugs, '
                         'version one point two.')
        # (a pause, not a range)
        self.assertEqual(aloud('We sold 3 — 2 came back.'), 'We sold three — two came back.')
        self.assertEqual(aloud('The 7th of May.'), 'The seventh of May.')
        self.assertEqual(aloud('In 2026 AI will help.'), 'In twenty twenty-six AI will help.')  # (not a postcode)
        self.assertEqual(aloud('Be there at 5 p.m.'), 'Be there at five PM.')  # (its full stop)
        self.assertEqual(aloud('At 5 p.m. we close.'), 'At five PM we close.')
        # (may, not May)
        self.assertEqual(aloud('Print it 3 times if you may 2 more.'), 'Print it three times if you may two more.')
        # (a run of thousands of digits, a code at most: one at a time, and int() never has to read it)
        self.assertEqual(aloud(f'Code {"1" * 5000}.5.'), 'Code ' + 'one ' * 4999 + 'one point five.')

    def test_codes_a_letter_or_digit_at_a_time(self):
        """A postcode, an order number or a code a letter or digit at a time, the letters by their names (the board:
        "1234AB" run together tripped the voices, and "AB" was the Dutch and German word)."""
        for written, en, nl, de in [
            ('1234AB', 'one two three four A B', 'één twee drie vier aa bee', 'eins zwei drei vier Ah Beh'),
            ('1234 AB', 'one two three four A B', 'één twee drie vier aa bee', 'eins zwei drei vier Ah Beh'),
            ('1234ab', 'one two three four A B', 'één twee drie vier aa bee', 'eins zwei drei vier Ah Beh'),
            ('ORD-7Q4K-M2', 'O R D seven Q four K M two', 'oo err dee, zeven kuu vier kaa, emm twee',
             'Oh Err Deh, sieben Kuh vier Kah, Emm zwei'),
            ('BUD-2041', 'B U D two oh four one', 'bee uu dee, twee nul vier één', 'Beh Uh Deh, zwei null vier eins'),
            ('MP3', 'M P three', 'emm pee drie', 'Emm Peh drei'),
            ('482913', 'four eight two nine one three', 'vier acht twee negen één drie',
             'vier acht zwei neun eins drei'),
            ('020 123 4567', 'oh two oh one two three four five six seven',
             'nul twee nul één twee drie vier vijf zes zeven',
             'null zwei null eins zwei drei vier fünf sechs sieben'),
            # (the decimal word apart, as before; money and times as before)
            ('25.5', 'twenty-five point five', 'vijfentwintig komma vijf', 'fünfundzwanzig Komma fünf'),
            ('€29.95', 'twenty-nine euros ninety-five', 'negenentwintig euro vijfennegentig',
             'neunundzwanzig Euro fünfundneunzig'),
            ('14:30', 'two thirty PM', 'veertien uur dertig', 'vierzehn Uhr dreißig'),
            # (no code: a number's unit or ending, a word with its number, a size, a version, a postcode's letters apart
            # in lowercase, which could be a word)
            ('1500km', 'one thousand five hundred km', 'duizend vijfhonderd km', 'tausendfünfhundert km'),
            ('1000mL', 'one thousand mL', 'duizend mL', 'tausend mL'),
            ('1500kW', 'one thousand five hundred kW', 'duizend vijfhonderd kW', 'tausendfünfhundert kW'),
            ('COVID-19', 'COVID-nineteen', 'COVID-negentien', 'COVID-neunzehn'),
            ('iPhone15', 'iPhone fifteen', 'iPhone vijftien', 'iPhone fünfzehn'),
            ('10x15', 'ten x fifteen', 'tien x vijftien', 'zehn x fünfzehn'),
            ('v2.1', 'v two point one', 'v twee komma één', 'v zwei Komma eins'),
            ('1234 ab', 'one thousand two hundred and thirty-four ab', 'duizend tweehonderdvierendertig ab',
             'tausendzweihundertvierunddreißig ab')]:
            self.assertEqual(aloud(f'It is {written}, really.', 'en'), f'It is {en}, really.', written)
            self.assertEqual(aloud(f'Het is {written}, echt.', 'nl'), f'Het is {nl}, echt.', written)
            self.assertEqual(aloud(f'Es ist {written}, wirklich.', 'de'), f'Es ist {de}, wirklich.', written)
        self.assertEqual(aloud('Postcode 1234AB in Amsterdam.', 'nl'),
                         'Postcode één twee drie vier aa bee in Amsterdam.')
        aloud('A1' * 5000 + '.5'), aloud('A-' * 5000 + '1.5')  # (a long run is quick)


# (German, and every language in Pocket TTS)
class German(unittest.IsolatedAsyncioTestCase):
    """A call in German: numbers, amounts, times and dates as German says them, and German's own little words."""
    def test_numbers_amounts_times_and_dates_in_german(self):
        for written, de in [
            ('310', 'dreihundertzehn'), ('1', 'eins'), ('0', 'null'), ('21', 'einundzwanzig'), ('101', 'hunderteins'),
            ('1000', 'tausend'), ('12500', 'zwölftausendfünfhundert'), ('21000', 'einundzwanzigtausend'),
            ('1.250', 'tausendzweihundertfünfzig'), ('1 250 000', 'eine Million zweihundertfünfzigtausend'),
            ('2,5', 'zwei Komma fünf'), ('-4', 'minus vier'), ('42%', 'zweiundvierzig Prozent'), ('#90', 'Nummer neunzig'),
            ('2–3', 'zwei bis drei'), ('2026', 'zweitausendsechsundzwanzig'), ('1995', 'neunzehnhundertfünfundneunzig'),
            ('06', 'null sechs'), ('06-12345678', 'null sechs eins zwei drei vier fünf sechs sieben acht'),
            # amounts
            ('€4', 'vier Euro'), ('€1', 'ein Euro'), ('29,95 €', 'neunundzwanzig Euro fünfundneunzig'),
            ('€1,05', 'ein Euro und fünf Cent'), ('€0,50', 'fünfzig Cent'), ('€1.250', 'tausendzweihundertfünfzig Euro'),
            ('€35–40', 'fünfunddreißig bis vierzig Euro'), ('€35 bis €40', 'fünfunddreißig bis vierzig Euro'),
            ('€1 Mio.', 'eine Million Euro.'), ('2,5 Millionen Euro', 'zwei Komma fünf Millionen Euro'),
            # times and dates
            ('14:30', 'vierzehn Uhr dreißig'), ('22:00 Uhr', 'zweiundzwanzig Uhr'), ('1:00', 'ein Uhr'),
            ('3pm', 'fünfzehn Uhr'), ('9:00–17:00', 'neun Uhr bis siebzehn Uhr'),
            ('7.10.2026', 'siebten Oktober zweitausendsechsundzwanzig'), ('am 7. Oktober', 'am siebten Oktober'),
            ('ab 1. Mai', 'ab ersten Mai'), ('der 3. März', 'der dritte März'), ('am 20. Dez.', 'am zwanzigsten Dezember.'),
            ('am 8 Okt', 'am achten Oktober')]:
            self.assertEqual(aloud(f'Es ist {written}, wirklich.', 'de'), f'Es ist {de}, wirklich.', written)

    async def speak(self, lang, voice, words, respell=None):
        """What the speech engines were given for the agent's reply, and Pocket TTS's language and voice."""
        brain = Brain()
        brain.voice, brain.reply, brain.respell = voice, words, respell or {}
        SPOKEN.clear(), VOICED.clear()
        with tempfile.TemporaryDirectory() as d, unittest.mock.patch.object(server, 'CALL_LOGS', Path(d)), \
                unittest.mock.patch.object(server, 'hq', no_screen(server.hq)):
            call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', lang,
                               brain=brain)
            await call.answer('Hallo?', None)
        return SPOKEN[:], VOICED[:]

    @unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
    async def test_every_language_in_the_agents_own_voice_and_ai_as_each_says_it(self):
        self.assertEqual(await self.speak('de', 'alba', 'Ich bin eine AI, ein KI-Assistent. Die MAIL und AIDA.'),
                         (['Ich bin eine Ka-I, ein Ka-I-Assistent.', 'Die MAIL und AIDA.'], [('german', 'alba')] * 2))
        self.assertEqual(await self.speak('nl', 'jane', 'Ik ben een AI-assistent.'),
                         (['Ik ben een aa-ie-assistent.'], [('dutch', 'jane')]))
        self.assertEqual(await self.speak('en', 'eve', "I'm an AI assistant."), (["I'm an AI assistant."], [('english', 'eve')]))
        # (a voice that garbles Dutch speaks it with Piper, which reads "AI" right as it is)
        self.assertEqual(await self.speak('nl', 'bill_boerst', 'Ik ben een AI-assistent.'), (['Ik ben een AI-assistent.'], []))

    def test_little_words_and_stop_words_in_german(self):
        for text in ('Ja.', 'Genau.', 'Ja, genau.', 'Okay.', 'Alles klar.', 'Danke schön.', 'Ach so.', 'Mhm.', 'Ja, bitte.', 'Ähm.'):
            self.assertTrue(stray(text, 'de'), text)
        for text in ('Stopp.', 'Moment.', 'Nein.', 'Warte mal.', 'Was?', 'Wie bitte?', 'Halt, das stimmt nicht.',
                     'Und die Rechnungen?', 'Das ist falsch.'):
            self.assertFalse(stray(text, 'de'), text)
        self.assertFalse(stray('Ja, genau.', 'en'), 'German filler counts only on a German call')
        self.assertTrue(stray('That was it.', 'de') is False and stray('Was it?', 'en') is False)

    def test_hesitation_goes_from_what_is_written_down_in_german(self):
        for heard, written in (('Äh, schick das Paket heute.', 'Schick das Paket heute.'),
                               ('Die blaue, ähm, und die grüne.', 'Die blaue, und die grüne.'),
                               ('Ähm', 'Ähm')):
            self.assertEqual(unhesitating(heard, 'de'), written, heard)

    @unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
    async def test_the_companys_words_are_respelt_in_their_language_only(self):
        # (brand.yaml speech.respell, from the call's context)
        respell = {'en': {'Acme': 'Ak-mee'}}
        self.assertEqual(await self.speak('en', 'eve', "Acme's first week. ACME, Acmes!", respell),
                         (["Ak-mee's first week.", 'Ak-mee, Acmes!'], [('english', 'eve')] * 2))
        self.assertEqual(await self.speak('nl', 'jane', 'Acme is af.', respell), (['Acme is af.'], [('dutch', 'jane')]))
        # a word's end, a compound's last part too
        respell = {'nl': {'-poster': 'pooster', '-posters': 'poosters'}}
        self.assertEqual(await self.speak('nl', 'jane', 'Een Geboorteposter, twee posters. Impostor.', respell),
                         (['Een Geboortepooster, twee poosters.', 'Impostor.'], [('dutch', 'jane')] * 2))

    @unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
    async def test_a_german_call_speaks_german_in_the_agents_own_voice(self):
        self.assertEqual(await self.speak('de', 'bill_boerst', 'Das kostet €29,95.'),
                         (['Das kostet neunundzwanzig Euro fünfundneunzig.'], [('german', 'bill_boerst')]))

    def test_the_lines_own_words_in_german(self):
        with unittest.mock.patch.object(server, 'now_ms', lambda: NOW):
            self.assertEqual(server.cant_answer('Juno', 'limit', NOW + 600_000, 'Europe/Amsterdam', 'de'),
                             'Juno kann gerade nicht antworten: unser Claude-Abo ist bis 00:10 an seinem Limit. Was du sagst, '
                             'wird trotzdem aufgeschrieben, und Juno meldet sich nach dem Gespräch.')
            self.assertIn('bis morgen um 00:10', server.cant_answer('Juno', 'limit', NOW + 86_400_000 + 600_000, 'Europe/Amsterdam', 'de'))


def no_screen(coordinator):
    """A stand-in coordinator that has no watch-along on (screen-turn), and answers the rest as `coordinator` does."""
    return lambda method, path, body=None: {'on': False} if path == 'screen-turn' else coordinator(method, path, body)


class Juno(unittest.IsolatedAsyncioTestCase):
    """A call with Juno around the stand-ins: the board's words go in window by window."""
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_hq, server.hq = server.hq, no_screen(server.hq)
        server.CALL_LOGS, server.LIVE, server.WAIT = Path(self.tmp.name), Path(self.tmp.name), {'done': 0.01, 'open': 0.02}
        self.events, self.audio = [], []

        async def audio(x):
            self.audio.append(len(x))

        async def event(e):
            self.events.append(e)

        async def clear():
            self.events.append({'type': 'clear'})

        self.call = server.Call(audio, event, clear, 'juno', 'en')
        self.call.brain = self.brain = Brain()
        self.call.transcribe = self.transcribe
        self.call.echo = None  # (the echo tests put it back: its whole 10 ms blocks would shift these tests' windows.)
        self.words, self.level = {}, 0.6  # what each utterance says, by its loudness
        self.sounds = {}  # whether an utterance sounds finished, by its loudness, where its words don't say
        self.now_ms, server.now_ms = server.now_ms, lambda: NOW
        self.turn_end, server.turn_end = server.turn_end, NS(finished=self.finished)

    def tearDown(self):
        server.now_ms, server.turn_end, server.hq = self.now_ms, self.turn_end, self.real_hq
        self.tmp.cleanup()

    def finished(self, audio):
        """Smart Turn's stand-in: the board sounds finished after an utterance whose words end a sentence, or as the
        test says it sounds (sounds)."""
        loud = audio[np.abs(audio) > 0.5]
        level = float(loud[-1]) if len(loud) else None
        text = self.words.get(level, ('',))[0]
        return float(self.sounds.get(level, text.rstrip().endswith(('.', '?', '!'))))

    def transcribe(self, seg):
        """Each utterance's words, or as many as the audio holds of it (a look mid-sentence)."""
        said = []
        for level, (text, n) in self.words.items():
            if got := int(np.isclose(seg, level).sum()):
                words = text.split()
                said += words[:max(1, round(len(words) * got / n))] if got < n else words
        return ' '.join(said)

    def utterance(self, text, windows):
        """The board saying `text` for this many VAD windows (a footstep: ''), at a level 16-bit PCM holds exactly (the
        echo canceller works on HQ's PCM)."""
        self.level = round((self.level + 0.01) * 32768) / 32768
        self.words[self.level] = (text, windows * 512)
        return np.full(windows * 512, self.level, np.float32)

    async def talk(self, text, windows, chunk=2048):
        await self.feed(self.utterance(text, windows), chunk)

    async def quiet(self, windows, chunk=2048):
        await self.feed(np.zeros(windows * 512, np.float32), chunk)

    async def feed(self, x, chunk, played=None):
        """played: the agent's voice as HQ played it over x."""
        for i in range(0, len(x), chunk):
            await self.call.hear(x[i:i + chunk], None if played is None else played[i:i + chunk])
            if (over := self.call.over) and over.get('look'):  # (a look at the words so far takes no audio time here)
                await over['look']
            await asyncio.sleep(0)

    async def settle(self):
        """Real time for the call's own tasks: the wait before answering, the reply being written and synthesised."""
        for _ in range(300):
            await asyncio.sleep(0.01)
            if not self.call.waiting and (not self.call.turn or self.call.turn.done()):
                return
        self.fail('the call never settled')

    async def first_reply(self):
        """The board asks; Juno answers, all 6 s of it sent (and playing from now on)."""
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])
        self.assertEqual(sum(self.audio), 6 * 16000)
        self.events.clear()

    def playing(self):
        return not self.call.speaking.is_set() and {'type': 'clear'} not in self.events


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class Hold(Juno):
    """The board's words over Juno's reply."""
    async def test_a_stuck_agent_keeps_what_was_heard_and_its_restart_hears_the_call(self):
        brain = self.brain

        async def stuck(text, pictures=()):  # one sentence, then 90 s of silence (the turn timeout)
            brain.asked.append(text)
            yield "Sure, I'll check the orders now. "
            yield 'Then I'
            raise asyncio.TimeoutError()

        async def start():
            brain.started = True
        brain.ask, brain.start, brain.recap = stuck, start, ''
        await self.call.answer('Can you check the orders?', None)
        self.assertTrue(brain.started)
        self.assertEqual(self.call.lines, ['Board: Can you check the orders?',
                                           "Juno: Sure, I'll check the orders now. (cut off: the call agent stopped)",
                                           'Juno: Sorry, I lost my train of thought there. Could you say that again?'])
        # the fresh session's first message carries the call so far (Agent.ask puts brain.recap in front of it)
        self.assertIn("Board: Can you check the orders?\nJuno: Sure, I'll check the orders now. (cut off", brain.recap)
        agent = server.Agent('juno', 'en')
        agent.recap, agent.proc = 'RECAP', NS(returncode=1)
        with self.assertRaises(RuntimeError):
            await agent.ask('Hello?').__anext__()
        self.assertEqual(agent.recap, '', 'the recap goes with the first message only')

    async def test_the_agents_own_voice_in_the_microphone_lets_the_reply_play_on_and_starts_no_turn(self):
        """The browser's canceller let the reply's words back into the microphone, loud as the board (calls #91, #93):
        HQ's copy of what played beside them takes them out."""
        await self.first_reply()
        self.call.echo = server.Echo()
        self.call.echo.blocks = echo.SETTLED  # (a call under way: the canceller has settled)
        own = self.utterance('Just asking questions.', 40)
        await self.feed(own, 320, played=own)  # (HQ's 20 ms frames)
        await self.quiet(40, 320)
        await self.settle()
        self.assertTrue(self.playing())
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])
        self.assertNotIn('heard', [e['type'] for e in self.events])

    async def test_the_board_talking_over_the_agents_own_voice_still_stops_it(self):
        await self.first_reply()
        self.call.echo = server.Echo()
        self.call.echo.blocks = echo.SETTLED  # (a call under way: the canceller has settled)
        await self.quiet(50, 320)
        own = np.full(40 * 512, 0.25, np.float32)
        await self.feed(own + self.utterance("Hold on, that's not what I asked.", 40), 320, played=own)
        await self.quiet(40, 320)
        await self.settle()
        self.assertFalse(self.playing())
        self.assertEqual(self.brain.asked[1:], ["Hold on, that's not what I asked."])

    async def test_a_footstep_lets_the_reply_play_on(self):
        await self.first_reply()
        await self.quiet(40)
        await self.talk('', 8)  # a footstep the VAD took for speech: nothing in it
        await self.quiet(30)
        await self.talk('', 30)  # a longer run of noise: still no words at the looks
        await self.quiet(30)
        await self.settle()
        self.assertTrue(self.playing())
        self.assertEqual((self.call.draft, self.brain.asked, self.brain.stopped), ([], ['Can you check the orders?'], 0))

    async def test_a_sound_with_no_words_lets_the_reply_play_on_however_long_and_a_short_wait_stops_it(self):
        """A bottle put down, a knock, a pour: the VAD hears talking for 3 s, the recogniser no words (board, call #77)."""
        await self.first_reply()
        await self.quiet(50)
        await self.talk('', 90)
        await self.quiet(30)
        await self.settle()
        self.assertTrue(self.playing())
        self.assertEqual((self.call.draft, self.brain.asked, self.brain.stopped), ([], ['Can you check the orders?'], 0))
        await self.talk('Wait.', 12)
        await self.quiet(30)
        await self.settle()
        self.assertFalse(self.playing())
        self.assertEqual(self.brain.asked[1:], ['Wait.'])

    async def test_a_sound_with_no_words_while_the_agent_thinks_takes_nothing_back_and_an_um_does(self):
        self.brain.thinking = asyncio.Event()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        for _ in range(100):  # (until the agent is asked)
            if self.brain.asked:
                break
            await asyncio.sleep(0.01)
        await self.talk('', 20)
        await self.quiet(30)
        self.brain.thinking.set()
        await self.settle()
        self.assertEqual((self.brain.asked, self.brain.stopped), (['Can you check the orders?'], 0))
        self.assertEqual(self.call.lines, ['Board: Can you check the orders?', f'Juno: {REPLY}'])
        await self.quiet(250)
        self.brain.thinking.clear()
        await self.talk('Check the invoices.', 30)
        await self.quiet(20)
        for _ in range(100):
            if len(self.brain.asked) == 2:
                break
            await asyncio.sleep(0.01)
        await self.talk('Um.', 12)  # (a hesitation is speech: the board isn't finished)
        await self.quiet(20)
        self.brain.thinking.set()
        await self.settle()
        # (taken back, and the "um" isn't written down: #6350.)
        self.assertTrue(self.brain.asked[2].startswith("(I wasn't finished") and self.brain.asked[2].endswith(') Check the invoices.'))

    async def test_okay_lets_the_reply_play_on_and_starts_no_turn(self):
        await self.first_reply()
        await self.quiet(40)
        await self.talk('Okay.', 20)
        await self.quiet(30)  # (the recogniser's pause: the fragment is let go here)
        await self.settle()
        self.assertTrue(self.playing())
        self.assertEqual(self.call.draft, [])
        await self.quiet(200)  # past the end of the reply: still nothing to answer
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])
        self.assertNotIn('Okay', str(self.events) + str(self.call.lines))

    async def test_okay_then_more_is_one_message_that_interrupts(self):
        await self.first_reply()
        await self.quiet(50)  # 1.6 s into the reply: past the take-back
        await self.talk('Okay.', 20)
        await self.quiet(15)  # let go...
        self.assertTrue(self.playing())
        await self.talk('So what about the invoices?', 40)  # ...and counted back in: the board is talking
        self.assertFalse(self.playing())  # stopped at a look, before the board finished
        await self.quiet(30)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?', 'Okay. So what about the invoices?'])
        self.assertEqual([x.split(':')[0] for x in self.call.lines], ['Board', 'Juno', 'Board', 'Juno'])
        self.assertEqual(self.call.lines[2], 'Board: Okay. So what about the invoices?')

    async def test_a_real_sentence_stops_it_as_before(self):
        await self.first_reply()
        await self.quiet(50)
        await self.talk("Hold on, that's not what I asked.", 24)
        self.assertFalse(self.playing())  # stopped while the board was still talking
        self.assertEqual(self.events[:2], [{'type': 'clear'}, {'type': 'state', 'state': 'listening'}])
        await self.quiet(30)
        await self.settle()
        self.assertEqual(self.brain.asked[1:], ["Hold on, that's not what I asked."])

    async def test_two_words_heard_twice_stop_it_while_the_board_talks(self):
        await self.first_reply()
        await self.quiet(50)
        # (32 windows, the first look at 8)
        await self.talk('Hold on.', 32)  # looks hear "Hold", "Hold", "Hold on.", "Hold on.": a mishearing wouldn't repeat
        self.assertFalse(self.playing())

    async def test_a_short_stop_stops_it_when_the_board_pauses(self):
        await self.first_reply()
        await self.quiet(50)
        await self.talk('Wait, stop.', 6)  # shorter than a look
        self.assertTrue(self.playing())
        await self.quiet(30)
        await self.settle()
        self.assertFalse(self.playing())
        self.assertEqual(self.brain.asked[1:], ['Wait, stop.'])

    async def test_a_yes_after_the_reply_that_replaced_a_cut_one_is_answered(self):
        """The cut reply's unplayed audio doesn't count: once the new reply has played, a "Yes." is a message."""
        await self.first_reply()
        await self.quiet(50)
        await self.talk("Hold on, that's not what I asked.", 24)
        await self.quiet(30)
        await self.settle()
        await self.quiet(200)  # the new reply (6 s) has played out
        await self.talk('Yes.', 15)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked[1:], ["Hold on, that's not what I asked.", 'Yes.'])
        self.assertIn('Board: Yes.', self.call.lines)

    async def test_a_yes_over_the_end_of_the_reply_is_answered(self):
        """Started over the reply's last moments, but the reply has played out by the time the board stops: an answer."""
        await self.first_reply()
        await self.quiet(170)  # 5.4 s of the reply's 6 s
        await self.talk('Yes.', 22)  # held while the reply plays; it ends 0.1 s before the board does
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked[1:], ['Yes.'])
        self.assertIn('Board: Yes.', self.call.lines)
        self.assertEqual(self.brain.stopped, 0)

    async def test_okay_then_more_after_a_short_reply_has_played_is_a_turn(self):
        """An "Okay." let go over the start of a short reply, then more once it has played out: the reply was heard."""
        self.brain.reply = 'Sure.'  # (2 s)
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.settle()
        await self.quiet(25)
        await self.talk('Okay.', 20)  # let go: the reply still plays
        await self.quiet(20)  # it has played out
        await self.talk('So what about the invoices?', 40)  # carried on within AGAIN of the "Okay."
        await self.quiet(30)
        await self.settle()
        self.assertEqual(self.brain.asked[1:], ['Okay. So what about the invoices?'])
        self.assertEqual(self.brain.stopped, 0)
        self.assertEqual(self.call.lines[:3], ['Board: Can you check the orders?', 'Juno: Sure.',
                                               'Board: Okay. So what about the invoices?'])

    async def test_a_yes_after_a_reconnect_is_answered(self):
        """HQ reconnects and drops the reply's queued audio: a "Yes." into the silence is a message, not held."""
        await self.first_reply()
        await self.quiet(40)
        self.call.reconnected()  # (what app_call's resume does)
        await self.talk('Yes.', 15)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked[1:], ['Yes.'])
        self.assertIn('Board: Yes.', self.call.lines)

    async def test_a_short_answer_over_the_reply_is_let_go(self):
        """The accepted cost: "Yes, please." while the reply still plays passes like an "okay"."""
        await self.first_reply()
        await self.quiet(50)
        await self.talk('Yes, please.', 20)
        await self.quiet(30)
        await self.settle()
        self.assertTrue(self.playing())
        self.assertEqual((self.call.draft, self.brain.asked[1:]), ([], []))

    async def test_a_word_more_while_the_agent_thinks_takes_the_reply_back(self):
        """Nothing heard of the reply yet: no hold, a short add-on joins the message as before."""
        self.brain.thinking = asyncio.Event()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        for _ in range(100):  # (until the agent is asked)
            if self.brain.asked:
                break
            await asyncio.sleep(0.01)
        await self.talk('tonight.', 15)
        await self.quiet(20)
        self.brain.thinking.set()
        await self.settle()
        self.assertEqual(self.brain.asked[1], "(I wasn't finished, and I didn't hear your reply to the first part: answer my "
                                              "whole message instead.) Can you check the orders? tonight.")
        self.assertEqual(self.call.lines[0], 'Board: Can you check the orders? tonight.')

    async def test_carrying_on_over_the_reply_takes_it_back(self):
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.settle()  # the reply has just been heard: the board carries on at once
        await self.talk('and the invoices from last week', 30)
        self.assertFalse(self.playing())
        await self.quiet(30)
        await self.settle()
        self.assertEqual(self.brain.asked[1], "(I wasn't finished, and I didn't hear your reply to the first part: answer my "
                                              "whole message instead.) Can you check the orders? and the invoices from last week")
        self.assertEqual(self.call.lines[:1], ['Board: Can you check the orders? and the invoices from last week'])
        self.assertEqual(len(self.call.lines), 2)  # (the reply taken back is gone; the one to the whole message is there)

    async def test_each_line_has_when_it_was_said_and_a_message_taken_back_keeps_its_start(self):
        """The board's words carry when they began (taken back and said again with more: when they first began), the
        agent's reply when it started being heard, and the file on disk has them beside the lines, one each."""
        server.now_ms = lambda: NOW + CLOCK[0] * 1000  # (the wall clock moves with the line's)
        began = server.now_ms()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.settle()  # (its reply is heard, then taken back)
        more = server.now_ms()
        await self.talk('and the invoices from last week', 30)
        await self.quiet(30)
        await self.settle()
        self.assertEqual(len(self.call.lines), 2)
        board, reply = self.call.times
        self.assertLess(abs(board - began), 500)  # (the stand-in VAD ends a segment sooner than PAUSE: a little before)
        self.assertGreater(reply, more + 30 * 32)  # (heard once the words that took the first one back were over)
        on_disk = json.loads(self.call.file.read_text())
        self.assertEqual((on_disk['lines'], on_disk['times']), (self.call.lines, self.call.times))

    async def test_a_long_message_taken_back_at_every_pause_is_on_disk_for_a_restart(self):
        """The board talks on, each pause sends the message so far and its next words take it back, so nothing is ever
        answered; then the line restarts. What it hands over at its start has every word."""
        brain, stop = self.brain, asyncio.Event()

        async def thinking(text, pictures=()):  # (the agent never gets to its first word: each turn is stopped first)
            brain.asked.append(text)
            yield server.DELIVERED
            await stop.wait()
            stop.clear()
        brain.ask, brain.interrupt = thinking, stop.set
        said = ['First, the shop.', 'Then the invoices,', 'and the ad for next week.']
        for words in said:
            await self.talk(words, 30)
            await self.quiet(60)  # long enough to be sent
            await asyncio.sleep(0.05)
        await self.talk('Last, the call screen', 30)  # still talking when the line goes
        await self.quiet(20)
        self.assertGreaterEqual(len(self.brain.asked), 3)
        self.assertEqual(json.loads(self.call.file.read_text())['lines'],
                         ['Board: First, the shop. Then the invoices, and the ad for next week. Last, the call screen'])
        stop.set()

    async def test_a_call_is_live_from_its_start_to_its_end(self):
        live, self.brain.start = Path(server.LIVE, self.call.file.stem), lambda: asyncio.sleep(0)
        await self.call.start()
        self.assertTrue(live.exists(), 'a deploy waits for this call')
        await asyncio.to_thread(self.call.end)
        self.assertFalse(live.exists())

    async def test_take_back_counts_from_when_the_board_started(self):
        """Filler first, so the words only read as an interruption 1.7 s in: it started within TAKE_BACK, so the reply goes
        back."""
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.settle()
        await self.quiet(10)
        await self.talk('uh um so and the invoices from last week', 60)
        self.assertFalse(self.playing())
        await self.quiet(30)
        await self.settle()
        self.assertTrue(self.brain.asked[1].startswith("(I wasn't finished") and self.brain.asked[1].endswith('last week'))
        self.assertEqual([x.split(':')[0] for x in self.call.lines], ['Board', 'Juno'])

    async def test_normal_turns_are_unchanged(self):
        await self.talk('Okay.', 20)  # nothing playing: a word is a message
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Okay.'])
        await self.quiet(250)  # the reply has played out, and more
        self.events.clear()
        await self.talk('Yes.', 15)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Okay.', 'Yes.'])
        self.assertNotIn({'type': 'clear'}, self.events)
        await self.quiet(250)
        server.WAIT = {'done': 0.2, 'open': 0.5}  # a pause mid-sentence, then the rest: one message
        await self.talk('Check the orders and', 20, chunk=320)  # (the phone line's 20 ms pieces)
        await self.quiet(16, chunk=320)
        await self.talk('the invoices.', 20, chunk=320)
        await self.quiet(20, chunk=320)
        await self.settle()
        self.assertEqual(self.brain.asked[2:], ['Check the orders and the invoices.'])

    async def test_a_full_stop_mid_thought_waits_for_the_rest(self):
        """The recogniser writes a full stop at almost every pause: the line goes by how the board sounds, so a pause
        mid-thought waits for the rest, which is answered as one message with nothing taken back."""
        server.WAIT = {'done': 0.01, 'open': 60}
        await self.talk('So I was thinking.', 20)
        self.sounds[self.level] = False  # (the voice trails off)
        await self.quiet(30)
        await asyncio.sleep(0.1)
        self.assertEqual(self.brain.asked, [])
        await self.talk('Can you check the orders?', 20)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['So I was thinking. Can you check the orders?'])
        self.assertEqual(self.brain.stopped, 0)
        self.assertEqual(self.call.paused(), "call: juno line: the board's pauses: 1 of 2 sounded finished")

    async def test_a_finished_turn_is_answered_at_once_without_a_full_stop(self):
        server.WAIT = {'done': 0.01, 'open': 60}
        await self.talk('check the orders', 20)
        self.sounds[self.level] = True
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['check the orders'])

    async def test_the_wait_before_answering_counts_from_the_end_of_the_words(self):
        """The transcription's time is part of the wait, not added to it."""
        server.WAIT = {'done': 0.4, 'open': 0.4}
        heard = self.transcribe
        # (0.4 s on the line's clock)
        self.call.transcribe = lambda seg: CLOCK.__setitem__(0, CLOCK[0] + 0.4) or heard(seg)
        await self.talk('Can you check the orders?', 20)
        await self.quiet(20)
        await asyncio.sleep(0.15)
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])

    async def test_an_um_holds_the_floor_and_is_not_written_down(self):
        server.WAIT = {'done': 0.01, 'open': 60}  # (an open end waits for the rest)
        await self.talk('Uh, can you check the, um', 20)
        await self.quiet(30)
        await asyncio.sleep(0.1)
        self.assertEqual(self.brain.asked, [])  # "um" at the end: the board isn't finished
        await self.talk('uh uh orders?', 20)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])
        self.assertEqual(self.call.lines[0], 'Board: Can you check the orders?')
        self.assertEqual([e['text'] for e in self.events if e['type'] == 'heard'],
                         ['Can you check the', 'Can you check the orders?', 'Can you check the orders?'])

    async def asked(self):
        for _ in range(100):  # (until the agent is asked and the line has said what it says before the tool answers)
            if self.brain.asked and self.audio:
                return await asyncio.sleep(0.05)
            await asyncio.sleep(0.01)
        self.fail('the agent was never asked')

    def ticks(self):
        return self.audio.count(len(server.tick()))

    def thoughts(self):
        return self.audio.count(len(server.thinking()))

    async def hushed(self, quiet=20):
        """After quiet windows of quiet, the rest of the board's HUSH (its VAD quiet starts PAUSE s after the words):
        the line's hold sounds can play now."""
        await self.quiet(round((server.HUSH - server.PAUSE) / server.WINDOW) + 1 - quiet)
        await self.asked()

    async def test_a_tool_step_before_any_words_ticks_until_the_words_come(self):
        """The agent writes a job's brief before it says a word. The line plays a soft tick once the board has been
        quiet for HUSH s, and whenever it's been quiet for 2 s after that, until the agent's words come; it says nothing
        of its own."""
        tool = asyncio.Event()
        self.brain.reply = [server.Step('mcp__hq__job'), tool, "I've queued it for Bolt as job #12. ", 'He starts soon.']
        await self.talk('Give Bolt the phone logs.', 30)
        await self.quiet(20)
        await asyncio.sleep(0.3)
        self.assertEqual((self.brain.asked, self.audio), (['Give Bolt the phone logs.'], []))  # (asked, the board just quiet)
        await self.hushed()
        await asyncio.sleep(0.3)
        self.assertEqual((self.ticks(), len(self.audio)), (1, 1))  # (the line had been quiet: a tick at once)
        self.assertEqual([e['type'] for e in self.events if e['type'] in ('said', 'tick')], ['tick'])
        await self.quiet(60)  # the tick and 1.6 s of quiet after it: nothing more yet
        await asyncio.sleep(0.3)
        self.assertEqual(self.ticks(), 1)
        await self.quiet(20)  # 2 s of quiet after it: a tick
        await asyncio.sleep(0.3)
        self.assertEqual(self.ticks(), 2)
        tool.set()  # the job tool answers, and the words come
        await self.settle()
        await self.quiet(200)
        await asyncio.sleep(0.3)
        self.assertEqual(self.ticks(), 2, 'no tick once the agent speaks')
        self.assertEqual(sum(self.audio), 2 * len(server.tick()) + 4 * 16000)  # (the stand-in synthesis: 2 s a sentence)
        self.assertEqual([e['text'] for e in self.events if e['type'] == 'said'],  # (as written)
                         ["I've queued it for Bolt as job #12.", 'He starts soon.'])
        self.assertEqual(self.call.lines, ['Board: Give Bolt the phone logs.',
                                           "Juno: I've queued it for Bolt as job #12. He starts soon."])
        self.assertEqual(self.brain.stopped, 0)

    async def test_the_wait_for_the_first_words_has_its_own_sound_and_a_word_more_over_it_still_takes_the_reply_back(self):
        """The model takes 2 s and more to its first words: once the board has been quiet for HUSH s, the line plays
        its thinking sound (not the tool step's tick), and whenever it's been quiet for 2 s after that. That sound isn't
        the reply being heard: the board carrying on over it, even well after it, wasn't finished."""
        self.brain.thinking = asyncio.Event()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.hushed()
        self.assertEqual((self.thoughts(), self.ticks(), len(self.audio)), (1, 0, 1))
        await self.quiet(65)  # the sound and 1.6 s of quiet after it: nothing more yet
        await asyncio.sleep(0.3)
        self.assertEqual(self.thoughts(), 1)
        await self.quiet(20)
        await asyncio.sleep(0.3)
        self.assertEqual(self.thoughts(), 2)
        await self.quiet(45)  # (past TAKE_BACK after the sound)
        await self.talk('tonight.', 15)
        await self.quiet(20)
        self.brain.thinking.set()
        await self.settle()
        self.assertEqual(self.brain.asked[1], "(I wasn't finished, and I didn't hear your reply to the first part: answer my "
                                              "whole message instead.) Can you check the orders? tonight.")
        self.assertEqual(self.call.lines, ['Board: Can you check the orders? tonight.', f'Juno: {REPLY}'])

    async def test_a_pause_mid_sentence_plays_no_sound_over_the_board(self):
        """The line asks the model after a short pause, but the board carries on: no sound in that pause, and the reply
        is taken back unheard."""
        self.brain.thinking = asyncio.Event()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(25)  # (0.8 s, and the VAD's pause before it: 1.25 s since the words)
        await asyncio.sleep(0.3)
        self.assertEqual((self.brain.asked, self.audio), (['Can you check the orders?'], []))
        await self.talk('And the invoices from last week.', 40)
        await asyncio.sleep(0.3)
        self.assertEqual(self.audio, [])
        await self.quiet(20)
        self.brain.thinking.set()
        await self.settle()
        self.assertEqual(self.brain.asked[1], "(I wasn't finished, and I didn't hear your reply to the first part: answer my "
                                              "whole message instead.) Can you check the orders? And the invoices from "
                                              "last week.")
        self.assertEqual(self.ticks() + self.thoughts(), 0)

    async def test_no_hold_sound_while_the_board_makes_one(self):
        """A sound with no words takes no reply back, and it isn't quiet either: the thinking sound waits for HUSH s of
        quiet after it."""
        self.brain.thinking = asyncio.Event()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await asyncio.sleep(0.3)
        await self.talk('', 80)  # (a long rustle, 2.6 s)
        await asyncio.sleep(0.3)
        self.assertEqual(self.audio, [])
        await self.quiet(30)  # (1.4 s since it, the VAD's pause included)
        await asyncio.sleep(0.3)
        self.assertEqual(self.audio, [])
        await self.hushed(30)
        self.assertEqual((self.thoughts(), len(self.audio)), (1, 1))
        self.brain.thinking.set()
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])

    async def test_words_before_a_tool_step_are_said_at_once_and_the_tick_waits_for_their_end(self):
        tool = asyncio.Event()
        self.brain.reply = ['One moment', server.Step('mcp__hq__search'), tool, 'It says a warmer world.']
        await self.talk('What is our mission?', 30)
        await self.quiet(20)
        await self.asked()
        self.assertEqual([e['text'] for e in self.events if e['type'] == 'said'], ['One moment'])  # (no full stop: said at the step)
        await self.quiet(110)  # the words play for 2 s, then 1.5 s of quiet: no tick yet
        await asyncio.sleep(0.3)
        self.assertEqual(self.ticks(), 0)
        await self.quiet(20)
        await asyncio.sleep(0.3)
        self.assertEqual(self.ticks(), 1)
        tool.set()
        await self.settle()
        self.assertEqual(self.call.lines[1], 'Juno: One moment It says a warmer world.')

    async def test_euro_amounts_are_spoken_as_words_and_shown_as_written(self):
        for lang, spoken in (('en', ['A mug is twenty-nine euros ninety-five.', 'The extra one is four euros off.']),
                             ('nl', ['A mug is negenentwintig euro vijfennegentig.', 'The extra one is vier euro off.'])):
            self.call.lang, self.events[:] = lang, []
            self.brain.reply = ['A mug is €29.', '95. The extra', ' one is €4 off.']  # (the stream cut "€29.95" in two)
            await self.call.answer('What does it cost?', None)
            del SPOKEN[:-2]
            self.assertEqual(SPOKEN, spoken)
            self.assertEqual([e['text'] for e in self.events if e['type'] == 'said'],
                             ['A mug is €29.95.', 'The extra one is €4 off.'])
            self.assertEqual(self.call.lines[-1], 'Juno: A mug is €29.95. The extra one is €4 off.')

    async def test_no_hold_line_of_the_lines_own_in_either_language(self):
        self.call.lang, tool = 'nl', asyncio.Event()
        self.brain.reply = [server.Step('mcp__hq__search'), server.Step('Read'), tool, 'Gevonden.']
        await self.talk('Wat is onze missie?', 30)
        await self.quiet(20)
        await self.hushed()
        tool.set()
        await self.settle()
        self.assertEqual([e['text'] for e in self.events if e['type'] == 'said'], ['Gevonden.'])
        self.assertEqual(self.ticks(), 1)
        self.assertEqual(self.call.lines[1], 'Juno: Gevonden.')

    async def test_an_okay_over_the_tick_lets_the_tool_step_carry_on(self):
        """Before the line held a step, an "okay?" into 10 s of silence took the reply back and stopped the agent
        mid-job. A tick is the reply being heard: a lone word over it is let go, as over the agent's words."""
        tool = asyncio.Event()
        self.brain.reply = [server.Step('mcp__hq__job'), tool, "I've queued it as job #12."]
        await self.talk('Give Bolt the phone logs.', 30)
        await self.quiet(20)
        await self.hushed()
        await self.quiet(50)
        await self.talk('Okay.', 20)
        await self.quiet(30)
        tool.set()
        await self.settle()
        self.assertEqual((self.brain.stopped, self.brain.asked, self.call.draft), (0, ['Give Bolt the phone logs.'], []))
        self.assertEqual(self.call.lines[1], "Juno: I've queued it as job #12.")

    async def test_after_skip_a_word_is_a_message(self):
        await self.first_reply()
        await self.quiet(20)
        okay = self.utterance('Okay.', 20)
        await self.feed(okay[:6 * 512], 2048)  # the board starts talking over the reply, and taps Skip
        await self.call.interrupt()  # (app_call on {'type': 'interrupt'})
        self.assertFalse(self.playing())
        await self.feed(okay[6 * 512:], 2048)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked[1:], ['Okay.'])


    async def test_a_seat_at_its_limit_is_said_by_the_line_itself_never_silence(self):
        """Every turn ends in the CLI's limit result: the board never hears silence. The line says why, in its
        own fixed words, on the company's clock; the call screen shows it; the transcript notes it; again, shorter."""
        until = 1909174200000  # 2030-07-01 22:10 UTC: 00:10 in Amsterdam
        self.brain.reply = [server.Unanswered('limit', until)]
        await self.talk('I did my long rant. Are you there?', 30)
        await self.quiet(20)
        await self.settle()
        first = ("Juno can't answer right now: our Claude seat is at its limit until 00:10. What you say is still written "
                 "down, and Juno follows up after the call.")
        self.assertIn({'type': 'notice', 'text': first}, self.events)
        self.assertIn({'type': 'said', 'text': first}, self.events)
        self.assertEqual(sum(self.audio), 2 * 16000, 'the board hears it (one sentence of the stand-in voice)')
        self.assertEqual(self.call.lines, ['Board: I did my long rant. Are you there?', f'(The line, not Juno: {first})'])
        self.events.clear()
        await self.talk('Hello?', 20)
        await self.quiet(20)
        await self.settle()
        again = "Juno still can't answer: our Claude seat is at its limit until 00:10. What you say is written down."
        self.assertIn({'type': 'notice', 'text': again}, self.events)
        self.events.clear()
        self.brain.reply = 'Sorry, I am back now.'  # the seat reset: a reply gets through, and the notice goes
        await self.talk('And now?', 20)
        await self.quiet(20)
        await self.settle()
        self.assertIn({'type': 'notice', 'text': ''}, self.events)
        self.assertEqual(self.call.lines[-1], 'Juno: Sorry, I am back now.')
        self.assertIsNone(self.call.noticed)

    async def test_signed_out_or_any_other_error_is_said_too_in_dutch_on_a_dutch_call(self):
        self.call.lang = 'nl'
        self.brain.reply = [server.Unanswered('signin')]
        await self.call.answer('Hoor je me?', None)
        self.assertEqual(self.call.lines[-1], '(The line, not Juno: Juno kan nu niet antwoorden: ons Claude-abonnement is uitgelogd. '
                                              'Wat je zegt wordt wel opgeschreven, en Juno komt er na het gesprek op terug.)')
        self.call.lang = 'en'
        self.brain.reply = [server.Unanswered('error')]
        await self.call.answer('Hello?', None)
        self.assertEqual(self.call.lines[-1], "(The line, not Juno: Juno can't answer right now: the call agent ran into an error. "
                                              "What you say is still written down, and Juno follows up after the call.)")
        self.assertEqual(server.cant_answer('Juno', 'limit'), "Juno can't answer right now: our Claude seat is at its limit. "
                                                               "What you say is still written down, and Juno follows up after the call.")
        self.assertIn('until 22:10 UTC', server.cant_answer('Juno', 'limit', 1909174200000, 'Not/AZone'))  # (no clock: UTC, said so)

    def test_a_reset_on_another_day_says_the_day_in_either_language(self):
        hour, day = 3600_000, 24 * 3600_000
        self.assertEqual(server.clock(NOW + 10 * 60_000, 'Europe/Amsterdam'), '00:10')
        self.assertEqual(server.clock(NOW + day + hour, 'Europe/Amsterdam'), '01:00 tomorrow')
        self.assertEqual(server.clock(NOW + day + hour, 'Europe/Amsterdam', 'nl'), 'morgen om 01:00')
        self.assertEqual(server.clock(NOW + 4 * day + hour, 'Europe/Amsterdam'), 'Saturday at 01:00')  # (Tuesday 2 July now)
        self.assertEqual(server.clock(NOW + 4 * day + hour, 'Europe/Amsterdam', 'nl'), 'zaterdag om 01:00')
        self.assertEqual(server.clock(NOW + 7 * day + hour, 'Europe/Amsterdam'), '9 July at 01:00')
        self.assertEqual(server.clock(NOW + 7 * day + hour, 'Europe/Amsterdam', 'nl'), '9 juli om 01:00')
        self.assertEqual(server.clock(NOW + 3 * hour, 'Not/AZone'), '01:00 UTC tomorrow')  # (in UTC it's still 1 July)
        self.assertEqual(server.cant_answer('Juno', 'limit', NOW + 4 * day + hour, 'Europe/Amsterdam', 'nl'),
                         'Juno kan nu niet antwoorden: ons Claude-abonnement zit tot zaterdag om 01:00 aan zijn limiet. '
                         'Wat je zegt wordt wel opgeschreven, en Juno komt er na het gesprek op terug.')

    async def test_a_short_reply_after_a_notice_clears_it_too(self):
        """A reply without a sentence's end is said from what's left at the end of the turn: it got through all the same."""
        self.brain.reply = [server.Unanswered('limit')]
        await self.call.answer('Are you there?', None)
        self.assertEqual(self.call.noticed, 'limit')
        self.events.clear()
        self.brain.reply = ['Yes']
        await self.call.answer('Can you hear me?', None)
        self.assertEqual(self.call.lines[-1], 'Juno: Yes')
        self.assertIn({'type': 'notice', 'text': ''}, self.events)
        self.assertIsNone(self.call.noticed)

    async def test_words_said_before_the_error_stay_in_the_transcript_and_the_line_says_the_rest(self):
        self.brain.reply = ['Sure, ', "I'll check. ", server.Unanswered('error')]
        await self.call.answer('Can you check the orders?', None)
        self.assertEqual(self.call.lines[1:], ["Juno: Sure, I'll check. (cut off)", "(The line, not Juno: Juno can't answer right now: "
                                               "the call agent ran into an error. What you say is still written down, and Juno follows up after the call.)"])

    async def test_an_agent_that_wont_start_again_is_said_too(self):
        brain = self.brain

        async def gone(text, pictures=()):
            brain.asked.append(text)
            raise RuntimeError('the call agent is gone (exit 1)')
            yield  # noqa (an async generator)

        async def start():
            raise OSError('the coordinator is down')
        brain.ask, brain.start = gone, start
        await self.call.answer('Hello?', None)
        self.assertEqual(self.call.lines[-1], "(The line, not Juno: Juno can't answer right now: the call agent ran into an error. "
                                              "What you say is still written down, and Juno follows up after the call.)")
        self.assertTrue(self.audio, 'the board hears it')


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class Late(Juno):
    """The board's audio reaching the line late on a weak connection, as HQ's pings tell it."""
    def ping(self, late_ms=0):
        """HQ's ping beside the frames, sent late_ms before the line reads it (HQ's clock: the test's, as monotonic)."""
        self.call.pinged(CLOCK[0] * 1000 - late_ms)

    async def test_words_that_come_late_wait_for_the_rest_and_go_as_one_message(self):
        """What the board said comes 20 s late, in a burst: the line answers once it has caught up, all of it at once,
        never its first part as if just said (then taken back by the rest)."""
        self.ping()  # (on time: the baseline)
        await self.quiet(10)
        self.ping(20000)  # (what follows was said 20 s ago)
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await asyncio.sleep(0.2)
        self.assertEqual(self.brain.asked, [])
        await self.talk('And the invoices.', 30)
        self.ping(300)  # (caught up)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders? And the invoices.'])
        self.assertEqual(self.call.lateness(),
                         "call: juno line: the board's audio came up to 20.0 s late; "
                         '1 answer waited for it to catch up')

    async def test_an_uplink_that_never_catches_up_is_answered_once_the_quiet_after_the_words_is_in(self):
        """The quiet after the words still comes 20 s late: the line answers once 20 s of it has come, not never."""
        self.ping()
        await self.quiet(10)
        self.ping(20000)
        await self.talk('Can you check the orders?', 30)
        for i in range(44):  # (22.5 s of quiet, each half second with its ping, still 20 s late)
            await self.quiet(16)
            self.ping(20000)
            await asyncio.sleep(0.02)
            if i == 20:
                self.assertEqual(self.brain.asked, [], 'answered before the quiet after the words was in')
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])

    async def test_pings_that_stop_coming_hold_the_answer_until_they_come_again(self):
        self.ping()
        await self.talk('Can you check the orders?', 30)
        await self.quiet(1)
        CLOCK[0] += 2  # (2 s with nothing coming: the frames after these are on their way)
        await asyncio.sleep(0.2)
        self.assertEqual(self.brain.asked, [])
        self.ping()
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])

    async def test_pings_on_time_change_nothing(self):
        self.ping(80)
        await self.talk('Can you check the orders?', 30)
        self.ping(120)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])
        self.assertEqual(self.call.lateness(), "call: juno line: the board's audio came up to 0.0 s late")

    async def test_the_line_s_wall_clock_set_mid_call_holds_nothing(self):
        """Lateness is HQ's monotonic clock against the line's: a wall clock stepping 3 s (a time sync) is no late
        audio."""
        self.ping()
        await self.quiet(10)
        with unittest.mock.patch.object(server.time, 'time', lambda: NOW / 1000 + 3):
            self.ping()
            await self.talk('Can you check the orders?', 30)
            self.ping()
            await self.quiet(20)
            await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders?'])

    async def test_audio_sent_again_after_a_reconnect_waits_like_a_late_burst(self):
        """HQ reconnected and sends first what the line never had, with pings from when it was said: the baseline stays
        across connections, so it reads as late, and the line answers all of it at once, never its first part as if just
        said."""
        self.ping()
        await self.quiet(10)
        CLOCK[0] += 3  # (the connection drops; HQ is back 3 s later)
        self.call.reconnected()
        self.ping(20000)  # (sent again: said 20 s ago)
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await asyncio.sleep(0.2)
        self.assertEqual(self.brain.asked, [])
        await self.talk('And the invoices.', 30)
        self.ping(300)  # (the live audio after it: caught up)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Can you check the orders? And the invoices.'])

    async def test_a_resumed_connection_hears_how_much_of_the_board_the_line_has(self):
        """The call and each pong say how many of the board's samples the line has (HQ sends the rest again), and a
        frame the old connection reads after the call moved isn't heard twice."""
        frame, ping = np.zeros(server.FRAME, '<i2').tobytes(), json.dumps({'type': 'ping', 't': CLOCK[0] * 1000})
        self.call.live_at = 1.0  # (live before the drop: app_call set it then)
        server.CALLS['c1'] = {'call': self.call, 'line': server.Line(Socket([])), 'timer': None}
        go, read = asyncio.Event(), asyncio.Event()

        class Dropping(Socket):  # (the old connection: its last frame read only once the new one has the call)
            async def __anext__(self):
                if len(self.received) == 1:
                    read.set()
                    await go.wait()
                return await super().__anext__()

        old, new = Dropping([json.dumps({'resume': 'c1'}), frame, frame, frame]), Socket([json.dumps({'resume': 'c1'}), ping])
        try:
            dropping = asyncio.create_task(server.app_call(old))
            await read.wait()
            await server.app_call(new)
            go.set()
            await dropping
        finally:
            if timer := server.CALLS.pop('c1')['timer']:
                timer.cancel()
        self.assertEqual([json.loads(m)['heard'] for m in old.sent if json.loads(m)['type'] == 'call'], [0])
        self.assertEqual([(e['type'], e['heard']) for e in map(json.loads, new.sent) if e['type'] in ('call', 'pong')],
                         [('call', 2 * server.FRAME), ('pong', 2 * server.FRAME)])
        self.assertEqual(self.call.got, 2 * server.FRAME, 'the old connection\'s last frame comes again on the new one')


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class HangUp(Juno):
    """The agent ends the call with hang_up once the board has said goodbye: the line hangs up after the
    goodbye has played and 1.5 s of quiet, unless the board speaks first."""
    async def goodbye(self):
        """The board says goodbye; Juno says hers (2 s, playing from now on) and hangs up."""
        self.hung = []

        async def hang_up():
            self.hung.append(CLOCK[0])
        self.call.hang_up = hang_up
        self.brain.reply = ['Bye for now, enjoy your workout! ', server.Step(server.HANG_UP_TOOL)]
        await self.talk("That's all for today. Bye!", 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(sum(self.audio), 2 * 16000)
        self.brain.reply = REPLY  # (anything said after it is answered as usual)

    async def wait(self, windows):
        await self.quiet(windows)
        await asyncio.sleep(0.3)  # (the line looks every 0.1 s)

    async def tone(self):
        """The hang-up tone plays (in real time: the board's side plays it), then the line hangs up."""
        await asyncio.sleep(len(server.hang_up_tone()) / server.RATE + server.TONE_TAIL_SECONDS)

    async def test_the_line_hangs_up_once_the_goodbye_has_played_and_it_has_been_quiet(self):
        await self.goodbye()
        await self.wait(100)  # the goodbye played (2 s) and 1.2 s since: not yet
        self.assertEqual(self.hung, [])
        self.assertEqual(sum(self.audio), 2 * 16000)
        await self.wait(20)
        self.assertEqual(self.audio[-1], len(server.hang_up_tone()), 'the hang-up tone')
        self.assertEqual(self.events[-1], {'type': 'tick'})  # (HQ counts it as a start of its own, as the tick's)
        self.assertEqual(self.hung, [], 'not over the tone')
        await self.tone()
        self.assertEqual(len(self.hung), 1)
        lines = ["Board: That's all for today. Bye!", 'Juno: Bye for now, enjoy your workout!', '(Juno ended the call.)']
        self.assertEqual(self.call.lines, lines)
        self.assertEqual(json.loads(self.call.file.read_text())['lines'], lines)  # (on disk for the hand-over)
        await self.wait(200)
        self.assertEqual(len(self.hung), 1, 'once')

    async def test_without_hang_up_the_call_stays_open(self):
        self.call.hang_up = lambda: self.fail('hung up')
        await self.first_reply()
        await self.wait(400)
        self.assertIsNone(self.call.leaving)

    async def test_the_board_speaking_after_the_goodbye_keeps_the_call_open_and_is_answered(self):
        await self.goodbye()
        await self.wait(70)  # the goodbye has played
        await self.talk('Oh, one more thing.', 30)
        await self.quiet(20)
        await self.settle()
        await self.wait(300)
        self.assertEqual(self.hung, [])
        self.assertEqual(self.brain.asked[-1], 'Oh, one more thing.')
        self.assertNotIn('(Juno ended the call.)', self.call.lines)

    async def test_talking_over_the_goodbye_keeps_the_call_open(self):
        await self.goodbye()
        await self.quiet(10)
        await self.talk('Wait, I forgot something.', 30)  # (an interruption: the goodbye stops)
        await self.quiet(20)
        await self.settle()
        await self.wait(300)
        self.assertEqual(self.hung, [])
        self.assertTrue(self.brain.asked[-1].endswith('Wait, I forgot something.'))  # (with what it took back)

    async def test_interrupt_keeps_the_call_open(self):
        await self.goodbye()
        await self.quiet(10)
        await self.call.interrupt()  # (HQ's Interrupt button)
        await self.wait(300)
        self.assertEqual(self.hung, [])

    async def test_interrupt_over_the_tone_keeps_the_call_open(self):
        await self.goodbye()
        await self.wait(120)  # the tone is out
        self.assertEqual(self.audio[-1], len(server.hang_up_tone()), 'the hang-up tone')
        await self.call.interrupt()
        await self.tone()
        self.assertEqual(self.hung, [])
        self.assertNotIn('(Juno ended the call.)', self.call.lines)

    async def test_the_board_talking_over_the_tone_keeps_the_call_open(self):
        await self.goodbye()
        await self.wait(120)  # the tone is out
        self.call.over = {'since': 0, 'text': '', 'held': False, 'from': 0}  # (talking, the words not recognised yet)
        await self.tone()
        self.assertEqual(self.hung, [])
        self.assertNotIn('(Juno ended the call.)', self.call.lines)

    async def test_a_sound_over_the_tone_still_hangs_up(self):
        await self.goodbye()
        await self.wait(120)  # the tone is out
        await self.talk('', 15)  # (a cough still going as the tone ends: the line waits to hear what it is)
        await self.tone()
        self.assertEqual(self.hung, [])
        await self.wait(20)  # (no words: it hangs up after all)
        self.assertEqual(len(self.hung), 1)
        self.assertEqual(len(self.brain.asked), 1)

    async def test_the_board_hanging_up_over_the_tone_ends_it_once(self):
        await self.goodbye()
        await self.wait(120)  # the tone is out
        self.call.end()
        await self.tone()
        self.assertEqual(self.hung, [])
        self.assertNotIn('(Juno ended the call.)', self.call.lines)

    async def test_a_bye_over_the_goodbye_lets_it_hang_up(self):
        await self.goodbye()
        await self.quiet(10)
        await self.talk('Bye.', 15)  # (a lone word over the reply is let go, as ever)
        await self.wait(120)
        await self.tone()
        self.assertEqual(len(self.hung), 1)
        self.assertEqual(len(self.brain.asked), 1)

    async def test_a_sound_without_words_after_the_goodbye_waits_for_quiet(self):
        await self.goodbye()
        await self.quiet(100)
        await self.talk('', 20)  # a weight put down, 3.8 s in
        await self.wait(30)  # the goodbye played long ago, but it's been quiet only 1 s
        self.assertEqual(self.hung, [])
        await self.wait(20)
        await self.tone()
        self.assertEqual(len(self.hung), 1)
        self.assertEqual(len(self.brain.asked), 1)

    # The CLI runs hang_up and hands its answer back to the model, which writes again in the same turn (a new response).
    async def test_hung_up_after_the_goodbye_its_reply_to_the_tool_is_not_said(self):
        self.brain.reply = ['Thank you, talk soon. ', server.Step(server.HANG_UP_TOOL), server.RESPONSE,
                            'Thank you, talk soon.']
        await self.call.answer('Talk soon.', None)
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], ['Thank you, talk soon.'])
        self.assertEqual(self.call.lines[-1], 'Juno: Thank you, talk soon.')
        self.assertTrue(self.call.leaving, 'it hangs up')

    async def test_hung_up_after_the_goodbye_and_another_tool_step_its_reply_is_not_said(self):
        self.brain.reply = ['Talk soon. ', server.Step('mcp__hq__job'), server.Step(server.HANG_UP_TOOL),
                            server.RESPONSE, 'Talk soon.']
        await self.call.answer('Talk soon.', None)
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], ['Talk soon.'])
        self.assertEqual(self.call.lines[-1], 'Juno: Talk soon.')
        self.assertTrue(self.call.leaving, 'it hangs up')

    async def test_hung_up_first_the_goodbye_after_it_is_said(self):
        self.brain.reply = [server.Step(server.HANG_UP_TOOL), server.RESPONSE, 'Thank you, talk soon.']
        await self.call.answer('Talk soon.', None)
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], ['Thank you, talk soon.'])
        self.assertEqual(self.call.lines[-1], 'Juno: Thank you, talk soon.')
        self.assertTrue(self.call.leaving, 'it hangs up')

    async def test_hung_up_first_after_earlier_words_and_a_tool_step_the_goodbye_is_said(self):
        self.brain.reply = ['One moment. ', server.Step('mcp__hq__job'), server.RESPONSE, ' ',
                            server.Step(server.HANG_UP_TOOL), server.RESPONSE, 'Thank you, talk soon.']
        await self.call.answer('Talk soon.', None)
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], ['One moment.', 'Thank you, talk soon.'])
        self.assertTrue(self.call.leaving, 'it hangs up')

    async def test_a_goodbye_cut_short_by_an_error_never_hangs_up(self):
        self.hung = []

        async def hang_up():
            self.hung.append(CLOCK[0])
        self.call.hang_up = hang_up
        self.brain.reply = ['Bye for now! ', server.Step(server.HANG_UP_TOOL), server.Unanswered('error')]
        await self.call.answer('Bye!', None)
        await self.wait(300)
        self.assertEqual(self.hung, [])
        self.assertTrue(self.call.lines[-1].startswith('(The line, not Juno:'))


OPENING = "Hi, this is Juno from Testco. I'm an AI assistant, calling about our parcel."


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
# (calls out)
class CallOut(Juno):
    """A call we placed to a partner, on the phone: Juno speaks first in the opening's fixed words, keeps notes, and keeps
    no transcript once they'd rather we didn't."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.brain = Brain()
        self.brain.opening, self.brain.objected, self.brain.who = OPENING, "No problem, I won't keep one.", 'Print API'
        self.brain.token = 't1'
        self.ended, self.hq, server.hq = [], server.hq, lambda method, path, body=None: self.ended.append((path, body))
        self.call = server.Call(self.call.send_audio, self.call.send_event, self.call.clear, 'juno', 'en', phone=True,
                                callout=12, brain=self.brain)
        self.call.transcribe = self.transcribe
        await self.call.start()
        await self.call.greet()
        SPOKEN.clear()

    def tearDown(self):
        server.hq = self.hq
        super().tearDown()

    async def picked_up(self):
        """They answer the phone; the opening (2 s) is said and plays from now on."""
        await self.talk('Print API, Sanne speaking.', 30)
        await self.quiet(20)
        await self.settle()

    async def test_the_opening_is_said_after_their_first_words_and_the_model_goes_on_from_their_answer(self):
        await self.picked_up()
        self.assertEqual(SPOKEN, [OPENING])
        self.assertEqual(self.brain.asked, [], 'their hello is not the model\'s to answer')
        self.assertEqual(self.call.lines, ['Print API: Print API, Sanne speaking.', f'Juno: {OPENING}'])
        await self.quiet(70)  # (the opening has played)
        await self.talk('Sure, what about it?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.asked, ['Sure, what about it?'])
        self.assertIn(f'The line has said your opening for you, in these words: "{OPENING}"', self.brain.recap)
        self.assertIn('Print API, Sanne speaking.', self.brain.recap)
        self.assertEqual(self.call.lines[2:], ['Print API: Sure, what about it?', f'Juno: {REPLY}'])

    async def test_the_opening_is_said_after_three_seconds_of_quiet_from_pickup(self):
        await self.quiet(90)  # (2.9 s)
        await asyncio.sleep(0.05)
        self.assertEqual(SPOKEN, [])
        await self.quiet(5)
        await self.settle()
        self.assertEqual(SPOKEN, [OPENING])
        self.assertEqual(self.call.lines, [f'Juno: {OPENING}'])
        self.assertIn(' They picked up. The line has said your opening', self.brain.recap)

    async def test_talking_over_the_opening_is_talking_over_a_reply(self):
        await self.picked_up()
        await self.quiet(10)
        await self.talk('Sorry, who is this?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertIn({'type': 'clear'}, self.events)  # (the opening stopped)
        self.assertEqual(self.brain.asked, ['Sorry, who is this?'])
        self.assertIn(f'The line has said your opening for you, in these words: "{OPENING}"', self.brain.recap)

    async def test_notes_are_kept_in_order_with_the_call(self):
        await self.picked_up()
        await self.quiet(70)
        self.brain.reply = [server.Step(server.NOTE_TOOL), server.Used(server.NOTE_TOOL, {'what': 'Reprint ships Tuesday'}),
                            server.RESPONSE, 'Tuesday works. ', server.Step(server.NOTE_TOOL),
                            server.Used(server.NOTE_TOOL, {'what': 'Tracking code by email\nand more'}),  # (refused: not kept)
                            server.Step(server.NOTE_TOOL), server.Used(server.NOTE_TOOL, {'what': 'No charge for the reprint'})]
        await self.talk('We can reprint it by Tuesday, at no charge.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.call.notes, ['Reprint ships Tuesday', 'No charge for the reprint'])
        on_disk = json.loads(self.call.file.read_text())
        self.assertEqual((on_disk['callout'], on_disk['notes'], on_disk['objected']), (12, self.call.notes, False))
        self.assertEqual(on_disk['lines'][-1], 'Juno: Tuesday works.')

    async def test_no_transcript_says_the_fixed_words_drops_the_transcript_and_keeps_only_the_notes(self):
        await self.picked_up()
        await self.quiet(70)
        self.brain.reply = ['Of course. ', server.Step(server.NO_TRANSCRIPT_TOOL), server.Used(server.NO_TRANSCRIPT_TOOL, {}),
                            server.RESPONSE, 'So, about the parcel.']
        await self.talk("I'd rather you didn't keep a transcript.", 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-3:], ['Of course.', "No problem, I won't keep one.", 'So, about the parcel.'])
        self.assertEqual(self.call.lines, [])
        self.brain.reply = [server.Step(server.NOTE_TOOL), server.Used(server.NOTE_TOOL, {'what': 'Reprint ships Tuesday'}),
                            server.RESPONSE, 'Great, Tuesday it is.']
        await self.quiet(150)
        await self.talk('We reprint it, ships Tuesday.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.call.lines, [], 'no line kept after it either')
        on_disk = self.call.file.read_text()
        for dropped in ('Sanne speaking', 'transcript', 'parcel', 'Tuesday it is', 'ships Tuesday.'):
            self.assertNotIn(dropped, on_disk)
        self.call.end()
        self.assertEqual([path for path, body in self.ended], ['call-end'])
        self.assertEqual(self.ended[0][1], {'agent': 'juno', 'lines': [], 'request': 0, 'token': 't1', 'callout': 12,
                                            'notes': ['Reprint ships Tuesday'], 'objected': True})


class FakeRoomSocket:
    """A join page's connection: its join message, then what the test puts in; `sent` is what reached it."""
    def __init__(self, name, rejoin=None, origin=None):
        self.queue, self.sent, self.code = asyncio.Queue(), [], None
        self.request = NS(headers={'Origin': origin or server.ORIGIN})
        self.first = json.dumps({'type': 'join', 'token': 'tok', 'name': name, **({'rejoin': rejoin} if rejoin else {})})

    async def recv(self):
        return self.first

    async def send(self, message):
        if self.code is not None:
            raise server.ConnectionClosed(None, None)
        self.sent.append(message)

    async def close(self, code=1000, reason=''):
        if self.code is None:
            self.code = code
            self.queue.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if (message := await self.queue.get()) is None:
            raise server.ConnectionClosed(None, None)
        return message

    def events(self, kind=None):
        return [e for e in (json.loads(m) for m in self.sent if isinstance(m, str)) if kind is None or e['type'] == kind]

    def frames(self):
        return [np.frombuffer(m, '<i2').astype(np.float32) / 32767 for m in self.sent if isinstance(m, bytes)]


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
# (the join link's rooms)
class Room(Juno):
    """A call out's room on the join link's page: Sanne and Piet with Juno, through the mixer, ticked by the test."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.brain = Brain()
        self.brain.opening, self.brain.token = OPENING, 't1'
        self.ended, self.hq, server.hq = [], server.hq, no_screen(lambda method, path, body=None: self.ended.append((path, body)))
        self.tickets = []
        room.ROOMS.clear(), room.ENDED.clear(), SPOKEN.clear()
        self.saved = room.EMPTY_SECONDS, room.HANG_UP_WAIT_SECONDS
        room.EMPTY_SECONDS = room.HANG_UP_WAIT_SECONDS = 0.2

        def make_call(send_audio, send_event, clear, ticket, hang_up, speakers):
            call = server.Call(send_audio, send_event, clear, ticket['agent'], 'en', hang_up=hang_up, callout=ticket['callout'],
                               speakers=speakers, brain=self.brain)
            call.transcribe, call.opening_quiet = self.transcribe, server.ROOM_OPENING_QUIET_SECONDS
            self.call = call
            return call
        self.make_call = make_call

    async def asyncTearDown(self):
        for left in list(room.ROOMS.values()):
            await left.end()

    def tearDown(self):
        server.hq = self.hq
        room.EMPTY_SECONDS, room.HANG_UP_WAIT_SECONDS = self.saved
        room.ROOMS.clear()
        super().tearDown()

    def ticket(self, token):
        self.tickets.append(token)
        return {'agent': 'juno', 'lang': 'en', 'callout': 5, 'name': 'Juno'}

    async def join(self, name, rejoin=None):
        ws = FakeRoomSocket(name, rejoin)
        asyncio.create_task(room.join(ws, self.ticket, self.make_call))
        for _ in range(100):
            await asyncio.sleep(0.01)
            if ws.events('room') or ws.code:
                break
        return ws

    def room(self):
        return room.ROOMS[5]

    async def ticks(self, n, said_by=None, x=None):
        """n ticks of the mixer; said_by speaks x (a frame at a time) meanwhile, the others are quiet."""
        r = self.room()
        for i in range(n):
            if said_by is not None:
                person = next(p for p in r.people.values() if p.name == said_by)
                person.hear((x[i * 320:(i + 1) * 320] * 32768).astype('<i2').tobytes())
            r.tick()
            await r.ear.join()
            if (over := self.call.over) and over.get('look'):
                await over['look']
            await asyncio.sleep(0)

    async def say(self, name, text, windows):
        x = self.utterance(text, windows)
        await self.ticks(len(x) // 320, name, x)

    async def test_two_people_hear_juno_and_each_other_never_themselves_and_the_transcript_names_them(self):
        sanne = await self.join('Sanne')
        await self.room().ready.wait()
        self.assertEqual(self.tickets, ['tok'])
        piet = await self.join('Piet')
        you = sanne.events('room')[0]
        sanne_id = you['you']
        self.assertEqual((you['agent'], [p['name'] for p in you['people']]), ({'name': 'Juno', 'look': 'juno'}, ['Sanne']))
        self.assertEqual([p['name'] for p in sanne.events('people')[-1]['people']], ['Sanne', 'Piet'])
        await self.ticks(80)  # (1.6 s of quiet: the opening, said once the first person is in)
        await self.settle()
        self.assertEqual(SPOKEN, [OPENING])
        await self.ticks(110)  # (it plays, 2 s, with its words in time: said before its first frame)
        said_at = next(i for i, m in enumerate(piet.sent) if isinstance(m, str) and json.loads(m)['type'] == 'said')
        self.assertEqual(len(piet.sent[said_at + 1]), 1280)
        for ws in (sanne, piet):  # (the agent's voice, with its own copy for the mouth)
            self.assertEqual(sum(len(f) == 640 and np.allclose(f[:320], 0.01, atol=1e-3) for f in ws.frames()), 100)
        sanne.sent.clear(), piet.sent.clear()
        await self.say('Sanne', 'Can you check the orders?', 30)
        level = self.level
        self.assertTrue(any(np.allclose(f[:320], level, atol=1e-3) for f in piet.frames()), 'Piet hears Sanne')
        self.assertFalse(any(abs(f[:320]).max() > 0.1 for f in sanne.frames()), 'Sanne never hears herself')
        self.assertEqual(piet.events('talking')[0]['id'], sanne_id)
        await self.ticks(20)
        await self.settle()
        await self.say('Piet', 'And the invoices.', 30)
        await self.ticks(20)
        await self.settle()
        self.assertEqual(self.brain.asked[0], 'Sanne: Can you check the orders?')  # (the agent hears who said it)
        self.assertIn('Sanne: Can you check the orders?', self.call.lines)
        self.assertTrue(any(line.startswith('Piet: ') and 'invoices' in line for line in self.call.lines), self.call.lines)

    async def test_one_leaves_and_rejoins_in_their_place_and_the_room_ends_two_minutes_after_the_last_leaves(self):
        sanne = await self.join('Sanne')
        piet = await self.join('Piet')
        piet_id, piet_key = piet.events('room')[0]['you'], piet.events('room')[0]['key']
        await piet.close()  # (dropped)
        await asyncio.sleep(0.05)
        self.assertEqual([p['name'] for p in sanne.events('people')[-1]['people']], ['Sanne'])
        back = await self.join('Piet', rejoin=piet_key)
        self.assertEqual(back.events('room')[0]['you'], piet_id)
        self.assertEqual([p['name'] for p in sanne.events('people')[-1]['people']], ['Sanne', 'Piet'])
        for ws in (sanne, back):
            ws.queue.put_nowait(json.dumps({'type': 'bye'}))
        await asyncio.sleep(0.05)
        self.assertIn(5, room.ROOMS, 'it waits for someone to come back')
        await asyncio.sleep(0.4)
        self.assertNotIn(5, room.ROOMS)
        self.assertEqual([path for path, body in self.ended], ['call-end'])
        late = await self.join('Sanne')
        self.assertEqual(late.code, 4004, 'a link is good for one call')

    async def test_the_agent_hanging_up_ends_the_room_for_everyone(self):
        sanne, piet = await self.join('Sanne'), await self.join('Piet')
        await self.room().hang_up()
        for ws in (sanne, piet):
            self.assertEqual((ws.events('hangup'), ws.code), ([{'type': 'hangup'}], 4000))

    async def test_an_id_from_the_list_of_people_takes_nobody_s_place(self):
        sanne = await self.join('Sanne')
        piet = await self.join('Piet')
        piet_id = sanne.events('people')[-1]['people'][1]['id']
        self.assertNotIn(piet.events('room')[0]['key'], json.dumps(sanne.events('people')))
        other = await self.join('Mallory', rejoin=piet_id)
        self.assertIsNone(piet.code, 'Piet stays connected')
        self.assertNotEqual(other.events('room')[0]['you'], piet_id)

    async def test_dropped_joins_never_hold_more_than_six_places(self):
        anchor = await self.join('Anchor')
        for i in range(8):
            ws = await self.join(f'Drop{i}')
            await ws.close()  # (dropped, no bye)
            await asyncio.sleep(0.02)
        self.assertLessEqual(len(self.room().people), room.MOST)
        self.assertIn('Anchor', [p.name for p in self.room().people.values()])
        self.assertIsNone(anchor.code)

    async def test_a_full_name_joins_and_a_longer_one_is_turned_away_before_the_link_is_asked_about(self):
        full = 'Maria Guadalupe Fernández de Córdoba y Figueroa ' + 'é' * (room.NAME_LENGTH - 48)
        self.assertEqual(len(full), room.NAME_LENGTH)
        self.assertIsNone((await self.join(full)).code)
        self.assertEqual([p.name for p in self.room().people.values()], [full])
        self.tickets.clear()
        self.assertEqual(((await self.join(full + 'x')).code, self.tickets), (1008, []))

    async def test_a_seventh_person_is_turned_away(self):
        people = [await self.join(f'P{i}') for i in range(6)]
        self.assertEqual([ws.code for ws in people], [None] * 6)
        self.assertEqual((await self.join('Seventh')).code, 4009)

    async def test_a_page_from_anywhere_but_hq_is_turned_away_before_the_link_is_asked_about(self):
        ws = FakeRoomSocket('Sanne', origin='https://elsewhere.example')
        await server.room_call(ws)
        self.assertEqual((ws.code, ws.sent, room.ROOMS), (1008, [], {}))


class Played(unittest.TestCase):
    """How HQ played the voice, logged at hang-up: numbers only, whatever HQ sends."""
    def test_the_line_says_how_the_voice_played(self):
        self.assertEqual(server.played('ada', {'via': 'stream', 'rate': 48000, 'frames': 412, 'stutters': 3, 'interrupted': 1, 'stalls': 2}),
                         'call: ada hung up; HQ played 412 frames via stream at 48000 Hz, 3 stutters, 1 interruptions, 2 stalls')
        # (an HQ from before the stalls were counted: none)
        self.assertTrue(server.played('ada', {'via': 'stream', 'frames': 4}).endswith(', 0 stalls'))

    def test_nothing_but_numbers_reaches_the_log(self):
        self.assertEqual(server.played('ada', {'via': 'hello\nthere', 'rate': '48000', 'frames': -1, 'stutters': 1e12, 'text': 'hi'}),
                         'call: ada hung up; HQ played 0 frames via unknown at 0 Hz, 0 stutters, 0 interruptions, 0 stalls')
        self.assertEqual(server.played('ada', None), '')  # (an older HQ says nothing: no line)


class Device(unittest.TestCase):
    """Which browser and system a call came from: whose echo canceller the board's microphone went through first.
"""
    def test_safari_and_chrome_on_an_iphone_and_chrome_on_a_mac_are_told_apart(self):
        iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)'
        self.assertEqual(server.device(iphone + ' Version/26.0 Mobile/15E148 Safari/604.1'), 'Safari on an iPhone')
        self.assertEqual(server.device(iphone + ' CriOS/141.0 Mobile/15E148 Safari/604.1'), 'Chrome on an iPhone')
        mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
        self.assertEqual(server.device(mac), 'Chrome on a Mac or an iPad')
        self.assertEqual(server.device(''), 'unknown on unknown')


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class EchoDelay(unittest.TestCase):
    """The agent's voice comes back in the microphone a device's own time after it played, longer on some devices than
    AEC3 looks: the line finds it and holds what played back by it."""
    def talk(self, rng, seconds):
        """Speech-like: bursts of noise, a quarter-second each, some silent."""
        bursts = rng.standard_normal((seconds * 4, 4000)) * (rng.random((seconds * 4, 1)) < 0.7)
        return (0.1 * bursts).astype(np.float32).ravel()

    def hear(self, mic, played):
        canceller = echo.Echo()
        for i in range(0, len(mic), 320):  # (HQ's 20 ms frames)
            canceller.cancel(mic[i:i + 320], played[i:i + 320])
        return canceller

    def test_a_voice_coming_back_700_ms_later_is_found_and_held_back_by_all_but_100_ms(self):
        rng = np.random.default_rng(1)
        played = self.talk(rng, 10)
        mic = 0.5 * np.concatenate([np.zeros(11200, np.float32), played])[:len(played)] + 0.003 * self.talk(rng, 10)
        canceller = self.hear(mic, played)
        self.assertEqual((canceller.delay, canceller.shift), (11200, 11200 - echo.LEFT_TO_AEC3_SAMPLES))
        self.assertIn('it came back 700 ms after it played', canceller.report('ada'))

    def test_a_microphone_without_the_voice_finds_no_delay(self):
        rng = np.random.default_rng(2)
        canceller = self.hear(self.talk(rng, 10), self.talk(rng, 10))  # (the board talking, nothing of the voice)
        self.assertEqual((canceller.delay, canceller.shift), (None, 0))
        self.assertIn('no delay found', canceller.report('ada'))


class Timeline(unittest.TestCase):
    """HQ's timeline of the playback, logged at hang-up at UTC times from when HQ heard the line pick up."""
    at = 1790000000.0  # 2026-09-21T14:13:20Z

    # (mic silent)
    def test_each_kind_in_plain_words_at_the_line_s_times(self):
        events = [[-0.5, 'dropped', 12], [-0.5, 'stall', 0.31], [0.04, 'running'], [2.6, 'voice', 0, 0], [5.25, 'tick', 0.1, 3], [9.97, 'dry'],
                  [12.0, 'slow', 0.42, 3.04], [13.5, 'audio waiting'], [14, 'track mute'], [15, 'cut'], [16, 'stall'],
                  [17, 'wake lock released'], [18, 'mic mute'], [18.5, 'mic silent'], [19, 'mic restarted'],
                  [20, 'wake lock held'], [21, 'wake lock refused'], [22, 'no wake lock'], [23, 'lagging'], [27, 'caught up', 12.34]]
        self.assertEqual(server.timeline('ada', events, self.at),
                         'call: ada playback, timed: 14:13:19.5 12 earlier left out; 14:13:19.5 stall 0.31 s; 14:13:20.0 context running; '
                         '14:13:22.6 voice (0.0 s queued, 0 sources); 14:13:25.2 tick (0.1 s queued); 14:13:29.9 ran dry; '
                         '14:13:32.0 clock at 0.42x for 3.0 s; 14:13:33.5 audio waiting; 14:13:34.0 track mute; '
                         '14:13:35.0 cut; 14:13:36.0 stall (to the end); 14:13:37.0 wake lock released; '
                         '14:13:38.0 mic mute; 14:13:38.5 mic silent; 14:13:39.0 mic restarted; '
                         '14:13:40.0 wake lock held; 14:13:41.0 wake lock refused; 14:13:42.0 no wake lock; '
                         '14:13:43.0 lagging; 14:13:47.0 caught up (12.3 s behind at most)')

    def test_nothing_but_known_kinds_and_numbers_reaches_the_log(self):
        events = [[1, 'hello there'], [2, 'voice', 'words', 1], [3, ['voice']], ['4', 'dry'], [5, 'slow', 0.5],
                  [1e9, 'dry'], [6, 'voice', 1e12, 1], 'dry', [7, 'audio play\n'], [8, 'cut', 1], [9, 'running', 4],
                  [10, 'audio pause', 1], [11, 'dropped']]
        self.assertEqual(server.timeline('ada', events, self.at), '')
        self.assertEqual(server.timeline('ada', [[1, 'dry']] * 500, self.at).count('ran dry'), 301)
        self.assertEqual(server.timeline('ada', None, self.at), '')  # (an older HQ sends none)
        self.assertEqual(server.timeline('ada', [[1, 'dry']], None), '')  # (never picked up)


# The CLI's own events for a turn its seat's limit turned away (2.1.283 against limit_model.py; the line logs this result as
# "call agent (juno): success: You've hit your session limit · resets 10:10pm (UTC)")
LIMITED = [{'type': 'rate_limit_event', 'rate_limit_info': {'status': 'rejected', 'resetsAt': 1909174200, 'rateLimitType': 'five_hour',
                                                            'unifiedWindows': {'five_hour': {'utilization': 1, 'resetsAt': 1909174200}}}},
           {'type': 'assistant', 'parent_tool_use_id': None, 'error': 'rate_limit', 'is_api_error_message': True,
            'message': {'model': '<synthetic>', 'role': 'assistant', 'content': [{'type': 'text', 'text': "You've hit your session limit · resets 10:10pm (UTC)"}]}},
           {'type': 'result', 'subtype': 'success', 'is_error': True, 'api_error_status': 429, 'terminal_reason': 'api_error',
            'result': "You've hit your session limit · resets 10:10pm (UTC)"}]


class Proc:
    """A call agent's CLI: `replies` are its turns, each streamed as text and a result once its request has started (the
    model has the message); None is dying mid-reply, a dict is a result that ends the turn before any request, and a
    list is those events (LIMITED). then: what runs as a turn is heard (the worker moving the line to another seat)."""
    def __init__(self, replies, then=None):
        self.replies, self.lines, self.returncode, self.heard_messages, self.then = list(replies), [], None, [], then
        self.stdin = NS(write=self.heard, drain=lambda: asyncio.sleep(0))
        self.stdout, self.stderr = NS(readline=self.line), NS(readline=lambda: asyncio.sleep(60, b''))

    def heard(self, b):
        if b'"user"' not in b:
            return
        self.heard_messages.append(json.loads(b)['message'])
        reply = self.replies.pop(0)
        if self.then and reply is not None:
            self.then()
        if isinstance(reply, list):
            self.lines += [json.dumps(e).encode() for e in reply]
            return
        if isinstance(reply, dict):
            self.lines.append(json.dumps({'type': 'result', **reply}).encode())
            return
        self.lines.append(json.dumps({'type': 'stream_event', 'event': {'type': 'message_start', 'message': {}}}).encode())
        if reply is not None:
            self.lines += [json.dumps({'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': reply}}}).encode(),
                           json.dumps({'type': 'result', 'subtype': 'success'}).encode()]

    async def line(self):
        await asyncio.sleep(0)
        if self.lines:
            return self.lines.pop(0) + b'\n'
        self.returncode = 1
        return b''

    async def wait(self):
        return self.returncode

    def kill(self):
        self.returncode = -9


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class Restart(unittest.IsolatedAsyncioTestCase):
    """The call agent dies mid-reply and the line starts a new one: it's still the same call, with one token, from the
    first session's words to the hand-over. The coordinator here hands out a token per call and takes it back at the end."""
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        seat = Path(self.tmp.name) / 'seat'
        seat.write_text('seat')
        server.CALL_LOGS, server.LIVE, self.seat, server.SEAT = Path(self.tmp.name), Path(self.tmp.name), server.SEAT, seat
        self.hq, self.live, self.asked = server.hq, set(), []
        server.hq = self.coordinator
        self.procs = [Proc([None]), Proc(['Yes, I will build it.'])]  # the first session dies on the first message
        self.started, self.signed, self.seat_now = [], [], {'room': True}
        self.spawn, asyncio.create_subprocess_exec = asyncio.create_subprocess_exec, self.exec
        self.now_ms, server.now_ms = server.now_ms, lambda: NOW

    async def asyncTearDown(self):
        server.hq, server.SEAT, asyncio.create_subprocess_exec, server.now_ms = self.hq, self.seat, self.spawn, self.now_ms
        self.tmp.cleanup()

    async def exec(self, *args, **kw):
        self.assertEqual(kw['env']['HQ_TOKEN'], 't1', 'every session hands work on with the call\'s one token')
        self.started.append(self.procs.pop(0))
        fd = int(kw['env']['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'])  # (on a pipe, not in the env)
        self.assertEqual((kw['pass_fds'], 'CLAUDE_CODE_OAUTH_TOKEN' in kw['env']), ((fd,), False))
        self.signed.append(os.read(fd, 4096).decode())
        return self.started[-1]

    signed, seat_now, pin_shots = [], {'room': True}, []

    def coordinator(self, method, path, body=None):
        self.asked.append((method, path, body))
        if path.split('?')[0] == 'call-context':
            token = (body or {}).get('token')
            if not token:  # (only a request with no token starts a call)
                token = f't{len(self.live) + 1}'
                self.live.add(token)
            elif token not in self.live:  # (a restart whose call has ended: call.ts refuses it)
                raise HTTPError(f'{server.HQ}/api/voice/call-context', 409, 'Conflict', None, None)
            return {'prompt': 'You are Juno.', 'token': token, 'seat': self.seat_now, 'timeZone': 'Europe/Amsterdam',
                    'pins': self.pin_shots}
        if path == 'call-end':
            self.live.discard(body['token'])
        if path == 'call-ticket':  # (the phone line's)
            return {'agent': 'juno', 'lang': 'en'}

    async def test_a_restarted_call_agent_stays_on_the_same_call(self):
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        await call.answer('Can you build the page?', None)  # the session dies: a new one, and "Sorry, I lost my train..."
        self.assertEqual(len(self.started), 2, 'a second session was started')
        await call.answer('Can you build the page?', None)
        call.end()
        contexts = [(m, p, b) for m, p, b in self.asked if p.split('?')[0] == 'call-context']
        self.assertEqual(len(contexts), 2)
        self.assertEqual([b and b.get('token') for m, p, b in contexts], ['', 't1'], 'the restart asks with the call\'s token')
        self.assertTrue(all('t1' not in p for m, p, b in contexts), 'never in the URL (URLs reach logs)')
        end = [b for m, p, b in self.asked if p == 'call-end']
        self.assertEqual([b['token'] for b in end], ['t1'])
        self.assertEqual(end[0]['lines'][-2:], ['Board: Can you build the page?', 'Juno: Yes, I will build it.'])
        self.assertEqual(self.live, set(), 'no token outlives the call')

    # A call about the board's pins: the line asks for it with their numbers, and their screenshots and pictures go with the
    # session's first message, each named, a restarted session's too; never anything that isn't a JPEG or PNG
    # (pictures)
    async def test_the_pins_screenshots_go_with_each_sessions_first_message(self):
        self.procs = [Proc(['I see the pale button.', 'Yes.', None]), Proc(['Sure.'])]
        self.pin_shots = [{'id': 5, 'kind': 'screenshot', 'type': 'image/jpeg', 'data': JPEG},
                          {'id': 5, 'kind': 'picture', 'type': 'image/jpeg', 'data': JPEG},
                          {'id': 6, 'kind': 'screenshot', 'type': 'image/gif', 'data': JPEG},
                          {'id': '7', 'kind': 'screenshot', 'type': 'image/jpeg', 'data': JPEG},
                          {'id': 8, 'kind': 'screenshot', 'type': 'image/png', 'data': JPEG},
                          {'id': 9, 'kind': 'screenshot', 'type': 'image/jpeg', 'data': BROKEN}]  #.
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', 'en', pins=[5, 6])
        await call.start()
        self.assertEqual(call.picture_bytes, 2 * len(JPEG), 'they count towards what the session sends')
        await call.answer('About the pins.', None)
        first = self.started[0].heard_messages[0]['content']
        self.assertEqual([part['type'] for part in first], ['image', 'image', 'text'])
        self.assertEqual(first[0]['source'], {'type': 'base64', 'media_type': 'image/jpeg', 'data': JPEG})
        self.assertEqual(first[2]['text'], "(The pins' screenshots and pictures, in order: #5 screenshot, #5 picture.)\n\nAbout the pins.")
        await call.answer('And the price?', None)
        self.assertEqual([part['type'] for part in self.started[0].heard_messages[1]['content']], ['text'], 'once a session')
        await call.answer('Can you build the page?', None)  # the session dies: a restart, which gets them again
        await call.answer('Can you build the page?', None)
        again = self.started[1].heard_messages[0]['content']
        self.assertEqual([part['type'] for part in again], ['image', 'image', 'text'])
        self.assertIn("(The pins' screenshots and pictures, in order: #5 screenshot, #5 picture.)", again[2]['text'])
        call.end()
        contexts = [b for m, p, b in self.asked if p == 'call-context']
        self.assertEqual([b['pins'] for b in contexts], [[5, 6], [5, 6]])

    # The phone line has no screen: its call agent's briefing leaves out the pictures, also after a restart.
    async def test_a_phone_call_asks_for_its_briefing_as_a_phone_call_also_after_a_restart(self):
        for phone in (False, True):
            self.procs, self.asked = [Proc([None]), Proc(['Yes.'])], []
            call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', 'en',
                               phone=phone)
            await call.start()
            await call.answer('Can you build the page?', None)  # the session dies: a restart
            call.end()
            contexts = [b for m, p, b in self.asked if p == 'call-context']
            self.assertEqual([b['phone'] for b in contexts], [phone, phone])

    # The board hangs up while a picture is on its way from the coordinator.
    async def test_a_picture_fetched_after_the_hang_up_starts_no_turn_and_no_agent(self):
        events = []
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0, events.append(e)), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        call.quiet = 100  # (the board has been quiet a while: the picture's turn would go right after the quiet moment)
        release, fetch = threading.Event(), server.fetch_picture
        server.fetch_picture = lambda n, c: release.wait(5) and {'id': n, 'type': 'image/jpeg', 'data': JPEG}
        try:
            showing = asyncio.create_task(call.show(17))
            await asyncio.sleep(0.05)
            call.end()
            release.set()
            await showing
            await asyncio.sleep(0.2)
            CLOCK[0] += 2 * server.SHOWN_SECONDS  # (the quiet moment has long passed)
            await asyncio.sleep(0.3)
        finally:
            server.fetch_picture = fetch
        self.assertEqual(len(self.started), 1, 'no new session after the hang-up')
        self.assertFalse(call.file.exists(), 'the handed-over transcript stays handed over')
        self.assertEqual((call.pictures, call.showing, call.turn), ([], None, None), 'no turn for the picture')
        self.assertEqual(self.started[0].heard_messages, [])
        self.assertEqual([e for e in events if e['type'] == 'picture'], [])
        self.assertEqual([b['token'] for m, p, b in self.asked if p == 'call-end'], ['t1'])

    # A picture is seen only once the model has it, and a restarted session has none of the old one's: HQ hears they're
    # lost, and the recap names them.
    def picture_events(self, events):
        return [(e['id'], e['state'], e.get('why')) for e in events if e['type'] == 'picture']

    async def test_a_picture_for_an_agent_that_has_already_exited_is_lost_never_seen(self):
        self.procs[0] = Proc([])
        self.procs[0].returncode = 1  # (it exited while the call was quiet)
        events = []
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0, events.append(e)), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        call.pictures, call.picture_bytes = [{'id': 17, 'type': 'image/jpeg', 'data': JPEG}], len(JPEG)
        await call.answer('What do you think of this?', None)
        self.assertEqual(len(self.started), 2, 'a second session was started')
        self.assertEqual(self.picture_events(events), [(17, 'failed', 'lost')])
        self.assertEqual((call.pictures, call.held, call.picture_bytes), ([], [], 0))
        await call.answer('What do you think of it?', None)
        message = self.started[1].heard_messages[0]['content']
        self.assertEqual([part['type'] for part in message], ['text'], 'the new session gets no picture')
        self.assertIn('#17', message[0]['text'])
        call.end()

    async def test_pictures_seen_before_the_agent_dies_mid_turn_are_lost_with_it(self):
        self.procs = [Proc(['Nice shop.', None]), Proc(['Sure.'])]
        events = []
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0, events.append(e)), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        call.pictures = [{'id': 17, 'type': 'image/jpeg', 'data': JPEG}]
        await call.answer('This is the shop.', None)
        self.assertEqual(self.picture_events(events), [(17, 'seen', None)])
        call.pictures = [{'id': 20, 'type': 'image/jpeg', 'data': JPEG}]
        await call.answer('And this is the menu.', None)  # the model has it, then the session dies
        self.assertEqual(self.picture_events(events)[1:], [(20, 'seen', None), (17, 'failed', 'lost'), (20, 'failed', 'lost')])
        self.assertEqual(call.held, [])
        await call.answer('Can you see them?', None)
        message = self.started[1].heard_messages[0]['content']
        self.assertEqual([part['type'] for part in message], ['text'])
        self.assertIn('#17, #20', message[0]['text'])
        call.end()

    # A turn that ends before its request starts (the board talked over it, or the seat turned it away) leaves its message
    # in the session, which sends it with the next request (the real CLI does: RealCli). HQ keeps 'received' for its
    # pictures until then: no "share it again" for a picture the agent gets.
    async def test_a_turn_that_ends_before_its_request_starts_has_its_pictures_seen_with_the_next_request(self):
        for stopped in ({'subtype': 'error_during_execution', 'is_error': True}, LIMITED):
            self.procs, self.started = [Proc([stopped, 'Sure.'])], []
            events = []
            call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0, events.append(e)), lambda: asyncio.sleep(0), 'juno', 'en')
            await call.start()
            call.pictures = [{'id': 17, 'type': 'image/jpeg', 'data': JPEG}]
            await call.answer('This is the shop.', None)
            self.assertEqual(self.picture_events(events), [], 'not seen yet, and nothing failed')
            self.assertEqual((call.held, [p['id'] for p in call.unsent]), ([], [17]))
            await call.answer('What do you think?', None)
            self.assertEqual(self.picture_events(events), [(17, 'seen', None)])
            self.assertEqual((call.held, call.unsent), ([17], []))
            self.assertEqual(len(self.started), 1, 'the session goes on')
            self.assertEqual([part['type'] for part in self.started[0].heard_messages[1]['content']], ['text'], 'sent once')
            call.end()

    async def test_pictures_of_a_stopped_turn_are_lost_if_the_session_dies_before_the_next_request(self):
        self.procs = [Proc([{'subtype': 'error_during_execution', 'is_error': True}]), Proc(['Sure.'])]
        events = []
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0, events.append(e)), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        call.pictures = [{'id': 17, 'type': 'image/jpeg', 'data': JPEG}]
        await call.answer('', None)
        self.started[0].returncode = 1  # (it exited before the next request)
        await call.answer('This is the shop.', None)
        self.assertEqual(self.picture_events(events), [(17, 'failed', 'lost')], 'never seen: lost with the session')
        self.assertEqual(call.unsent, [])
        await call.answer('Can you see it?', None)
        self.assertIn('#17', self.started[1].heard_messages[0]['content'][-1]['text'], 'the recap names it')
        call.end()

    async def test_a_resumed_call_hears_what_happened_to_its_pictures_while_it_was_away(self):
        self.procs = [Proc(['Nice shop.', None]), Proc([])]
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: line.send(json.dumps(e)), lambda: asyncio.sleep(0), 'juno', 'en')
        line = server.Line(Socket([]))
        await call.start()
        call.pictures = [{'id': 17, 'type': 'image/jpeg', 'data': JPEG}]
        await call.answer('This is the shop.', None)
        line.ws.closed = True  # HQ's connection drops; the session dies and loses #17 while it's away
        await call.answer('Can you see it?', None)
        call.live_at = 1.0  # (the call went live before the drop: app_call set it then)
        server.CALLS['c1'] = {'call': call, 'line': line, 'timer': None}
        resumed = Socket([json.dumps({'resume': 'c1'})])
        try:
            await server.app_call(resumed)
        finally:
            if timer := server.CALLS.pop('c1')['timer']:
                timer.cancel()
            call.end()
        events = [json.loads(m) for m in resumed.sent]
        self.assertEqual(events[0]['type'], 'call')
        self.assertEqual([e for e in events if e['type'] == 'picture'], [{'type': 'picture', 'id': 17, 'state': 'failed', 'why': 'lost'}])

    # The agent hangs up: HQ hears it and hangs up as its own button does, saying
    # how the voice played; an HQ that doesn't is told the call is gone. The phone line closes Twilio's stream.
    async def answer_with_a_goodbye(self, ws, feed, found):
        server.HANG_UP_WAIT_SECONDS, farewell = 0.2, server.HANG_UP_WAIT_SECONDS
        self.addCleanup(setattr, server, 'HANG_UP_WAIT_SECONDS', farewell)
        self.procs = [Proc([BYE])]
        task = asyncio.create_task(found(ws))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if self.calls:
                break
        call = self.calls[-1]
        await call.answer("That's all for today. Bye!", None)
        for _ in range(250):  # 5 s of quiet: the goodbye plays for 2 s
            ws.put(feed)
        return task, call

    def ended(self):
        end = [b for m, p, b in self.asked if p == 'call-end']
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]['lines'], ["Board: That's all for today. Bye!", 'Juno: Bye for now!', '(Juno ended the call.)'])
        self.assertEqual(self.live, set())

    def capture(self):
        self.calls, made = [], server.Call
        self.addCleanup(setattr, server, 'Call', made)
        server.Call = lambda *a, **k: self.calls.append(made(*a, **k)) or self.calls[-1]

    async def test_hq_hangs_up_as_its_button_does_when_the_agent_hangs_up(self):
        self.capture()
        ws = LiveSocket(json.dumps({'agent': 'juno', 'lang': 'en'}))
        task, call = await self.answer_with_a_goodbye(ws, bytes(2 * server.FRAME), server.app_call)
        for _ in range(300):
            await asyncio.sleep(0.01)
            if '{"type": "hangup"}' in ws.sent:
                break
        self.assertIn('{"type": "hangup"}', ws.sent)
        ws.put(json.dumps({'type': 'bye'}))  # (HQ's endCall)
        await task
        await asyncio.sleep(0.3)  # (HANG_UP_WAIT_SECONDS: the line has nothing left to do)
        self.ended()
        self.assertIsNone(ws.code)
        self.assertFalse([e for e in server.CALLS.values() if e['call'] is call])

    async def test_an_hq_that_doesnt_hang_up_is_told_the_call_is_gone(self):
        self.capture()
        ws = LiveSocket(json.dumps({'agent': 'juno', 'lang': 'en'}))
        task, call = await self.answer_with_a_goodbye(ws, bytes(2 * server.FRAME), server.app_call)
        await asyncio.wait_for(task, 5)
        self.ended()
        self.assertEqual(ws.code, 4000)
        self.assertFalse([e for e in server.CALLS.values() if e['call'] is call])

    async def test_the_phone_line_closes_its_stream_when_the_agent_hangs_up(self):
        self.capture()
        ws = LiveSocket(json.dumps({'event': 'start', 'start': {'streamSid': 'MZ1', 'customParameters': {'ticket': 'tk'}}}), queued=True)
        silence = base64.b64encode(server.ulaw_encode(np.zeros(160, np.float32))).decode()
        task, call = await self.answer_with_a_goodbye(ws, json.dumps({'event': 'media', 'media': {'payload': silence}}), server.phone_call)
        await asyncio.wait_for(task, 5)
        self.ended()
        self.assertTrue(ws.closed)

    # An ended call stays ended: the board hangs up while a reply is being written, and the hang-up's kill looks to the
    # reply like its agent dying.
    async def test_a_reply_cut_off_by_the_hang_up_starts_no_new_agent(self):
        self.procs[0] = Hung()
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        turn = asyncio.create_task(call.answer('Can you build the page?', None))
        await asyncio.sleep(0.05)
        call.end()  # (kills the session: its reply ends mid-way, as a crash's would)
        await turn
        self.assertEqual(len(self.started), 1, 'no new session after the hang-up')
        self.assertFalse(call.file.exists(), 'the handed-over transcript stays handed over')
        end = [b for m, p, b in self.asked if p == 'call-end']
        self.assertEqual([(b['token'], b['lines']) for b in end], [('t1', ['Board: Can you build the page?'])])

    # The agent died on its own, and the board hangs up while the restart waits for the coordinator. The coordinator
    # takes the restart's context in before the hand-over (the reply comes back late), or after it (it refuses: the call
    # has ended). The voice line hangs up in a worker thread (app_call), as here.
    async def test_a_restart_that_comes_back_after_the_hang_up_starts_no_agent(self):
        for after in (False, True):
            with self.subTest(context_after_the_hand_over=after):
                await self.restart_across_the_hang_up(after)

    async def restart_across_the_hang_up(self, after):
        self.procs, self.started, self.asked, self.live = [Proc([None]), Proc(['Yes.'])], [], [], set()
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        restarting, hung_up, answer = threading.Event(), threading.Event(), self.coordinator

        def coordinator(method, path, body=None):
            if path == 'call-context' and body.get('token'):
                restarting.set()
                if after:
                    hung_up.wait(5)
                    return answer(method, path, body)
                reply = answer(method, path, body)
                hung_up.wait(5)
                return reply
            return answer(method, path, body)
        server.hq = coordinator
        turn = asyncio.create_task(call.answer('Can you build the page?', None))  # the session dies: a restart
        await asyncio.to_thread(restarting.wait, 5)
        await asyncio.to_thread(call.end)
        hung_up.set()
        await turn
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.started), 1, 'no session starts after the hang-up')
        self.assertEqual(self.live, set(), 'no live call or token remains')
        self.assertEqual([b['token'] for m, p, b in self.asked if p == 'call-end'], ['t1'])
        self.assertFalse(call.file.exists(), 'the handed-over transcript stays handed over')

    # A transcript write already past its check of ended when the board hangs up (keep() on the event loop, end() in a
    # worker thread): it finishes before the hand-over, and doesn't bring the transcript back after it.
    async def test_a_write_under_way_at_the_hang_up_is_handed_over_once(self):
        call = server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0), lambda: asyncio.sleep(0), 'juno', 'en')
        await call.start()
        call.lines.append('Board: Can you build the page?')
        writing, go, write = threading.Event(), threading.Event(), Path.write_text

        def held(path, *a, **kw):  # (the turn's write stops between the check and the file)
            if threading.current_thread() is keeper:
                writing.set()
                go.wait(5)
            return write(path, *a, **kw)
        keeper = threading.Thread(target=call.keep)
        Path.write_text = held
        try:
            keeper.start()
            await asyncio.to_thread(writing.wait, 5)
            ender = threading.Thread(target=call.end)
            ender.start()
            await asyncio.to_thread(ender.join, 0.2)  # (the old code hung up here, under the write)
            go.set()
            await asyncio.to_thread(keeper.join, 5)
            await asyncio.to_thread(ender.join, 5)
        finally:
            Path.write_text = write
        self.assertFalse(call.file.exists(), 'the write under way doesn\'t bring the transcript back')
        server.hand_over(call.file)  # (what the voice line does with transcripts it finds on starting)
        end = [b for m, p, b in self.asked if p == 'call-end']
        self.assertEqual([(b['token'], b['lines']) for b in end], [('t1', ['Board: Can you build the page?'])])
        self.assertEqual(self.live, set(), 'no token outlives the call')


    def call(self):
        self.events, self.audio = [], []

        async def event(e):
            self.events.append(e)

        async def audio(x):
            self.audio.append(len(x))
        return server.Call(audio, event, lambda: asyncio.sleep(0), 'juno', 'en')

    async def test_a_limit_on_the_lines_seat_is_said_and_the_session_stays(self):
        self.procs = [Proc([LIMITED, LIMITED, 'Back again.'])]
        call = self.call()
        await call.start()
        await call.greet()  # (the coordinator's reading had room: nothing said at pickup)
        self.assertIsNone(call.turn)
        await call.answer('Are you there?', None)
        self.assertEqual(call.lines[-1], "(The line, not Juno: Juno can't answer right now: our Claude seat is at its limit until 00:10. "
                                         "What you say is still written down, and Juno follows up after the call.)")
        await call.answer('Hello?', None)
        self.assertIn('still can\'t answer', call.lines[-1])
        await call.answer('Now?', None)
        self.assertEqual(call.lines[-1], 'Juno: Back again.')
        self.assertEqual(len(self.started), 1, 'the same token, the same seat: no new session for nothing')
        call.end()

    async def test_the_worker_moved_the_line_to_a_seat_with_room_mid_turn_so_it_asks_again_there(self):
        """If another seat has room, the call uses it: the worker puts its token here (voiceSeat), and the line's turn
        that hit the limit goes again on a fresh session that knows the call so far. The board hears only the answer."""
        moved = lambda: server.SEAT.write_text('seat with room')
        self.procs = [Proc([LIMITED], then=moved), Proc(['Yes, I will build it.'])]
        call = self.call()
        await call.start()
        await call.answer('Can you build the page?', None)
        self.assertEqual(self.signed, ['seat', 'seat with room'])
        self.assertEqual(call.lines, ['Board: Can you build the page?', 'Juno: Yes, I will build it.'])
        self.assertFalse([e for e in self.events if e.get('type') == 'notice'], 'nothing to say: it answered')
        call.end()

    async def test_a_picture_asked_again_on_the_new_seat_goes_with_it(self):
        """The turn that hit the limit carried a picture: the new session's message carries it again, so HQ hears it was
        seen, never that it was lost."""
        moved = lambda: server.SEAT.write_text('seat with room')
        self.procs = [Proc([LIMITED], then=moved), Proc(['A blue mug.'])]
        png = base64.b64encode(b'\x89PNG\r\n\x1a\n').decode()
        coordinator = self.coordinator
        self.coordinator = lambda method, path, body=None: (
            {'type': 'image/png', 'data': png} if path.startswith('picture?') else coordinator(method, path, body))
        server.hq = self.coordinator
        call = self.call()
        await call.start()
        await call.show(7)
        await call.answer('What is this?', None)
        self.assertEqual(call.lines, ['Board: (shared picture #7 on screen)', 'Board: What is this?', 'Juno: A blue mug.'])
        self.assertEqual([c['type'] for c in self.started[1].heard_messages[0]['content']], ['image', 'text'])
        self.assertEqual([(e['id'], e['state']) for e in self.events if e.get('type') == 'picture'], [(7, 'received'), (7, 'seen')])
        self.assertEqual(call.picture_bytes, len(png))
        call.end()

    async def test_what_the_failed_turn_wrote_before_the_limit_isnt_said_with_the_new_seats_reply(self):
        """The limit came after a few words nobody heard yet (no sentence's end): the new session's reply is said alone."""
        moved = lambda: server.SEAT.write_text('seat with room')
        unfinished = {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'I can'}}}
        self.procs = [Proc([[unfinished, *LIMITED]], then=moved), Proc(['Yes, I can hear you.'])]
        call = self.call()
        await call.start()
        await call.answer('Can you hear me?', None)
        self.assertEqual(self.signed, ['seat', 'seat with room'])
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], ['Yes, I can hear you.'])
        self.assertEqual(call.lines, ['Board: Can you hear me?', 'Juno: Yes, I can hear you.'])
        call.end()

    async def test_a_new_session_doesnt_say_the_old_seats_reset(self):
        """On the line's new seat, a limit with no reset of its own (a bare 429) is said without the old seat's time."""
        bare = [{'type': 'result', 'subtype': 'success', 'is_error': True, 'api_error_status': 429}]
        self.procs = [Proc([LIMITED]), Proc([bare])]
        call = self.call()
        await call.start()
        await call.answer('Are you there?', None)
        self.assertIn('until 00:10', call.lines[-1])
        server.SEAT.write_text('seat with room')
        await call.answer('Hello?', None)
        self.assertEqual(self.signed, ['seat', 'seat with room'])
        self.assertEqual(call.lines[-1], "(The line, not Juno: Juno still can't answer: our Claude seat is at its limit. "
                                         "What you say is written down.)")
        call.end()

    async def test_moved_after_a_notice_the_next_turn_starts_on_the_new_seat(self):
        self.procs = [Proc([LIMITED]), Proc(['I can hear you now.'])]
        call = self.call()
        await call.start()
        await call.answer('Are you there?', None)
        self.assertIn("can't answer", call.lines[-1])
        server.SEAT.write_text('seat with room')
        await call.answer('Hello?', None)
        self.assertEqual((self.signed, call.lines[-1]), (['seat', 'seat with room'], 'Juno: I can hear you now.'))
        self.assertIn({'type': 'notice', 'text': ''}, self.events)
        call.end()

    async def test_no_seat_with_room_is_said_at_pickup_before_the_board_talks(self):
        self.seat_now = {'room': False, 'why': 'limit', 'until': 1909174200000}
        self.procs = [Proc([])]
        call = self.call()
        await call.start()
        await call.greet()
        await call.turn
        words = ("Juno can't answer right now: our Claude seat is at its limit until 00:10. What you say is still written down, "
                 "and Juno follows up after the call.")
        self.assertEqual(call.lines, [f'(The line, not Juno: {words})'])
        self.assertEqual([e for e in self.events if e.get('type') == 'notice'], [{'type': 'notice', 'text': words}])
        self.assertEqual(self.events[-1], {'type': 'state', 'state': 'listening'})
        self.assertTrue(self.audio)
        call.end()


class Socket:
    """HQ's connection to the call screen: `received` comes in (the first by recv(), the rest by iterating), then it
    drops; `sent` is what reached it."""
    def __init__(self, received):
        self.received, self.sent, self.closed = list(received), [], False
        self.request = NS(headers={'Origin': server.ORIGIN})

    async def recv(self):
        return self.received.pop(0)

    async def send(self, message):
        if self.closed:
            raise server.ConnectionClosed(None, None)
        self.sent.append(message)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.received:
            raise server.ConnectionClosed(None, None)
        return self.received.pop(0)


class LiveSocket(Socket):
    """A connection that stays open until the line or the test closes it: put() is what comes in next (after `first`, by
    recv(), or queued first with queued=True: the phone line reads none by recv())."""
    def __init__(self, first, queued=False):
        super().__init__([] if queued else [first])
        self.queue, self.code = asyncio.Queue(), None
        if queued:
            self.put(first)

    def put(self, message):
        self.queue.put_nowait(message)

    async def close(self, code=1000, reason=''):
        if not self.closed:
            self.closed, self.code = True, code if code != 1000 else None
            self.queue.put_nowait(None)

    async def __anext__(self):
        if (message := await self.queue.get()) is None:
            raise StopAsyncIteration
        return message


# A goodbye, then the hang_up tool step, as the CLI streams them
BYE = [{'type': 'stream_event', 'event': {'type': 'message_start', 'message': {}}},
       {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Bye for now! '}}},
       {'type': 'stream_event', 'event': {'type': 'content_block_start', 'content_block': {'type': 'tool_use', 'name': 'mcp__hq__hang_up'}}},
       {'type': 'result', 'subtype': 'success'}]


class Hung(Proc):
    """A call agent that hears the message and writes nothing until it's killed."""
    def __init__(self):
        super().__init__([])
        self.killed = asyncio.Event()

    def heard(self, b):
        if b'"user"' in b:
            self.heard_messages.append(json.loads(b)['message'])

    async def line(self):
        await self.killed.wait()
        return b''

    def kill(self):
        super().kill()
        self.killed.set()


JPEG = base64.b64encode(b'\xff\xd8\xff\xe0 a photo').decode()
DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='  # (a real PNG, 1 px)
PHOTO = lambda n: base64.b64encode(f'\xff\xd8\xff\xe0 photo{n}'.encode('latin-1')).decode()  # (another one, as long)
BROKEN = base64.b64encode(b'\xff\xd8\xff\xe0' + bytes(96)).decode()
BROKEN = BROKEN[:80] + '!' + BROKEN[81:]  # (a JPEG's start, its base64 broken well past its first characters)


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class Pictures(Juno):
    """The board shares pictures on HQ's call screen: the line fetches each from the coordinator (call 7's: #17 a JPEG,
    #18 not base64, #19 a GIF, #20 to #26 more JPEGs, #27 #17's bytes shared again, #28 a JPEG whose base64 breaks
    partway; anything else it refuses), and the
    agent sees them with the board's next words, or on their own after a quiet moment."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.hq, server.hq, self.fetched = server.hq, no_screen(self.coordinator), []
        self.held = {}  # a picture's fetch waits for its threading.Event

    async def asyncTearDown(self):
        server.hq = self.hq
        for release in self.held.values():
            release.set()

    def coordinator(self, method, path, body=None):
        self.fetched.append((method, path))
        if (n := int(path.split('id=')[1].split('&')[0])) in self.held:
            self.held[n].wait(5)
        pictures = {17: ('image/jpeg', JPEG), 18: ('image/jpeg', 'not base64!'), 19: ('image/gif', base64.b64encode(b'GIF89a').decode()),
                    **{n: ('image/jpeg', PHOTO(n)) for n in range(20, 27)}, 27: ('image/jpeg', JPEG),
                    28: ('image/jpeg', BROKEN)}  #.
        for n, (kind, data) in pictures.items():
            if path == f'picture?id={n}&call=7':
                return {'id': n, 'type': kind, 'data': data}
        raise HTTPError(f'http://hq/api/voice/{path}', 404, 'Not Found', {}, None)

    def states(self):
        return [(e['id'], e['state'], e.get('why')) for e in self.events if e['type'] == 'picture']

    async def test_a_picture_shared_while_idle_starts_a_turn_with_it_after_a_quiet_moment(self):
        agent = self.call.brain = server.Agent('juno', 'en')
        agent.proc, agent.call = Proc(['Nice photo of the shop.', "You're welcome."]), 7
        await self.call.show(17)
        self.assertEqual(self.fetched, [('GET', 'picture?id=17&call=7')])
        await self.quiet(40)  # 1.3 s: still waiting for the board to say something
        await asyncio.sleep(0.3)
        self.assertEqual(agent.proc.heard_messages, [])
        await self.quiet(30)
        await asyncio.sleep(0.3)
        await self.settle()
        self.assertEqual(agent.proc.heard_messages[0]['content'], [
            {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': JPEG}},
            {'type': 'text', 'text': "(I've shared a picture on screen.)"}])
        self.assertEqual(self.states(), [(17, 'received', None), (17, 'seen', None)])
        self.assertEqual(self.call.lines, ['Board: (shared picture #17 on screen)', 'Juno: Nice photo of the shop.'])
        await self.quiet(250)  # the reply has played out; the next turn has words only, as before
        await self.talk('Thanks.', 15)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(agent.proc.heard_messages[1]['content'], [{'type': 'text', 'text': 'Thanks.'}])

    async def test_a_picture_shared_before_the_board_talks_goes_with_its_words(self):
        await self.call.show(17)
        await self.call.show(20)
        await self.talk('What do you think of these?', 30)
        await self.quiet(20)
        await self.settle()
        await self.quiet(300)  # long after: no turn of the pictures' own
        await asyncio.sleep(0.3)
        self.assertEqual((self.brain.asked, self.brain.shown), (['What do you think of these?'], [[17, 20]]))
        self.assertEqual(self.call.lines[:2], ['Board: (shared pictures #17, #20 on screen)', 'Board: What do you think of these?'])
        self.assertEqual(self.states()[-2:], [(17, 'seen', None), (20, 'seen', None)])

    async def test_a_picture_the_line_cannot_use_is_refused_and_the_call_goes_on(self):
        for n in (99, 18, 28, 19):  # the coordinator refuses it (not this call's, or the call ended), bad data (at its
            await self.call.show(n)  # start, partway), not a JPEG or PNG
        self.assertEqual(self.states(), [(n, 'failed', 'unreadable') for n in (99, 18, 28, 19)])
        await self.quiet(100)
        await asyncio.sleep(0.3)
        self.assertEqual(self.brain.asked, [])
        await self.talk('Can you check the orders?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual((self.brain.asked, self.brain.shown), (['Can you check the orders?'], [[]]))
        self.assertEqual(self.call.lines[0], 'Board: Can you check the orders?')

    # The agent sees the pictures in the order HQ sent them, whichever fetch ends first: #99 (refused) and #17 are still
    # on their way when #20 is here and the board talks, so #20 waits for them.
    async def test_pictures_reach_the_agent_in_the_order_they_were_shared_whichever_fetch_ends_first(self):
        self.held = {99: threading.Event(), 17: threading.Event()}
        for n in (99, 17, 20):
            asyncio.create_task(self.call.show(n))
        while self.states() != [(20, 'received', None)]:
            await asyncio.sleep(0.01)
        await self.talk('What do you think?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual((self.brain.asked, self.brain.shown), (['What do you think?'], [[]]), '#20 waits for the two before it')
        await self.quiet(250)  # (the reply plays out)
        self.held[17].set()
        while len(self.states()) < 2:
            await asyncio.sleep(0.01)
        await self.quiet(100)
        await asyncio.sleep(0.3)
        self.assertEqual(self.brain.asked, ['What do you think?'], 'still waiting for #99, though #17 and #20 are here')
        self.held[99].set()  # refused: the ones after it go without it
        while len(self.states()) < 3:
            await asyncio.sleep(0.01)
        await self.quiet(70)
        await asyncio.sleep(0.3)
        await self.settle()
        self.assertEqual(self.brain.shown, [[], [17, 20]])
        self.assertEqual(self.states()[:3], [(20, 'received', None), (17, 'received', None), (99, 'failed', 'unreadable')])

    # HQ sends a number again on a new connection until the line answers: #17's 'received' was lost with the old
    # connection, and #20's number never reached the line. The resumed connection hears #17's word again, #20 is
    # fetched, and the agent gets each once.
    async def test_numbers_sent_again_after_a_reconnect_reach_the_agent_once(self):
        old = server.Line(Socket([]))
        old.ws.closed = True
        self.call.send_event = lambda e: old.send(json.dumps(e))
        self.held = {17: threading.Event()}
        fetching = asyncio.create_task(self.call.show(17))
        await asyncio.sleep(0.05)
        await self.call.show(17)  # (sent twice while its fetch is on its way)
        self.held[17].set()
        await fetching
        self.call.live_at = 1.0
        server.CALLS['c1'] = {'call': self.call, 'line': old, 'timer': None}
        resumed = Socket([json.dumps(m) for m in ({'resume': 'c1'}, {'type': 'picture', 'id': 17}, {'type': 'picture', 'id': 20})])
        try:
            await server.app_call(resumed)
            await asyncio.sleep(0.1)
        finally:
            if timer := server.CALLS.pop('c1')['timer']:
                timer.cancel()
        events = [json.loads(m) for m in resumed.sent]
        self.assertEqual([(e['id'], e['state']) for e in events if e['type'] == 'picture'], [(17, 'received'), (20, 'received')])
        self.assertEqual(self.fetched, [('GET', 'picture?id=17&call=7'), ('GET', 'picture?id=20&call=7')])
        self.assertEqual(self.call.picture_bytes, 2 * len(JPEG))
        self.call.send_event = lambda e: asyncio.sleep(0, self.events.append(e))
        await self.talk('What do you think of these?', 30)
        await self.quiet(20)
        await self.settle()
        await self.call.show(17)  # (once more, after the agent has it)
        await self.quiet(300)
        await asyncio.sleep(0.3)
        self.assertEqual(self.brain.shown, [[17, 20]])

    # The board shares a slide while the line is quiet, the picture's own turn is stopped before its request
    # starts (the board talks over it), and the board shares the same slide again. The agent gets it once, with the
    # board's words, and HQ hears 'seen' for both numbers, never "share it again".
    async def test_a_stopped_turns_picture_is_seen_with_the_next_and_the_same_picture_again_goes_once(self):
        agent = self.call.brain = server.Agent('juno', 'en')
        agent.proc, agent.call = Proc([{'subtype': 'error_during_execution', 'is_error': True}, 'It came through.']), 7
        await self.call.show(17)
        await self.quiet(70)
        await asyncio.sleep(0.3)
        await self.settle()
        self.assertEqual(len(agent.proc.heard_messages), 1, "the picture's own turn, stopped before its request")
        self.assertEqual(self.states(), [(17, 'received', None)])
        await self.call.show(27)  # the same slide again
        self.assertEqual(self.states()[1:], [(27, 'received', None)])
        await self.talk('This slide is the worst.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(agent.proc.heard_messages[1]['content'], [{'type': 'text', 'text': 'This slide is the worst.'}])
        self.assertEqual(self.states()[2:], [(17, 'seen', None), (27, 'seen', None)])
        self.assertEqual(self.call.lines[:2], ['Board: (shared picture #17 on screen)', 'Board: This slide is the worst.'])
        self.assertEqual(self.call.picture_bytes, len(JPEG))

    # A picture the line let go (lost with a restarted session) shared again is a new one: it goes to the agent.
    async def test_the_same_picture_after_it_was_lost_goes_again(self):
        await self.call.show(17)
        await self.talk('Look at this.', 30)
        await self.quiet(20)
        await self.settle()
        await self.call.lose_pictures([])
        await self.call.show(27)
        self.assertEqual(self.states(), [(17, 'received', None), (17, 'seen', None), (17, 'failed', 'lost'), (27, 'received', None)])
        await self.quiet(250)
        await self.talk('And again.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(self.brain.shown, [[17], [27]])
        self.assertEqual(self.states()[-1], (27, 'seen', None))

    async def test_at_most_six_pictures_wait_for_a_turn(self):
        for n in range(20, 27):
            await self.call.show(n)
        self.assertEqual(self.states()[-1], (26, 'failed', 'too many'))
        await self.quiet(70)
        await asyncio.sleep(0.3)
        await self.settle()
        self.assertEqual((self.brain.asked, self.brain.shown), (["(I've shared 6 pictures on screen.)"], [list(range(20, 26))]))


# (a real JPEG, 2 x 1 px, whose header the CLI reads: it turns away a picture whose size it can't tell)
GREY = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8A{}//Z'.format
SHOT = lambda version: base64.b64encode(f'\xff\xd8\xff\xe0 screen{version}'.encode('latin-1')).decode()  # (the screen at that version)
BRIEF = 'This is a walk-through: trust the screen.'
MOMENTS = ['#12 17:03:12 tapped "Add to basket" (button)', '#13 17:03:14 page /shop/mug']


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class Screen(Juno):
    """A walk-through: the board shows our pages on its call (call 7). The coordinator's watch-along answers each
    turn's screen-turn from `turns` (a dict, an exception it raises, or a function it runs first), as the coordinator
    does: a picture only when the screen's version isn't the one the line has seen, none while paused, its briefing
    until the session has had it. The screen tool's route (screen) answers from `looks`."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.turns, self.looks, self.asked = [], [], []
        server.hq = self.coordinator

    def coordinator(self, method, path, body=None):
        self.asked.append((path, body))
        if path == 'call-end':
            return None
        answer = (self.turns if path == 'screen-turn' else self.looks).pop(0)
        answer = answer() if callable(answer) else answer
        if isinstance(answer, Exception):
            raise answer
        if path != 'screen-turn' or not answer['on']:
            return answer
        changed = answer['version'] != body['seen'] and not answer['paused'] and body['picture']
        return {**answer, **({'picture': {'type': 'image/jpeg', 'data': SHOT(answer['version'])}} if changed else {}),
                **({} if body['briefed'] else {'brief': BRIEF})}

    def on(self, version, lines, last, paused=False):
        return {'on': True, 'paused': paused, 'lines': lines, 'last': last, 'version': version}

    async def turn(self, words):
        """The board says `words`, and Juno's answer plays out."""
        await self.talk(words, 30)
        await self.quiet(20)
        await self.settle()
        await self.quiet(250)

    def screen_turns(self):
        return [(body['after'], body['seen'], body['briefed']) for path, body in self.asked if path == 'screen-turn']

    async def test_a_turn_brings_the_moments_and_a_picture_of_the_screen_before_the_words(self):
        agent = self.call.brain = server.Agent('juno', 'en')
        agent.proc, agent.call = Proc(['Tap the blue button.', 'Yes.']), 7
        self.turns = [self.on(4, MOMENTS, 13), self.on(4, [], 13)]
        await self.turn('What do I do here?')
        image, words = agent.proc.heard_messages[0]['content']
        self.assertEqual((image['type'], image['source']['data']), ('image', SHOT(4)))
        self.assertTrue(words['text'].startswith(BRIEF), 'the briefing first')
        self.assertLess(words['text'].index(MOMENTS[0]), words['text'].index(MOMENTS[1]))
        self.assertTrue(words['text'].endswith('\n\nWhat do I do here?'), 'the moments before the words')
        self.assertEqual(self.call.lines, [f'Board: (on screen: {MOMENTS[0]}; {MOMENTS[1]}; a picture of the screen went with it)',
                                           'Board: What do I do here?', 'Juno: Tap the blue button.'])
        await self.turn('Done.')  # (the same screen, nothing new: the words alone)
        self.assertEqual(agent.proc.heard_messages[1]['content'], [{'type': 'text', 'text': 'Done.'}])
        self.assertEqual(self.call.lines[3:], ['Board: Done.', 'Juno: Yes.'])
        self.assertEqual([body for path, body in self.asked][0], {'purpose': 'call', 'ref': '7', 'after': 0, 'seen': 0, 'briefed': False,
                                                                     'picture': True})
        self.assertEqual(self.screen_turns(), [(0, 0, False), (13, 4, True)])
        self.assertEqual((self.call.screen['pictures'], self.call.picture_bytes), (1, len(SHOT(4))))

    async def test_pictures_of_the_screen_stop_at_forty_a_call_the_tools_included(self):
        self.looks = [{'picture': {'type': 'image/jpeg', 'data': SHOT(n)}, 'line': f'#{n} 17:00:00 page /'} for n in range(100, 139)]
        for _ in range(39):
            self.assertIn('picture', await self.call.screen_tool({}))
        self.turns = [self.on(1, MOMENTS[:1], 12), self.on(2, MOMENTS[1:], 13), self.on(3, [], 13)]
        for words in ('This one?', 'And this?', 'Still there?'):
            await self.turn(words)
        self.assertEqual(self.brain.shown, [['screen'], [], []])
        self.assertEqual([body['picture'] for path, body in self.asked if path == 'screen-turn'], [True, False, False],
                         'past the count, no picture is asked for')
        self.assertIn(MOMENTS[1], self.brain.asked[1], 'the moments go on')
        self.assertIn(server.SCREEN_WORDS['full'], self.brain.asked[1])
        self.assertEqual(self.brain.asked[2], 'Still there?', 'told once')
        self.assertEqual(await self.call.screen_tool({}), {'error': server.SCREEN_WORDS['full']})
        self.looks = [{'lines': MOMENTS}]
        self.assertEqual(await self.call.screen_tool({'since': '#12'}), {'lines': MOMENTS})
        self.assertEqual(self.call.screen['pictures'], 40)

    async def test_pictures_of_the_screen_stop_within_the_sessions_bytes(self):
        self.turns = [self.on(1, [], 0), self.on(2, [], 0)]
        with unittest.mock.patch.object(server, 'SESSION_BYTES', 2 * len(SHOT(1)) - 1):  # (room for one)
            await self.turn('Look.')
            await self.turn('And now?')
        self.assertEqual(self.brain.shown, [['screen'], []])
        self.assertIn(server.SCREEN_WORDS['full'], self.brain.asked[1])
        self.assertEqual(self.call.picture_bytes, len(SHOT(1)))

    async def test_paused_the_agent_hears_it_once_and_gets_nothing_more_until_it_is_on_again(self):
        self.turns = [self.on(5, ['#14 17:04:00 paused'], 14, paused=True), self.on(5, ['#15 17:04:30 typed in Name'], 15, paused=True),
                      self.on(6, ['#16 17:05:00 resumed'], 16), self.on(6, ['#17 17:06:00 paused'], 17, paused=True)]
        await self.turn('One moment.')
        self.assertEqual(await self.call.screen_tool({}), {'error': server.SCREEN_WORDS['paused']})
        for words in ('Still here.', 'Back.', 'Paused again.'):
            await self.turn(words)
        self.assertEqual(self.brain.shown, [[], [], ['screen'], []])
        first, still, back, again = self.brain.asked
        self.assertIn('#14 17:04:00 paused', first)
        self.assertIn(server.SCREEN_WORDS['paused'], first)
        self.assertEqual(still, 'Still here.', 'nothing more while paused')
        self.assertIn('#16 17:05:00 resumed', back)
        self.assertNotIn(server.SCREEN_WORDS['paused'], back)
        self.assertIn(server.SCREEN_WORDS['paused'], again, 'paused again: told again')
        self.assertNotIn('screen', [path for path, body in self.asked], 'the tool asked nothing while paused')
        self.assertNotIn('Board: (on screen: #15 17:04:30 typed in Name)', self.call.lines)

    async def test_a_restarted_session_gets_the_briefing_and_the_picture_again(self):
        self.turns = [self.on(4, MOMENTS, 13), self.on(4, [], 13)]
        await self.turn('Here.')
        await self.call.restart(self.call.lines)
        await self.turn('Again?')
        self.assertEqual(self.screen_turns(), [(0, 0, False), (13, 0, False)])
        self.assertEqual(self.brain.shown, [['screen'], ['screen']])
        self.assertTrue(self.brain.asked[1].startswith(BRIEF))

    async def test_a_room_asks_by_its_call_out_and_a_phone_call_never_asks(self):
        for phone in (False, True):
            self.call = server.Call(self.call.send_audio, self.call.send_event, self.call.clear, 'juno', 'en',
                                    phone=phone, callout=12, brain=self.brain)
            self.call.transcribe = self.transcribe
            self.turns = [self.on(1, MOMENTS, 13)]
            await self.call.start()
            await self.turn('Hello?')
            self.call.end()
        self.assertEqual([(body['purpose'], body['ref']) for path, body in self.asked if path == 'screen-turn'], [('callout', '12')])
        self.assertIsNone(self.brain.screen, 'no screen tool on the phone')
        self.assertEqual(await self.call.screen_tool({}), {'error': server.SCREEN_WORDS['none']})
        self.assertEqual(self.brain.shown, [['screen'], []])

    async def test_a_turn_asked_again_on_a_new_seat_leaves_the_next_turn_its_picture(self):
        """The turn's session stopped at its seat's limit and the line moved to a seat with room: the fresh session
        has never seen the screen, so the next turn brings its picture again, though nothing changed."""
        self.turns = [self.on(4, MOMENTS, 13), self.on(4, [], 13), self.on(4, [], 13)]
        await self.turn('One.')
        self.brain.reply = [server.Unanswered('limit')]
        self.brain.moved = lambda: setattr(self.brain, 'reply', REPLY) or True  # (the worker moved it: it answers there)
        await self.turn('Two.')
        self.brain.moved = lambda: False
        await self.turn('Three.')
        self.assertEqual(self.screen_turns(), [(0, 0, False), (13, 4, True), (13, 0, False)])
        self.assertEqual([len(shown) for shown in self.brain.shown], [1, 0, 0, 1])

    async def test_a_coordinator_that_fails_or_is_slow_leaves_the_turn_as_it_was(self):
        slow = lambda: threading.Event().wait(0.3) or self.on(1, MOMENTS, 13)
        failed = lambda: HTTPError('http://hq/api/voice/screen-turn', 500, 'Internal Server Error', {}, None)
        self.turns = [failed(), self.on(1, MOMENTS[:1], 12), failed(), ValueError('not JSON'), slow, self.on(2, MOMENTS[1:], 13)]
        with unittest.mock.patch.object(server, 'SCREEN_TURN_SECONDS', 0.05):
            for words in ('One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'):
                await self.turn(words)
        unread = f"({server.SCREEN_WORDS['unread']})\n\n"
        # (before the screen was ever on, nothing; after, the agent hears it wasn't read, and has its moments next time)
        self.assertEqual(self.brain.asked[0], 'One.')
        self.assertEqual(self.brain.asked[2:5], [unread + 'Three.', unread + 'Four.', unread + 'Five.'])
        self.assertIn(MOMENTS[1], self.brain.asked[5])
        self.assertEqual([len(shown) for shown in self.brain.shown], [0, 1, 0, 0, 0, 1])
        self.assertEqual(self.screen_turns(), [(0, 0, False), (0, 0, False), *[(12, 1, True)] * 4])
        self.assertEqual([line for line in self.call.lines if 'on screen' not in line][::2],
                         ['Board: One.', 'Board: Two.', 'Board: Three.', 'Board: Four.', 'Board: Five.', 'Board: Six.'])

    async def test_the_screen_tool_reaches_its_call_through_the_lines_socket(self):
        socket_path = Path(self.tmp.name) / 'screen.sock'
        screens = await server.serve_screens(socket_path)
        self.addAsyncCleanup(screens.wait_closed)
        self.addCleanup(screens.close)
        self.assertEqual(socket_path.stat().st_mode & 0o777, 0o600)
        self.call.new_screen_key()
        self.assertEqual(self.brain.screen, (str(server.SCREEN_SOCKET), self.call.screen_key))
        region = {'x': 0.5, 'y': 0, 'width': 0.5, 'height': 0.5}
        self.looks = [{'picture': {'type': 'image/jpeg', 'data': SHOT(9)}, 'line': MOMENTS[0]}, {'lines': MOMENTS}]
        first = await self.tool(socket_path, self.call.screen_key, {'at': '#12', 'region': region}, {'since': '-2m'})
        self.assertEqual(first, [(False, [{'type': 'image', 'data': SHOT(9), 'mimeType': 'image/jpeg'}, {'type': 'text', 'text': MOMENTS[0]}]),
                                 (False, [{'type': 'text', 'text': '\n'.join(MOMENTS)}])])
        self.assertEqual([body for path, body in self.asked], [{'purpose': 'call', 'ref': '7', 'at': '#12', 'region': region},
                                                               {'purpose': 'call', 'ref': '7', 'since': '-2m'}])
        self.assertEqual((self.call.screen['pictures'], self.call.picture_bytes), (1, len(SHOT(9))))
        old = self.call.screen_key
        await self.call.restart([])  # (a new session, a new key: the old one answers nothing)
        new = self.call.screen_key
        self.call.end()  # (an ended call's neither)
        for key in (old, new):
            self.assertEqual(await self.tool(socket_path, key, {}), [(True, [{'type': 'text', 'text': server.SCREEN_WORDS['gone']}])])
        self.assertEqual(len(self.asked), 2)

    async def test_the_sketch_tool_shows_a_sketch_within_the_calls_bytes_and_never_on_a_call_out(self):
        """The line asks the coordinator's sketch route for its call and counts the picture against the call's bytes; a
        refusal comes back in the coordinator's words; a picture that isn't a PNG whose data decodes fails the tool,
        uncounted; the socket routes a sketch ask to it."""
        png = base64.b64encode(b'\x89PNG\r\n\x1a\n sketch').decode()
        broken = base64.b64encode(b'\x89PNG\r\n\x1a\n' + bytes(96)).decode()
        broken = broken[:80] + '!' + broken[81:]  # (a PNG's start, its base64 broken well past it)
        line = 'Sketch #3 “Tote bag”: drawn 2026-10-24 14:02 UTC, last changed 2026-10-24 15:10 UTC.'
        sketch = {'picture': {'type': 'image/png', 'data': png}, 'line': line}
        refused = HTTPError('http://hq/api/voice/sketch', 404, 'Not Found', {}, io.BytesIO(b'{"error": "No sketch #9."}'))
        self.looks = [sketch, refused, {'picture': {'type': 'image/jpeg', 'data': JPEG}, 'line': line},
                      {'picture': {'type': 'image/png', 'data': broken}, 'line': line}, sketch, sketch]
        start = self.call.picture_bytes
        self.assertEqual(await self.call.sketch_tool({'sketch': 'tote'}), {'picture': sketch['picture'], 'line': line})
        self.assertEqual(await self.call.sketch_tool({'sketch': '9'}), {'error': 'No sketch #9.'})
        for asked in ('mug', 'cap'):  # (a JPEG, not a sketch's PNG; a PNG broken partway)
            with self.assertRaises(ValueError):
                await self.call.sketch_tool({'sketch': asked})
        with unittest.mock.patch.object(server, 'SESSION_BYTES', start + 2 * len(png) - 1):  # (room for one)
            self.assertEqual(await self.call.sketch_tool({'sketch': '3'}), {'error': server.SKETCH_WORDS['full']})
        self.assertEqual(self.call.picture_bytes, start + len(png))
        self.assertEqual(self.call.screen['pictures'], 0, "a sketch isn't a picture of the screen")
        socket_path = Path(self.tmp.name) / 'screen.sock'
        screens = await server.serve_screens(socket_path)
        self.addAsyncCleanup(screens.wait_closed)
        self.addCleanup(screens.close)
        self.call.new_screen_key()
        reader, writer = await asyncio.open_unix_connection(str(socket_path))
        writer.write((json.dumps({'sketch': '3', 'key': self.call.screen_key}) + '\n').encode())
        self.assertEqual(json.loads(await reader.read()), {'picture': sketch['picture'], 'line': line})
        writer.close()
        self.assertEqual([body for path, body in self.asked],
                         [{'call': 7, 'sketch': s} for s in ('tote', '9', 'mug', 'cap', '3', '3')])
        self.call.callout = 12
        self.assertEqual(await self.call.sketch_tool({'sketch': '3'}), {'error': server.SKETCH_WORDS['none']})
        self.assertEqual(len(self.asked), 6, 'nothing asked on a call out')

    async def tool(self, socket_path, key, *calls):
        """hq_tools.py's screen tool as the call agent's CLI runs it, with the line's socket and a session's key: each
        call's (isError, content)."""
        env = guard.agent_env({'PATH': os.environ['PATH']}, 'http://127.0.0.1:9', 3, 'call-token', 'juno', (str(socket_path), key))
        msgs = [{'jsonrpc': '2.0', 'id': i + 1, 'method': 'tools/call', 'params': {'name': 'screen', 'arguments': a}} for i, a in enumerate(calls)]
        proc = await asyncio.create_subprocess_exec(*guard.HQ_TOOLS, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        out, _ = await proc.communicate(''.join(json.dumps(m) + '\n' for m in msgs).encode())
        return [(r['result']['isError'], r['result']['content']) for r in map(json.loads, out.decode().splitlines())]


# The board drawing on its call
NOTES = {41: (2, 'this  feels\nhigh', {'type': 'image/png', 'data': DOT}), 42: (3, '', None),
         43: (4, 'and here', {'type': 'image/jpeg', 'data': BROKEN})}  # (by the note's id: its number, words, picture)
TEACUPS = '/projects/teacups'


@unittest.skipIf(np is None, 'numpy is not installed (see the docstring)')
class BoardDrawing(Juno):
    """The board draws on its own call (call 7): its notes come from the coordinator's note route (`NOTES`, anything else
    a 404), the agent asks to see its screen and rings things on its page, and HQ answers on the call's WebSocket."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.hq, server.hq, self.fetched, self.screen_on = server.hq, self.coordinator, [], False

    async def asyncTearDown(self):
        server.hq = self.hq

    def coordinator(self, method, path, body=None):
        if path == 'screen-turn':
            return {'on': self.screen_on, 'paused': False, 'lines': [], 'last': 0, 'version': 0}
        self.fetched.append(path)
        note_id = int(path.split('id=')[1].split('&')[0])
        if path != f'note?id={note_id}&call=7' or note_id not in NOTES:
            raise HTTPError(f'http://hq/api/voice/{path}', 404, 'Not Found', {}, None)
        n, words, picture = NOTES[note_id]
        return {'n': n, 'words': words, 'url': TEACUPS, 'picture': picture}

    def told(self, kind):
        return [{k: v for k, v in e.items() if k != 'type'} for e in self.events if e['type'] == kind]

    async def turn(self, words):
        await self.talk(words, 30)
        await self.quiet(20)
        await self.settle()
        await self.quiet(250)

    async def quiet_turn(self):
        """The line stays quiet long enough for what waits to go in a turn of its own."""
        await self.quiet(70)
        await asyncio.sleep(0.3)
        await self.settle()
        await self.quiet(250)

    async def test_a_note_goes_to_the_agent_as_a_picture_and_its_words_once_with_the_boards_next_words(self):
        await self.call.note(41)
        await self.call.note(41)  # (HQ sends it again until it hears back: let be)
        self.assertEqual(self.told('note'), [{'id': 41, 'state': 'received'}])
        await self.turn('Is that right?')
        drawn = "(I drew note 2 on HQ's page /projects/teacups, saying “this feels high”: the picture is the page around it, my ink on it.)"
        self.assertEqual((self.brain.asked, self.brain.shown), ([f'{drawn}\n\nIs that right?'], [['note 2']]))
        self.assertEqual(self.call.lines[:2], ['Board: (drew note 2 on /projects/teacups)', 'Board: Is that right?'])
        self.assertEqual(self.call.picture_bytes, len(DOT))
        self.assertEqual(self.fetched, ['note?id=41&call=7'])
        self.assertEqual(self.told('picture'), [], 'HQ hears no picture word for a note')
        await self.call.note(41)
        await self.turn('And now?')
        self.assertEqual(self.brain.shown[1], [], 'once')
        recap = await self.call.lose_pictures([])  # (a restarted session: the recap names it, HQ hears nothing)
        self.assertIn("You can't see the board's note 2 any more", recap)
        self.assertEqual(len(self.events), len([e for e in self.events if e['type'] != 'note']) + 1)

    async def test_notes_drawn_while_the_line_is_quiet_go_in_a_turn_of_their_own_in_their_order(self):
        await self.call.note(42)  # (no picture: its words alone, here none)
        await self.call.note(41)
        await self.quiet_turn()
        self.assertEqual(self.brain.asked, ["(I drew note 3 on HQ's page /projects/teacups.)\n(I drew note 2 on HQ's page "
                                            '/projects/teacups, saying “this feels high”: the picture is the page around it, my '
                                            'ink on it.)'])
        self.assertEqual(self.brain.shown, [['note 2']])
        self.assertEqual(self.call.lines[:2], ['Board: (drew note 3 on /projects/teacups)', 'Board: (drew note 2 on /projects/teacups)'])

    async def test_a_note_whose_picture_doesnt_fit_the_calls_bytes_goes_with_its_words(self):
        with unittest.mock.patch.object(server, 'SESSION_BYTES', len(DOT) - 1):
            await self.call.note(41)
            await self.turn('See?')
        self.assertEqual(self.told('note'), [{'id': 41, 'state': 'received'}])
        self.assertEqual(self.brain.shown, [[]])
        self.assertEqual(self.brain.asked, ["(I drew note 2 on HQ's page /projects/teacups, saying “this feels high”. Its "
                                            "picture didn't fit: the call has had all the pictures it can hold.)\n\nSee?"])
        self.assertEqual(self.call.picture_bytes, 0)

    async def test_a_note_the_line_cannot_read_is_refused_and_told_again_on_resume(self):
        for note_id in (99, 43):  # (not this call's, a picture broken partway)
            await self.call.note(note_id)
        self.assertEqual(self.told('note'), [{'id': 99, 'state': 'failed', 'why': 'unreadable'},
                                             {'id': 43, 'state': 'failed', 'why': 'unreadable'}])
        await self.quiet(100)
        await asyncio.sleep(0.3)
        self.assertEqual(self.brain.asked, [])
        self.events.clear()
        await self.call.retell()
        self.assertEqual(self.told('note'), [{'id': 99, 'state': 'failed', 'why': 'unreadable'},
                                             {'id': 43, 'state': 'failed', 'why': 'unreadable'}])

    async def test_an_ask_to_see_goes_to_hq_and_the_boards_tap_comes_with_the_agents_next_turn(self):
        socket_path = Path(self.tmp.name) / 'screen.sock'
        screens = await server.serve_screens(socket_path)
        self.addAsyncCleanup(screens.wait_closed)
        self.addCleanup(screens.close)
        self.call.new_screen_key()
        reader, writer = await asyncio.open_unix_connection(str(socket_path))
        writer.write((json.dumps({'ask_to_see': "the pricing page", 'key': self.call.screen_key}) + '\n').encode())
        self.assertEqual(json.loads(await reader.read()), {'ok': server.ASK_WORDS['asked'].format(what="the pricing page")})
        writer.close()
        self.assertEqual(self.told('ask'), [{'id': 1, 'what': "the pricing page"}])
        self.assertEqual(await self.call.drawing.ask_tool({'ask_to_see': 'the basket'}),
                         {'error': server.ASK_WORDS['waiting'].format(what="the pricing page")})
        self.call.drawing.asked(7, 'not now')  # (no such ask)
        self.call.drawing.asked(1, 'show')
        self.call.drawing.asked(1, 'not now')  # (answered already)
        await self.turn('There.')
        show = "(They tapped Show on your ask to see the pricing page: their screen comes with their turns from now.)"
        self.assertEqual(self.brain.asked, [f'{show}\n\nThere.'])
        self.assertEqual(await self.call.drawing.ask_tool({'ask_to_see': 'the basket'}), {'ok': server.ASK_WORDS['asked'].format(what='the basket')})
        self.call.drawing.asked(2, 'not now')
        await self.quiet_turn()  # (nothing said: its own turn once the line is quiet)
        self.assertEqual(self.brain.asked[1:], ['(They tapped Not now on your ask to see the basket.)'])
        self.assertEqual(self.told('ask'), [{'id': 1, 'what': "the pricing page"}, {'id': 2, 'what': 'the basket'}])

    async def test_no_ask_while_the_screen_is_shown_or_hq_is_away(self):
        self.screen_on = True
        await self.turn('Here it is.')
        self.assertEqual(await self.call.drawing.ask_tool({'ask_to_see': 'the shop'}), {'error': server.ASK_WORDS['shown']})
        self.screen_on = False
        await self.turn('Stopped.')
        self.call.away = True
        self.assertEqual(await self.call.drawing.ask_tool({'ask_to_see': 'the shop'}), {'error': server.ASK_WORDS['away']})
        self.assertEqual(await self.call.drawing.ink_tool({'draw': {'ring': 'Add'}}), {'error': server.INK_WORDS['away']})
        self.call.reconnected()
        self.assertIn('ok', await self.call.drawing.ask_tool({'ask_to_see': 'the shop'}))
        self.assertEqual(self.told('ask'), [{'id': 1, 'what': 'the shop'}])

    async def ink(self, draw, answer=None):
        """The draw tool's answer, with HQ answering the ring it was sent (`answer`'s fields; None: no answer)."""
        tool = asyncio.create_task(self.call.drawing.ink_tool({'draw': draw}))
        while not tool.done() and len(self.told('ink')) < len(self.inks) + 1:
            await asyncio.sleep(0.01)
        self.inks = self.told('ink')
        if answer is not None:
            self.call.drawing.inked({'type': 'inked', 'id': self.inks[-1]['id'], **answer})
        return await tool

    async def test_a_ring_goes_to_hq_and_the_tool_answers_with_hqs_word(self):
        self.inks = []
        self.assertEqual(await self.ink({'ring': 'Add to basket', 'words': 'this one'}, {'drawn': True}),
                         {'ok': 'Drawn: a ring round “Add to basket” on their page, in your ink, with “this one” beside it. '
                                "It stays on this call's page in the book."})
        self.assertEqual(await self.ink({'note': 2}, {'drawn': False, 'why': 'There is no note 2 on this page.'}),
                         {'error': 'There is no note 2 on this page.'})
        with unittest.mock.patch.object(drawing, 'INK_SECONDS', 0.05):
            self.assertEqual(await self.ink({'ring': 'Basket'}), {'error': server.INK_WORDS['late']})
        self.call.drawing.inked({'type': 'inked', 'id': 3, 'drawn': True})  # (too late: let be)
        self.assertEqual(await self.ink({'ring': 'x', 'note': 2}), {'error': server.INK_WORDS['shape']})
        self.assertEqual(self.inks, [{'id': 1, 'ring': 'Add to basket', 'note': None, 'words': 'this one'},
                                     {'id': 2, 'ring': None, 'note': 2, 'words': ''}, {'id': 3, 'ring': 'Basket', 'note': None, 'words': ''}])
        tool = asyncio.create_task(self.call.drawing.ink_tool({'draw': {'ring': 'Checkout'}}))
        while len(self.told('ink')) < 4:
            await asyncio.sleep(0.01)
        await asyncio.to_thread(self.call.end)  # (hung up while HQ draws it: from the hang-up's thread)
        self.assertEqual(await asyncio.wait_for(tool, 1), {'error': server.INK_WORDS['ended']})

    async def test_hqs_note_tap_and_ring_answer_reach_the_call_on_its_websocket(self):
        old = server.Line(Socket([]))  # (HQ's connection, dropped: what's sent on it is lost)
        old.ws.closed = True
        self.call.live_at = 1.0
        server.CALLS['c1'] = {'call': self.call, 'line': old, 'timer': None}
        self.call.send_event = lambda e: server.CALLS['c1']['line'].send(json.dumps(e))
        self.assertIn('ok', await self.call.drawing.ask_tool({'ask_to_see': 'the shop'}))
        ink = asyncio.create_task(self.call.drawing.ink_tool({'draw': {'ring': 'Add'}}))
        await asyncio.sleep(0.05)
        resumed = Socket([json.dumps(m) for m in ({'resume': 'c1'}, {'type': 'note', 'id': 41}, {'type': 'asked', 'id': 1, 'answer': 'show'},
                                                  {'type': 'inked', 'id': 2, 'drawn': True})])
        try:
            await server.app_call(resumed)
            await asyncio.sleep(0.1)
        finally:
            if timer := server.CALLS.pop('c1')['timer']:
                timer.cancel()
        sent = [json.loads(m) for m in resumed.sent]
        self.assertIn({'type': 'ask', 'id': 1, 'what': 'the shop'}, sent, 'the waiting ask, again on the resumed connection')
        self.assertIn({'type': 'note', 'id': 41, 'state': 'received'}, sent)
        self.assertIn('ok', await ink)
        self.assertTrue(self.call.away, 'the connection dropped')
        self.assertEqual(self.call.drawing.answered, ["(They tapped Show on your ask to see the shop: their screen comes with "
                                                      'their turns from now.)'])

    async def test_no_asks_or_rings_on_a_call_out_or_the_phone(self):
        for callout, phone in ((12, False), (0, True)):
            self.call.callout, self.call.phone = callout, phone
            self.assertEqual(await self.call.drawing.ask_tool({'ask_to_see': 'the shop'}), {'error': server.ASK_WORDS['none']})
            self.assertEqual(await self.call.drawing.ink_tool({'draw': {'ring': 'Add'}}), {'error': server.INK_WORDS['none']})
        self.assertEqual(self.told('ask') + self.told('ink'), [])


@unittest.skipUnless(np is not None and limit_model.installed(), 'needs numpy and the Claude CLI (the worker and the voice image have it)')
class RealCli(unittest.IsolatedAsyncioTestCase):
    """The whole chain against a model API the test runs: the real CLI as the line starts it (guard.TOOLS, agent_env),
    the real Agent.ask and Call.answer."""
    def line(self, url, d):
        """The line's call agent talks to the model at url; the call's events are kept in self.events."""
        saved = server.hq, server.REPO, server.agent_env, server.SEAT, server.now_ms, server.CALL_LOGS, server.LIVE
        self.addCleanup(lambda: [setattr(server, k, v) for k, v in zip(('hq', 'REPO', 'agent_env', 'SEAT', 'now_ms', 'CALL_LOGS', 'LIVE'), saved)])
        server.now_ms = lambda: NOW
        seat = Path(d, 'token')
        seat.write_text('sk-ant-oat01-test')
        server.hq = lambda m, p, b=None: {'prompt': 'You are Juno.', 'token': 't1', 'seat': {'room': True}, 'timeZone': 'Europe/Amsterdam'} \
            if p.startswith('call-context') else None
        server.REPO, server.SEAT, server.CALL_LOGS, server.LIVE = d, seat, Path(d), Path(d)
        server.agent_env = lambda *a: limit_model.cli_env(saved[2](*a), url, d)
        self.events = []
        return server.Call(lambda x: asyncio.sleep(0), lambda e: asyncio.sleep(0, self.events.append(e)), lambda: asyncio.sleep(0), 'juno', 'en')

    # A seat at its limit: a model API that turns every request away as such a seat does (limit_model.py). The line says
    # the reset the CLI read, on the company's clock.
    async def test_the_cli_s_limit_reaches_the_board_as_the_lines_words(self):
        url, stop = limit_model.serve(1909174200)  # 22:10 UTC
        try:
            call = self.line(url, limit_model.tmp())
            await call.start()
            await asyncio.wait_for(call.answer('Are you there?', None), 60)
            await asyncio.wait_for(call.answer('Hello?', None), 60)  # (the session is still up: the same again, shorter)
            call.end()
        finally:
            stop()
        notices = [e['text'] for e in self.events if e.get('type') == 'notice']
        self.assertEqual(notices, ["Juno can't answer right now: our Claude seat is at its limit until 00:10. What you say is still "
                                   "written down, and Juno follows up after the call.",
                                   "Juno still can't answer: our Claude seat is at its limit until 00:10. What you say is written down."])
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], notices)

    async def test_the_call_agent_s_session_records_go_when_its_cli_ends_and_the_log_keeps_numbers_only(self):
        """HQ's transcript is the only copy of a call (audit 2026-10-04, P19): the CLI's own record of the session, every
        word in it, goes with the session, and its turns' numbers reach the log (turns.py)."""
        d, out = limit_model.tmp(), io.StringIO()
        url, stop = limit_model.serve(1909174200)
        saved, server.SESSIONS = server.SESSIONS, Path(d, 'projects')
        try:
            with contextlib.redirect_stdout(out):
                call = self.line(url, d)
                await call.start()
                await asyncio.wait_for(call.answer('Pumpernickel, are you there?', None), 60)
                call.end()
                for _ in range(100):  # (the CLI is killed at the hang-up: watch() forgets its session once it has ended)
                    if 'turn 1' in out.getvalue():
                        break
                    await asyncio.sleep(0.1)
        finally:
            stop()
            server.SESSIONS = saved
        self.assertRegex(out.getvalue(), r'(?m)^[0-9TZ:.-]+ call: session [0-9a-f]{8} turn 1')
        self.assertNotIn('Pumpernickel', out.getvalue())
        self.assertEqual([f for f in Path(d).rglob('*') if f.is_file() and 'Pumpernickel' in f.read_text(errors='replace')], [])

    # A picture's own turn is stopped while its request is on its way (the board talks over it). The CLI keeps
    # the message and sends it with the next turn's request, so the line says the agent has the picture then, and never
    # that it failed.
    async def test_a_picture_whose_turn_was_stopped_goes_with_the_next_request(self):
        bodies, first = [], threading.Event()

        class Model(BaseHTTPRequestHandler):  # holds its first answer back until the test lets it go; then a few words
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
                if not self.path.startswith('/v1/messages') or not body.get('stream') or body.get('max_tokens', 0) < 100:
                    self.send_response(404)  # (the CLI's side requests)
                    return self.end_headers()
                bodies.append(body)
                if len(bodies) == 1:
                    first.wait(30)
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                events = [{'type': 'message_start', 'message': {'id': 'm', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                                                                'content': [], 'usage': {'input_tokens': 2, 'output_tokens': 1}}},
                          {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                          {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'It came through.'}},
                          {'type': 'content_block_stop', 'index': 0},
                          {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 4}},
                          {'type': 'message_stop'}]
                try:
                    self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())
                except OSError:  # (the stopped turn's request: the CLI has gone)
                    pass
        model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        try:
            call = self.line(f'http://127.0.0.1:{model.server_address[1]}', limit_model.tmp())
            await call.start()
            call.pictures = [{'id': 3, 'type': 'image/png', 'data': DOT}]
            turn = asyncio.create_task(call.answer('', None))
            while not bodies:
                await asyncio.sleep(0.05)
            await asyncio.wait_for(call.answer('This slide is the worst.', turn), 60)
            call.end()
        finally:
            first.set()
            model.shutdown()
        images = [[part for m in b['messages'] if m['role'] == 'user' and isinstance(m['content'], list)
                   for part in m['content'] if part.get('type') == 'image'] for b in bodies]
        self.assertEqual([len(i) for i in images], [1, 1], 'the next request has the picture, once')
        self.assertEqual([(e['id'], e['state']) for e in self.events if e['type'] == 'picture'], [(3, 'seen')])

    # hang_up runs in the CLI and its answer goes back to the model, which writes again in the same turn: the goodbye is

    async def goodbye(self, *first):
        bodies, bye = [], {'type': 'text', 'text': 'Thank you, talk soon.'}
        tools = {name: {'type': 'tool_use', 'id': f'toolu_{i}', 'name': name, 'input': {}}  # (mcp__hq__nothing: one the
                 for i, name in enumerate((server.HANG_UP_TOOL, 'mcp__hq__nothing'))}  # CLI doesn't have, an error)

        class Model(BaseHTTPRequestHandler):  # the goodbye and the tools (in the order asked), then the goodbye again
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
                if not self.path.startswith('/v1/messages') or not body.get('stream') or body.get('max_tokens', 0) < 100:
                    self.send_response(404)  # (the CLI's side requests)
                    return self.end_headers()
                bodies.append(body)
                answered = 'tool_result' in json.dumps(body['messages'])
                blocks = [bye] if answered else [bye if b == 'bye' else tools[b] for b in first]
                events = [{'type': 'message_start', 'message': {'id': 'm', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                                                                'content': [], 'usage': {'input_tokens': 2, 'output_tokens': 1}}}]
                for i, b in enumerate(blocks):
                    events += [{'type': 'content_block_start', 'index': i, 'content_block': {**b, 'text': ''} if b is bye else b},
                               {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': b['text']} if b is bye
                                else {'type': 'input_json_delta', 'partial_json': '{}'}},
                               {'type': 'content_block_stop', 'index': i}]
                events += [{'type': 'message_delta', 'delta': {'stop_reason': 'end_turn' if answered else 'tool_use'}, 'usage': {'output_tokens': 9}},
                           {'type': 'message_stop'}]
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())
        model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        try:
            call = self.line(f'http://127.0.0.1:{model.server_address[1]}', limit_model.tmp())
            await call.start()
            await asyncio.wait_for(call.answer('Talk soon.', None), 60)
            call.end()
        finally:
            model.shutdown()
            model.server_close()
        self.assertEqual(len(bodies), 2, 'the tool ran and its answer went back to the model')
        self.assertEqual([e['text'] for e in self.events if e.get('type') == 'said'], ['Thank you, talk soon.'])
        self.assertEqual(call.lines[-1], 'Juno: Thank you, talk soon.')
        self.assertTrue(call.leaving, 'it hangs up')

    async def test_a_walk_through_s_screen_reaches_the_model_and_its_tool_through_the_real_cli(self):
        """A walk-through as the line runs it, with SCREEN_PICTURES at 2: the first turn's picture of the screen and its
        moments in the message, the screen tool's picture through the line's socket in the tool's result, and on the
        next turn, the budget spent, the moments and that pictures have stopped, without one. The CLI's copies of the
        pictures go with the session."""
        d, bodies = limit_model.tmp(), []
        tool = {'type': 'tool_use', 'id': 'toolu_1', 'name': 'mcp__hq__screen', 'input': {'at': '#12'}}

        class Model(BaseHTTPRequestHandler):  # the screen tool first, then a few words on each request after it
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
                if not self.path.startswith('/v1/messages') or not body.get('stream') or body.get('max_tokens', 0) < 100:
                    self.send_response(404)  # (the CLI's side requests)
                    return self.end_headers()
                bodies.append(body)
                block = tool if len(bodies) == 1 else {'type': 'text', 'text': 'The blue button.'}
                delta = ({'type': 'input_json_delta', 'partial_json': json.dumps(tool['input'])} if block is tool
                         else {'type': 'text_delta', 'text': block['text']})
                events = [{'type': 'message_start', 'message': {'id': 'm', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                                                                'content': [], 'usage': {'input_tokens': 2, 'output_tokens': 1}}},
                          {'type': 'content_block_start', 'index': 0, 'content_block': {**block, 'input': {}} if block is tool else {**block, 'text': ''}},
                          {'type': 'content_block_delta', 'index': 0, 'delta': delta}, {'type': 'content_block_stop', 'index': 0},
                          {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if block is tool else 'end_turn'}, 'usage': {'output_tokens': 9}},
                          {'type': 'message_stop'}]
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())
        model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        turns = [{'on': True, 'paused': False, 'lines': MOMENTS, 'last': 13, 'version': 1, 'brief': BRIEF,
                  'picture': {'type': 'image/jpeg', 'data': GREY('D')}},
                 {'on': True, 'paused': False, 'lines': ['#14 17:03:20 typed in Name on the mug'], 'last': 14, 'version': 2,
                  'picture': {'type': 'image/jpeg', 'data': GREY('T')}}]
        asked = []
        saved = server.SCREEN_SOCKET, server.SESSIONS
        self.addCleanup(lambda: [setattr(server, k, v) for k, v in zip(('SCREEN_SOCKET', 'SESSIONS'), saved)])
        server.SCREEN_SOCKET, server.SESSIONS = Path(d, 'screen.sock'), Path(d, 'projects')
        screens = await server.serve_screens(server.SCREEN_SOCKET)
        try:
            call = self.line(f'http://127.0.0.1:{model.server_address[1]}', d)
            context = server.hq

            def coordinator(method, path, body=None):
                asked.append((path, body))
                if path == 'call-context':
                    return {**context(method, path, body), 'call': 7}
                if path == 'screen':
                    return {'picture': {'type': 'image/jpeg', 'data': GREY('L')}, 'line': MOMENTS[0]}
                return turns.pop(0) if path == 'screen-turn' else None
            server.hq = coordinator
            with unittest.mock.patch.object(server, 'SCREEN_PICTURES', 2):
                await call.start()
                await asyncio.wait_for(call.answer('What do I tap?', None), 60)
                await asyncio.wait_for(call.answer('That one?', None), 60)
            # (the CLI's copies of the pictures, where it keeps them: they go with the session)
            copies = lambda: [*server.PICTURE_COPIES.glob(f"claude-*/{re.sub('[^A-Za-z0-9]', '-', d)}/*/images/*"),
                              *Path(d).rglob('*.jpg')]  # (and the tool's, beside the session's records)
            self.assertEqual(len(copies()), 2)
            call.end()
            for _ in range(100):
                if not copies():
                    break
                await asyncio.sleep(0.1)
            self.assertEqual(copies(), [])
        finally:
            screens.close()
            model.shutdown()
            model.server_close()
        self.assertEqual(len(bodies), 3, 'the screen tool ran, and each turn reached the model')
        first, result, second = ([m for m in body['messages'] if m['role'] == 'user'][-1]['content'] for body in bodies)
        words = next(part['text'] for part in first if part['type'] == 'text' and 'What do I tap?' in part['text'])
        self.assertEqual((first[0]['type'], first[0]['source']['data']), ('image', GREY('D')), 'the picture first')
        self.assertTrue(words.startswith(BRIEF) and words.rstrip().endswith('What do I tap?'))
        self.assertIn(MOMENTS[1], words)
        self.assertIn(GREY('L'), json.dumps(result), "the tool's picture reached the model")
        self.assertNotIn('image', [part.get('type') for part in second], 'the budget is spent')
        self.assertIn('#14 17:03:20 typed in Name on the mug', json.dumps(second))
        self.assertIn(server.SCREEN_WORDS['full'], json.dumps(second))
        self.assertEqual([body for path, body in asked if path == 'screen'], [{'purpose': 'call', 'ref': '7', 'at': '#12'}])
        self.assertEqual(call.screen['pictures'], 2)

    async def test_the_goodbye_then_hang_up_says_it_once(self):
        await self.goodbye('bye', server.HANG_UP_TOOL)

    async def test_the_goodbye_another_tool_then_hang_up_says_it_once(self):
        await self.goodbye('bye', 'mcp__hq__nothing', server.HANG_UP_TOOL)

    async def test_hang_up_then_the_goodbye_says_it_once(self):
        await self.goodbye(server.HANG_UP_TOOL)


    async def test_a_call_out_s_note_and_no_transcript_through_the_real_cli(self):
        """A call to a partner, as the line runs it: the partner tools, the opening's words from call-context, and the
        model's note and no_transcript read from the CLI's stream."""
        bodies = []
        steps = [{'type': 'tool_use', 'id': 'toolu_1', 'name': server.NO_TRANSCRIPT_TOOL, 'input': {}, 'json': '{}'},
                 {'type': 'tool_use', 'id': 'toolu_2', 'name': server.NOTE_TOOL, 'input': {}, 'json': '{"what": "Pickup moved to Tuesday"}'}]

        class Model(BaseHTTPRequestHandler):  # both tools, then a few words once their answers are in
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
                if not self.path.startswith('/v1/messages') or not body.get('stream') or body.get('max_tokens', 0) < 100:
                    self.send_response(404)
                    return self.end_headers()
                bodies.append(body)
                answered = 'tool_result' in json.dumps(body['messages'])
                events = [{'type': 'message_start', 'message': {'id': 'm', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
                                                                'content': [], 'usage': {'input_tokens': 2, 'output_tokens': 1}}}]
                if answered:
                    events += [{'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                               {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'Tuesday works for us.'}},
                               {'type': 'content_block_stop', 'index': 0}]
                for i, step in enumerate([] if answered else steps):
                    block = {k: v for k, v in step.items() if k != 'json'}
                    events += [{'type': 'content_block_start', 'index': i, 'content_block': block},
                               {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': step['json']}},
                               {'type': 'content_block_stop', 'index': i}]
                events += [{'type': 'message_delta', 'delta': {'stop_reason': 'end_turn' if answered else 'tool_use'}, 'usage': {'output_tokens': 9}},
                           {'type': 'message_stop'}]
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())
        model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        ended = []
        try:
            d = limit_model.tmp()
            phone = self.line(f'http://127.0.0.1:{model.server_address[1]}', d)
            context = {'prompt': 'You are Juno, calling Print API.', 'token': 't1', 'seat': {'room': True}, 'timeZone': 'Europe/Amsterdam',
                       'opening': OPENING, 'objected': "No problem, I won't keep one.", 'who': 'Print API', 'tools': 'partner', 'callout': 12}
            asked = []
            server.hq = lambda m, p, b=None: (asked.append(b), context)[1] if p == 'call-context' else ended.append(b)
            call = server.Call(phone.send_audio, phone.send_event, phone.clear, 'juno', 'en', phone=True, callout=12)
            await call.start()
            await call.greet()
            SPOKEN.clear()
            call.open('Print API, Sanne speaking.')
            await call.turn
            await asyncio.wait_for(call.answer("I'd rather you didn't keep a transcript. And pickup is Tuesday now.", None), 60)
            call.end()
        finally:
            model.shutdown()
            model.server_close()
        self.assertEqual(asked[0]['callout'], 12)
        self.assertEqual(sorted(bodies[0]['tools'][i]['name'] for i in range(len(bodies[0]['tools']))),
                         [f'mcp__hq__{t}' for t in guard.PARTNER_TOOLS], 'the partner tools, nothing else')
        self.assertIn('The line has said your opening for you', json.dumps(bodies[0]['messages']))
        answers = json.dumps(bodies[1]['messages'])
        self.assertIn('Noted.', answers)
        self.assertIn('no transcript is kept from here', answers)
        self.assertEqual(SPOKEN, [OPENING, "No problem, I won't keep one.", 'Tuesday works for us.'])
        self.assertEqual((call.lines, call.notes), ([], ['Pickup moved to Tuesday']))
        self.assertEqual({k: ended[0][k] for k in ('lines', 'notes', 'objected', 'callout')},
                         {'lines': [], 'notes': ['Pickup moved to Tuesday'], 'objected': True, 'callout': 12})

class Timing(unittest.IsolatedAsyncioTestCase):
    """Agent.ask's timing line, which the daily model check reads: a turn stopped before any words says so, rather than
    logging "first words after 0.0 s" (that would count as the fastest reply of the day)."""
    async def turn(self, events):
        import contextlib, io, json
        lines = [(json.dumps(e) + '\n').encode() for e in events]

        async def readline():
            CLOCK[0] += 1.2  # each event from the session comes 1.2 s after the one before
            return lines.pop(0)
        agent = server.Agent('juno', 'en')
        agent.proc = NS(returncode=None, stdin=NS(write=lambda b: None, drain=lambda: asyncio.sleep(0)),
                        stdout=NS(readline=readline))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            said = [t if isinstance(t, str) else f'[{t.name}]' async for t in agent.ask('Hello?')
                    if t not in (server.DELIVERED, server.RESPONSE)]
        return ''.join(said), out.getvalue().strip()

    async def test_a_reply_logs_when_its_first_words_came(self):
        said, log = await self.turn([{'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Hi.'}}},
                                     {'type': 'result'}])
        self.assertEqual((said, log), ('Hi.', 'call: juno replied, first words after 1.2 s, done after 2.4 s; tokens unknown'))

    def tool(self, name='mcp__hq__job'):  # (the CLI's shape for a tool step's start: test_guard.CallAgent checks it)
        return {'type': 'stream_event', 'event': {'type': 'content_block_start', 'index': 0,
                                                  'content_block': {'type': 'tool_use', 'id': 'toolu_1', 'name': name, 'input': {}}}}

    async def test_a_tool_step_before_the_first_words_says_when_it_started(self):
        said, log = await self.turn([self.tool(), {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Queued.'}}},
                                     {'type': 'result'}])
        self.assertEqual((said, log), ('[mcp__hq__job]Queued.',
                                       'call: juno replied, first words after 2.4 s (after a tool step at 1.2 s), done after 3.6 s; step mcp__hq__job; tokens unknown'))

    async def test_a_tool_step_after_the_first_words_is_not_in_the_line(self):
        said, log = await self.turn([{'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'One moment. '}}},
                                     self.tool('mcp__hq__search'), {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Found it.'}}},
                                     {'type': 'result'}])
        self.assertEqual((said, log), ('One moment. [mcp__hq__search]Found it.', 'call: juno replied, first words after 1.2 s, done after 4.8 s; tokens unknown'))

    async def test_a_turn_stopped_in_a_tool_step_logs_no_words_and_the_step(self):
        said, log = await self.turn([self.tool(), {'type': 'result', 'is_error': True, 'subtype': 'error_during_execution'}])
        self.assertEqual(log, 'call: juno replied with no words, done after 2.4 s (after a tool step at 1.2 s); step mcp__hq__job; tokens unknown')

    async def test_a_turn_stopped_before_any_words_logs_no_words(self):
        said, log = await self.turn([{'type': 'result', 'is_error': True, 'subtype': 'error_during_execution'}])
        self.assertEqual((said, log), ('', 'call: juno replied with no words, done after 1.2 s; tokens unknown'))

    # where a reply's first seconds go
    def start(self, usage=None):
        return {'type': 'stream_event', 'event': {'type': 'message_start', 'message': {'id': 'msg_1', 'usage': usage or {
            'input_tokens': 6, 'cache_read_input_tokens': 18000, 'cache_creation_input_tokens': 420, 'output_tokens': 1}}}}

    def block(self, kind, at='start'):
        return {'type': 'stream_event', 'event': {'type': f'content_block_{at}', 'index': 0, **({'content_block': {'type': kind}} if at == 'start' else {})}}

    async def test_a_reply_says_its_tokens_and_how_long_it_thought_before_its_words(self):
        """Where the first seconds go: the turn's first request's tokens (message_start) and the thinking before the words."""
        said, log = await self.turn([self.start(), self.block('thinking'), self.block('thinking', 'stop'), self.block('text'),
                                     {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Hi.'}}}, {'type': 'result'}])
        self.assertEqual((said, log), ('Hi.', 'call: juno replied, first words after 6.0 s, done after 7.2 s; '
                                              'tokens in 6, cache read 18000, cache write 420; thought 1.2 s from 2.4 s'))

    async def test_no_thinking_says_so_and_thinking_after_the_words_is_not_counted(self):
        said, log = await self.turn([self.start({'input_tokens': 9}), self.block('text'),
                                     {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Hi. '}}},
                                     self.block('thinking'), self.block('thinking', 'stop'), {'type': 'result'}])
        self.assertEqual(log, 'call: juno replied, first words after 3.6 s, done after 7.2 s; tokens in 9, cache read 0, cache write 0; no thinking')

    async def test_thinking_on_both_sides_of_a_tool_step_adds_up_and_the_step_is_named(self):
        said, log = await self.turn([self.start(), self.block('thinking'), self.block('thinking', 'stop'), self.tool('mcp__hq__search'),
                                     self.start({'input_tokens': 99}), self.block('redacted_thinking'), self.block('redacted_thinking', 'stop'),
                                     {'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': 'Found it.'}}}, {'type': 'result'}])
        self.assertEqual(log, 'call: juno replied, first words after 9.6 s (after a tool step at 4.8 s), done after 10.8 s; '
                              'step mcp__hq__search; tokens in 6, cache read 18000, cache write 420; thought 2.4 s from 2.4 s')

    async def test_a_turn_stopped_while_thinking_counts_the_thinking_so_far(self):
        said, log = await self.turn([self.start(), self.block('thinking'), {'type': 'result', 'is_error': True, 'subtype': 'error_during_execution'}])
        self.assertEqual(log, 'call: juno replied with no words, done after 3.6 s; tokens in 6, cache read 18000, cache write 420; thought 1.2 s from 2.4 s')

    async def test_the_cli_s_limit_result_raises_unanswered_with_its_reset(self):
        with self.assertRaises(server.Unanswered) as r:
            await self.turn(LIMITED)
        self.assertEqual((r.exception.why, r.exception.until), ('limit', 1909174200000))
        with self.assertRaises(server.Unanswered) as r:  # (a 429 with no rate_limit_event: a limit, its reset unknown)
            await self.turn([{'type': 'result', 'subtype': 'success', 'is_error': True, 'api_error_status': 429}])
        self.assertEqual((r.exception.why, r.exception.until), ('limit', 0))

    async def test_signed_out_and_other_errors_raise_too_and_only_the_cli_s_signals_count(self):
        signed_out = [{'type': 'assistant', 'error': 'authentication_failed', 'message': {'content': [{'type': 'text', 'text': 'Invalid API key'}]}},
                      {'type': 'result', 'subtype': 'success', 'is_error': True, 'api_error_status': 401}]
        with self.assertRaises(server.Unanswered) as r:
            await self.turn(signed_out)
        self.assertEqual(r.exception.why, 'signin')
        with self.assertRaises(server.Unanswered) as r:
            await self.turn([{'type': 'result', 'subtype': 'error_max_turns', 'is_error': True}])
        self.assertEqual(r.exception.why, 'error')
        # the model writing about a limit is a reply like any other
        said, _ = await self.turn([{'type': 'stream_event', 'event': {'delta': {'type': 'text_delta', 'text': "You've hit your session limit."}}},
                                   {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': "You've hit your session limit."}]}},
                                   {'type': 'result', 'subtype': 'success', 'result': "You've hit your session limit."}])
        self.assertEqual(said, "You've hit your session limit.")


if __name__ == '__main__':
    unittest.main()
