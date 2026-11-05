"""A design session: the board's call as a brainstorm at the table. The board
asks the agent for one, which turns the call into one with its design_session tool, and back into an ordinary call
the same way (HQ's one call key). Its page is a free sketch page in the
Notebook (HQ's), and the agent takes part as one of the people in the room: the words below tell it how, its own
judgment does the rest. There are no turns: what it hears it may let pass in silence, and its replies with no words
are fine.

The raised hand: the agent has something worth adding while the people talk (raise_hand). HQ shows a raised hand in
the call window with a soft beep; the line gives the agent its moment at a natural pause (the room quiet for
HAND_PAUSE_SECONDS, nothing on its way), or at once when someone taps the hand, as a turn of its own (Call.hand_turn).
The hand comes down when the agent speaks, when it lowers it, or once its moment has been given.

Saying nothing: the line hands the agent everything it hears, and a model asked
something writes something back (a stage direction like "(listening)", read aloud). Its say_nothing tool passes the
turn: nothing more of the reply is said, and its tool steps after it play no tick, which is for someone waiting on an
answer (Call.answer).
A prototype built in the background: the prototype tool with a brief instead of a page. A builder of its own (the CLI
once, at BUILD_EFFORT, no tools) takes the minutes a good one needs while the call goes on, the page lands on the iPads
as the agent's would, and the agent's hand goes up for it (Call.build, built)."""
import os, re
from callnotes import PROTOTYPE_ABOUT, PROTOTYPE_NAME

# How long the room stays quiet (past the second idle() waits for the last words) before a raised hand's moment: a
# breath between two people's lines is shorter, a pause to think is longer.
HAND_PAUSE_SECONDS = 1.5
# Made only once they're done (README, Made once they're done; Call.made): the asks that make something, and how long
# the room is quiet first (longer after words Smart Turn heard as unfinished).
MAKES = {'draw_picture', 'mark_notes', 'change_note', 'try', 'prototype', 'write_down'}
MAKE_QUIET_SECONDS = {'done': 1.5, 'open': 3.0}
# Sound with no words in it (a fan, music, a pour) keeps the room from going quiet and takes no turn back, so the wait
# would last as long as the noise while someone waits on what they asked for: past this it's made all the same, and
# the agent hears it was made early (MADE_EARLY_WORDS). A judgment of how long a person waits on a drawing they asked
# for before they take it as unheard, not a measure.
MAKE_MOST_SECONDS = 30.0
# A pause Smart Turn hears as unfinished, in a session: people think aloud at the table, so the line waits this long
# for the rest before handing the words to the agent (a call's own wait is WAIT_SECONDS['open']). A finished one goes
# at once.
DESIGN_OPEN_SECONDS = 3.0
MADE_WORDS = ("Not made: they went on talking before it was, so they weren't done asking. You hear their whole thought "
              'with their next words: decide then.')
MADE_EARLY_WORDS = ("(Made before the room went quiet: they may not have finished. If what they say next asks for "
                    'something else, change it.)')
# The most of a hand's reason the line keeps (HQ shows it under the hand)
ABOUT_LENGTH = 120

# (its line on waiting until someone has really finished)
# (the page's notes, understood later without the session; faults off the page.)
DESIGN_WORDS = (
    "(This call is a design session from now on: a brainstorm with the people in the room, at a table, with you as one "
    "of them. Its page is a free sketch page in the Notebook: everyone draws anywhere on it with their own pen, and you "
    "draw there too (draw_picture).\n"
    "- There are no turns. They mostly talk to each other, not to you: most of what you hear needs no answer, and then "
    "you say nothing at all: call say_nothing, and nothing else is heard. Whatever you write is read aloud, so never a "
    "filler or a stage direction like \"(listening)\". A silence is them thinking or drawing, not a cue for you to "
    "speak.\n"
    "- People often say a whole sentence and then more: a correction, the rest of the idea. Whatever you make (a "
    "drawing, a change on the page, a prototype) waits until the room is quiet a moment, and isn't made if they talk "
    "on: you then hear their whole thought, and act on all of it, never on its first sentence alone. A short answer to "
    "a question put to you needs no wait.\n"
    "- Work nobody is waiting on (the list, a sketch) starts with say_nothing too: "
    "the line plays its tick only while someone waits for your answer. When someone asks you something, answer, and "
    "let the tick tell them you're on it while your tools run.\n"
    "- Listen, and keep the ideas on the page so that someone reading it later, who wasn't here, understands each "
    "one and the vision behind it: per idea or point, a small sketch of it with full sentences of what was said, by "
    "whom, and why, in their terms rather than keywords (draw_picture: a little product page with a date on it, and "
    "\"Mia wants the delivery date on the product page, not at checkout: people who find out late leave, and a date "
    "seen early makes them trust us\"). Group them as they grow; when you reorganise, draw the new notes in place of the old "
    "ones (change_note deletes them), never a second list beside them. The page is about this session's subject: a "
    "fault in our own tools goes on the call's list alone (write_down with page false), not on the page.\n"
    "- Bring your own ideas, and what's been overlooked. Have prototypes built while they talk (prototype with a "
    "brief): a builder takes the few minutes a good one needs in the background, it lands on their iPads, and your "
    "hand goes up for it (or, if it fails, to say why). They'd rather wait a few minutes for one that's really good "
    "than have a thin one at once: brief it to be worth playing with, and brief one idea at its heart (a screen or a "
    "flow to feel), never a whole product: a brief for everything at once runs past the quarter of an hour a build may "
    "take and lands nothing. Several at once, or a whole product, go to colleagues (job, now: true). When you start "
    "one, say so in a sentence; say it's there when your hand's moment comes.\n"
    # (one version per round of feedback, not per remark.)
    "- Feedback on a prototype comes a sentence at a time while they play with it. Gather it: a new version for every "
    "remark, minutes apart, is chaos to follow. Their round on it is done when they've had their say: they move on to "
    "something else, or ask for the new one. Then each prototype that round was about gets one new version with all "
    "of it (its name again, one brief with every change, and about: the change in a line), and you say in a sentence "
    "that you're making it and what goes in (\"I'll put all that into a v3 of Reis A: bigger photos, the cover "
    "first\"). When its hand comes up, say what changed. One remark they want to see straight away (\"make it blue, "
    "let's see it\") is a round of its own. What they say about one while its next version is being built is the "
    "round after it.\n"
    "- When you have something worth adding and they're talking, never talk over them: raise your hand (raise_hand, "
    "with what it's about) and say nothing more in that reply. The line gives you your moment at a natural pause, or "
    "when they tap your hand. If it no longer fits by then, say nothing: your hand comes down. If someone talks to you, "
    "answer as usual.\n"
    "- Write down no tasks during the session (no write_down but a fault's, no jobs except prototypes). At the end, "
    "when they wrap up, give the list of ideas, and let them agree together who does what; write down only what they "
    "agreed.)"
)
# What the agent hears when its raised hand's moment comes (Call.hand_turn), by how it came
HAND_WORDS = {
    'pause': '(A natural pause now, with your hand raised to add: {about}. Say it now, briefly, if it still fits what '
             "has been said since you raised it; if not, say nothing. Your hand is down.)",
    'tapped': '(They tapped your raised hand: your turn now. You raised it to add: {about}. Say it briefly. Your hand '
              'is down.)',
    # (the line's own hand, for a prototype built in the background: Call.build.)
    'built pause': '(A natural pause now, with your hand up because a prototype you had built is ready: {about}. Say '
                   "briefly that it's on their iPads, what changed in a next version, and what to try first, if it "
                   "still fits; if not, say nothing: "
                   'its card is on their iPads. Your hand is down.)',
    'built tapped': '(They tapped your raised hand: a prototype you had built is ready: {about}. Say briefly that '
                    "it's on their iPads, what changed in a next version, and what to try first. Your hand is down.)",
    # (and for one that failed: they're waiting for it.)
    'failed pause': "(A natural pause now, with your hand up because a prototype you had built didn't come: {about}. "
                    "Say briefly that it didn't, why, and what you'll do instead, if it still fits; if not, say "
                    'nothing. Your hand is down.)',
    'failed tapped': "(They tapped your raised hand: a prototype you had built didn't come: {about}. Say briefly that "
                     "it didn't, why, and what you'll do instead. Your hand is down.)",
}
DESIGN_TOOL_WORDS = {
    'on': 'This call is a design session now: the board\'s screen opens its free sketch page.',
    'already': 'This call is a design session already.',
    # (the session switched off: an ordinary call again.)
    'off': 'This call is an ordinary call again, no design session: answer what you hear as usual, without a hand.',
    'not on': 'This call is no design session.',
    'failed': "The call couldn't be made a design session just now",
    'gone': 'The call has ended.',
}
HAND_TOOL_WORDS = {
    'up': "Your hand is raised: they see it and hear a soft beep. Say nothing more in this reply; your moment comes at "
          'a natural pause, or when they tap it.',
    'down': 'Your hand is down.',
    'none': 'Your hand was down already.',
    'shape': 'raise_hand takes what it is about (about), a few words, or down: true to lower it.',
    'failed': "Your hand couldn't be raised just now",
    'gone': 'The call has ended.',
}

# A prototype built in the background (Call.build): the builder's effort, how long one may take before the line gives
# up on it, and the most of a brief.
# (medium: a builder's minutes go to the page, not to thinking before it; at high, a big brief ran past BUILD_SECONDS.
BUILD_EFFORT = os.environ.get('VOICE_BUILD_EFFORT', 'medium')
BUILD_SECONDS = 15 * 60
BRIEF_MOST = 4000
# The builder's own briefing: the call agent hands it only the brief (and the version before, for a next one).
BUILD_WORDS = (
    "You build one prototype for a design session in progress: the people in it are talking on while you work, and "
    "the moment it's done it lands on their iPads to play with. They'd rather wait a few minutes for one that's three "
    "times as good than get a thin one in seconds, but they're waiting minutes, not a quarter of an hour: the line "
    "stops a build after that, and nothing lands. A page of about 30 KB is with them in minutes; one of 60 KB runs "
    "past the quarter hour. So go deep, not wide: the heart of the idea, the moment that makes people show each "
    "other, done really well, with simple stand-ins for the rest of a big brief (a few drawn photos, a book's first "
    "pages).\n"
    "What good is here:\n"
    "- Everything you can tap does something you see, with motion that has weight (easing, overshoot, squash and "
    "stretch), never just a line of text. A pet you feed gets a bowl that empties as it eats, crumbs and a happy face; "
    "stroked, it closes its eyes, purrs and its tail swishes; put to sleep, the room dims and it curls up with Z's "
    "floating up.\n"
    "- It lives between taps: state that changes over time and shows on it (a mood, a meter, a season), small idle "
    "motion (blinking, a glance, a drift), a surprise now and then.\n"
    "- Drawn with care in inline SVG or canvas: a style of its own, a small palette, shapes with character. Not a "
    "form with default buttons.\n"
    "- Sound where it adds (Web Audio, synthesised in code, quiet, started by the first tap).\n"
    "- Its words few, in the language the brief gives.\n"
    "The page: one whole HTML page with everything inline (CSS, script, SVG, data URLs). Nothing outside it loads: no "
    "fonts, scripts or pictures from the web. It fills an iPad in either orientation, held by people at a table, with "
    "big touch targets and no hover-only parts. Never anyone's real details. It's a throwaway: no build step, no "
    "backend, nothing saved past a reload unless the idea needs localStorage.\n"
    "Answer with the page alone, from <!doctype html> to </html>, then one line after it: what to try first, in the "
    "brief's language, a dozen words or so."
)
BUILD_TOOL_WORDS = {
    'started': ("The builder has it and takes the few minutes a good one needs, in the background: it lands on their "
                "iPads as a card, and your hand goes up for it then. If you haven't yet, say in a sentence that it's "
                "being made (a next version: what goes in it)."),
    'shape': (f'prototype with a brief takes name (at most {PROTOTYPE_NAME} characters: the same name again builds '
              f'its next version from the last one), brief (what to build and how it should feel, at most '
              f'{BRIEF_MOST} characters) and about (what a next version changes, one line of at most {PROTOTYPE_ABOUT} '
              f'characters).'),
    # (a next version builds on the last one, so a second one under way beside it would lose the first one's changes.
    'building': ('{name} is still being built, from your last brief for it: what they say about it now is the round '
                 'after that version lands, built on it.'),
}
# What the agent hears of a build that didn't land (its hand's moment: HAND_WORDS failed), and of one that did, when it
# hears with its next message instead (Design.hear_built).
BUILD_FAILED = ("(A prototype you had built didn't come: {about}. They're waiting for it: say so briefly, with why, "
                'when you next speak.)')
BUILT = '({about} Its card is on their iPads.)'
LANGUAGES = {'en': 'English', 'nl': 'Dutch', 'de': 'German'}


def build_ask(name, brief, lang, earlier=None):
    """The builder's message: the brief, the language of the page's words, and the version before (earlier: its page,
    when the call saved one under this name: the next version builds on it)."""
    before = f'\n\nThe version before, to build on (keep what works, make it better):\n{earlier}' if earlier else ''
    return f'Prototype: {name}\nIts words in {LANGUAGES.get(lang, lang)}.\n\n{brief}{before}'


def prototype_key(name):
    """A prototype's name as the store compares it: its name column is SQLite's nocase, which folds ASCII letters only
    (callprototypes.ts: 'reis a' is v2 of 'Reis A', 'één' a prototype of its own beside 'Één')."""
    return name.encode().lower().decode()


class Progress:
    """How far a builder got (Call.builder), from its CLI's stream: when its thinking ended, how much of its answer it
    has written. Read when it's given up on, so the reason says where the minutes went."""

    def __init__(self, start):
        self.start, self.answered, self.thought, self.written = start, None, None, 0

    def seen(self, event, at):
        """One line of the CLI's stream-json (a dict), at the line's clock."""
        e = event.get('event') if event.get('type') == 'stream_event' else None
        if not isinstance(e, dict):
            return
        if e.get('type') == 'message_start' and self.answered is None:
            self.answered = at
        block = e.get('content_block') or {}
        if e.get('type') == 'content_block_start' and block.get('type') == 'text' and self.thought is None:
            self.thought = at
        delta = e.get('delta') or {}
        if e.get('type') == 'content_block_delta' and isinstance(delta.get('text'), str):
            self.written += len(delta['text'].encode())

    def said(self, now):
        """Where it was at now, in a few words."""
        minutes = lambda s: f'{s / 60:.0f} minute{"" if round(s / 60) == 1 else "s"}' if s >= 90 else f'{s:.0f} s'
        if self.answered is None:
            return f'the model never started answering in {minutes(now - self.start)}'
        if self.thought is None:
            return f'it was still thinking after {minutes(now - self.start)}, no page begun'
        return (f'it thought for {minutes(self.thought - self.start)}, then wrote {self.written >> 10} KB of its page in '
                f'{minutes(now - self.thought)}')


def built_page(result):
    """(page, line) from the builder's answer: the page from <!doctype html> to </html>, and its line after it. None
    when there's no whole page in it."""
    page = re.search(r'<!doctype html.*</html>', result, re.I | re.S)
    if not page:
        return None
    line = ' '.join(result[page.end():].split())
    return page.group(0), line[:200]


class Design:
    """One call's design session: whether it is one (on), what the agent still has to hear of it (told), and the
    agent's raised hand (hand: its reason, and whether it was tapped). send_event: HQ's events."""

    def __init__(self, send_event):
        self.send_event = send_event
        self.on = False
        self.news = False  # (the session's words, for the agent's next message: told)
        self.hand = None   # {'about': str, 'tapped': bool} while raised
        self.due = ''      # (the hand's moment's words, for the turn it gives: moment)

    def start(self):
        """The call becomes a design session. Whether it wasn't one yet."""
        if self.on:
            return False
        self.on = self.news = True
        return True

    async def stop(self):
        """The call an ordinary one again, the agent's hand down. Whether it was a design session."""
        if not self.on:
            return False
        await self.lower()
        self.on = self.news = False
        return True

    def fresh(self):
        """A fresh session for the call (the line restarted it): it hears the session's words again."""
        self.news = self.on

    def told(self):
        """What the agent should hear with its next message: the design session's words (once a session), and its
        hand's moment when it has come. Or ''."""
        words = '\n'.join(filter(None, (DESIGN_WORDS if self.news else '', self.due)))
        self.news, self.due = False, ''
        return words

    async def retell(self):
        """A resumed connection hears that this is a design session, and of the hand."""
        if self.on:
            await self.send_event({'type': 'design'})
        if self.hand:
            await self.send_event({'type': 'hand', 'up': True, 'about': self.hand['about']})

    async def raise_hand(self, about, built='', failed=False):
        """The hand up, with what it's about as HQ shows it. built: the agent's words on a prototype built for it in
        the background, which the line raised it for (failed: one that didn't come, and why). One up for a prototype
        already, the agent hears of that one with its next message."""
        if self.hand and self.hand['built']:
            self.hear_built(self.hand['built'], self.hand['failed'])
        self.hand = {'about': about, 'tapped': False, 'built': built, 'failed': failed}
        await self.send_event({'type': 'hand', 'up': True, 'about': about})

    async def built(self, name, words, failed=False):
        """A prototype built in the background is ready, or failed (name: as HQ shows it under the hand; words: what
        the agent hears, with why for one that failed): the line raises the agent's hand for it. Up already for
        something else, the hand stays as it is, and the agent hears of the prototype with its next message. Whether
        it raised the hand."""
        if self.hand:
            self.hear_built(words, failed)
            return False
        await self.raise_hand(name, built=words, failed=failed)
        return True

    def hear_built(self, words, failed=False):
        """The agent hears of a prototype built for it (or one that failed) with its next message, not at a hand's
        moment (the hand up for something else, or down before its moment)."""
        self.due = '\n'.join(filter(None, (self.due, (BUILD_FAILED if failed else BUILT).format(about=words))))

    async def lower(self):
        """The hand down (the agent spoke, lowered it, or had its moment). Whether it was up. One up for a prototype
        that comes down before its moment, the agent hears of it with its next message."""
        if not self.hand:
            return False
        if self.hand['built']:
            self.hear_built(self.hand['built'], self.hand['failed'])
        self.hand = None
        await self.send_event({'type': 'hand', 'up': False})
        return True

    def tapped(self):
        """Someone tapped the hand on the call screen: its moment is now."""
        if self.hand:
            self.hand['tapped'] = True

    async def moment(self):
        """The hand's moment has come: the agent hears it with its next message (told), and the hand is down."""
        how = 'tapped' if self.hand['tapped'] else 'pause'
        built = 'failed' if self.hand['failed'] else 'built'
        kind, about = (f'{built} {how}', self.hand['built']) if self.hand['built'] else (how, self.hand['about'])
        self.due = '\n'.join(filter(None, (self.due, HAND_WORDS[kind].format(about=about))))
        # so lower() doesn't tell the agent of it a second time
        self.hand['built'] = ''
        await self.lower()
