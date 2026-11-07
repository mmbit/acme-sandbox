"""A design session: the board's call as a brainstorm at the table. The board
asks the agent for one, or the call is one in all but name, and the agent turns it into one with its design_session
tool, and back into an ordinary call the same way (HQ's one call key). Its page is a free sketch page in the
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
A prototype built from a brief: the prototype tool with a brief instead of a page. A colleague builds it as a job (the
coordinator's callbuilds.ts), followed and steered from the call as any job it queued, its placeholder on the call's
page at once; it lands on their screens as the agent's would, and the agent's hand goes up for it (Call.built,
Design.built)."""
import re
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
# (the page's notes, understood later without the session, one per topic as the talk goes; faults off the page:
# (the hand never explained to them)
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
    "- Listen, and keep the ideas on the page as the talk goes, so that someone reading it later, who wasn't here, "
    "understands each one and the vision behind it. Each topic gets a note of its own (draw_picture), drawn once the "
    "talk has settled it or moved on to the next, never saved up for one note at the end with everything crammed in: "
    "a session that went from the poster's two layers to who it's for and then to its print size has three notes on "
    "its page by then, not one. Note more rather than less: per topic full sentences of what was said, by whom, and "
    "why, in their terms rather than keywords, with a small sketch of it where one helps (a little product page with "
    "a date on it, and \"Mia wants the delivery date on the product page, not at checkout: people who find out late "
    "leave, and a date seen early makes them trust us\"). A topic that comes back gets its note redrawn with what's "
    "new (change_note deletes the old one); group them as they grow, and when you reorganise, draw the new notes in "
    "place of the old ones, never a second list beside them. The page is about this session's subject: a "
    "fault in our own tools goes on the call's list alone (write_down with page false), not on the page.\n"
    "- Bring your own ideas, and what's been overlooked. Have prototypes built while they talk (prototype with a "
    "brief): a colleague builds it as a job, its placeholder is on the page at once with their face, and it lands on "
    "their screens, your hand going up for it (or, if it fails, to say why). Make what they ask for, at the size they "
    "picture it: an infographic or a poster is one still picture, made in about a minute, that they then work on "
    "round by round; a screen to feel is that one screen. Never a bigger thing than asked (an animation for an "
    "infographic): what they want more of, they ask for next round. Brief one idea at its heart, never a whole "
    "product, and choose who builds it and how (by, lighter, effort) by what it is: a still picture or a small change "
    "goes quick and light. Several at once, or a whole product, go to colleagues (job, now: true). When you start "
    "one, say so in a sentence, and say it's there when your hand's moment comes. They know how the hand works: never "
    "tell them it will go up, or that you'll say when it's there. While it's built you can see how it goes "
    "(activity, with its job), and what they say about it then goes straight to its builder: prototype again under "
    "its name with the change, so they never wait for a version they've already seen a flaw in.\n"
    # (one version per round of feedback, not per remark.)
    "- Feedback on a prototype comes a sentence at a time while they play with it. Gather it: a new version for every "
    "remark, minutes apart, is chaos to follow. Their round on it is done when they've had their say: they move on to "
    "something else, or ask for the new one. Then each prototype that round was about gets one new version with all "
    "of it (its name again, one brief with every change, and about: the change in a line), and you say in a sentence "
    "that you're making it and what goes in (\"I'll put all that into a v3 of Reis A: bigger photos, the cover "
    "first\"). When its hand comes up, say what changed. One remark they want to see straight away (\"make it blue, "
    "let's see it\") is a round of its own. What they say about one while its next version is being built goes into "
    "that version, if it's still being built.\n"
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
                   "briefly that it's on their screens, what changed in a next version, and what to try first, if it "
                   "still fits; if not, say nothing: its card is on their screens. Your hand is down.)",
    'built tapped': '(They tapped your raised hand: a prototype you had built is ready: {about}. Say briefly that '
                    "it's on their screens, what changed in a next version, and what to try first. Your hand is "
                    'down.)',
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

# A prototype built from a brief (the coordinator's callbuilds.ts): the most of a brief, and how the agent asks for one.
BRIEF_MOST = 4000
EFFORTS = ('low', 'medium', 'high')
BUILD_TOOL_WORDS = {  # (said in the call's language, nothing of the hand)
    'started': ("If you haven't yet, say in a sentence, in the call's language, that it's being made (a next "
                "version: what goes in it), and nothing of the hand."),
    'shape': (f'prototype with a brief takes name (at most {PROTOTYPE_NAME} characters: the same name again builds '
              f'its next version from the last one, or, while it is still being built, goes to its builder), brief '
              f'(what to build and how it should feel, at most {BRIEF_MOST} characters), about (what a next version '
              f'changes, one line of at most {PROTOTYPE_ABOUT} characters), and if you like by (who builds it: a '
              f"colleague's id), lighter (true: on their lighter model) and effort ({', '.join(EFFORTS)})."),
}
# What the agent hears of a build that didn't land (its hand's moment: HAND_WORDS failed), and of one that did, when it
# hears with its next message instead (Design.hear_built).
BUILD_FAILED = ("(A prototype you had built didn't come: {about}. They're waiting for it: say so briefly, with why, "
                'when you next speak.)')
BUILT = '({about} Its card is on their screens.)'
LANGUAGES = {'en': 'English', 'nl': 'Dutch', 'de': 'German'}


def build_asked(given):
    """A brief to build, as the coordinator takes it (callbuilds.ts build), or None when it isn't one."""
    name, brief, about = (given.get(k, '') for k in ('name', 'brief', 'about'))
    if set(given) - {'name', 'brief', 'about', 'by', 'lighter', 'effort'} or not all(
            isinstance(v, str) for v in (name, brief, about)):
        return None
    name, brief, about = ' '.join(name.split()), brief.strip(), ' '.join(about.split())
    if not 0 < len(name) <= PROTOTYPE_NAME or not 0 < len(brief) <= BRIEF_MOST or len(about) > PROTOTYPE_ABOUT:
        return None
    by, lighter, effort = given.get('by'), given.get('lighter'), given.get('effort')
    if by is not None and not (isinstance(by, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', by)) or \
            lighter is not None and not isinstance(lighter, bool) or effort is not None and effort not in EFFORTS:
        return None
    return {'name': name, 'brief': brief, **({'about': about} if about else {}), **({'by': by} if by else {}),
            **({'lighter': True} if lighter else {}), **({'effort': effort} if effort else {})}


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
