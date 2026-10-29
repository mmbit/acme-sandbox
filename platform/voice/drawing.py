"""The board drawing on its own HQ call, the voice line's half.

The board draws with the Pencil on HQ's pages, and each note it draws comes to the line as it lifts the Pencil
(server.py Call.note: the agent gets it as it gets a shared picture, the page around the note as its picture and the
note's words in front of the board's). It's for the agent, which makes a scrap of it only if it judges it worth keeping,
and HQ keeps its ink drawn until the agent's turn on it is done (server.py Call.scribbled; the board, call 161.). The agent asks to see the board's screen (ask_to_see) and draws a ring in its own
ink on the board's screen (draw), aimed from its picture of that screen: it says where on the picture, and HQ draws the
ring exactly there, never choosing a target itself (the AI decides, not an algorithm). Both
tools ask through the line's screen socket, as the sketch tool does, and only on the board's own calls. HQ shows the ask
as a card with Show and Not now, which blocks nothing, and draws the ring; it answers both on the call's WebSocket
(server.py app_call: 'asked', 'inked'). A ring only catches the board's eye: it follows what it's on as the board
scrolls and goes with it, and with the call; it's never kept."""
import itertools

from answers import Answers

# What the agent's words may hold: what it asks to see and what it rings, as HQ's card and the ring's label show them,
# and the few words it writes beside a ring
WHAT_MOST, BESIDE_MOST = 120, 80
# A ring is drawn in the board's browser as soon as HQ has it: HQ answers well within this, and the agent waits for it
# mid-reply (the line's tick holds the call), so past it the agent hears HQ didn't answer and says what it meant in
# words instead.
INK_SECONDS = 5
# What the line says to the agent about the board's notes, in front of the board's words (the board's own turn, so in
# its voice), and in a restarted session's recap
NOTE_WORDS = {
    'drawn': "(I drew note {n} on HQ's page {url}{saying}",
    'saying': ', saying “{words}”',
    'picture': ': the picture is the page around it, my ink on it.)',
    'bare': '.)',
    'full': ". Its picture didn't fit: the call has had all the pictures it can hold.)",
    'lost': ("\n(You can't see the board's {notes} any more: they were in the stopped session. A scrap can still be "
             "cut from them: ask the board what they showed if you need to.)"),
}
# What the agent hears about its asks to see the board's screen: the tool's answer, its refusals, and the board's tap,
# in front of the agent's next turn (or in a turn of its own once the line is quiet)
ASK_WORDS = {
    'asked': ('Asked: HQ shows the board your ask to see {what}, with Show and Not now. Carry on talking: their answer '
              'comes with a later turn.'),
    'show': '(They tapped Show on your ask to see {what}: their screen comes with their turns from now.)',
    'not now': '(They tapped Not now on your ask to see {what}.)',
    'none': "You can ask to see the screen only on the board's own calls in HQ.",
    'shown': ('Their screen is shown already: it comes with each of their turns, and the screen tool looks closer. '
              'Ask only once they stop showing it.'),
    'waiting': 'Your ask to see {what} is still waiting for their answer: it comes with a later turn.',
    'away': "HQ isn't connected just now (the board's connection dropped): try again in a moment.",
    'shape': f'what is the one thing you want to see, in a few words (at most {WHAT_MOST} characters)',
    'gone': "This session can't ask any more: the call ended, or its session was restarted.",
    'failed': "The ask couldn't be sent just now",
}
# What the agent hears about its rings on the board's screen
INK_WORDS = {
    'drawn': ("Drawn: a ring where you aimed on their screen, in your ink{beside}. It follows what it's on as they "
              "scroll, and goes when that does or the call ends. {told}"),
    'beside': ', with “{words}” beside it',
    'late': "HQ didn't answer: the ring may not be on their screen. Say what you meant in words.",
    'ended': 'The call ended before HQ drew it.',
    'none': "You can draw only on the board's own calls in HQ.",
    'away': "HQ isn't connected just now (the board's connection dropped): say what you mean in words.",
    'shape': (f'draw takes at (the box to ring on your latest picture of their whole screen: x, y, width and height, '
              f'each a fraction of the picture from 0 to 1 from its top left) and words beside it (at most '
              f'{BESIDE_MOST} characters)'),
    # (scroll it into view, look again, aim from that picture.)
    'moved': ("You moved their screen since your last picture of it: look at it now (the screen tool) and aim from "
              'that picture.'),
    'gone': "This session can't draw any more: the call ended, or its session was restarted.",
    'failed': "The ring couldn't be drawn just now",
}
# A spot on the picture of the board's whole screen, as fractions of its width and height from its top left (the
# screen tool's region is in the same terms)
SPOT = ('x', 'y')
BOX = ('x', 'y', 'width', 'height')


def one_line(text):
    return ' '.join(str(text or '').split())


# What the line adds about a note the book's judge read (the coordinator's bookjudge.ts, with the note: bookcalls.ts
# forVoice), and the line about what changed on one later (server.py Call.note_news).
VERDICT_WORDS = {
    'answer': " (The board's note asks for an answer: write it on the page with answer_note, and say it if it helps.)",
    'try': (" (The board's note asks to see it made: a try run is making a few versions for real, on a page right after "
            "this call's, which the sketch tool shows by the word 'tries'.{landed})"),
    'landed': ' Landed so far: {names}.',
    # (the version the board ringed or ticked on its page.)
    'picked': " The board picked “{name}”: that's the one to build.",
    'news': "(News on note {n}, on HQ's page {url}.)",
}


def verdict_said(note):
    """The line on a note's verdict and the versions landed so far (its entry's note), or '' for none."""
    reply = (note.get('verdict') or {}).get('reply')
    if reply == 'answer':
        return VERDICT_WORDS['answer']
    picked = VERDICT_WORDS['picked'].format(name=note['picked']) if note.get('picked') else ''
    if reply != 'try':
        return f' ({picked[1:]})' if picked else ''
    names = ', '.join(f'“{name}”' for name in note.get('versions') or [] if name)
    return VERDICT_WORDS['try'].format(landed=(VERDICT_WORDS['landed'].format(names=names) if names else '') + picked)


def note_said(entry):
    """A note's line for the agent (its entry with the call's pictures, server.py Call.note), in front of the board's
    words: where the board drew it, what it said, and what its picture is (none: HQ had none, or no room for it), and
    what the book's judge made of it; or, for news on a note it has (Call.note_news), that alone."""
    note = entry['note']
    if note.get('news'):
        return VERDICT_WORDS['news'].format(n=note['n'], url=note['url']) + verdict_said(note)
    saying = NOTE_WORDS['saying'].format(words=note['words']) if note['words'] else ''
    end = 'full' if note.get('full') else 'picture' if entry['data'] else 'bare'
    return NOTE_WORDS['drawn'].format(n=note['n'], url=note['url'], saying=saying) + NOTE_WORDS[end] + verdict_said(note)


def notes_lost(numbers):
    """The recap's line on the notes the stopped session saw (their numbers on the call's page), or ''."""
    return NOTE_WORDS['lost'].format(notes=f"note{'s' * (len(numbers) > 1)} {', '.join(numbers)}") if numbers else ''


def what_asked(what):
    """What the agent asks to see, as one line, or None if it isn't one HQ's card can show."""
    what = one_line(what) if isinstance(what, str) else ''
    return what if 0 < len(what) <= WHAT_MOST else None


def fraction(value):
    return type(value) in (int, float) and 0 <= value <= 1


def spot_asked(spot):
    """A spot on the picture of the board's screen ({x, y}, fractions), or None if it isn't one."""
    if not isinstance(spot, dict) or set(spot) != set(SPOT) or not all(fraction(spot[k]) for k in SPOT):
        return None
    return {k: float(spot[k]) for k in SPOT}


def box_asked(box):
    """A box on the picture of the board's screen ({x, y, width, height}, fractions), inside it and with some size, or
    None if it isn't one."""
    if not isinstance(box, dict) or set(box) != set(BOX) or not all(fraction(box[k]) for k in BOX):
        return None
    box = {k: float(box[k]) for k in BOX}
    inside = box['x'] + box['width'] <= 1.0001 and box['y'] + box['height'] <= 1.0001
    return box if inside and box['width'] > 0 and box['height'] > 0 else None


def ink_asked(draw):
    """A ring the agent asks for ({at, words}: the box it aims at on its picture of the board's screen, and the words
    beside it), cleaned, or None if it isn't one."""
    if not isinstance(draw, dict) or set(draw) - {'at', 'words'}:
        return None
    words = draw.get('words')
    words = one_line(words) if isinstance(words, str) else '' if words is None else None
    if not (at := box_asked(draw.get('at'))) or words is None or len(words) > BESIDE_MOST:
        return None
    return {'at': at, 'words': words}


def refused(call, words):
    """Why the agent can't ask, draw or drive on this call now (in `words`), or None. Only the board's own HQ call: on
    a call out the partner's words could steer it (house rule 9), and the phone has no page. (Shared with driving.py.)"""
    if call.callout or call.phone or not call.brain.call:
        return words['none']
    if call.ended:
        return words['gone']
    return words['away'] if call.away else None


class Drawing:
    """A call's asks to see the board's screen and its rings on the board's page: what's still waiting for HQ's answer,
    and the board's answers the agent hasn't had yet. The board's notes go with the call's pictures (Call.note)."""
    def __init__(self, call):
        self.call = call
        self.ids = itertools.count(1)  # (asks and rings: HQ dedupes a resent ask by its id)
        self.waiting = None  # the ask the board hasn't answered yet ({id, what}): one at a time
        self.answered = []   # the agent's words on the board's taps, for its next turn
        self.inks = Answers(INK_WORDS)  # each ring HQ hasn't answered yet
        # The agent moved the board's screen (driving.py) since its last picture of the whole of it: it looks before it
        # rings or points (a zoom is no such picture: server.py screen_tool)
        self.moved = False

    async def ask_tool(self, asked):
        """The agent's ask_to_see tool (hq_tools.py, through the line's socket): HQ shows the ask, and the tool answers
        at once. Refused where the line can't ask (refused), with the screen shown already and not paused, and with an
        ask still waiting for the board."""
        if refusal := refused(self.call, ASK_WORDS):
            return {'error': refusal}
        if not (what := what_asked(asked.get('ask_to_see'))):
            return {'error': ASK_WORDS['shape']}
        if self.call.screen['on'] and not self.call.screen['paused']:
            return {'error': ASK_WORDS['shown']}
        if self.waiting:
            return {'error': ASK_WORDS['waiting'].format(what=self.waiting['what'])}
        self.waiting = {'id': next(self.ids), 'what': what}
        await self.call.send_event({'type': 'ask', **self.waiting})
        return {'ok': ASK_WORDS['asked'].format(what=what)}

    def asked(self, ask_id, answer):
        """The board tapped Show or Not now on the ask: the agent hears it with its next turn, or in a turn of its own
        once the line is quiet. An answer to an ask that isn't waiting is let be (HQ's resend of one already had)."""
        if not self.waiting or self.waiting['id'] != ask_id or answer not in ('show', 'not now'):
            return
        self.answered.append(ASK_WORDS[answer].format(what=self.waiting['what']))
        self.waiting = None
        self.call.nudge()

    def told(self):
        """The board's answers for the agent's turn now (none left after it)."""
        answered, self.answered = self.answered, []
        return '\n'.join(answered)

    async def ink_tool(self, asked):
        """The agent's draw tool (hq_tools.py, through the line's socket): HQ draws the ring where the agent aimed on its
        picture of the board's screen and says it did, or why not; the tool waits for that up to its call's ink_seconds
        (INK_SECONDS). Refused where the line can't draw (refused), and once the agent has moved the board's screen
        since its last picture of it: aimed from that picture, the ring would miss."""
        if refusal := refused(self.call, INK_WORDS):
            return {'error': refusal}
        if not (ink := ink_asked(asked.get('draw'))):
            return {'error': INK_WORDS['shape']}
        if self.moved:
            return {'error': INK_WORDS['moved']}
        answer = await self.inks.ask(self.call, {'type': 'ink', 'id': next(self.ids), **ink}, self.call.limits.ink_seconds)
        if 'error' in answer:
            return answer
        beside = INK_WORDS['beside'].format(words=ink['words']) if ink['words'] else ''
        return {'ok': INK_WORDS['drawn'].format(beside=beside, told=answer['said']).strip()}

    def looked(self):
        """The agent has a picture of the board's whole screen as it is now: it aims from that."""
        self.moved = False

    def inked(self, event):
        """HQ's answer to a ring: drawn (with what HQ says of it), or why not, in HQ's words. One for a ring that isn't
        waiting is let be."""
        self.inks.answer(event.get('id'), event.get('drawn') is True, one_line(event.get('why')))

    async def retell(self):
        """A resumed connection hears the ask still waiting again (HQ dedupes it by its id)."""
        if self.waiting:
            await self.call.send_event({'type': 'ask', **self.waiting})

    def end(self):
        """The call ended: the rings still waiting for HQ get their answer now. (From any thread: Call.end runs in one.)"""
        self.inks.end()
