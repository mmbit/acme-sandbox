"""The call agent's tools, as a tiny MCP server over stdio in place of a shell (guard.TOOLS, guard.PARTNER)."""
import json, os, re, subprocess, sys

# The CLI starts this with the seat's sign-in in its environment: hq gets only the call's own HQ_*
HQ_ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'HQ_URL', 'HQ_TOKEN', 'HQ_AGENT', 'HQ_CALL') if k in os.environ}
# (the coordinator refuses longer ones from a call too: server.ts, ledger.ts, messages.ts)
TITLE, BRIEF, WHAT, ADD = 140, 8000, 200, 8000
PIN_WORDS = 4000  # a pin's words, as long as the note box takes (feedback.ts)
UNSURE = "{} Don't hand it on again: tell the board the hand-off is unconfirmed and that you'll check after the call."
UNNOTED = "{} Don't note it again: the follow-up goes through the whole call afterwards and records it if it's missing."
# The board's call tools answer in numbers (jobs, items, pins, calls) the agent needs for its next tool, and the agent
# speaks right after reading them: every answer but hang_up's carries this as a part of its own (answer()), the moment
# the agent turns it into words. Text keeps its numbers.
ALOUD = ('The numbers here are for your tools only. Never say one aloud (a job, card, pull request, call, item or '
         'pin): tell the board what the work is and whose it is.')
COLLEAGUE = re.compile(r'[a-z0-9][a-z0-9-]{0,39}')
DEADLINE = re.compile(r'^[0-9][0-9hmHM:TZ -]{0,24}$')  # (the coordinator reads it: windows.ts)
THREAD = re.compile(r'^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$')  # (projects.ts)
CODE = re.compile(r'^[A-Za-z]{2,8}$')  # a task's code word (jobcodes.ts WORD)
ID = {'type': 'string', 'pattern': '^[a-z0-9][a-z0-9-]*$', 'description': "the colleague's id, lowercase (e.g. ada)"}
LINE = {'type': 'string', 'minLength': 1, 'maxLength': WHAT,
        'description': f'one plain line in your own words, at most {WHAT} characters: the board reads it'}
# a promise's time, for work new or already under way (a review, a running job)
WHEN = {'type': 'string', 'pattern': DEADLINE.pattern, 'description': 'when you told the board it will be done, at our '
        'pace: 2h, 90m or 1h30m from now, or a UTC time (14:30; the board says its own local time, so convert). Give '
        'it whenever you tell the board a time, also for work already under way (a review, a running job): after the '
        "call it becomes the window of that work\'s thread"}
TOOLS = [
    {'name': 'job', 'description': "Put work on a colleague's list as a separate job. It doesn't reach them live: "
     "nobody is on it until it runs, so tell the board it's queued, never that it's sent or that they're on it. The "
     "title is what HQ shows; the brief is the whole hand-off, in the colleague's terms: they get nothing else. It's "
     "queued only when this answers with a job number; if it answers 'Not confirmed', it may be, so don't send it "
     'again. If the board then adds to it or changes it, use add with that number: never a second job beside it, and '
     "never a promise to add it after the call. Its answer gives each agreed deadline's facts and the other threads it "
     'moves: your briefing says what the board hears of them.',
     'inputSchema': {'type': 'object', 'required': ['agent', 'title', 'code', 'brief'],
                     'additionalProperties': False, 'properties': {
         'agent': ID,
         'code': {'type': 'string', 'pattern': CODE.pattern, 'description': "the task's code word: one word for what "
                  'it does, in capitals, at most 8 letters (COVERS, FLIGHT, IMPRINT). HQ puts the project in front '
                  '(HQ-COVERS) and refuses a word another task holds: then pick another'},
         'title': {'type': 'string', 'minLength': 1, 'maxLength': TITLE,
                   'description': f'one short line, at most {TITLE} characters, in plain words: the step alone, '
                   "since HQ shows it inside its thread, so never the thread's or project's name in front"},
         'brief': {'type': 'string', 'minLength': 1, 'maxLength': BRIEF, 'description': 'everything they need: what to '
                   f'do, why, what the board said. At most {BRIEF:,} characters; more is two jobs'},
         'item': {'type': 'integer', 'minimum': 1, 'description': 'if this job carries out a promise or a correction '
                  'noted on this call: the number promise or replace answered with (it is then done when the job is)'},
         # (thread)
         'thread': {'type': 'string', 'pattern': THREAD.pattern, 'description': 'the open thread the work serves '
                    '(<project>/<slug>), needed with an item that has a time: the time goes on the thread. Without '
                    'one, the job '
                    "is refused with the open threads listed: pick the one the board's words are about and use job "
                    'again with it'},
         'after': {'type': 'integer', 'minimum': 1, 'description': 'a job that must merge before this one starts: '
                   "to queue it behind a deadline's work, when you judge that deadline worth protecting from it"},
         'now': {'type': 'boolean', 'description': 'Left out, the job waits until this call ends, so what the '
                       'board adds to it on the call (add) goes into its brief and it starts whole. True starts it at '
                       'once: your judgment each time, or the board\'s word, on whether the work can\'t wait for the end '
                       'of the call (the site is down: someone looks now. Needed by tomorrow: it waits the few minutes, '
                       'since one whole brief is worth more)'}}}},
    {'name': 'promise', 'description': "Note a promise on this call's list the moment you make it: whenever you tell "
     "the board that you, or a colleague, will do something. Note it before you say it's done. It's on the call's list "
     'straight away, even if the line drops, but it reaches nobody live: after the call, the follow-up hands it out, '
     'and the board sees whether it happened.',
     'inputSchema': {'type': 'object', 'required': ['owner', 'what'], 'additionalProperties': False, 'properties': {
         'owner': {**ID, 'description': "who sees it through: your own id, or a colleague's (lowercase, e.g. ada)"},
         'what': LINE,
         'deadline': WHEN}}},
    {'name': 'replace', 'description': 'When the board changes something still open that your briefing lists with its '
     "number, or something you noted on this call, note the change now: it goes on this call's list in place of the "
     "earlier item, whose jobs that haven't started are cancelled. It reaches nobody live: a job already running runs "
     "on, and hears the correction from the call's follow-up after the call. Only those items: never guess a number, "
     'and any other is refused; then say the follow-up will correct it from the call. A job you queued on this call '
     "takes the board's change with add instead. Its answer names the item it replaced: if that isn't what the board "
     'meant, tell the board, and the follow-up puts it right.',
     'inputSchema': {'type': 'object', 'required': ['item', 'what'], 'additionalProperties': False, 'properties': {
         'item': {'type': 'integer', 'minimum': 1, 'description': 'the earlier item\'s number (#n)'},
         'what': {**LINE, 'description': f'what it is now, one plain line in your own words, at most {WHAT} characters:'
                  ' the board reads it'},
         'deadline': {**WHEN, 'description': 'a new time, if the board changed it or you told it one (as for promise); '
                      "without one, the earlier item\'s time stays"}}}},
]
# Adding to a job the call queued (hq extend on a call: call.ts addToJob), when the board adds or corrects something
# after the job tool answered: into its brief while it hasn't started, else to its running session at its next step.
TOOLS += [
    {'name': 'add', 'description': 'When the board adds to or changes a job you queued on this call, add it to that '
     'job now, by the number the job tool answered with: before the job starts it goes into its brief; once it has, '
     "the job's session reads it at its next step. Only jobs you queued on this call (any other is refused: then the "
     "follow-up adds it from the call). Tell the board what this answers, in plain words. It's added only when this "
     "answers so; if it answers 'Not confirmed', it may be, so don't add it again.",
     'inputSchema': {'type': 'object', 'required': ['job', 'words'], 'additionalProperties': False, 'properties': {
         'job': {'type': 'integer', 'minimum': 1,
                 'description': 'the job you queued on this call (#n, from the job tool)'},
         'words': {'type': 'string', 'minLength': 1, 'maxLength': ADD,
                   'description': "what the board added or changed, in the colleague's terms, as part of that job's "
                   f'brief. At most {ADD:,} characters'}}}},
]
# The board's settled word to work already under way (hq say on a call: call.ts reach), for real need only, as often as
# the board's word needs: each goes on the call's list, so the follow-up
# doesn't send it again.
TOOLS += [
    {'name': 'reach', 'description': "When the board's settled word matters to work already under way before the call "
     "ends, pass it on to that running job or pull request's review, by the number your briefing lists, as often as "
     "the board's word needs; anything still being worked out goes to the follow-up. It goes on this call's list "
     "too. Tell the board where it went as this answers; if it answers 'Not confirmed', it may have gone, so don't send it again.",
     'inputSchema': {'type': 'object', 'required': ['agent', 'job', 'words', 'what'], 'additionalProperties': False,
                     'properties': {
         'agent': {**ID, 'description': "whose job or review it is, lowercase (e.g. ada): a number that isn't theirs "
                   'is refused'},
         'job': {'type': 'integer', 'minimum': 1,
                 'description': "the running job's or review's number (#n in your briefing)"},
         'words': {'type': 'string', 'minLength': 1, 'maxLength': ADD,
                   'description': "what the board wants that work to know now, in the colleague's terms. At most "
                   f'{ADD:,} characters'},
         'what': {**LINE, 'description': f"what you passed on, one plain line for the call's list, at most {WHAT} "
                  'characters: the board reads it'}}}},
]
# A call about the board's pins (review notes it rang about from HQ's Reviews; the briefing lists them): their words,
# and marking one sent (hq pin). The board said a pin is sent only when the agent queues work for it or answers it on
# the call, and it must hear which: the answer tells the agent to say so.
PIN = {'type': 'integer', 'minimum': 1, 'description': "the pin's number (#n in your briefing)"}
TOOLS += [
    {'name': 'pin_words', 'description': "On a call about the board's pins: when you and the board land on better "
     'words for a pin, rewrite it. HQ shows the new words; the pin still waits there, not sent.',
     'inputSchema': {'type': 'object', 'required': ['pin', 'words'], 'additionalProperties': False, 'properties': {
         'pin': PIN,
         'words': {'type': 'string', 'minLength': 1, 'maxLength': PIN_WORDS,
                   'description': 'the whole note as it reads now'}}}},
    {'name': 'pin_sent', 'description': "On a call about the board's pins: mark a pin sent, either with the job you "
     'queued for it (its number, from the job tool) or as answered on this call (it needed no work, like a question). '
     "Starting the call sent none: a pin you don't mark stays waiting in HQ for later.",
     'inputSchema': {'type': 'object', 'required': ['pin'], 'additionalProperties': False, 'properties': {
         'pin': PIN, 'job': {'type': 'integer', 'minimum': 1, 'description': 'the job queued for it'},
         'answered': {'type': 'boolean', 'description': 'true: answered on this call, no job'}}}},
]
# Looking things up (hq search, hq history, hq call, hq intercom; the coordinator's memory.ts and intercom.ts): the
# Handbook, knowledge, the board's calls with everyone (with their summaries), the intercom, and the agent's own jobs
# and requests, so a call about past work, or something the board asked on the intercom, finds it.
# Read-only; the call token sees only its own agent's work, and a call the coordinator won't show (one still going on)
# comes back as hq's refusal.
TOOLS += [
    {'name': 'search', 'description': "Search the company's handbook, playbooks, briefs and knowledge base, the "
     "board's earlier calls with everyone and their summaries, the intercom, and your own job reports and desk phone "
     'requests, by meaning and by words (in English or Dutch; names and numbers like #32 hit exactly). Each hit says '
     'where it is. '
     'The archive (what was replaced or finished) comes last, marked, with what replaced it: history, never the '
     'current answer.',
     'inputSchema': {'type': 'object', 'required': ['query'], 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500}}}},
    {'name': 'history', 'description': 'Your own recent jobs (status, pull request, whole report), desk phone requests '
     "with the board's answers, and calls, newest first. A query narrows it; '#35' finds that number.",
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'maxLength': 500}}}},
    {'name': 'call', 'description': "An earlier call with the board in full, yours or a colleague's, by its number "
     "(search and history point to them as 'hq call <number>'): when, who, what it was about, every line said, and its "
     'summary.',
     'inputSchema': {'type': 'object', 'required': ['id'], 'additionalProperties': False, 'properties': {
         'id': {'type': 'integer', 'minimum': 1, 'description': 'the call number, e.g. 12 for hq call 12'}}}},
    {'name': 'intercom', 'description': "The board's intercom chat with the CEO, every line since its first day, each "
     "with its time (the company's clock) and who said it: a day ('2026-10-16'), days ('2026-10-14..2026-10-16') or a "
     "day's hours ('2026-10-16 09:00-12:00') read in full, or any other words to find the lines nearest them or their "
     "meaning, best first ('what the board asked about the projects view'). Look here before you tell the board "
     "something wasn't asked or written down.",
     'inputSchema': {'type': 'object', 'required': ['query'], 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500,
                   'description': "a day, days, a day's hours, or words"}}}},
    {'name': 'eta', 'description': 'Where planned work stands now, before you tell the board when it will be done: for '
     "a project or a thread by its name or a few words ('The checkout', 'the game's levels'), each open thread's "
     'ETA, the agent time it has left, its window (the time agreed with the board) with its planned finish and the slack '
     'that leaves or by how much it misses, what it waits on and what goes on next, all by name, live from the plan '
     'HQ plays, in a second. For new work, use when.',
     'inputSchema': {'type': 'object', 'required': ['query'], 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500,
                   'description': "the project's or thread's name, or a few words"}}}},
    {'name': 'when', 'description': 'Before you tell the board when work will be done: it sizes the work on done jobs '
     'like it (or takes the size given) and plays it into the plan as it stands, every seat and window counted, in a '
     'few seconds: the earliest it can be done without making any window miss, and the window to set. With by (the '
     "board's time), whether it makes that time, and only if not, what would: windows giving or one more seat. "
     'Give the board the time it says.',
     'inputSchema': {'type': 'object', 'required': ['what'], 'additionalProperties': False, 'properties': {
         'what': {'type': 'string', 'minLength': 1, 'description': 'the work, in a few words'},
         'agent': {'type': 'string', 'description': "who would do it (its id; yours if left out)"},
         'size': {'type': 'string', 'description': 'its agent time, when known: 90m, 2h or 1h30m'},
         'after': {'type': 'integer', 'minimum': 1, 'description': 'the job that must merge before this work starts'},
         'by': {'type': 'string', 'description': "the board's time in UTC: 14:30 or 2026-10-06T14:30Z"}}}},
]
# Ending the call: the agent can hang up once the board has clearly said goodbye.
# The tool itself does nothing: the voice line sees the agent use it in the reply's stream (server.py, Call.leave) and
# hangs up once the goodbye has played, unless the board speaks first.
HANG_UP_ANSWER = ("The line hangs up once your goodbye has finished playing. If the board speaks before then, the call "
                  "stays open and its words come to you as a new message: answer them as usual.")
# A goodbye in the agent's own words.
TOOLS += [
    {'name': 'hang_up', 'description': 'End the call, only once the board has clearly wrapped it up: it said goodbye, '
     "asked you to end the call, or thanked you to close it ('thank you, that's all'). Then say a short goodbye of your "
     "own that fits the call ('Thank you, talk soon.' is one example, not a set line), then use this in the same "
     'reply: no recap of what was queued or noted unless the board asks for one, nothing about deadlines. Never on a '
     'pause or a silence, a thank-you while the business is still going (a question unanswered, a decision to make, a '
     "new ask in the same words), or anything you're unsure of: then stay on the line (the board can always hang up "
     "itself), without asking whether it's done. The line hangs up once your goodbye has played, and if the board "
     'speaks before then, the call stays open.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}}},
]
# A call out to a partner. note and no_transcript run nothing: the voice line
# reads them from the reply's stream (server.py, Call.noted and Call.object), keeps each note in order, and on
# no_transcript says the company's fixed words itself and keeps no transcript from then on, only the notes. A note and a
# hang_up come after the words (nothing is heard while the model writes a step).
NOTE_ANSWER = "Noted. Don't say again what you've already said in this reply."
NO_TRANSCRIPT_ANSWER = ('Understood: no transcript is kept from here, only your notes. The line has already told them '
                        "so in fixed words: don't say it again, go on with the call.")
PARTNER_HANG_UP_ANSWER = ('The line hangs up once your goodbye has finished playing. If they speak before then, the '
                          'call stays open and their words come to you as a new message: answer them as usual.')
PARTNER_TOOLS = [
    {'name': 'note', 'description': "Note what was agreed or asked, in one plain line, once it's settled (a date, "
     "an amount, who does what next). Your notes are kept with the call even when the transcript isn't, and your "
     'follow-up after the call works from them: note everything it will need. Say your answer first and use this after '
     'it, in the same reply: nothing is heard while you write a note.',
     'inputSchema': {'type': 'object', 'required': ['what'], 'additionalProperties': False, 'properties': {
         'what': {**LINE, 'description': f'one plain line in your own words, at most {WHAT} characters'}}}},
    {'name': 'no_transcript', 'description': "Use this at once, before saying anything, when they say they'd rather we "
     "didn't keep a transcript of the call (or a recording). The line then tells them in fixed words that we won't, "
     'and from then on keeps only your notes. Use note for what is agreed after that, as before.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}}},
    {'name': 'hang_up', 'description': "End the call once it's clearly over: they said goodbye or asked to end it, or "
     "it's a voicemail or an automated menu you can't get through (then without leaving a message). Say a short "
     'goodbye first, then use this in the same reply. Never on a pause or a silence, or while something is still '
     'open. The line hangs up once your goodbye has played, and if they speak before then, the call stays open.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}}},
]


LOOK_UPS = ('search', 'history', 'call', 'intercom', 'eta')  # (eta)


def look(name, a):
    """(ok, text): runs `hq search|history|call|intercom` (or `hq projects` for eta) from an argument list, in the
    allowlisted environment."""
    query = a.get('query', '')
    if name == 'call':
        cid = a.get('id')
        if type(cid) is not int or cid < 1:
            return False, 'call needs its number, like 12'
        query = str(cid)
    elif not isinstance(query, str) or (name in ('search', 'intercom', 'eta') and not query.strip()):
        return False, f'{name} needs a query'
    if len(query) > 500:
        return False, f'query too long ({len(query):,} > 500): ask something shorter'
    commands = {
        'search': ['hq', 'search', query, '5'],
        'call': ['hq', 'call', query],
        'intercom': ['hq', 'intercom', query],
        'eta': ['hq', 'projects', query],
        'history': ['hq', 'history'] + ([query] if query.strip() else []),
    }
    return looked(name, commands[name])


def when(a):
    """(ok, text): runs `hq when` from an argument list: the work, its size, whose it is, its prerequisite and the
    board's time, each checked so none reads as another's flag."""
    what, agent, size, by = (a.get(k, '') for k in ('what', 'agent', 'size', 'by'))
    if not isinstance(what, str) or not what.strip() or what.startswith('-'):
        return False, 'when needs what the work is'
    if not isinstance(agent, str) or (agent and not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', agent)):
        return False, "agent is an agent's id, like juno"
    if not isinstance(size, str) or (size and not re.fullmatch(r'(\d{1,2}h)?(\d{1,4}m)?', size)):
        return False, 'size is agent time: 90m, 2h or 1h30m'
    if not isinstance(by, str) or (by and not re.fullmatch(r'[0-9:TZ -]{4,20}', by)):
        return False, 'by is a UTC time: 14:30 or 2026-10-06T14:30Z'
    after = a.get('after')
    if 'after' in a and (type(after) is not int or after < 1):
        return False, 'after is a job number, like 123'
    argv = ['hq', 'when', what, *([size] if size else []), *(['--agent', agent] if agent else []),
            *(['--after', str(after)] if after is not None else []), *(['--by', by] if by else [])]
    return looked('when', argv)


def looked(name, argv):
    """Run a lookup and return (ok, text)."""
    r = subprocess.run(argv, env=HQ_ENV, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    if r.returncode:
        return False, f'hq {name} failed: {(r.stderr or r.stdout).strip()[:300] or "the coordinator refused it"}'
    # Successful lookups return every line so long transcripts remain complete.
    return True, r.stdout.strip()


def run(args, words, timeout=30):
    """hq, from an argument list in the allowlisted environment, with the words on stdin: (exit code, stdout, stderr),
    or None if it hung. Never the words in argv: any uid can read /proc/<pid>/cmdline."""
    try:
        r = subprocess.run(['hq', *args], env=HQ_ENV, input=words, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def plain(what):
    """The refusal for a "what" that isn't one plain line within the limit (never cut), or None."""
    if not what or '\n' in what or '\r' in what:
        return 'what needs one plain line: the board reads it'
    if len(what) > WHAT:
        return f'what too long ({len(what):,} > {WHAT:,}): make it one short line; the follow-up has the whole call'


def hq(name, a):
    """(ok, text): runs hq for a valid call. Too long is refused, never cut; every answer says it's on a list, not with
    anyone yet."""
    if name == 'job':
        return job(a)
    if name == 'add':
        return add(a)
    if name == 'hang_up':
        return True, HANG_UP_ANSWER
    if name in ('pin_words', 'pin_sent'):
        return pin(name, a)
    if name == 'reach':
        return reach(a)
    if name not in ('promise', 'replace'):
        return False, f'no tool {name}: hand work on with job, note a promise with promise'
    what, item, owner = str(a.get('what', '')).strip(), a.get('item'), str(a.get('owner', ''))
    if name == 'promise' and not COLLEAGUE.fullmatch(owner):
        return False, 'owner must be a colleague id, like ada'
    if name == 'replace' and (type(item) is not int or item < 1):
        return False, "item must be the earlier item's number"
    if refused := plain(what):
        return False, refused
    deadline = a.get('deadline')
    if refused := readable(deadline):
        return False, refused
    # (the words, as the agent gave them, are the quote: the follow-up has the call's own around them)
    when = ['--deadline', deadline] if deadline else []
    args = ['item', 'add', 'promise', owner] if name == 'promise' else ['item', 'replace', str(item)]
    r = run([*args, what, '-', *when], what)
    return answered(r, 'Nothing recorded', 'it may or may not be on the list', UNNOTED)


def job(a):
    agent = str(a.get('agent', ''))
    if not COLLEAGUE.fullmatch(agent):
        return False, 'agent must be a colleague id, like ada'
    item = a.get('item')
    title, brief = str(a.get('title', '')).strip(), str(a.get('brief', '')).strip()
    if not title or not brief:
        return False, 'job needs a title and a brief'
    if item is not None and (type(item) is not int or item < 1):
        return False, 'item must be the number promise or replace answered with'
    code = a.get('code')
    if not (type(code) is str and CODE.fullmatch(code)):
        return False, 'code must be one word of 2 to 8 letters for what the task does, like COVERS'
    thread = a.get('thread')
    if thread is not None and not (type(thread) is str and THREAD.fullmatch(thread)):
        return False, 'thread must be one from the open threads, like shop/launch-deck'
    if len(title) > TITLE:
        return False, (f'title too long ({len(title):,} > {TITLE:,}): keep it to one short line and put the rest in '
                       'the brief')
    if len(brief) > BRIEF:
        return False, f'brief too long ({len(brief):,} > {BRIEF:,}): split it into two jobs'
    now = a.get('now', False)
    if type(now) is not bool:
        return False, 'now must be true or false'
    after = a.get('after')  # (before the agent: hq job reads --after there only)
    if after is not None and (type(after) is not int or after < 1):
        return False, 'after is a job number, like 123'
    flags = [*(['--item', str(item)] if item else []), *(['--thread', thread] if thread else []),
             *(['--now'] if now else []), '--code', code]
    r = run(['job', *(['--after', str(after)] if after else []), agent, title, '-', *flags], brief)
    ok, text = answered(r, 'No job was queued', 'the job may or may not be queued', by='hq job')
    return ok, f"{text}\nNot started yet: it's on {agent}'s list, and nobody is on it until it runs." if ok else text


def add(a):
    """add: hq extend <job> -, the words on stdin. Its answer says where they went (the brief, or the running job)."""
    n, words = a.get('job'), str(a.get('words', '')).strip()
    if type(n) is not int or n < 1:
        return False, 'job must be the number the job tool answered with'
    if not words:
        return False, 'add needs what the board added or changed'
    if len(words) > ADD:
        return False, f'too long ({len(words):,} > {ADD:,}): keep the addition short; the follow-up has the whole call'
    return answered(run(['extend', str(n), '-'], words), 'Nothing was added', 'it may or may not have been added')


def reach(a):
    """reach: hq say <agent> - --job <n> --what "line", the words on stdin. Its answer says where they went."""
    agent, n = str(a.get('agent', '')), a.get('job')
    words, what = str(a.get('words', '')).strip(), str(a.get('what', '')).strip()
    if not COLLEAGUE.fullmatch(agent):
        return False, 'agent must be a colleague id, like ada'
    if type(n) is not int or n < 1:
        return False, "job must be the running job's or review's number from your briefing"
    if not words:
        return False, 'reach needs what the board wants that work to know'
    if len(words) > ADD:
        return False, (f'too long ({len(words):,} > {ADD:,}): keep it to what the work needs now; the follow-up has '
                       'the whole call')
    if refused := plain(what):
        return False, refused
    reply = run(['say', agent, '-', '--job', str(n), '--what', what], words)
    return answered(reply, 'Nothing was sent', 'it may or may not have gone')


def answered(reply, refusal, unconfirmed, again=UNSURE, by='hq'):
    """(ok, text) from run's reply: done only when hq confirms it, and refused only when hq's refusal says nothing
    happened. Anything else may have come after the coordinator saved it (hq: exit 3, "Not confirmed"): a retry could
    do it twice, so `again` tells the agent not to."""
    if reply is None:
        return False, again.format(f'Not confirmed: {unconfirmed} ({by} took too long).')
    code, out, err = reply
    if code == 0 and out:
        return True, out
    if code == 1 and err.startswith(refusal):
        return False, err
    if code != 3:
        err = f'Not confirmed: {unconfirmed} ({by}: {err or out or f"exit {code}"}).'
    return False, again.format(err)


def readable(deadline):
    """The refusal for a deadline the coordinator can't read (windows.ts), or None."""
    if deadline is not None and not (type(deadline) is str and DEADLINE.fullmatch(deadline)):
        return 'deadline must be a time from now (2h, 90m) or a UTC time (14:30)'


def pin(name, a):
    """pin_words and pin_sent: hq pin, the words on stdin. The answer says what the board must hear."""
    n, words, job_id, answered = a.get('pin'), a.get('words'), a.get('job'), a.get('answered')
    if type(n) is not int or n < 1:
        return False, 'pin must be its number from your briefing'
    if name == 'pin_words':
        if not isinstance(words, str) or not words.strip():
            return False, 'words needs the whole note as it reads now'
        if len(words) > PIN_WORDS:
            return False, f'words too long ({len(words):,} > {PIN_WORDS:,}): make it shorter'
        args, stdin = ['pin', 'words', str(n), '-'], words.strip()
    else:
        bad_job = job_id is not None and (type(job_id) is not int or job_id < 1)
        if (job_id is None) == (answered is not True) or bad_job:
            return False, 'pin_sent needs either the job number you queued for it, or answered: true'
        args, stdin = ['pin', 'sent', str(n), f'job:{job_id}' if job_id else 'answered'], ''
    r = run(args, stdin)
    if r is None:
        return False, ('Not confirmed: the pin may or may not have changed (hq took too long). Tell the board you will '
                       'check it after the call.')
    code, out, err = r
    if code != 0 or not out:
        return False, err or out or f'hq pin failed (exit {code})'
    if name == 'pin_words':
        return True, out
    say = ('Tell the board plainly which of its notes went to which work, and whether that work is queued or already '
           'under way.' if job_id
           else 'Tell the board plainly which of its notes you answered here, with no work queued for it.')
    return True, f'{out}\n{say}'


def partner(name, a):
    """(ok, text) for a partner call's own tools, which run nothing."""
    if name == 'note':
        refused = plain(str(a.get('what', '')).strip())
        return (False, refused) if refused else (True, NOTE_ANSWER)
    if name == 'no_transcript':
        return True, NO_TRANSCRIPT_ANSWER
    if name == 'hang_up':
        return True, PARTNER_HANG_UP_ANSWER
    return False, f'no tool {name} on a call with a partner'


def answer(msg, offered=TOOLS):
    """The reply to one JSON-RPC message, or None for a notification. offered: the call's tool set."""
    method, mid = msg.get('method'), msg.get('id')
    if mid is None:
        return None
    if method == 'initialize':
        result = {'protocolVersion': msg.get('params', {}).get('protocolVersion', '2025-06-18'),
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'hq', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': offered}
    elif method == 'tools/call':
        p = msg.get('params', {})
        name, arguments = p.get('name'), p.get('arguments') or {}
        if offered is PARTNER_TOOLS:
            ok, text = partner(name, arguments)
        else:
            ok, text = (when(arguments) if name == 'when'
                        else (look if name in LOOK_UPS else hq)(name, arguments))
        aloud = [] if offered is PARTNER_TOOLS or name == 'hang_up' else [{'type': 'text', 'text': ALOUD}]
        result = {'content': [{'type': 'text', 'text': text}, *aloud], 'isError': not ok}
    elif method == 'ping':
        result = {}
    else:
        return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'no method {method}'}}
    return {'jsonrpc': '2.0', 'id': mid, 'result': result}


if __name__ == '__main__':
    tool_set = PARTNER_TOOLS if sys.argv[1:] == ['partner'] else TOOLS
    for line in sys.stdin:
        msg = None
        try:
            msg = json.loads(line)
            reply = answer(msg, tool_set)
        except Exception as e:  # (a bad line or a stuck hq: the agent hears it failed, the server carries on)
            mid = msg.get('id') if isinstance(msg, dict) else None
            reply = {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32603, 'message': str(e)[:200]}}
        if reply:
            print(json.dumps(reply), flush=True)
