"""A call's notes page in the board's Notebook, the voice line's half.

On its turn the agent turns what the board said and drew into one scrap per change, each its own focused crop (scrap):
the part of one of the board's notes on this call, or of its shown screen at a moment, that the change is about, with
the change in the agent's words and the board's why. The coordinator's Ink store cuts it and puts it on the call's notes
page (ink/callnotes.ts), where the board sees it land as it's made, and on the call's list; the call's follow-up hands
it out; a plain note is a scrap with no crop, its words alone on a post-it. The agent works the page as
the board does too: reads it (read_page), draws on it (mark_page) and changes, moves or deletes what's on it
(change_page), each a step the board's Undo takes back. title names the page's topic, after the call's date and time,
and the agent is reminded every few turns until it has. Only on the board's own HQ call.
The call engine's halves (drawing.py, driving.py, the screen tool) know nothing of the page: this reads them, never the
other way round."""
import asyncio
import json
import re
from urllib.error import HTTPError

from drawing import box_asked, one_line

# The most of the agent's words for one change (its line on the call's list) and its why, and of the page's topic (the
# coordinator's own limits: a topic of 21 characters after the call's date and time is whole in the Notebook's bar on
# an iPad mini.)
CHANGE_MOST, WHY_MOST, TITLE_MOST = 200, 300, 21
# Where a scrap is cut from: one of the board's notes on the call ('note 3'), or a moment of its shown screen
FROM = re.compile(r'^(note\s*#?[0-9]{1,4}|now|-[0-9]{1,4}[sm]|[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?|#[0-9]{1,6})$', re.I)
# What the agent hears about its scraps and the page's title
SCRAP_WORDS = {
    'shape': (f"scrap takes words (the one change, at most {CHANGE_MOST} characters), goal (why the board wants it, at "
              f"most {WHY_MOST} characters), owner (the id of the agent whose work it is) if you know it, and for a crop "
              f"both from ('note 3': one of the board's notes on this call; or a moment of its shown screen: 'now', "
              f"'-20s', '17:03:12', '#12') and region (the part of that picture the change is about: x, y, width and "
              f"height, fractions from 0 to 1 from its top left), or neither for a plain note"),
    'none': "There's no notes page on this call: only the board's own calls in HQ have one.",
    'gone': "This session can't add to the page any more: the call ended, or its session was restarted.",
    'failed': "The scrap couldn't be made just now",
}
TITLE_WORDS_SAID = {
    'shape': (f'title is what the call is about in at most {TITLE_MOST} characters ("Shop page prices"): the page '
              "keeps the call's date and time in front of it"),
    'none': SCRAP_WORDS['none'],
    'gone': SCRAP_WORDS['gone'],
    'failed': "The page couldn't be titled just now",
}
# Every so many of the board's turns, until the agent has titled the page, a line in front of the board's words reminds
# it to
REMIND_EVERY = 3
TITLE_REMINDER = ("(Your notes page has no topic yet: once it's clear what this call is about, give it one with "
                  'title_page.)')


def scrap_asked(a):
    """A scrap the agent asks for ({from?, region?, words, goal, owner?}: a crop from and region both, or a plain note
    with neither), cleaned, or None if it isn't one."""
    if not isinstance(a, dict) or set(a) - {'from', 'region', 'words', 'goal', 'owner'}:
        return None
    words = one_line(a.get('words')) if isinstance(a.get('words'), str) else ''
    goal = one_line(a.get('goal')) if isinstance(a.get('goal'), str) else ''
    owner = a.get('owner')
    if not 0 < len(words) <= CHANGE_MOST or not 0 < len(goal) <= WHY_MOST:
        return None
    if owner is not None and not (isinstance(owner, str) and re.fullmatch(r'[a-z0-9-]{1,40}', owner)):
        return None
    asked = {'words': words, 'goal': goal, **({'owner': owner} if owner else {})}
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
    'shape': 'read_page takes nothing',
    'none': SCRAP_WORDS['none'],
    'gone': SCRAP_WORDS['gone'],
    'failed': "The page couldn't be read just now",
}
MARK_WORDS = {
    'shape': (f"mark_page takes mark (one of {', '.join(MARKS)}) and where: around (a number on the page, as read_page "
              "gives it) or box ({x, y, width, height} in the page's px) for a rect, ellipse or highlight; points "
              "([[x, y], ...] in the page's px) for a line or arrow (from and to), a pen line or a highlight along them; "
              "filled (true) for a rect or ellipse"),
    'none': SCRAP_WORDS['none'],
    'gone': SCRAP_WORDS['gone'],
    'failed': "The mark couldn't be made just now",
}
CHANGE_WORDS = {
    'shape': (f"change_page takes id (a number on the page, as read_page gives it) and one of words (your own note's or "
              f"scrap's new words, at most {CHANGE_MOST} characters), to ({{x, y}}: its new top left in the page's px) "
              "and delete (true)"),
    'none': SCRAP_WORDS['none'],
    'gone': SCRAP_WORDS['gone'],
    'failed': "The page couldn't be changed just now",
}


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
    """One change the agent asks for on the page ({id, words | to | delete}), cleaned, or None if it isn't one."""
    if not isinstance(a, dict) or set(a) - {'id', 'words', 'to', 'delete'} or not isinstance(a.get('id'), int):
        return None
    how = set(a) - {'id'}
    if len(how) != 1:
        return None
    if 'words' in a:
        words = one_line(a['words']) if isinstance(a['words'], str) else ''
        return {'id': a['id'], 'words': words} if 0 < len(words) <= CHANGE_MOST else None
    if 'to' in a:
        to = a['to']
        ok = isinstance(to, dict) and set(to) == {'x', 'y'} and all(number(v) for v in to.values())
        return {'id': a['id'], 'to': to} if ok else None
    return {'id': a['id'], 'delete': True} if a['delete'] is True else None


def title_asked(title):
    """The page's topic the agent gives, as one line, or None if it isn't a short one."""
    title = one_line(title) if isinstance(title, str) else ''
    return title if 0 < len(title) <= TITLE_MOST else None


def said_back(err):
    """The coordinator's own words in a refusal ({error}), or ''."""
    try:
        return str(json.loads(err.read() or 'null').get('error') or '')
    except (ValueError, AttributeError, TypeError, OSError):
        return ''


class CallNotes:
    """A call's notes page, as the agent adds to it: its scraps and its title, each straight to the coordinator.
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
        try:
            got = await asyncio.to_thread(self.call.wiring.hq, 'POST', route, {'call': self.call.brain.call, **body})
        except HTTPError as err:
            if err.code not in (400, 404, 409):
                raise
            return {'error': said_back(err) or f"{words['failed']}."}
        return {'ok': str(got['ok']) if whole else one_line(got['ok'])}

    async def scrap_tool(self, asked):
        """The agent's scrap tool (hq_tools.py, through the line's socket): one change on the call's notes page."""
        if refusal := self.refused(SCRAP_WORDS):
            return {'error': refusal}
        if not (scrap := scrap_asked(asked.get('scrap'))):
            return {'error': SCRAP_WORDS['shape']}
        return await self.ask('scrap', scrap, SCRAP_WORDS)

    async def page_tool(self, asked):
        """The agent's read_page tool: what's on the call's notes page, a line each."""
        if refusal := self.refused(PAGE_WORDS):
            return {'error': refusal}
        return await self.ask('page', {}, PAGE_WORDS, whole=True)

    async def mark_tool(self, asked):
        """The agent's mark_page tool: a shape, a pen line or a highlight on the call's notes page."""
        if refusal := self.refused(MARK_WORDS):
            return {'error': refusal}
        if not (mark := mark_asked(asked.get('mark_page'))):
            return {'error': MARK_WORDS['shape']}
        return await self.ask('mark', mark, MARK_WORDS)

    async def change_tool(self, asked):
        """The agent's change_page tool: one thing on the call's notes page changed, moved or deleted."""
        if refusal := self.refused(CHANGE_WORDS):
            return {'error': refusal}
        if not (change := change_asked(asked.get('change_page'))):
            return {'error': CHANGE_WORDS['shape']}
        return await self.ask('change', change, CHANGE_WORDS)

    async def title_tool(self, asked):
        """The agent's title_page tool: the call's notes page named in a few words."""
        if refusal := self.refused(TITLE_WORDS_SAID):
            return {'error': refusal}
        if not (title := title_asked(asked.get('title_page'))):
            return {'error': TITLE_WORDS_SAID['shape']}
        got = await self.ask('title', {'title': title}, TITLE_WORDS_SAID)
        self.titled = self.titled or 'ok' in got
        return got
