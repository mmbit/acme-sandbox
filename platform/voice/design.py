"""A design session: the board's call as a brainstorm at the table. The board
starts one with HQ's Design session key (the hello's `design`), or the agent turns a call into one when someone asks
for it (the design_session tool). Its page is a free sketch page in the Notebook (HQ's), and the agent takes part as
one of the people in the room: the words below tell it how, its own judgment does the rest. There are no turns: what
it hears it may let pass in silence, and its replies with no words are fine.

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
from callnotes import PROTOTYPE_NAME

# How long the room stays quiet (past the second idle() waits for the last words) before a raised hand's moment: a
# breath between two people's lines is shorter, a pause to think is longer.
HAND_PAUSE_SECONDS = 1.5
# Made only once they're done: a sentence that sounds finished is often followed
# by more (call #262), the line hands it to the agent at once all the same so a short answer comes quickly, and its
# words are taken back if they go on (Call.cut_in), but a page tool or a build can't be. So in a session what the agent
# makes (MAKES, the line's socket asks) waits until the room is done: quiet MAKE_QUIET seconds since the last words
# (longer after words Smart Turn heard as unfinished), nothing heard still to answer, the pen at rest. Talking on before
# then takes the turn back with their words, nothing is made, and the agent hears the whole thought. The model's own
# time to write the step is mostly that quiet already. At most MAKE_MOST_SECONDS: a room whose noise never stops
# doesn't hold the work for good.
MAKES = {'draw_picture', 'mark_notes', 'change_note', 'try', 'prototype', 'write_down'}
MAKE_QUIET = {'done': 1.5, 'open': 3.0}
MAKE_MOST_SECONDS = 30.0
# A pause Smart Turn hears as unfinished, in a session: people think aloud at the table, so the line waits this long
# for the rest before handing the words to the agent (a call's own wait is WAIT_SECONDS['open']). A finished one goes
# at once.
DESIGN_OPEN_SECONDS = 3.0
MADE_WORDS = ("Not made: they went on talking before it was, so they weren't done asking. You hear their whole thought "
              'with their next words: decide then.')
# The most of a hand's reason the line keeps (HQ shows it under the hand)
ABOUT_LENGTH = 120

# (its line on waiting until someone has really finished)
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
    "- Work nobody is waiting on (the list, a sketch, a prototype mentioned in passing) starts with say_nothing too: "
    "the line plays its tick only while someone waits for your answer. When someone asks you something, answer, and "
    "let the tick tell them you're on it while your tools run.\n"
    "- Listen, and keep the ideas in view: an organised list of the ideas so far on the page, grouped as they grow, "
    "drawn again as it changes (draw_picture, change_note to replace the older one). Sketch an idea yourself when a "
    "drawing says it better than words: small and quick.\n"
    "- Bring your own ideas, and what's been overlooked. Have prototypes built while they talk (prototype with a "
    "brief): a builder takes the few minutes a good one needs in the background, it lands on their iPads, and your "
    "hand goes up for it. They'd rather wait a few minutes for one that's really good than have a thin one at once: "
    "brief it to be worth playing with. Several at once, or a whole product, go to colleagues (job, now: true). Don't "
    "announce a build they asked for in passing; say it's there when your hand's moment comes.\n"
    "- When you have something worth adding and they're talking, never talk over them: raise your hand (raise_hand, "
    "with what it's about) and say nothing more in that reply. The line gives you your moment at a natural pause, or "
    "when they tap your hand. If it no longer fits by then, say nothing: your hand comes down. If someone talks to you, "
    "answer as usual.\n"
    "- Write down no tasks during the session (no write_down, no jobs except prototypes). At the end, when they wrap "
    "up, give the list of ideas, and let them agree together who does what; write down only what they agreed.)"
)
# What the agent hears when its raised hand's moment comes (Call.hand_turn), by how it came
HAND_WORDS = {
    'pause': '(A natural pause now, with your hand raised to add: {about}. Say it now, briefly, if it still fits what '
             "has been said since you raised it; if not, say nothing. Your hand is down.)",
    'tapped': '(They tapped your raised hand: your turn now. You raised it to add: {about}. Say it briefly. Your hand '
              'is down.)',
    # (the line's own hand, for a prototype built in the background: Call.build.)
    'built pause': '(A natural pause now, with your hand up because a prototype you had built is ready: {about}. Say '
                   "briefly that it's on their iPads and what to try first, if it still fits; if not, say nothing: "
                   'its card is on their iPads. Your hand is down.)',
    'built tapped': '(They tapped your raised hand: a prototype you had built is ready: {about}. Say briefly that '
                    "it's on their iPads and what to try first. Your hand is down.)",
}
DESIGN_TOOL_WORDS = {
    'on': 'This call is a design session now: the board\'s screen opens its free sketch page.',
    'already': 'This call is a design session already.',
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
BUILD_EFFORT = os.environ.get('VOICE_BUILD_EFFORT', 'high')
BUILD_SECONDS = 15 * 60
BRIEF_MOST = 4000
# The builder's own briefing: the call agent hands it only the brief (and the version before, for a next one).
BUILD_WORDS = (
    "You build one prototype for a design session in progress: the people in it are talking on while you work, and "
    "the moment it's done it lands on their iPads to play with. They'd rather wait a few minutes for one that's three "
    "times as good than get a thin one in seconds, so take the time it needs, and make it something people show "
    "each other.\n"
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
                "iPads as a card, and your hand goes up for it then. Don't announce it; if someone asks, it's on its "
                "way."),
    'shape': (f'prototype with a brief takes name (at most {PROTOTYPE_NAME} characters: the same name again builds '
              f'its next version from the last one) and brief (what to build and how it should feel, at most '
              f'{BRIEF_MOST} characters).'),
}
# What the agent hears of a build that didn't land
BUILD_FAILED = '({name}, the prototype you had built, failed: {why}. Say so only if someone asks after it.)'
LANGUAGES = {'en': 'English', 'nl': 'Dutch', 'de': 'German'}


def build_ask(name, brief, lang, earlier=None):
    """The builder's message: the brief, the language of the page's words, and the version before (earlier: its page,
    when the call saved one under this name: the next version builds on it)."""
    before = f'\n\nThe version before, to build on (keep what works, make it better):\n{earlier}' if earlier else ''
    return f'Prototype: {name}\nIts words in {LANGUAGES.get(lang, lang)}.\n\n{brief}{before}'


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

    async def raise_hand(self, about, built=''):
        """The hand up, with what it's about as HQ shows it. built: the agent's words on a prototype built for it in
        the background, which the line raised it for. One up for a prototype
        already, the agent hears of that one with its next message."""
        if self.hand and self.hand['built']:
            self.hear_built(self.hand['built'])
        self.hand = {'about': about, 'tapped': False, 'built': built}
        await self.send_event({'type': 'hand', 'up': True, 'about': about})

    async def built(self, name, words):
        """A prototype built in the background is ready (name: as HQ shows it under the hand): the line raises the
        agent's hand for it. Up already for something else, the hand stays as it is, and the agent hears of the
        prototype with its next message. Whether it raised the hand."""
        if self.hand:
            self.hear_built(words)
            return False
        await self.raise_hand(name, built=words)
        return True

    def hear_built(self, words):
        """The agent hears of a prototype built for it with its next message, not at a hand's moment (the hand up for
        something else, or down before its moment)."""
        self.due = '\n'.join(filter(None, (self.due, f'({words} Its card is on their iPads.)')))

    async def lower(self):
        """The hand down (the agent spoke, lowered it, or had its moment). Whether it was up. One up for a prototype
        that comes down before its moment, the agent hears of it with its next message."""
        if not self.hand:
            return False
        if self.hand['built']:
            self.hear_built(self.hand['built'])
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
        kind, about = (f'built {how}', self.hand['built']) if self.hand['built'] else (how, self.hand['about'])
        self.due = '\n'.join(filter(None, (self.due, HAND_WORDS[kind].format(about=about))))
        # so lower() doesn't tell the agent of it a second time
        self.hand['built'] = ''
        await self.lower()
