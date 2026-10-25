"""The call agent's tools, as a tiny MCP server over stdio in place of a shell (guard.TOOLS, guard.PARTNER)."""
import json, os, re, socket, subprocess, sys
from concurrent.futures import ThreadPoolExecutor, wait

# The CLI starts this with the seat's sign-in in its environment: hq gets only the call's own HQ_*
HQ_ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'HQ_URL', 'HQ_TOKEN', 'HQ_AGENT', 'HQ_CALL') if k in os.environ}
# The screen tool (and the sketch tool) asks the voice line itself, on its
# socket, by the session's key (guard.agent_env): the line keeps the call's picture budget and its own token. Neither is
# here on a call with no screen.
SCREEN_SOCKET, SCREEN_KEY = os.environ.get('SCREEN_SOCKET', ''), os.environ.get('SCREEN_KEY', '')
# (the coordinator refuses longer ones from a call too: server.ts, ledger.ts, messages.ts)
TITLE, BRIEF, WHAT, ADD = 140, 8000, 200, 8000
PIN_WORDS = 4000  # a pin's words, as long as the note box takes (feedback.ts)
UNSURE = "{} Don't hand it on again: tell the board the hand-off is unconfirmed and that you'll check after the call."
UNNOTED = "{} Don't note it again: the follow-up goes through the whole call afterwards and records it if it's missing."
# A tool waits for the coordinator's real answer however long it takes: a slow coordinator is still there, and a fixed
# cutoff turned its slow moments into hand-offs the agent couldn't confirm (board, call 127). Only hq's own failures end
# it (a refused connection, a reset). The agent hears back within STILL s all the same, so the call is never silent for
# long: a tool still waiting then says so and carries on in the background (WORK: what's under way at hang-up still
# lands), and the waiting tool hears it.
STILL = 20
WORK, PENDING = ThreadPoolExecutor(), []  # (PENDING: each tool still waiting, as (what it is, its future))
STILL_WAITING = ("Still waiting for the coordinator's answer to {}: it's slow, not down, and this is still going "
                 "through, not lost. Never use the tool again for it. Tell the board in a few words that it's still on "
                 "its way, then use waiting to hear how it went.")
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
        'it whenever you tell the board a time, also for work already under way (a review, a running job): with job, '
        "the promise is that work\'s, and its thread takes the time at once; the job tool\'s with its item takes it as "
        "it\'s queued"}
SIZE = {'type': 'string', 'description': 'your scope estimate of agent time, from clean past jobs: 90m, 2h or 1h30m'}
TOOLS = [
    {'name': 'job', 'description': "Put work on a colleague's list as a separate job. It doesn't reach them live: "
     "nobody is on it until it runs, so tell the board it's queued, never that it's sent or that they're on it. The "
     "title is what HQ shows; the brief is the whole hand-off, in the colleague's terms: they get nothing else. It's "
     "queued only when this answers with a job number; if it answers 'Not confirmed', it may be, so don't send it "
     'again. If the board then adds to it or changes it, use add with that number: never a second job beside it, and '
     "never a promise to add it after the call. Its answer gives each agreed deadline's facts and the other threads it "
     'moves: your briefing says what the board hears of them. First use estimate, compare the scopes, and give your own size, refs and why. HQ saves it once. Only the CEO changes it later.',
     'inputSchema': {'type': 'object', 'required': ['agent', 'title', 'code', 'brief', 'size', 'refs', 'why'],
                     'additionalProperties': False, 'properties': {
         'agent': ID,
         'size': SIZE,
         'refs': {'type': 'array', 'items': {'type': 'integer', 'minimum': 1}, 'description': 'clean past jobs you judged comparable; empty when no scope fits'},
         'why': {'type': 'string', 'minLength': 1, 'description': 'why these jobs fit, how this scope differs, or why no job fits'},
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
                       'since one whole brief is worth more)'},
         'expedite': {'type': 'boolean', 'description': "the CEO's only, for a structural fix to HQ itself when a fault "
                      'could also stall its own fix: it starts first, ahead of the plan, pacing and pauses, and merges '
                      'on its checks, its review after. Never for ordinary work'}}}},
    {'name': 'promise', 'description': "Note a promise on this call's list the moment you make it: whenever you tell "
     "the board that you, or a colleague, will do something. Note it before you say it's done. It's on the call's list "
     'straight away, even if the line drops, but it reaches nobody live: after the call, the follow-up hands it out, '
     'and the board sees whether it happened.',
     'inputSchema': {'type': 'object', 'required': ['owner', 'what'], 'additionalProperties': False, 'properties': {
         'owner': {**ID, 'description': "who sees it through: your own id, or a colleague's (lowercase, e.g. ada)"},
         'what': LINE,
         'deadline': WHEN,
         # (askwindow.ts: the board's ask takes its window as it's queued, not after the call.)
         'job': {'type': 'integer', 'minimum': 1, 'description': "the owner's job already queued or running that the "
                 'promise is about (its number, from your briefing or the job tool), with deadline: the promise is '
                 "that job's, done when it is, and its thread takes the time at once, so it goes ahead of work that "
                 'can wait while the call is still on'},
         'thread': {'type': 'string', 'pattern': THREAD.pattern, 'description': 'with job, for a job you queued on this '
                    'call in no thread: the open thread it serves (<project>/<slug>), which it goes on, with the time'}}}},
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
    {'name': 'expedite', 'description': "The CEO's only: a structural fix to HQ itself goes first (hq expedite). A "
     'queued or running job starts ahead of everything and merges on its checks; one that has pushed, its pull request '
     'still in review, merges now if its last push passed them. Its review follows on what merged.',
     'inputSchema': {'type': 'object', 'required': ['job'], 'additionalProperties': False, 'properties': {
         'job': {'type': 'integer', 'minimum': 1, 'description': 'the fix\'s job number'}}}},
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
# comes back as hq's refusal. (The platform's languages)
TOOLS += [
    {'name': 'search', 'description': "Search the company's handbook, playbooks, briefs and knowledge base, the "
     "board's earlier calls with everyone and their summaries, the intercom, and your own job reports and desk phone "
     "requests, by meaning and by words (in any of the platform's languages; names and numbers like #32 hit exactly). "
     'Each hit says where it is. '
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
     'that leaves or by how much it misses, what it waits on (a card as "the board: <its title>") and what goes on next, '
     'all by name, live from the plan HQ plays, in a second. With no query, what is going on right now, fresh each '
     "time: everyone HQ counts at work (the board's number), each on its job or review with its seat, thread and "
     'window and, while a hold is on, why it runs, then every open desk phone card with the work waiting on it. Use it '
     "whenever the board asks who's working, whether a hold leaks or what a card holds up: your briefing's list is from "
     'the start of the call. For new work, use when. With extra_seat (5x or 20x), replay the whole live plan '
     'with a hypothetical added Claude Max seat at any time. Returns every project, thread and window before and '
     'after, measured capacity, assumptions and confidence. Query is optional for that replay. Nothing changes.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500,
                   'description': "the project's or thread's name, or a few words; leave it out for what's going on "
                   'right now'},
         'extra_seat': {'type': 'string', 'enum': ['5x', '20x']}}}},
    {'name': 'estimate', 'description': 'Find clean past jobs with briefs, reports, changed files and actual agent times. Compare their scope yourself before supplying size, refs and why to job, or size to when. Search ranking is only a candidate list, never an estimate.',
     'inputSchema': {'type': 'object', 'required': ['query'], 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500, 'description': 'the scope of work to compare'},
         'agent': ID}}},
    {'name': 'when', 'description': 'Before you tell the board when work will be done: use estimate to compare clean past jobs, '
     'choose size yourself, then it plays that size into the plan as it stands, every seat and window counted, in a '
     'few seconds: the earliest it can be done without making any window miss, and the window to set. With by (the '
     "board's time), whether it makes that time, and only if not, what would: windows giving or one more seat. "
     'Give the board the time it says. With extra_seat (5x or 20x), omit what and its flags to replay the whole '
     'existing plan before and after an added Claude Max seat, with every window and capacity confidence. '
     'Use this whenever the board asks whether another seat would help, even if no deadline misses. Nothing changes.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'what': {'type': 'string', 'minLength': 1, 'description': 'the work, in a few words'},
         'agent': {'type': 'string', 'description': "who would do it (its id; yours if left out)"},
         'size': SIZE,
         'after': {'type': 'integer', 'minimum': 1, 'description': 'the job that must merge before this work starts'},
         'by': {'type': 'string', 'description': "the board's time in UTC: 14:30 or 2026-10-06T14:30Z"},
         'extra_seat': {'type': 'string', 'enum': ['5x', '20x']}}}},
]
# Managing the company's work on the call: hq's management commands, as the agent runs them off the
# call, with the coordinator's own rules on who may do what. Each command, and which of its own commands it takes (None:
# all of them; '': the command alone; '#': a number, to read one). None of them takes a file, waits for the board or
# speaks as the job a call doesn't have (status, ask, wait, reply, meeting say...). Their short lines go as hq's
# arguments, as off the call; a brief and the board's words still go on stdin (job, add, reach). The coordinator opens
# only these commands' routes to a call's token (server.ts MANAGE_ROUTES).
MANAGE = {'cancel': None, 'stop': None, 'waits': None, 'window': None, 'review': None, 'job': {'move'}, 'plan': None,
          'thread': None, 'project': None, 'decision': None, 'inbox': {'', '#', 'accept', 'drop', '--all'},
          'meeting': {'', '#', 'ask', 'asks', 'set', 'join', 'drop'}, 'jobs': None, 'requests': None, 'close': None,
          'topic': None, 'summary': None, 'followthrough': {''}, 'estimate': {'set'}, 'seat-warning': None,
          'owed': {'', 'close'}}
TOOLS += [
    {'name': 'manage', 'description': "Manage the company's work now, as you would with hq off the call, when the "
     'board decides it or it is yours to do: cancel a queued job that never ran (cancel <job> "why"), stop a running one '
     '(stop), pause or resume a thread or project (thread pause <project>/<slug> "why", thread resume, project pause, '
     'project resume), move a job to another thread (job move <job> <project>/<slug>), drop, order or retitle a task '
     '(plan drop <job> "why", plan move, plan title), draw, rename or close threads (plan thread, plan need, plan rename, '
     'plan done, thread move), set or lift a window (window <project>/<slug> | <job> <time | none>), a job\'s waits '
     '(waits), its size (estimate set), projects (project say, new, owner, rename, done), the inbox (inbox, inbox accept, '
     'inbox drop), meetings (meeting ask, asks, set, join, drop), the desk phone\'s cards (requests, close <card>, topic), '
     'a product\'s return to the board that its words close (owed, owed close <slug> "why"), a '
     'decision (decision, decision link), subscription warnings (seat-warning), a stuck pull request back to review '
     '(review), and reads (jobs, plan '
     '<project>, thread list, summary, followthrough). HQ allows you what it allows you off the call. It acts at once: '
     "then tell the board what you did, in plain words: that's what your follow-up reads in the transcript. Never "
     "promise it for after the call when this can do it now.",
     'inputSchema': {'type': 'object', 'required': ['command'], 'additionalProperties': False, 'properties': {
         'command': {'type': 'array', 'minItems': 1,
                     'items': {'type': 'string', 'minLength': 1},
                     'description': 'the hq command\'s words after hq, one per item, as on the command line without '
                     'quotes: ["cancel", "123", "the board dropped it"], ["thread", "pause", "shop/launch-deck", '
                     '"waits for the board\'s photos"]'}}}},
]
# Ending the call: the agent can hang up once the board has clearly said goodbye.
# The tool itself does nothing: the voice line sees the agent use it in the reply's stream (server.py, Call.leave) and
# hangs up once the goodbye has played, unless the board speaks first.
HANG_UP_ANSWER = ("The line hangs up once your goodbye has finished playing. If the board speaks before then, the call "
                  "stays open and its words come to you as a new message: answer them as usual.")
TOOLS += [
    {'name': 'waiting', 'description': "Hear how the tools that answered 'Still waiting' went: the coordinator was "
     "slow, and each kept going. It waits a little for them and gives each one's answer as the tool itself would have. What "
     "still hasn't answered keeps going: tell the board it's still on its way, and use waiting again later, never the "
     'tool itself again.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}}},
]
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
# A walk-through: the caller shows our pages, and the line brings the agent the moments since its last turn and a
# picture of the screen with each of their turns. The screen tool looks closer, on the board's calls and a partner's.
MOMENT = re.compile(r'^(-[0-9]{1,4}[smh]|[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?|#[0-9]{1,6})$')  # (the coordinator reads it)
FRACTION = {'type': 'number', 'minimum': 0, 'maximum': 1}
SCREEN_TOOL = {
    'name': 'screen', 'description': "The screen of the person on the call, while they show you our pages (a "
    'walk-through): what is on it now, at a past moment, a part of it zoomed in, or the list of what they did since a '
    "time. Each of their turns already brings you what they did since your last one and a picture when the screen "
    'changed: use this for a closer look or to look back. Its pictures share the call\'s picture budget with those, so '
    'ask for one only when you need it. Never read its lines or numbers out: say what you see, as someone looking over '
    'their shoulder would.',
    'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
        'at': {'type': 'string', 'pattern': MOMENT.pattern, 'description': "a past moment, for its picture: '-20s' "
               "(that long ago), '17:03:12' (a time as the moment lines give it) or '#12' (a moment's number). Left "
               'out: now'},
        'region': {'type': 'object', 'required': ['x', 'y', 'width', 'height'], 'additionalProperties': False,
                   'properties': {k: FRACTION for k in ('x', 'y', 'width', 'height')},
                   'description': 'a part of the screen to zoom into, in fractions of its width and height (0 to 1) '
                   'from its top left: {x: 0.5, y: 0, width: 0.5, height: 0.5} is the top right quarter'},
        'since': {'type': 'string', 'pattern': MOMENT.pattern, 'description': 'instead of a picture, the list of what '
                  "they did since then: '-2m', '17:03' or '#12'"}}}}
TOOLS += [SCREEN_TOOL]
# The board's Sketchbook: a sketch it means on the call, through the line too (it counts the picture in the call's).
TOOLS += [
    {'name': 'sketch', 'description': "One of the board's sketches (its Sketchbook in HQ), when it means one on the "
     "call: by its number ('12') or a few words of its label ('tote bag'). Shows you its picture, with its label and "
     'when it was drawn and last changed; a label that matches several shows the latest and names the rest, and none '
     'lists the latest sketches. Its picture stays in the call, so open one only when the board means it.',
     'inputSchema': {'type': 'object', 'required': ['sketch'], 'additionalProperties': False, 'properties': {
         'sketch': {'type': 'string', 'minLength': 1, 'maxLength': 200,
                    'description': "its number, '12', or a few words of its label"}}}},
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
    SCREEN_TOOL,  #.
]


LOOK_UPS = ('search', 'history', 'call', 'intercom', 'eta', 'estimate')  # (eta)


def look(name, a):
    """(ok, text): runs `hq search|history|call|intercom` (or `hq projects` for eta, `hq now` for eta with no query)
    from an argument list, in the allowlisted environment."""
    extra = a.get('extra_seat')
    if name == 'eta' and 'extra_seat' in a and extra not in ('5x', '20x'):
        return False, 'extra_seat takes 5x or 20x'
    query = a.get('query', '')
    if name == 'call':
        cid = a.get('id')
        if type(cid) is not int or cid < 1:
            return False, 'call needs its number, like 12'
        query = str(cid)
    elif not isinstance(query, str) or (name in ('search', 'intercom', 'estimate') and not query.strip()):
        return False, f'{name} needs a query'
    if len(query) > 500:
        return False, f'query too long ({len(query):,} > 500): ask something shorter'
    agent = a.get('agent')
    if name == 'estimate' and agent is not None and not (isinstance(agent, str) and COLLEAGUE.fullmatch(agent)):
        return False, 'agent must be a colleague id, like ada'
    commands = {
        'search': ['hq', 'search', query, '5'],
        'estimate': ['hq', 'estimate', query, *(['--agent', agent] if agent else [])],
        'call': ['hq', 'call', query],
        'intercom': ['hq', 'intercom', query],
        # (with neither a query nor extra_seat: hq now.)
        'eta': ['hq', 'projects', *([query] if query.strip() else []),
                *(['--extra-seat', extra] if extra else [])] if query.strip() or extra else ['hq', 'now'],
        'history': ['hq', 'history'] + ([query] if query.strip() else []),
    }
    return looked(name, commands[name])


def when(a):
    """(ok, text): runs `hq when` from an argument list: the work, its size, whose it is, its prerequisite and the
    board's time, each checked so none reads as another's flag."""
    if 'extra_seat' in a:
        if a['extra_seat'] not in ('5x', '20x'):
            return False, 'extra_seat takes 5x or 20x'
        if any(k in a for k in ('what', 'agent', 'size', 'by', 'after')):
            return False, 'extra_seat replays the existing plan: omit new work and its flags'
        return looked('when', ['hq', 'when', '--extra-seat', a['extra_seat']])
    what, agent, size, by = (a.get(k, '') for k in ('what', 'agent', 'size', 'by'))
    if not isinstance(what, str) or not what.strip() or what.startswith('-'):
        return False, 'when needs what the work is'
    if not isinstance(agent, str) or (agent and not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', agent)):
        return False, "agent is an agent's id, like juno"
    if not valid_size(size):
        return False, 'size is agent time: 90m, 2h or 1h30m'
    if not isinstance(by, str) or (by and not re.fullmatch(r'[0-9:TZ -]{4,20}', by)):
        return False, 'by is a UTC time: 14:30 or 2026-10-06T14:30Z'
    after = a.get('after')
    if 'after' in a and (type(after) is not int or after < 1):
        return False, 'after is a job number, like 123'
    argv = ['hq', 'when', what, '--size', size, *(['--agent', agent] if agent else []),
            *(['--after', str(after)] if after is not None else []), *(['--by', by] if by else [])]
    return looked('when', argv)


def looked(name, argv):
    """Run a lookup and return (ok, text)."""
    r = subprocess.run(argv, env=HQ_ENV, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if r.returncode:
        return False, f'hq {name} failed: {(r.stderr or r.stdout).strip()[:300] or "the coordinator refused it"}'
    # Successful lookups return every line so long transcripts remain complete.
    return True, r.stdout.strip()


def run(args, words):
    """hq, from an argument list in the allowlisted environment, with the words on stdin: (exit code, stdout, stderr).
    Never the words in argv: any uid can read /proc/<pid>/cmdline."""
    r = subprocess.run(['hq', *args], env=HQ_ENV, input=words, capture_output=True, text=True)
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
    if name == 'expedite':
        n = a.get('job')
        if type(n) is not int or n < 1:
            return False, 'job is a job number, like 123'
        return answered(run(['expedite', str(n)], ''), 'Nothing expedited', 'it may or may not be expedited', by='hq expedite')
    if name == 'hang_up':
        return True, HANG_UP_ANSWER
    if name in ('pin_words', 'pin_sent'):
        return pin(name, a)
    if name == 'reach':
        return reach(a)
    if name == 'manage':
        return manage(a.get('command'))
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
    work, thread = (a.get('job'), a.get('thread')) if name == 'promise' else (None, None)
    if work is not None and (type(work) is not int or work < 1 or not deadline):
        return False, 'job is a job number, like 123, and goes with deadline'
    if thread is not None and (work is None or not (type(thread) is str and THREAD.fullmatch(thread))):
        return False, 'thread goes with job, and is one of the open threads, like shop/launch-deck'
    # (the words, as the agent gave them, are the quote: the follow-up has the call's own around them)
    when = [*(['--deadline', deadline] if deadline else []), *(['--job', str(work)] if work else []),
            *(['--thread', thread] if thread else [])]
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
    size, refs, why = a.get('size'), a.get('refs'), a.get('why')
    if not valid_size(size):
        return False, 'size is required agent time: 90m, 2h or 1h30m'
    if not isinstance(refs, list) or any(type(ref) is not int or ref < 1 for ref in refs):
        return False, 'refs must list the clean past job numbers, or [] when none fits'
    if not isinstance(why, str) or not why.strip():
        return False, 'why must explain the scope comparison, or why no past job fits'
    flags = [*(['--item', str(item)] if item else []), *(['--thread', thread] if thread else []),
             *(['--now'] if now else []), *(['--expedite'] if a.get('expedite') is True else []), '--code', code, '--size', size, '--why', why,
             *(['--refs', ','.join(map(str, refs))] if refs else [])]
    r = run(['job', *(['--after', str(after)] if after else []), agent, title, '-', *flags], brief)
    ok, text = answered(r, 'No job was queued', 'the job may or may not be queued', by='hq job')
    return ok, f"{text}\nNot started yet: it's on {agent}'s list, and nobody is on it until it runs." if ok else text


def valid_size(size):
    """Agent time uses positive hours and minutes, checked before they enter argv."""
    return isinstance(size, str) and bool(re.fullmatch(r'(\d+h)?(\d+m)?', size)) and any(c in '123456789' for c in size)


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


def manage(command):
    """manage: one of hq's management commands (MANAGE), from an argument list. Its answer is hq's, or why not."""
    if not (isinstance(command, list) and command and all(type(w) is str and w for w in command)):
        return False, 'command is the hq command\'s words, one per item, like ["cancel", "123", "why"]'
    if any('\n' in w or '\r' in w for w in command):
        return False, 'each word is one line'
    name, sub = command[0], command[1] if len(command) > 1 else None
    if name not in MANAGE:
        return False, (f'hq {name} is not a management command on a call: {", ".join(sorted(MANAGE))}. Hand work on '
                       'with job, note a promise with promise')
    takes, given = MANAGE[name], '' if sub is None else '#' if re.fullmatch(r'(findings:)?[0-9]+', sub) else sub
    if takes is not None and given not in takes:
        shown = ', '.join({'': '(nothing more)', '#': 'a number'}.get(t, t) for t in sorted(takes))
        return False, f'on a call, hq {name} takes {shown}'
    # hq's management commands (api.ts change): 1 is a refusal or a wrong command, so nothing changed; 6 and 7 reached
    # no HQ; anything else may have come after HQ made the change
    code, out, err = run(command, '')
    if code == 0:
        return True, out
    if code == 1:
        return False, err or out
    if code in (6, 7):
        return False, f"HQ couldn't be reached, so nothing changed (hq {name}: exit {code}). Try again in a moment."
    said = err or out or f'hq {name}: exit {code}'
    return False, f'Not confirmed: {said}. It may or may not have happened: check it before you do it again.'


def answered(reply, refusal, unconfirmed, again=UNSURE, by='hq'):
    """(ok, text) from run's reply: done only when hq confirms it, and refused only when hq's refusal says nothing
    happened. Anything else may have come after the coordinator saved it (hq: exit 3, "Not confirmed"): a retry could
    do it twice, so `again` tells the agent not to."""
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


def screen(a):
    """(ok, content) of the screen tool: the voice line's answer on its socket, as MCP content (a picture and its moment
    line, or the moment list), or its refusal."""
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': "There's no screen on this call: nobody is showing our pages."}]
    if any(k in a and not (isinstance(a[k], str) and MOMENT.fullmatch(a[k])) for k in ('at', 'since')):
        return False, [{'type': 'text', 'text': "at and since take '-20s', '17:03:12' or '#12'"}]
    region = a.get('region')
    if 'region' in a and not (isinstance(region, dict) and set(region) == {'x', 'y', 'width', 'height'} and all(
            type(v) in (int, float) and 0 <= v <= 1 for v in region.values())):
        return False, [{'type': 'text', 'text': 'region takes x, y, width and height, each a fraction from 0 to 1'}]
    if 'since' in a and ('at' in a or 'region' in a):
        return False, [{'type': 'text', 'text': 'since gives the moment list: ask for a picture (at, region) apart'}]
    got = line_asked({k: a[k] for k in ('at', 'region', 'since') if k in a})
    if 'error' in got or 'picture' in got:
        return shown(got)
    return True, [{'type': 'text', 'text': '\n'.join(got.get('lines') or []) or 'Nothing since then.'}]


def sketch(a):
    """(ok, content) of the sketch tool: the voice line's answer on its socket (a sketch's picture and its line), or
    its refusal."""
    asked = a.get('sketch')
    if not isinstance(asked, str) or not asked.strip() or len(asked) > 200:
        return False, [{'type': 'text', 'text': "sketch is its number, '12', or a few words of its label"}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': "Sketches can't be shown on this call."}]
    return shown(line_asked({'sketch': asked}))


def line_asked(asked):
    """The voice line's answer on its socket to one ask, by this session's key."""
    with socket.socket(socket.AF_UNIX) as line:  # (the line always answers or closes: it waits on the coordinator)
        line.connect(SCREEN_SOCKET)
        line.sendall((json.dumps({**asked, 'key': SCREEN_KEY}) + '\n').encode())
        return json.loads(b''.join(iter(lambda: line.recv(1 << 16), b'')))


def shown(got):
    """(ok, content) of the line's answer: its refusal, or a picture and its line, as MCP content."""
    if 'error' in got:
        return False, [{'type': 'text', 'text': str(got['error'])}]
    picture, line = got['picture'], got.get('line')
    return True, [{'type': 'image', 'data': picture['data'], 'mimeType': picture['type']},
                  *([{'type': 'text', 'text': line}] if line else [])]


def awaited(name, a):
    """(ok, text) of the board's tool, as soon as the coordinator answers, or within STILL s that it's still waiting."""
    future = WORK.submit(lambda: when(a) if name == 'when' else (look if name in LOOK_UPS else hq)(name, a))
    if wait([future], STILL).done:
        return future.result()
    what = next((f'{name} ({a[k]})' for k in ('title', 'what', 'query', 'words') if isinstance(a.get(k), str)), name)
    PENDING.append((what, future))
    return True, STILL_WAITING.format(what)


def waiting():
    """(ok, text): the answers that came for the tools still waiting, within STILL s, and what's still waiting."""
    if not PENDING:
        return True, 'Nothing is waiting for the coordinator: every tool of this call has its answer.'
    done = wait([future for _, future in PENDING], STILL).done  # (one look: one landing between two would be lost)
    came = [(what, outcome(future)) for what, future in PENDING if future in done]
    PENDING[:] = [(what, future) for what, future in PENDING if future not in done]
    lines = [f'{what}: {text}' for what, (_, text) in came] + [STILL_WAITING.format(what) for what, _ in PENDING]
    return all(ok for _, (ok, _) in came), '\n\n'.join(lines)


def outcome(future):
    """A finished tool's (ok, text), or how it failed (as answer() words a tool that raised)."""
    try:
        return future.result()
    except Exception as e:
        return False, f'failed: {str(e)[:200]}'


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
        if name == 'screen' or (name == 'sketch' and offered is TOOLS):  # (its own content: a picture and its line)
            ok, content = (screen if name == 'screen' else sketch)(arguments)
            return {'jsonrpc': '2.0', 'id': mid, 'result': {'content': content, 'isError': not ok}}
        if offered is PARTNER_TOOLS:
            ok, text = partner(name, arguments)
        elif name == 'waiting':
            ok, text = waiting()
        elif name == 'hang_up':
            ok, text = hq(name, arguments)
        else:
            ok, text = awaited(name, arguments)
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
