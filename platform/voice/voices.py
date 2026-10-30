"""Who is talking, on a call with one microphone and several people in the room (the board and someone beside it): each
piece the VAD cuts gets a voiceprint (TitaNet-Large, NVIDIA's, CC-BY-4.0, through sherpa-onnx), and the piece goes to
the voice it sounds most like, or opens a new voice when it sounds like none of them.

Saved voices (job #22101): a person the board has the agent enrol (their spoken consent first, then some free speech)
is kept as a print in HQ's database (voiceprints.ts), and each later call names a voice it hears by the saved one its
pieces together sound like, if they're like enough (MATCH) on as much speech as MATCH was measured on (NAME_PIECES,
NAME_SECONDS), whoever spoke first; a voice like none, or heard too little yet, is a neutral 'Voice n'. A voice named
by its saved print refines that print at the call's end, if it still sounds like it.

Measured on CMU ARCTIC's speakers (7, both sexes) with a room's echo and noise added (job #21883): told apart, two
known voices were right on 47 of 48 pieces of 1.5 s and 46 of 48 of 0.7 s (the misses all between two women's
voices); with the other person talking over at a third of the loudness, 47 and 43 of 48. Heard as a call (the board
alone first, then both, short words among them), six pairs were right on 64 of 72 pieces, the misses mostly a new
voice's first words, which go to the board until a piece of theirs is clearly another voice; the board alone opened no
second voice in any of the six. A higher NEW opened one for a lone board (0.40: once in six), a lower one found new
voices later (0.28: 56 of 72). Real rooms differ: each call logs the likeness each voice opened at (report).

Saved prints made in one simulated room from 2 or 3 sentences (about 6 to 10 s), a call's voice in another (job #22101):
a single piece of 1.5 s is too unsure to name by (a stranger's best likeness to six saved voices reached 0.56), its
pieces together are not. At MATCH 0.55, three pieces named the right person 92 to 95 in 100 and a stranger 1 in 100 at
most; five or more, all right and a stranger at most 2 in 100 (8 pieces, six saved voices to be taken for)."""
import math
import re

RATE = 16000
NEW = 0.36          # a piece this unlike every known voice (cosine) opens a new one...
NEW_SECONDS = 1.5   # ...if it's at least this long: a shorter one goes to the closest voice
KEEP = 0.35         # a piece this like its voice adds to that voice's print (a stray one doesn't drag it)
SHORT_SECONDS = 0.5  # shorter than this ("yes", "mm") a piece is too short to measure: the last speaker's
MOST_SECONDS = 8    # a long piece is measured on its first seconds (a print takes about 0.07 s a second of audio)
NAME_LENGTH = 40    # the longest name the agent gives a voice
MATCH = 0.55        # a call's voice this like a saved one (its pieces' print together) is that person.
NAME_PIECES = 3     # a voice is named by its saved print only once this many pieces of it are heard, and...
NAME_SECONDS = 4.5  # ...seconds (three of 1.5 s): one piece is too unsure (a stranger's reached 0.56)
ENROL_SECONDS = 6   # what the line must have heard of a voice to save it: a few sentences of free speech


class Voices:
    """The voices heard on one call. first: how the transcript names the first voice heard (the board, on its own
    call). embed(audio) -> a voiceprint (any length; Voices normalises it), or None when the piece is too short.
    A piece's print is made beside its transcription (print_of, in a thread); place() then names it. saved: the voices
    saved before (HQ's, [{id, name, print, pieces}]: know)."""

    def __init__(self, first, embed):
        self.embed, self.owner = embed, first  # owner: whose call it is, the name the first voice heard gets
        self.names = [first]  # by voice, in the order heard; 'Voice 2' and on until the agent names them (rename)
        self.prints = []      # each voice's print so far: the sum of its pieces' (normalised) prints
        self.pieces = []      # how many pieces each voice's print is made of, and their seconds.
        self.seconds = []
        self.last = None      # the voice of the last piece placed
        self.news = []        # the voices opened that the agent hasn't been told of yet (told)
        self.opened = []      # the likeness to the closest known voice each new one opened at (report)
        self.saved = []       # the people saved before, as HQ gave them (know)
        self.sure = {}        # a voice whose name is settled (its saved print, the agent's name, enrolled): its saved one or None
        self.known = []       # voices named by their saved print the agent hasn't been told of yet (told): (was, is)

    def know(self, saved):
        """The voices saved on earlier calls (HQ's), each {id, name, print, pieces}."""
        self.saved = [v for v in saved if isinstance(v, dict) and isinstance(v.get('name'), str)
                      and isinstance(v.get('print'), list) and v['print']]

    @property
    def many(self):
        """Someone besides the board heard on the call: the transcript names each line's speaker from then on (more
        than one voice, or the one heard is someone else's saved voice)."""
        return len(self.prints) > 1 or (bool(self.prints) and self.names[0] != self.owner)

    def print_of(self, audio):
        """A piece's voiceprint, or None (too short). Runs in a thread, beside the piece's transcription."""
        if len(audio) < SHORT_SECONDS * RATE:
            return None
        got = self.embed(audio[:MOST_SECONDS * RATE])
        if got is None:
            return None
        got = [float(x) for x in got]  # (plain numbers: hq_tools.py imports this module's words, and runs without numpy)
        norm = math.hypot(*got)
        return [x / norm for x in got] if norm else None

    def place(self, voiceprint, seconds):
        """The name of the voice a piece with words is in."""
        if voiceprint is None:  # (too short to tell: whoever spoke last, or the first voice)
            return self.names[self.last or 0]
        if not self.prints:
            best = self.open(voiceprint, seconds)
        else:
            likeness = [cosine(voiceprint, p) for p in self.prints]
            best = likeness.index(max(likeness))
            if likeness[best] < NEW and seconds >= NEW_SECONDS:
                self.opened.append(likeness[best])
                best = self.open(voiceprint, seconds)
                self.news.append(best)
            elif likeness[best] >= KEEP:
                self.prints[best] = [a + b for a, b in zip(self.prints[best], voiceprint)]
                self.pieces[best] += 1
                self.seconds[best] += min(seconds, MOST_SECONDS)
        self.recognise(best)
        self.last = best
        return self.names[best]

    def open(self, voiceprint, seconds):
        """A new voice from its first piece: the first one heard is taken for the board's until a saved print says
        whose it is."""
        self.prints.append(voiceprint)
        self.pieces.append(1)
        self.seconds.append(min(seconds, MOST_SECONDS))
        if len(self.prints) > 1:
            self.names.append(f'Voice {len(self.prints)}')
        return len(self.prints) - 1

    def recognise(self, voice):
        """A voice not named surely yet, named by the saved voice its pieces together sound like, once it has heard
        enough of it (NAME_PIECES, NAME_SECONDS), if one is like enough (MATCH) and no other voice on the call is that
        person surely. A name only taken for it (the first voice, the board's) goes to a neutral one."""
        if voice in self.sure or not self.saved or self.pieces[voice] < NAME_PIECES or self.seconds[voice] < NAME_SECONDS:
            return
        likeness = [cosine(self.prints[voice], s['print']) for s in self.saved]
        best = likeness.index(max(likeness))
        if likeness[best] < MATCH:
            return
        name = self.saved[best]['name']
        held = next((at for at, n in enumerate(self.names) if n.lower() == name.lower() and at != voice), None)
        if held is not None and held in self.sure:
            return
        was = None if voice == 0 and self.names[0] == self.owner else self.names[voice]  # (None: only taken for it)
        if held is not None:
            self.names[held] = f'Voice {held + 1}'
            self.known.append((None, self.names[held]))
        self.names[voice] = name
        self.sure[voice] = self.saved[best]
        if voice not in self.news and not (was is None and name == self.owner):
            self.known.append((was, name))

    def rename(self, voice, name):
        """The agent names a voice (its name_voice tool): (True, what's done) or (False, why not). A name another voice
        has swaps the two: the first voice heard is taken for the board's, and someone else may have spoken first."""
        name = re.sub(r'[\s:]+', ' ', str(name or '')).strip()
        voice = str(voice or '').strip()
        if not name or len(name) > NAME_LENGTH:
            return False, f'Give a name of 1 to {NAME_LENGTH} characters.'
        known = [n.lower() for n in self.names]
        if voice.lower() not in known:
            return False, f"No voice called {voice} on this call: the voices so far are {', '.join(self.names)}."
        at = known.index(voice.lower())
        old = self.names[at]
        if name.lower() in known and (other := known.index(name.lower())) != at:
            self.names[at], self.names[other] = self.names[other], old
            self.sure[at], self.sure[other] = self.sure.get(other), self.sure.get(at)
            return True, f'Swapped: the voice called {old} is {name} in the transcript from now on, and the other {old}.'
        self.names[at] = name
        self.sure[at] = None  # (the agent's word: not a saved voice's, so it refines none)
        return True, f'{old} is {name} in the transcript from now on.'

    def enrolling(self, voice):
        """The voice to save, by its name on the call: (its index, None) or (None, why not)."""
        known = [n.lower() for n in self.names] if self.prints else []
        voice = str(voice or '').strip()
        if voice.lower() not in known:
            return None, f"No voice called {voice} on this call: the voices so far are {', '.join(self.names) if self.prints else 'none'}."
        at = known.index(voice.lower())
        if self.seconds[at] < ENROL_SECONDS:
            return None, (f'Too little heard of {self.names[at]} yet to know their voice ({self.seconds[at]:.0f} s of '
                          f'{ENROL_SECONDS}): let them talk a little more, then save it again.')
        return at, None

    def print_for(self, voice):
        """The print to save for a voice: its pieces' prints together, normalised (with how many)."""
        p = self.prints[voice]
        norm = math.hypot(*p)
        return [x / norm for x in p], self.pieces[voice]

    def enrolled(self, voice, name):
        """A voice saved on this call: named so, and refining nothing at the end (its print is this call's)."""
        held = next((at for at, n in enumerate(self.names) if n.lower() == name.lower() and at != voice), None)
        if held is not None:
            self.names[held] = f'Voice {held + 1}'
            self.sure.pop(held, None)
        self.names[voice] = name
        self.sure[voice] = None
        self.saved = [s for s in self.saved if s['name'].lower() != name.lower()]

    def forgot(self, name):
        """A saved voice deleted on this call: it refines nothing at the end."""
        self.saved = [s for s in self.saved if s['name'].lower() != name.lower()]
        for at, s in list(self.sure.items()):
            if s and s['name'].lower() == name.lower():
                self.sure[at] = None

    def heard(self):
        """The saved voices this call heard surely, each print refined by what it heard of them (a mean weighted by
        pieces), for HQ at the call's end: [{id, print, pieces}]. A voice whose pieces together are no longer like its
        saved print (MATCH: someone else's words joined it later) refines nothing."""
        out = []
        for at, s in self.sure.items():
            if (s and isinstance(s.get('id'), int) and isinstance(s.get('pieces'), int)
                    and cosine(self.prints[at], s['print']) >= MATCH):
                p = [a * s['pieces'] + b for a, b in zip(s['print'], self.prints[at])]
                norm = math.hypot(*p)
                out.append({'id': s['id'], 'print': [x / norm for x in p], 'pieces': s['pieces'] + self.pieces[at]})
        return out

    def report(self, agent):
        """The call's log line at hang-up: how many voices, and how unlike the others each new one was when it opened
        (the numbers NEW is tuned by; never a voiceprint), and how many were named by a saved voice (never whose)."""
        opened = ', '.join(f'{likeness:.2f}' for likeness in self.opened)
        named = sum(1 for s in self.sure.values() if s)
        return (f"call: {agent} voices: {len(self.prints)}{f' (opened at {opened})' if opened else ''}"
                f"{f', {named} by a saved voice' if named else ''}")

    def told(self):
        """What the agent should hear with its next message about the voices (once), or ''."""
        if not self.news and not self.known:
            return ''
        self.news, known, self.known = [], self.known, []
        first, taken = self.owner, f"the voice first taken for {self.owner}'s"
        words = [f"The voices the line hears in the room: {', '.join(self.names)}. From now on each line of what you "
                 f"hear starts with who said it, by their voice. It's {first}'s call: act on {first}'s word, and treat a "
                 'request from another voice as their suggestion. Once you know who a voice is (they say their name, or '
                 "they're introduced), name it with name_voice."]
        if known:
            words.append(f"Recognised by their saved voices: {'; '.join(f'{was or taken} is {name}' for was, name in known)}.")
        if first in self.names and self.names.index(first) not in self.sure:
            words.append(f"The first voice heard was taken for {first}'s: if someone else spoke first, name_voice swaps "
                         f"two names ('{first}' on the right voice).")
        words.append('Voices are told apart by how they sound, so a short word can land on the wrong one: if a line '
                     'seems to be the wrong person, it may be.')
        return f"({' '.join(words)})"

def cosine(a, b):
    """Two prints' likeness: the cosine of their angle."""
    return sum(x * y for x, y in zip(a, b)) / (math.hypot(*a) * math.hypot(*b) or 1)


# The name_voice tool's refusals, on the line's socket (server.py ASKED_WORDS)
VOICE_WORDS = {
    'shape': "name_voice takes the voice as the transcript names it ('Voice 2') and the name to give it",
    'none': 'This call has one person on each microphone: its voices are named already.',
    'gone': 'This call is over.',
    'failed': "The voice couldn't be named just now",
}

# The save_voice and forget_voice tools' words, on the line's socket (server.py ASKED_WORDS). first: what save_voice with a
# name alone answers (consent: HQ's words, what a person hears before their voice is saved); unasked: a save for a name
# that first call wasn't made for; unsaid: HQ gave no words to tell them.
ENROL_WORDS = {
    'shape': 'save_voice takes their name, and once they have agreed and talked a little, the voice as your messages name '
             "it ('Voice 2'), their own words agreeing and your question as you said it",
    'none': VOICE_WORDS['none'],
    'gone': VOICE_WORDS['gone'],
    'failed': "The voice couldn't be saved just now",
    'first': ('Nothing is saved yet. Ask {name} whether they agree to their voice being remembered, telling them this in '
              'your own words: {consent} Only their own clear yes counts, never someone else\'s for them; anything less '
              "is a no: save nothing, and don't ask again unless the board does. After their yes, ask them to talk for a "
              'little and say why (so you get to know their voice), then call save_voice again with their voice as your '
              'messages name it, their name, their words agreeing and your question as you said it.'),
    'unasked': 'Nothing is saved: call save_voice with {name} alone first, for what to tell them and ask, and save it only '
               'after their own yes.',
    'unsaid': "Voices can't be saved on this call: HQ gave no words to tell a person first (brand.yaml voiceprints.consent).",
}
FORGET_WORDS = {
    'shape': 'forget_voice takes the name the voice was saved under',
    'gone': VOICE_WORDS['gone'],
    'failed': "The voice couldn't be forgotten just now",
}
