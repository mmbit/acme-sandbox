"""The board drawing on its own HQ call, the voice line's half.

The board draws with the Pencil on HQ's pages, and each note it draws comes to the line as it lifts the Pencil
(server.py Call.note: the agent gets it as it gets a shared picture, the page around the note as its picture and the
note's words in front of the board's). The agent asks to see the board's screen (ask_to_see) and draws a ring in its own
ink on the board's page (draw): both tools ask through the line's screen socket, as the sketch tool does, and only on
the board's own calls. HQ shows the ask as a card with Show and Not now, which blocks nothing, and draws the ring; it
answers both on the call's WebSocket (server.py app_call: 'asked', 'inked')."""
import asyncio, itertools

# What the agent's words may hold: what it asks to see and what it rings, as HQ's card and the ring's label show them,
# and the few words it writes beside a ring
WHAT_MOST, BESIDE_MOST = 120, 80
# A ring is drawn in the board's browser as soon as HQ finds the words on its page: HQ answers well within this, and the
# agent waits for it mid-reply (the line's tick holds the call), so past it the agent hears HQ didn't answer and says
# what it meant in words instead.
INK_SECONDS = 5
# What the line says to the agent about the board's notes, in front of the board's words (the board's own turn, so in
# its voice), and in a restarted session's recap
NOTE_WORDS = {
    'drawn': "(I drew note {n} on HQ's page {url}{saying}",
    'saying': ', saying “{words}”',
    'picture': ': the picture is the page around it, my ink on it.)',
    'bare': '.)',
    'full': ". Its picture didn't fit: the call has had all the pictures it can hold.)",
    'lost': ("\n(You can't see the board's {notes} any more: they were in the stopped session. They stay on this "
             "call's page in its book: ask the board about them if you need them.)"),
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
# What the agent hears about its rings on the board's page
INK_WORDS = {
    'drawn': 'Drawn: {ring} on their page, in your ink{beside}. It stays on this call\'s page in the book.',
    'ring': 'a ring round “{ring}”',
    'note': 'a ring round their note {note}',
    'beside': ', with “{words}” beside it',
    'late': "HQ didn't answer: the ring may not be on their page. Say what you meant in words.",
    'ended': 'The call ended before HQ drew it.',
    'none': "You can draw only on the board's own calls in HQ.",
    'away': "HQ isn't connected just now (the board's connection dropped): say what you mean in words.",
    'shape': (f'draw takes ring (the words it rings, at most {WHAT_MOST} characters) or note (its number on this '
              f"call's page), not both, and words beside it (at most {BESIDE_MOST} characters)"),
    'gone': "This session can't draw any more: the call ended, or its session was restarted.",
    'failed': "The ring couldn't be drawn just now",
}


def one_line(text):
    return ' '.join(str(text or '').split())


def note_said(entry):
    """A note's line for the agent (its entry with the call's pictures, server.py Call.note), in front of the board's
    words: where the board drew it, what it said, and what its picture is (none: HQ had none, or no room for it)."""
    note = entry['note']
    saying = NOTE_WORDS['saying'].format(words=note['words']) if note['words'] else ''
    end = 'full' if note.get('full') else 'picture' if entry['data'] else 'bare'
    return NOTE_WORDS['drawn'].format(n=note['n'], url=note['url'], saying=saying) + NOTE_WORDS[end]


def notes_lost(numbers):
    """The recap's line on the notes the stopped session saw (their numbers on the call's page), or ''."""
    return NOTE_WORDS['lost'].format(notes=f"note{'s' * (len(numbers) > 1)} {', '.join(numbers)}") if numbers else ''


def what_asked(what):
    """What the agent asks to see, as one line, or None if it isn't one HQ's card can show."""
    what = one_line(what) if isinstance(what, str) else ''
    return what if 0 < len(what) <= WHAT_MOST else None


def ink_asked(draw):
    """A ring the agent asks for ({ring, note, words}: exactly one of ring, the words it rings, and note, its number on
    the call's page), cleaned, or None if it isn't one."""
    if not isinstance(draw, dict) or set(draw) - {'ring', 'note', 'words'}:
        return None
    ring, note, words = draw.get('ring'), draw.get('note'), draw.get('words')
    words = one_line(words) if isinstance(words, str) else '' if words is None else None
    if (ring is None) == (note is None) or words is None or len(words) > BESIDE_MOST:
        return None
    if ring is not None and not (ring := what_asked(ring)) or note is not None and not (type(note) is int and note >= 1):
        return None
    return {'ring': ring, 'note': note, 'words': words}


class Drawing:
    """A call's asks to see the board's screen and its rings on the board's page: what's still waiting for HQ's answer,
    and the board's answers the agent hasn't had yet. The board's notes go with the call's pictures (Call.note)."""
    def __init__(self, call):
        self.call = call
        self.ids = itertools.count(1)  # (asks and rings: HQ dedupes a resent ask by its id)
        self.waiting = None  # the ask the board hasn't answered yet ({id, what}): one at a time
        self.answered = []   # the agent's words on the board's taps, for its next turn
        self.inks = {}       # each ring HQ hasn't answered yet, by its id: the future its answer settles

    def refusal(self, words):
        """Why the agent can't ask or draw on this call now (in `words`), or None. Only the board's own HQ call: on a
        call out the partner's words could steer it (house rule 9), and the phone has no page."""
        call = self.call
        if call.callout or call.phone or not call.brain.call:
            return words['none']
        if call.ended:
            return words['gone']
        return words['away'] if call.away else None

    async def ask_tool(self, asked):
        """The agent's ask_to_see tool (hq_tools.py, through the line's socket): HQ shows the ask, and the tool answers
        at once. Refused where the line can't ask (refusal), with the screen shown already and not paused, and with an
        ask still waiting for the board."""
        if refused := self.refusal(ASK_WORDS):
            return {'error': refused}
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
        """The agent's draw tool (hq_tools.py, through the line's socket): HQ draws the ring on the board's page and says
        it did, or why not; the tool waits for that up to INK_SECONDS. Refused where the line can't draw (refusal)."""
        if refused := self.refusal(INK_WORDS):
            return {'error': refused}
        if not (ink := ink_asked(asked.get('draw'))):
            return {'error': INK_WORDS['shape']}
        ink_id = next(self.ids)
        drawn = self.inks[ink_id] = asyncio.get_running_loop().create_future()
        try:
            await self.call.send_event({'type': 'ink', 'id': ink_id, **ink})
            answer = await asyncio.wait_for(drawn, INK_SECONDS)
        except TimeoutError:
            return {'error': INK_WORDS['late']}
        finally:
            self.inks.pop(ink_id, None)
        if 'error' in answer:
            return answer
        ring = INK_WORDS['ring'].format(ring=ink['ring']) if ink['ring'] else INK_WORDS['note'].format(note=ink['note'])
        beside = INK_WORDS['beside'].format(words=ink['words']) if ink['words'] else ''
        return {'ok': INK_WORDS['drawn'].format(ring=ring, beside=beside)}

    def inked(self, event):
        """HQ's answer to a ring: drawn, or why not, in HQ's words. One for a ring that isn't waiting is let be."""
        drawn = self.inks.get(event.get('id'))
        if drawn and not drawn.done():
            why = one_line(event.get('why')) or INK_WORDS['failed'] + '.'
            drawn.set_result({} if event.get('drawn') is True else {'error': why})

    async def retell(self):
        """A resumed connection hears the ask still waiting again (HQ dedupes it by its id)."""
        if self.waiting:
            await self.call.send_event({'type': 'ask', **self.waiting})

    def end(self):
        """The call ended: the rings still waiting for HQ get their answer now. (From any thread: Call.end runs in one.)"""
        for drawn in list(self.inks.values()):
            drawn.get_loop().call_soon_threadsafe(lambda drawn=drawn: drawn.done() or drawn.set_result(
                {'error': INK_WORDS['ended']}))
