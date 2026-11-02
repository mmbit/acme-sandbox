"""A call's notes, its page in the board's Notebook, the voice line's half.

On its turn the agent writes down what the board said and drew, one note per change (write_down): the change in the
agent's words with the board's why, and by default a picture of the part of one of the board's own notes on this call,
or of its shown screen at a moment, that the change is about. The coordinator's Ink store cuts the picture and puts the
note in the call's notes (ink/callnotes.ts), where the board sees it appear as it's written, and on the call's list;
the call's follow-up hands it out. A note with no picture is the agent's words alone on a post-it. The agent works the
notes as the board does too: reads them (read_notes), draws on them (mark_notes) and changes, moves or deletes what's
there (change_note), none of it a step the board's Undo takes back (only the board's own are), puts a drawing of its own
in them as a picture (draw_picture), and has versions of a note made for the board to pick from (try). title_notes
names their topic, after the call's date and time, and the agent is reminded every few turns until it has. Only on the
board's own HQ call.
The call engine's halves (drawing.py, driving.py, the screen tool) know nothing of the notes: this reads them, never the
other way round."""
import asyncio
import json
import re
from urllib.error import HTTPError

from drawing import box_asked, one_line

# The most of an item's line and of its goal, a note's words and goal among them: the coordinator's ledger.ts WHAT and
# GOAL, which every hand-off and note from a call keeps to. hq_tools reads them here. The most of the page's topic is
# callnotes.ts TOPIC_MOST: 21 characters after the call's date and time are whole in the Notebook's bar on an iPad mini.
WHAT, GOAL, TOPIC_MOST = 200, 300, 21
# A note's time and the work under way it's about (hq_tools.py timed_refusal), as the coordinator takes them
TIMED = {'deadline': str, 'board_set': bool, 'job': int, 'deliverable': str}
# Where a note's picture is cut from: one of the board's notes on the call ('note 3'), or a moment of its shown screen
FROM = re.compile(r'^(note\s*#?[0-9]{1,4}|now|-[0-9]{1,4}[sm]|[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?|#[0-9]{1,6})$', re.I)
# What the agent hears about its notes and their title
WRITE_DOWN_WORDS = {
    'shape': (f"write_down takes words (the one thing to be done, at most {WHAT} characters), goal (why the board "
              f"wants it, at most {GOAL} characters), owner (who sees it through) if you know it, deadline, board_set, "
              f"job and deliverable as their descriptions say, and for a "
              f"picture both from ('note 3': one of the board's own notes on this call; or a moment of its shown "
              f"screen: 'now', '-20s', '17:03:12', '#12') and region (the part of that picture the change is about: x, "
              f"y, width and height, fractions from 0 to 1 from its top left), or neither for your words alone"),
    'none': "There are no notes on this call: only the board's own calls in HQ have them.",
    'gone': "This session can't write in the call's notes any more: the call ended, or its session was restarted.",
    'failed': "The note couldn't be written just now",
}
TITLE_WORDS_SAID = {
    'shape': (f'title is what the call is about in at most {TOPIC_MOST} characters ("Shop page prices"): the '
              "Notebook puts the call's date and time in front of it"),
    'none': WRITE_DOWN_WORDS['none'],
    'gone': WRITE_DOWN_WORDS['gone'],
    'failed': "The notes couldn't be titled just now",
}
# Every so many of the board's turns, until the agent has titled the notes, a line in front of the board's words
# reminds it to
REMIND_EVERY = 3
TITLE_REMINDER = ("(The call's notes have no title yet: once it's clear what this call is about, give them one with "
                  'title_notes.)')


def note_asked(a):
    """A note the agent writes down ({from?, region?, words, goal, owner?, deadline?, board_set?, job?, deliverable?}: a
    crop from and region both, or a plain note with neither; its time and the work it's about as hq_tools checks them),
    cleaned, or None if it isn't one."""
    if not isinstance(a, dict) or set(a) - {'from', 'region', 'words', 'goal', 'owner', *TIMED}:
        return None
    words = one_line(a.get('words')) if isinstance(a.get('words'), str) else ''
    goal = one_line(a.get('goal')) if isinstance(a.get('goal'), str) else ''
    owner = a.get('owner')
    if not 0 < len(words) <= WHAT or not 0 < len(goal) <= GOAL:
        return None
    if owner is not None and not (isinstance(owner, str) and re.fullmatch(r'[a-z0-9-]{1,40}', owner)):
        return None
    if any(k in a and not isinstance(a[k], kind) for k, kind in TIMED.items()):
        return None
    timed = {k: a[k] for k in TIMED if k in a}
    asked = {'words': words, 'goal': goal, **({'owner': owner} if owner else {}), **timed}
    if 'from' not in a and 'region' not in a:
        return asked
    source = one_line(a.get('from')) if isinstance(a.get('from'), str) else ''
    if not FROM.match(source) or not (region := box_asked(a.get('region'))):
        return None
    return {'from': source, 'region': region, **asked}


# The agent working the page as the board does (the coordinator's ink/callpage.ts): reading it, a mark on it, one thing
# on it changed
MARKS = ('rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight')
PAGE_WORDS = {
    'shape': 'read_notes takes nothing',
    'none': WRITE_DOWN_WORDS['none'],
    'gone': WRITE_DOWN_WORDS['gone'],
    'failed': "The notes couldn't be read just now",
}
MARK_WORDS = {  # (a note's px)
    'shape': (f"mark_notes takes mark (one of {', '.join(MARKS)}), around (the note it goes on, a number as read_notes "
              "gives it; without it the mark is a drawing of its own), box ({x, y, width, height} in the note's px) "
              "for a rect, ellipse or highlight not round its contents; points ([[x, y], ...] in the note's px) for a "
              "line or arrow (from and to), a pen line or a highlight along them; filled (true) for a rect or ellipse"),
    'none': WRITE_DOWN_WORDS['none'],
    'gone': WRITE_DOWN_WORDS['gone'],
    'failed': "The mark couldn't be made just now",
}
CHANGE_WORDS = {  # (after)
    'shape': (f"change_note takes id (a note's number, as read_notes gives it) and one of words (your own note's new "
              f"words, at most {WHAT} characters), after (the number of the note it goes right after) "
              "and delete (true)"),
    'none': WRITE_DOWN_WORDS['none'],
    'gone': WRITE_DOWN_WORDS['gone'],
    'failed': "The notes couldn't be changed just now",
}

# The board asks to see a few versions of something on the page: its owner makes them in a try run (the coordinator's
# booktry.ts), and each lands under it
TRY_WORDS = {
    'shape': (f"try takes id (a note's number, as read_notes or write_down gives it) and why (the board's ask, "
              f"in one plain line of at most {WHAT} characters)"),
    'none': WRITE_DOWN_WORDS['none'],
    'gone': WRITE_DOWN_WORDS['gone'],
    'failed': "The try couldn't be started just now",
}

# A drawing of the agent's own (a diagram, a chart) put on the page as a picture in the company's look (the coordinator's
# drawing.ts), and that picture back for the agent to check
DRAW_WORDS = {
    'shape': 'draw_picture takes svg: one drawing, from <svg viewBox="0 0 640 480"> to its </svg>',
    'none': WRITE_DOWN_WORDS['none'],
    'gone': WRITE_DOWN_WORDS['gone'],
    'failed': "The drawing couldn't be put in the notes just now",
}


def drawing_asked(a):
    """The drawing the agent gives ({svg}), as the coordinator takes it, or None if it isn't one."""
    if not isinstance(a, dict) or set(a) != {'svg'} or not isinstance(a['svg'], str):
        return None
    svg = a['svg'].strip()
    return {'svg': svg} if svg.startswith('<svg') and svg.endswith('</svg>') else None


def number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e6


def mark_asked(a):
    """A mark the agent asks for ({mark, around?, box?, points?, filled?}), as the coordinator takes it, or None if it
    isn't one (the coordinator says which part's missing for the mark)."""
    if not isinstance(a, dict) or set(a) - {'mark', 'around', 'box', 'points', 'filled'} or a.get('mark') not in MARKS:
        return None
    if 'around' in a and not (isinstance(a['around'], int) and a['around'] > 0):
        return None
    box = a.get('box')
    if box is not None and not (isinstance(box, dict) and set(box) == {'x', 'y', 'width', 'height'}
                                and all(number(v) for v in box.values())):
        return None
    points = a.get('points')
    if points is not None and not (isinstance(points, list) and len(points) <= 500 and all(
            isinstance(p, list) and len(p) == 2 and all(number(v) for v in p) for p in points)):
        return None
    if 'filled' in a and not isinstance(a['filled'], bool):
        return None
    return dict(a)


def change_asked(a):
    """One change the agent asks for on the page ({id, words | after | delete}), cleaned, or None if it isn't one."""
    if not isinstance(a, dict) or set(a) - {'id', 'words', 'after', 'delete'} or not isinstance(a.get('id'), int):
        return None
    how = set(a) - {'id'}
    if len(how) != 1:
        return None
    if 'words' in a:
        words = one_line(a['words']) if isinstance(a['words'], str) else ''
        return {'id': a['id'], 'words': words} if 0 < len(words) <= WHAT else None
    if 'after' in a:
        after = a['after']
        ok = isinstance(after, int) and not isinstance(after, bool) and after > 0
        return {'id': a['id'], 'after': after} if ok else None
    return {'id': a['id'], 'delete': True} if a['delete'] is True else None


def try_asked(a):
    """Versions the agent asks for ({id, why}), cleaned, or None if it isn't that."""
    if not isinstance(a, dict) or set(a) != {'id', 'why'} or not isinstance(a['id'], int) or a['id'] < 1:
        return None
    why = one_line(a['why']) if isinstance(a['why'], str) else ''
    return {'id': a['id'], 'why': why} if 0 < len(why) <= WHAT else None


def title_asked(title):
    """The page's topic the agent gives, as one line, or None if it isn't a short one."""
    title = one_line(title) if isinstance(title, str) else ''
    return title if 0 < len(title) <= TOPIC_MOST else None


def said_back(err):
    """The coordinator's own words in a refusal ({error}), or ''."""
    try:
        return str(json.loads(err.read() or 'null').get('error') or '')
    except (ValueError, AttributeError, TypeError, OSError):
        return ''


class CallNotes:
    """A call's notes page, as the agent adds to it: its notes and its title, each straight to the coordinator.
    turns: the board's turns while the page has no topic of the agent's; titled: it has one."""
    def __init__(self, call):
        self.call = call
        self.turns, self.titled = 0, False

    def told(self):
        """The reminder to title the page for the agent's turn now, every REMIND_EVERY of the board's turns until it has
        (or '')."""
        if self.titled or self.refused(TITLE_WORDS_SAID):
            return ''
        self.turns += 1
        return TITLE_REMINDER if self.turns % REMIND_EVERY == 0 else ''

    def refused(self, words):
        """Why the agent can't add to the page on this call now, or None: the board's own HQ call only (a call out's
        partner could steer it, house rule 9; the phone has no page), and not once it's over."""
        call = self.call
        if call.callout or call.phone or not call.brain.call:
            return words['none']
        return words['gone'] if call.ended else None

    async def ask(self, route, body, words, whole=False):
        """The coordinator's answer to one of the page's asks, {ok} in a line (whole: its lines kept), or {error}."""
        got = await self.answer(route, body, words)
        return got if 'error' in got else {'ok': str(got['ok']) if whole else one_line(got['ok'])}

    async def answer(self, route, body, words):
        """The coordinator's whole answer to one of the page's asks, or {error}."""
        try:
            return await asyncio.to_thread(self.call.wiring.hq, 'POST', route, {'call': self.call.brain.call, **body})
        except HTTPError as err:
            # (429: the day's ink readings used, its words saying so.)
            if err.code not in (400, 404, 409, 429):
                raise
            return {'error': said_back(err) or f"{words['failed']}."}

    async def write_down_tool(self, asked):
        """The agent's write_down tool (hq_tools.py, through the line's socket): one change in the call's notes."""
        if refusal := self.refused(WRITE_DOWN_WORDS):
            return {'error': refusal}
        if not (note := note_asked(asked.get('write_down'))):
            return {'error': WRITE_DOWN_WORDS['shape']}
        return await self.ask('write-down', note, WRITE_DOWN_WORDS)

    async def page_tool(self, asked):
        """The agent's read_notes tool: what's on the call's notes page, a line each."""
        if refusal := self.refused(PAGE_WORDS):
            return {'error': refusal}
        return await self.ask('page', {}, PAGE_WORDS, whole=True)

    async def mark_tool(self, asked):
        """The agent's mark_notes tool: a shape, a pen line or a highlight on the call's notes page."""
        if refusal := self.refused(MARK_WORDS):
            return {'error': refusal}
        if not (mark := mark_asked(asked.get('mark_notes'))):
            return {'error': MARK_WORDS['shape']}
        return await self.ask('mark', mark, MARK_WORDS)

    async def change_tool(self, asked):
        """The agent's change_note tool: one thing on the call's notes page changed, moved or deleted."""
        if refusal := self.refused(CHANGE_WORDS):
            return {'error': refusal}
        if not (change := change_asked(asked.get('change_note'))):
            return {'error': CHANGE_WORDS['shape']}
        return await self.ask('change', change, CHANGE_WORDS)

    async def drawing_tool(self, asked):
        """The agent's draw_picture tool: its drawing put in the call's notes as a picture, and the picture back with
        its line."""
        if refusal := self.refused(DRAW_WORDS):
            return {'error': refusal}
        if not (drawing := drawing_asked(asked.get('draw_picture'))):
            return {'error': DRAW_WORDS['shape']}
        got = await self.answer('drawing', drawing, DRAW_WORDS)
        return got if 'error' in got else {'line': one_line(got['ok']), 'picture': got['picture']}

    async def try_tool(self, asked):
        """The agent's try tool: versions of something on the call's notes page, made for the board to pick from."""
        if refusal := self.refused(TRY_WORDS):
            return {'error': refusal}
        if not (versions := try_asked(asked.get('try'))):
            return {'error': TRY_WORDS['shape']}
        return await self.ask('try', versions, TRY_WORDS)

    async def title_tool(self, asked):
        """The agent's title_notes tool: the call's notes page named in a few words."""
        if refusal := self.refused(TITLE_WORDS_SAID):
            return {'error': refusal}
        if not (title := title_asked(asked.get('title_notes'))):
            return {'error': TITLE_WORDS_SAID['shape']}
        got = await self.ask('title', {'title': title}, TITLE_WORDS_SAID)
        self.titled = self.titled or 'ok' in got
        return got
