"""The agent driving a piece of work on the board's screen, the voice line's half.

On the board's own HQ call the agent suggests opening a piece of work (open_work: a preview page or one of HQ's
screens) and, once the board has opened it, drives it while it talks (drive: scrolls words into view, scrolls a screen
at a time, points where it aims on its picture of the screen), ringing things with drawing.py's draw. A scroll means a
fresh look before the next ring (drawing.py moved). Both tools ask through the line's screen socket, as
draw does. HQ shows the suggestion as a card with Open and Not now, which blocks nothing, and moves the board's screen;
the board can scroll, draw or take over at any moment, as HQ never blocks its own touch. HQ answers both on the call's
WebSocket (server.py app_call: 'opened', 'driven')."""
import itertools, re

from answers import Answers
from drawing import WHAT_MOST, one_line, refused, spot_asked, what_asked

# What the agent may open: a preview page (HQ's own PREVIEW in platform/hq/shell/desk.js, whose viewer opens it) or one
# of HQ's screens as its deep link (main.js's tools: /?open=jobs&job=<id> and the like). Nothing else reaches HQ.
PREVIEW = re.compile(r'https://[a-z0-9-]+\.preview\.[a-z0-9.-]+(/\S*)?')
HQ_SCREEN = re.compile(r'/\?open=(phone|jobs|projects|book|computer|gazette|intercom)(&\S*)?')
# How the agent scrolls a screen at a time, or to an end of the page
BY = ('down', 'up', 'top', 'bottom')
# HQ moves the board's screen as soon as it finds the words: as with a ring (INK_SECONDS), the agent waits for its answer
# mid-reply, and past this hears HQ didn't answer and says what it meant in words.
DRIVE_SECONDS = 5
# What the agent hears about its suggestions to open a piece of work: the tool's answer, its refusals, and the board's
# tap (or HQ's word that it couldn't open it), in front of its next turn or in a turn of its own once the line is quiet
OPEN_WORDS = {
    'asked': ('Suggested: HQ shows the board your suggestion to open {what}, with Open and Not now. Carry on talking: '
              'their answer comes with a later turn.'),
    'tapped': {
        'open': ("(They tapped Open on {what}: it's on their screen now, and {seen}. drive scrolls and points, draw "
                 'rings.)'),
        'not now': '(They tapped Not now on your suggestion to open {what}.)',
        'failed': "(HQ couldn't open {what} on their screen. {why})",
    },
    'unsaid': "It didn't say why.",
    # (their tap shows their screen too, as Show my screen does)
    'seen': {True: 'you see their screen with it', False: "their screen isn't shown to you"},
    'none': "You can open work on the board's screen only on the board's own calls in HQ.",
    'waiting': 'Your suggestion to open {what} is still waiting for their answer: it comes with a later turn.',
    'away': "HQ isn't connected just now (the board's connection dropped): try again in a moment.",
    'shape': (f'open_work takes what (what the board sees on the card, in a few words, at most {WHAT_MOST} characters) '
              'and address: a preview page (https://<name>.preview.<zone>/...) or one of HQ\'s screens '
              '(/?open=<screen>&..., the screen one of phone, jobs, projects, book, computer, gazette, intercom)'),
    'gone': "This session can't suggest opening anything any more: the call ended, or its session was restarted.",
    'failed': "The suggestion couldn't be sent just now",
}
# What the agent hears about moving the board's screen
DRIVE_WORDS = {
    'done': {
        'to': 'Scrolled: “{words}” should be in view on their screen.',
        'down': 'Scrolled: their screen is a screen further down.',
        'up': 'Scrolled: their screen is a screen further up.',
        'top': 'Scrolled: their screen is at the top of the page.',
        'bottom': 'Scrolled: their screen is at the bottom of the page.',
        'point': 'Pointed: your pointer is where you aimed on their screen.',
    },
    # (after a scroll: what the agent rings, it aims from a fresh picture.)
    'look': 'Look at their screen now (the screen tool) before you point at or ring anything on it.',
    'late': "HQ didn't answer: their screen may not have moved. Say what you meant in words.",
    'ended': 'The call ended before HQ moved their screen.',
    'none': "You can move the board's screen only on the board's own calls in HQ.",
    'away': "HQ isn't connected just now (the board's connection dropped): say what you mean in words.",
    'shape': (f'drive takes one of to (the words to scroll into view, at most {WHAT_MOST} characters), by '
              f'({", ".join(BY)}) or point (x and y: the spot on your latest picture of their whole screen, each a '
              'fraction of the picture from 0 to 1 from its top left)'),
    'gone': "This session can't move the board's screen any more: the call ended, or its session was restarted.",
    'failed': "Their screen couldn't be moved just now",
}


def work_asked(work):
    """A piece of work the agent suggests opening ({what, address}), cleaned, or None if it isn't one HQ opens."""
    if not isinstance(work, dict) or set(work) != {'what', 'address'}:
        return None
    what, address = what_asked(work['what']), work['address']
    if not what or not isinstance(address, str) or not (PREVIEW.fullmatch(address) or HQ_SCREEN.fullmatch(address)):
        return None
    return {'what': what, 'address': address}


def move_asked(drive):
    """A move of the board's screen the agent asks for (exactly one of to, by and point), cleaned, or None if it isn't
    one."""
    if not isinstance(drive, dict) or len(drive) != 1 or not set(drive) <= {'to', 'by', 'point'}:
        return None
    (kind, value), = drive.items()
    if kind == 'by':
        return {kind: value} if value in BY else None
    if kind == 'point':
        return {kind: spot} if (spot := spot_asked(value)) else None
    return {kind: words} if (words := what_asked(value)) else None


class Driving:
    """A call's suggestions to open a piece of work on the board's screen and its moves of that screen: what's still
    waiting for HQ's answer, and the board's answers the agent hasn't had yet."""
    def __init__(self, call):
        self.call = call
        self.ids = itertools.count(1)  # (suggestions and moves: HQ dedupes a resent suggestion by its id)
        self.waiting = None  # the suggestion the board hasn't answered yet ({id, what, url}): one at a time
        self.answered = []   # the agent's words on the board's taps, for its next turn
        self.moves = Answers(DRIVE_WORDS)  # each move HQ hasn't answered yet

    async def open_tool(self, asked):
        """The agent's open_work tool (hq_tools.py, through the line's socket): HQ shows the suggestion, and the tool
        answers at once. Refused where the line can't drive (drawing.refused), and with a suggestion still waiting."""
        if refusal := refused(self.call, OPEN_WORDS):
            return {'error': refusal}
        if not (work := work_asked(asked.get('open_work'))):
            return {'error': OPEN_WORDS['shape']}
        if self.waiting:
            return {'error': OPEN_WORDS['waiting'].format(what=self.waiting['what'])}
        self.waiting = {'id': next(self.ids), 'what': work['what'], 'url': work['address']}
        await self.call.send_event({'type': 'open', **self.waiting})
        return {'ok': OPEN_WORDS['asked'].format(what=work['what'])}

    def opened(self, event):
        """The board tapped Open or Not now, or HQ couldn't open it (why in HQ's words): the agent hears it with its next
        turn, or in a turn of its own once the line is quiet. One for a suggestion that isn't waiting is let be."""
        answer = event.get('answer')
        if not self.waiting or self.waiting['id'] != event.get('id') or answer not in OPEN_WORDS['tapped']:
            return
        why = one_line(event.get('why')) or OPEN_WORDS['unsaid']
        seen = OPEN_WORDS['seen'][event.get('shown') is True]
        self.answered.append(OPEN_WORDS['tapped'][answer].format(what=self.waiting['what'], why=why, seen=seen))
        self.waiting = None
        self.call.nudge()

    def told(self):
        """The board's answers for the agent's turn now (none left after it)."""
        answered, self.answered = self.answered, []
        return '\n'.join(answered)

    async def drive_tool(self, asked):
        """The agent's drive tool (hq_tools.py, through the line's socket): HQ moves the board's screen and says it did,
        or why not; the tool waits for that up to DRIVE_SECONDS. Refused where the line can't drive (drawing.refused),
        and a point once the agent has moved the board's screen since its last picture of it: aimed from that picture,
        it would miss (drawing.py moved)."""
        if refusal := refused(self.call, DRIVE_WORDS):
            return {'error': refusal}
        if not (move := move_asked(asked.get('drive'))):
            return {'error': DRIVE_WORDS['shape']}
        (kind, value), = move.items()
        if kind == 'point' and self.call.drawing.moved:
            return {'error': DRIVE_WORDS['look']}
        answer = await self.moves.ask(self.call, {'type': 'drive', 'id': next(self.ids), **move}, DRIVE_SECONDS)
        if 'error' in answer:
            return answer
        done = DRIVE_WORDS['done'][value if kind == 'by' else kind].format(words=value)
        scrolled = kind != 'point'
        if scrolled:
            self.call.drawing.moved = True
        return {'ok': ' '.join(filter(None, (done, answer['said'], scrolled and DRIVE_WORDS['look'])))}

    def driven(self, event):
        """HQ's answer to a move: done (maybe with a word on how, as when it scrolled to words off their screen), or why
        not, in HQ's words. One for a move that isn't waiting is let be."""
        self.moves.answer(event.get('id'), event.get('done') is True, one_line(event.get('why')))

    async def retell(self):
        """A resumed connection hears the suggestion still waiting again (HQ dedupes it by its id)."""
        if self.waiting:
            await self.call.send_event({'type': 'open', **self.waiting})

    def end(self):
        """The call ended: the moves still waiting for HQ get their answer now. (From any thread: Call.end runs in one.)"""
        self.moves.end()
