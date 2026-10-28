"""A call's notes page in the board's Notebook, the voice line's half.

On its turn the agent turns what the board said and drew into one scrap per change, each its own focused crop (scrap):
the part of one of the board's notes on this call, or of its shown screen at a moment, that the change is about, with
the change in the agent's words. The coordinator's Ink store cuts it and puts it on the call's notes page
(ink/callnotes.ts), where the board sees it land as it's made; title names the page. Only on the board's own HQ call.
The call engine's halves (drawing.py, driving.py, the screen tool) know nothing of the page: this reads them, never the
other way round."""
import asyncio
import json
import re
from urllib.error import HTTPError

from drawing import box_asked, one_line

# The most of the agent's words for one change, and of a title (the coordinator's own limits)
CHANGE_MOST, TITLE_MOST, TITLE_WORDS = 280, 120, 8
# Where a scrap is cut from: one of the board's notes on the call ('note 3'), or a moment of its shown screen
FROM = re.compile(r'^(note\s*#?[0-9]{1,4}|now|-[0-9]{1,4}[sm]|[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?|#[0-9]{1,6})$', re.I)
# What the agent hears about its scraps and the page's title
SCRAP_WORDS = {
    'shape': (f"scrap takes from ('note 3': one of the board's notes on this call; or a moment of its shown screen: "
              f"'now', '-20s', '17:03:12', '#12'), region (the part of that picture the change is about: x, y, width "
              f"and height, fractions from 0 to 1 from its top left) and words (the one change, at most {CHANGE_MOST} "
              f"characters), and owner (the id of the agent whose work it is) if you know it"),
    'none': "There's no notes page on this call: only the board's own calls in HQ have one.",
    'gone': "This session can't add to the page any more: the call ended, or its session was restarted.",
    'failed': "The scrap couldn't be made just now",
}
TITLE_WORDS_SAID = {
    'shape': f'title is a few words (at most {TITLE_WORDS}) naming what the call is about: a title, not a summary',
    'none': SCRAP_WORDS['none'],
    'gone': SCRAP_WORDS['gone'],
    'failed': "The page couldn't be titled just now",
}


def scrap_asked(a):
    """A scrap the agent asks for ({from, region, words, owner?}), cleaned, or None if it isn't one."""
    if not isinstance(a, dict) or set(a) - {'from', 'region', 'words', 'owner'}:
        return None
    source = one_line(a.get('from')) if isinstance(a.get('from'), str) else ''
    words = one_line(a.get('words')) if isinstance(a.get('words'), str) else ''
    owner = a.get('owner')
    if not FROM.match(source) or not (region := box_asked(a.get('region'))) or not 0 < len(words) <= CHANGE_MOST:
        return None
    if owner is not None and not (isinstance(owner, str) and re.fullmatch(r'[a-z0-9-]{1,40}', owner)):
        return None
    return {'from': source, 'region': region, 'words': words, **({'owner': owner} if owner else {})}


def title_asked(title):
    """The page's title the agent gives, as one line, or None if it isn't a few words."""
    title = one_line(title) if isinstance(title, str) else ''
    return title if 0 < len(title) <= TITLE_MOST and len(title.split()) <= TITLE_WORDS else None


def said_back(err):
    """The coordinator's own words in a refusal ({error}), or ''."""
    try:
        return str(json.loads(err.read() or 'null').get('error') or '')
    except (ValueError, AttributeError, TypeError, OSError):
        return ''


class CallNotes:
    """A call's notes page, as the agent adds to it: its scraps and its title, each straight to the coordinator."""
    def __init__(self, call):
        self.call = call

    def refused(self, words):
        """Why the agent can't add to the page on this call now, or None: the board's own HQ call only (a call out's
        partner could steer it, house rule 9; the phone has no page), and not once it's over."""
        call = self.call
        if call.callout or call.phone or not call.brain.call:
            return words['none']
        return words['gone'] if call.ended else None

    async def ask(self, route, body, words):
        try:
            got = await asyncio.to_thread(self.call.wiring.hq, 'POST', route, {'call': self.call.brain.call, **body})
        except HTTPError as err:
            if err.code not in (400, 404, 409):
                raise
            return {'error': said_back(err) or f"{words['failed']}."}
        return {'ok': one_line(got['ok'])}

    async def scrap_tool(self, asked):
        """The agent's scrap tool (hq_tools.py, through the line's socket): one change on the call's notes page."""
        if refusal := self.refused(SCRAP_WORDS):
            return {'error': refusal}
        if not (scrap := scrap_asked(asked.get('scrap'))):
            return {'error': SCRAP_WORDS['shape']}
        return await self.ask('scrap', scrap, SCRAP_WORDS)

    async def title_tool(self, asked):
        """The agent's title_page tool: the call's notes page named in a few words."""
        if refusal := self.refused(TITLE_WORDS_SAID):
            return {'error': refusal}
        if not (title := title_asked(asked.get('title_page'))):
            return {'error': TITLE_WORDS_SAID['shape']}
        return await self.ask('title', {'title': title}, TITLE_WORDS_SAID)
