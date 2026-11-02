"""The call agent's tools, as a tiny MCP server over stdio in place of a shell (guard.TOOLS, guard.PARTNER)."""
import http.client, json, os, re, signal, socket, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

import yaml

import reads
from drawing import ASK_WORDS, BESIDE_MOST, INK_WORDS, WHAT_MOST, ink_asked, what_asked
from driving import BY, DRIVE_WORDS, OPEN_WORDS, move_asked, work_asked
from callnotes import (CHANGE_WORDS, GOAL, MARK_WORDS, MARKS, PAGE_WORDS, TITLE_WORDS_SAID, TOPIC_MOST, TRY_WORDS, WHAT,
                       WRITE_DOWN_WORDS, change_asked, mark_asked, title_asked, try_asked, written_asked)
from voices import NAME_LENGTH, VOICE_WORDS
from voices import ENROL_WORDS, FORGET_WORDS

# The CLI starts this with the seat's sign-in in its environment: hq gets only the call's own HQ_* (HQ_TIME_ZONE: the
# board's clock for hq's times, guard.py agent_env). The call's Waits runs hq in it.
HQ_ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'HQ_URL', 'HQ_TOKEN', 'HQ_AGENT', 'HQ_CALL', 'HQ_TIME_ZONE')
          if k in os.environ}
# The screen tool (and the sketch tool) asks the voice line itself, on its
# socket, by the session's key (guard.agent_env): the line keeps the call's picture budget and its own token. Neither is
# here on a call with no screen.
SCREEN_SOCKET, SCREEN_KEY = os.environ.get('SCREEN_SOCKET', ''), os.environ.get('SCREEN_KEY', '')
# (the coordinator refuses longer ones from a call too: server.ts, ledger.ts, messages.ts. An item's line and goal:
# callnotes.py WHAT, GOAL.)
TITLE, BRIEF, ADD = 140, 8000, 8000
UNSURE = "{} Don't hand it on again: tell the board the hand-off is unconfirmed and that you'll check after the call."
UNNOTED = "{} Don't note it again: the follow-up goes through the whole call afterwards and records it if it's missing."
WORK = ThreadPoolExecutor()  # (the tools under way, every call's: what's under way at hang-up still lands)
STILL_WAITING = ("Still waiting for the coordinator's answer to {}: it's slow, not down (it answered a check that it's "
                 "alive moments ago), and this is still going through, not lost. Never use the tool again for it. Tell "
                 "the board in a few words that it's still on its way, then use waiting to hear how it went.")
STILL_CHECKING = ("Still waiting for the coordinator's answer to {}. Whether the coordinator is up is being checked: if "
                  "it's down, waiting will say so within seconds. Never use the tool again for it. Tell the board in a "
                  "few words that it's still on its way, then use waiting to hear how it went.")
DOWN = "The coordinator is down: it doesn't answer at all, not even a check that it's alive. Tell the board so plainly."
DOWN_HANDED = ' ' + UNSURE.format("The hand-off may or may not have gone through before it stopped answering.")
NO_ANSWER = "No answer in {} minutes, though the coordinator is up, so the wait ended."
# The board's call tools answer in numbers (jobs, items, calls) the agent needs for its next tool, and the agent
# speaks right after reading them: every answer but hang_up's carries this as a part of its own (answer()), the moment
# the agent turns it into words. Text keeps its numbers.
ALOUD = ('The numbers here are for your tools only. Never say one aloud (a job, card, pull request, call, item or '
         'pin): tell the board what the work is and whose it is.')
COLLEAGUE = re.compile(r'[a-z0-9][a-z0-9-]{0,39}')
DEADLINE = re.compile(r'^[0-9][0-9hmHM:TZ -]{0,24}$')  # (the coordinator reads it: windows.ts)
# (a deliverable, <project>/<slug>, in the tools' words.)
DELIVERABLE = re.compile(r'^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$')  # (projects.ts)
PROJECT = re.compile(r'^[a-z0-9][a-z0-9-]*$')  # (a project's id)
CODE = re.compile(r'^[A-Za-z]{2,8}$')  # a task's code word (jobcodes.ts WORD)
ID = {'type': 'string', 'pattern': '^[a-z0-9][a-z0-9-]*$', 'description': "the colleague's id, lowercase (e.g. ada)"}
# Work only one engine and model do (company/org.yaml engineOnly, the coordinator's engineonly.ts), by id with its
# what, from the deployed company's files (infra/compose.yaml's voice service; a test gives its own): the job tool marks
# a job as one (hq job --only), so it starts on them.
REPO = Path(os.environ.get('HQ_TOOLS_REPO', '/repo'))


def engine_only(org):
    """org.yaml's engineOnly rules, {id: what} (none where it has no engineOnly)."""
    return {str(rule['id']): str(rule['what']) for rule in yaml.safe_load(org.read_text()).get('engineOnly', [])}


ONLY = engine_only(REPO / 'company/org.yaml')
ONLY_IDS = list(ONLY)  # (a list: an answer that isn't a string is refused like an unknown id)
LINE = {'type': 'string', 'minLength': 1, 'maxLength': WHAT,
        'description': f'one plain line in your own words, at most {WHAT} characters: the board reads it'}
# why the board wants it, which the work it leads to is judged against
GOALS = {'type': 'string', 'minLength': 1, 'maxLength': GOAL,
         'description': "why the board wants it: the goal it serves or the problem it solves, in the board's own "
         f'terms from what it said on this call, never your plan for it. One plain line, at most {GOAL} characters. '
         'The team judges the work, and any rule made from it, against this'}
# the time of something written down, for work new or already under way (a review, a running job): the board's own
# with its date and no zone, as windows.ts reads it
# The time to tell the board is live four times in five.
WHEN = {'type': 'string', 'pattern': DEADLINE.pattern, 'description': 'when you told the board it will be done, at our '
        'pace: 2h, 90m or 1h30m from now; the board\'s own time as it said it, with its date and no zone (2026-10-26 '
        "09:00, on the company's clock); a time with Z, or a time of day alone (14:30), is UTC. Give "
        'it whenever you tell the board a time, also for work already under way (a review, a running job): with job, '
        "it is that work\'s, and its deliverable takes the time at once; the job tool\'s with its item takes it as "
        "it\'s queued. The time you tell is the one eta or when gives to tell the board (live four times in five), never a "
        'planned finish. It is ours: its slips are never news to the board, unless board_set'}
# whether the board set that time itself: only such a time's miss is told to it, once
BOARD_SET = {'type': 'boolean', 'description': 'with deadline: true only when the board named this time itself or '
             "asked for the work by it ('I need it by Tuesday'). A time you gave or offered, even one it took, is ours: "
             'leave it out'}
SIZE = {'type': 'string', 'description': 'your estimate as a JSON string, for example '
        '{"time":"35m","tokens":{"work":1000000,"reviews":200000,"fixes":100000,"feedback":0},"feedback_rounds":0,"confidence":{"level":"medium","why":"Two similar scopes, but limited feedback history"}}. '
        'These numbers illustrate the format, not defaults. Reason from the closest clean scopes and token splits '
        'from estimate, never averages. Include review, fix and expected feedback tokens. Visible experience, feel '
        'and performance normally need feedback rounds, backend work and refactoring normally do not. Give the '
        'token total and split beside the time you tell the board. Unknown historical seat meters stay unknown. State confidence (low, medium or high) and why in the JSON, based on how many past examples fit and how close they are. This is your judgment, not a tool score.'}
TOOLS = [
    {'name': 'job', 'description': "Put work on a colleague's list as a separate job. "
     "Queue it only once the board agrees the direction on this call. Until it does, say what you'd do and ask. A "
     "job on a direction the board then turns down makes more mess and wastes tokens and the board's money. It "
     "doesn't reach them live: nobody is on it until it runs, so tell the board it's queued, never that it's sent "
     "or that they're on it. The title is what HQ shows; the brief is the whole hand-off, in the colleague's terms: "
     "they get nothing else. It's queued only when this "
     "answers with a job number; if it answers 'Not confirmed', it may be, so don't send it again. If the board then "
     "adds to it or changes it, use add with that number: never a second job beside it, and never a note to add "
     "it after the call. Its answer gives each agreed deadline's facts and the other deliverables it "
     'moves: your briefing says what the board hears of them. First use estimate, compare the scopes, and give your own size, refs and why. HQ saves it once. Only the CEO changes it later. '
     "On the board's call in HQ the job is written in the call's notes too, so the board sees what reaches the team: "
     "for something you wrote down already, give its item instead.",
     'inputSchema': {'type': 'object', 'required': ['agent', 'title', 'code', 'brief', 'goal', 'size', 'refs', 'why'],
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
                   "since HQ shows it inside its deliverable, so never the deliverable's or project's name in front"},
         'brief': {'type': 'string', 'minLength': 1, 'maxLength': BRIEF, 'description': 'everything they need: what to '
                   f'do, why, what the board said. At most {BRIEF:,} characters with the goal; more is two jobs'},
         'goal': GOALS,
         'item': {'type': 'integer', 'minimum': 1, 'description': 'if this job carries out something written down '
                  'or corrected on this call: the item number write_down or replace answered with (it is then done '
                  'when the job is). The recorded goal of that item wins over goal here'},
         # (drawing one is as easy as joining one: the board, call 172)
         'deliverable': {'type': 'string', 'pattern': DELIVERABLE.pattern, 'description': 'the open deliverable '
                         'the work serves (<project>/<slug>), when you know the feature it is a step of: its answer '
                         "repeats that deliverable's done when, so check it's what this work delivers. Needed (or "
                         'new_deliverable) with an item that has a time: the time goes on the deliverable'},
         'new_deliverable': {'type': 'object', 'required': ['project', 'name', 'done_when'], 'additionalProperties': False,
                             'description': 'instead of deliverable: one drawn for this work, for work no open '
                             "deliverable makes (the project's owner or the CEO draws one)",
                             'properties': {'project': {'type': 'string', 'pattern': PROJECT.pattern,
                                                        'description': 'the project its work is for, like shop'},
                                            'name': {'type': 'string', 'minLength': 1},
                                            'done_when': {'type': 'string', 'minLength': 1,
                                                          'description': 'what this work delivers, in a line'}}},
         'after': {'type': 'integer', 'minimum': 1, 'description': 'a job that must merge before this one starts: '
                   "to queue it behind a deadline's work, when you judge that deadline worth protecting from it"},
         'now': {'type': 'boolean', 'description': 'Left out, the job waits until this call ends, so what the '
                       'board adds to it on the call (add) goes into its brief and it starts whole. True starts it at '
                       'once: your judgment each time, or the board\'s word, on whether the work can\'t wait for the end '
                       'of the call (the site is down: someone looks now. Needed by tomorrow: it waits the few minutes, '
                       'since one whole brief is worth more)'},
         'expedite': {'type': 'boolean', 'description': "the CEO's only, for a structural fix to HQ itself when a fault "
                      'could also stall its own fix, or for work the board needs in its hands now (its word on the '
                      'call): it starts first, ahead of the plan, pacing and pauses, and merges on its checks, its '
                      'review after. Never for work that can wait for its review'},
         **({'only': {'type': 'string', 'enum': ONLY_IDS, 'description': 'set it when the work is one of these '
                      'kinds, whoever it is for: it then starts on the one engine and model that does it. '
                      + '; '.join(f'{id}: {what}' for id, what in ONLY.items())}} if ONLY else {})}}},
    {'name': 'replace', 'description': 'When the board changes something still open that your briefing lists with its '
     "number, or something you wrote down on this call, note the change now: it goes on this call's list in place of "
     "the earlier item, whose jobs that haven't started are cancelled, and a note of it in the call's notes says the "
     "new words. It reaches nobody live: a job already running runs on, and hears the correction from the call's "
     'follow-up after the call. Only those items: never guess a number, and any other is refused; then say the '
     "follow-up will correct it from the call. A job you queued on this call takes the board's change with add "
     "instead. Its answer names the item it replaced: if that isn't what the board meant, tell the board, and the "
     'follow-up puts it right.',
     'inputSchema': {'type': 'object', 'required': ['item', 'what', 'goal'], 'additionalProperties': False,
                     'properties': {
         'item': {'type': 'integer', 'minimum': 1, 'description': 'the earlier item\'s number (#n)'},
         'what': {**LINE, 'description': f'what it is now, one plain line in your own words, at most {WHAT} characters:'
                  ' the board reads it'},
         'goal': {**GOALS, 'description': f"{GOALS['description']}. Why the board wants it now: the earlier "
                  'reason if it still holds'},
         'deadline': {**WHEN, 'description': 'a new time, if the board changed it or you told it one (as for '
                      'write_down); '
                      "without one, the earlier item\'s time stays"},
         'board_set': BOARD_SET}}},
]
# Adding to a job the call queued (hq extend on a call: call.ts addToJob), when the board adds or corrects something
# after the job tool answered: into its brief while it hasn't started, else to its running session at its next step.
TOOLS += [
    # (once what it waits for is met)
    {'name': 'expedite', 'description': "The CEO's only: a structural fix to HQ itself, or work the board needs in its "
     'hands now (its word on the call), goes first (hq expedite). A '
     'queued or running job starts ahead of everything, once what it waits for is met (the answer says what), and merges '
     'on its checks; one that has pushed, its pull request '
     'still in review, merges now if its last push passed them. Its review follows on what merged. A deliverable\'s '
     'task that hasn\'t started leaves its deliverable as its own job; a refusal says why and what to do instead.',
     'inputSchema': {'type': 'object', 'required': ['job'], 'additionalProperties': False, 'properties': {
         'job': {'type': 'integer', 'minimum': 1, 'description': 'the fix\'s job number'}}}},
    {'name': 'add', 'description': 'When the board adds to or changes a job you queued on this call, add it to that '
     'job now, by the number the job tool answered with: before the job starts it goes into its brief; once it has, '
     "the job's session reads it at its next step. Only jobs you queued on this call (any other is refused: then the "
     "follow-up adds it from the call). Tell the board what this answers, in plain words. It's added only when this "
     "answers so; if it answers 'Not confirmed', it may be, so don't add it again.",
     'inputSchema': {'type': 'object', 'required': ['job', 'words', 'goal'], 'additionalProperties': False,
                     'properties': {
         'job': {'type': 'integer', 'minimum': 1,
                 'description': 'the job you queued on this call (#n, from the job tool)'},
         'words': {'type': 'string', 'minLength': 1, 'maxLength': ADD,
                   'description': "what the board added or changed, in the colleague's terms, as part of that job's "
                   f'brief. At most {ADD:,} characters'},
         'goal': GOALS}}},
]
# The board's settled word to work already under way (hq say on a call: call.ts reach), for real need only, as often as
# the board's word needs: each goes on the call's list, so the follow-up
# doesn't send it again.
TOOLS += [
    {'name': 'reach', 'description': "When the board's settled word matters to work already under way before the call "
     "ends, pass it on to that running job or pull request's review, by the number your briefing lists, as often as "
     "the board's word needs; anything still being worked out goes to the follow-up. It goes on this call's list "
     "too, and on the board's call in HQ in its notes, as passed on. Tell the board where it went as this answers; if it answers 'Not confirmed', it may have gone, so don't send it again.",
     'inputSchema': {'type': 'object', 'required': ['agent', 'job', 'words', 'what', 'goal'], 'additionalProperties': False,
                     'properties': {
         'agent': {**ID, 'description': "whose job or review it is, lowercase (e.g. ada): a number that isn't theirs "
                   'is refused'},
         'job': {'type': 'integer', 'minimum': 1,
                 'description': "the running job's or review's number (#n in your briefing)"},
         'words': {'type': 'string', 'minLength': 1, 'maxLength': ADD,
                   'description': "what the board wants that work to know now, in the colleague's terms. At most "
                   f'{ADD:,} characters'},
         'what': {**LINE, 'description': f"what you passed on, one plain line for the call's list, at most {WHAT} "
                  'characters: the board reads it'},
         'goal': GOALS}}},
]
# Looking things up (hq search, hq history, hq call, hq intercom; the coordinator's memory.ts and intercom.ts): the
# Handbook, knowledge, the board's calls with everyone (with their summaries), the intercom, and the agent's own jobs
# and requests, so a call about past work, or something the board asked on the intercom, finds it.
# Read-only; the call token sees only its own agent's work, and a call the coordinator won't show (one still going on)
# comes back as hq's refusal.
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
    # (a deliverable past its window, or when past by, answers with what to check first: worker/hq deadlines.ts lateLines)
    # The safe live time is the one to tell the board.
    {'name': 'eta', 'description': 'Where planned work stands now, before you tell the board when it will be done: for '
     "a project or a deliverable by its name or a few words ('The checkout', 'the game's levels'), each open deliverable's "
     'ETA (its calculated merge time), the agent time it has left, its deadline and aim, with its planned live finish, the time to tell the board, and the slack '
     'that leaves or by how much it misses, what it waits on (a card as "the board: <its title>") and what goes on next, '
     'all by name, live from the plan HQ plays, in a second. With no query, what is going on right now, fresh each '
     "time: everyone HQ counts at work (the board's number), each on its job or review with its seat, deliverable and "
     'window and, while a hold is on, why it runs, then every open desk phone card with the work waiting on it. Use it '
     "whenever the board asks who's working, whether a hold leaks or what a card holds up: your briefing's list is from "
     'the start of the call. For new work, use when. With extra_seat (5x or 20x), replay the whole live plan '
     'with a hypothetical added Claude Max seat at any time. Returns every project, deliverable and window before and '
     'after, measured capacity, assumptions and confidence. Query is optional for that replay. A deliverable that misses its '
     'window comes with what to check and do before you tell the board a time: do it. To put a deliverable first, give it '
     'a window (manage): the scheduler makes room for it by itself, never a pause of other work. Nothing changes.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500,
                   'description': "the project's or deliverable's name, or a few words; leave it out for what's going on "
                   'right now'},
         'extra_seat': {'type': 'string', 'enum': ['5x', '20x']}}}},
    {'name': 'estimate', 'description': 'Find clean past jobs with briefs, reports, changed files and whole task agent times split into work, shared reviews and fixes. Size.time covers the work split only. The raw whole.cost token split and feature_cost feedback totals accompany the times. The forecast adds review and fix rounds once per deliverable. Queue and other waits are excluded. Compare their scope yourself before supplying size, refs and why to job, or size to when. Search ranking is only a candidate list, never an estimate.',
     'inputSchema': {'type': 'object', 'required': ['query'], 'additionalProperties': False, 'properties': {
         'query': {'type': 'string', 'minLength': 1, 'maxLength': 500, 'description': 'the scope of work to compare'},
         'agent': ID}}},
    {'name': 'when', 'description': 'Before you tell the board when work will be done: use estimate to compare clean past jobs, '
     'choose the task work estimate as size, then it plays that size into the plan as it stands, every seat and window counted, in a '
     'few seconds: the earliest planned live finish without making any window miss, a proposed window, and the time to tell the board (live four times in five). With by (the '
     "board's time), whether it makes that time, and only if not, what would: windows giving or one more seat. "
     'Give the board its time to tell the board, but a finish past by comes with what to check and do first: do it. '
     'With extra_seat (5x or 20x), omit what and its flags to replay the whole '
     'existing plan before and after an added Claude Max seat, with every window and capacity confidence. '
     'Use this whenever the board asks whether another seat would help, even if no deadline misses. Nothing changes.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'what': {'type': 'string', 'minLength': 1, 'description': 'the work, in a few words'},
         'agent': {'type': 'string', 'description': "who would do it (its id; yours if left out)"},
         'size': SIZE,
         'after': {'type': 'integer', 'minimum': 1, 'description': 'the job that must merge before this work starts'},
         # (the same time forms as WHEN)
         'by': {'type': 'string', 'description': "the board's own time as it said it, with its date and no zone "
                  "(2026-10-26 09:00, on the company's clock); a time with Z, or a time of day alone (14:30), is UTC"},
         'extra_seat': {'type': 'string', 'enum': ['5x', '20x']}}}},
]
# What a job's agent reads off the call (reads.py): the server's status report
# (jobs, pull requests, deploys, seats, the services' logs) and the company's git, every branch with unmerged work.
# Read-only; a long answer comes in pages (reads.PAGE), never cut.
FROM = {'type': 'integer', 'minimum': 1, 'description': 'the line to start from, when an answer said where the rest '
        'starts'}
OFFSET = {'type': 'integer', 'minimum': 0, 'description': 'with from, the characters into that line to start at, when '
          'an answer said the rest starts with an offset (a line longer than a page)'}
TOOLS += [
    {'name': 'report', 'description': "The server's status report, live, as your jobs read it with hq report: "
     'containers and deploys, memory and disk, seats and usage, the open and recent jobs and pull requests with '
     "reviews' findings, what waits on the board, calls, mail counts, errors and each service's last log lines. Use "
     "it before you tell the board you can't see or haven't checked something. With no section, the list of its "
     "sections; section: those whose heading has these words ('work', 'pull requests nobody', 'voice', 'errors'); "
     'find: only the lines with these words (a job number, a pull request, a name), in a section or the whole report. '
     'since or at: what changed since a time, or the report at a time (the last two days).',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'section': {'type': 'string', 'description': "words of a section's heading"},
         'find': {'type': 'string', 'description': 'only the lines with these words'},
         'since': {'type': 'string', 'description': 'an ISO time: what changed since then'},
         'at': {'type': 'string', 'description': 'an ISO time: the report as it was then'},
         'from': FROM, 'offset': OFFSET}}},
    {'name': 'git', 'description': "The company's code as your jobs read it with git, every branch: main, a job's "
     "work not merged yet (job/<n>, as a pull request's branch) and a job's commits that never reached a pull request "
     '(outgoing/job/<n>). log: the commits of rev (a range main..job/<n>: what the branch adds), optionally of a path; '
     'show: a commit (stat: only the files it changed), or with path a file or folder as it is at rev; diff: a range, '
     'main...job/<n> for what a branch changed (stat: the files only), optionally under a path; grep: the lines with '
     'pattern at rev (a fixed string), optionally under a path; branches: the branches, newest first, pattern '
     'narrowing them.',
     'inputSchema': {'type': 'object', 'required': ['command'], 'additionalProperties': False, 'properties': {
         'command': {'type': 'string', 'enum': ['log', 'show', 'diff', 'grep', 'branches']},
         'rev': {'type': 'string', 'description': 'a branch, tag or commit (main, job/1234, a sha; main if left '
                 'out), or a range for log and diff (main...job/1234)'},
         'path': {'type': 'string', 'description': 'a file or folder in the repository'},
         'pattern': {'type': 'string', 'description': "grep's words, or words in the branches' names and subjects"},
         'ignore_case': {'type': 'boolean'},
         'stat': {'type': 'boolean', 'description': 'show and diff: the files changed and their counts only'},
         'from': FROM, 'offset': OFFSET}}},
]
# Managing the company's work on the call: hq's management commands, as the agent runs them off the
# call, with the coordinator's own rules on who may do what. Each command, and which of its own commands it takes (None:
# all of them; '': the command alone; '#': a number, to read one). None of them takes a file, waits for the board or
# speaks as the job a call doesn't have (status, ask, wait, reply, meeting say...). Their short lines go as hq's
# arguments, as off the call; a brief and the board's words still go on stdin (job, add, reach). The coordinator opens
# only these commands' routes to a call's token (server.ts MANAGE_ROUTES).
# overseer, route, items and the estimate checks are the reads a job has, the call's too: the notes to the Overseer,
# the notes routed to jobs, every call's open items (one line each), the timing checks
MANAGE = {'cancel': None, 'stop': None, 'waits': None, 'window': None, 'review': None, 'job': {'move'}, 'plan': None,
          'deliverable': None, 'project': None, 'decision': None, 'inbox': {'', '#', 'accept', 'drop', '--all'},
          'meeting': {'', '#', 'ask', 'asks', 'set', 'join', 'drop'}, 'jobs': None, 'requests': None, 'close': None,
          'topic': None, 'summary': None, 'followthrough': {''}, 'seat-warning': None, 'owed': {'', 'close'},
          'overseer': {''}, 'route': {'log'}, 'items': {''}, 'estimate': {'set', '--audit', '--accuracy', '--calibration'}}
TOOLS += [
    # (a window puts work first, a pause only waits on a condition: worker/hq levels.ts WINDOW_FIRST and PAUSE_FOR say
    # the same rule).
    {'name': 'manage', 'description': "Manage the company's work now, as you would with hq off the call, when the "
     'board decides it or it is yours to do: cancel a queued job that never ran (cancel <job> "why"), stop a running one '
     '(stop), put work first with a window, the only way to (window <project>/<slug> | <job> <time>, or none to '
     'lift it; the scheduler makes room for it and gives the seat back after, by itself), pause or resume a deliverable '
     'or project only for work that must wait on a condition (something from the board, a decision it has to make, a '
     'hold it asked for), never to put other work first (deliverable pause <project>/<slug> "why" with --until <job>, '
     '--until-time <time> or --by-hand: what wakes you to judge it, never lifts it; deliverable resume, project pause, '
     'project resume), move a job to another deliverable (job move <job> <project>/<slug>), drop, order or retitle a '
     'task (plan drop <job> "why", plan move, plan title), draw, rename or close deliverables (plan deliverable, plan '
     'need, plan rename, plan done, deliverable move), a job\'s waits (waits), its size (estimate set), projects '
     '(project say, new, owner, rename, done), the inbox (inbox, inbox accept, '
     'inbox drop), meetings (meeting ask, asks, set, join, drop), the desk phone\'s cards (requests, close <card>, topic), '
     'a product\'s return to the board that its words close (owed, owed close <slug> "why"), a '
     'decision (decision, decision link), subscription warnings (seat-warning), a stuck pull request back to review '
     '(review), and reads (jobs, plan '
     '<project>, deliverable list, summary, followthrough, items, overseer, route log, estimate --audit, --accuracy or '
     '--calibration). HQ allows you what it allows you off the call. It acts at once: '
     "then tell the board what you did, in plain words: that's what your follow-up reads in the transcript. Never "
     "write it down for after the call when this can do it now.",
     'inputSchema': {'type': 'object', 'required': ['command'], 'additionalProperties': False, 'properties': {
         'command': {'type': 'array', 'minItems': 1,
                     'items': {'type': 'string', 'minLength': 1},
                     'description': 'the hq command\'s words after hq, one per item, as on the command line without '
                     'quotes: ["cancel", "123", "the board dropped it"], ["deliverable", "pause", "shop/launch-deck", '
                     '"waits for the board\'s photos", "--by-hand"]'}}}},
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
    'changed: use this for a closer look or to look back. Its pictures take room in your session as those do, so ask '
    'for one only when you need it. Never read its lines or numbers out: say what you see, as someone looking over '
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
# The board's Notebook (once the Sketchbook): a sketch it means on the call, through the line too (it counts the picture in the call's).
TOOLS += [
    {'name': 'sketch', 'description': "One of the board's sketches (its Notebook in HQ), when it means one on the "
     "call: by its number ('12') or a few words of its label ('tote bag'). Shows you its picture, with its label and "
     'when it was drawn and last changed; a label that matches several shows the latest and names the rest, and none '
     'lists the latest sketches. Its picture stays in the call, so open one only when the board means it.',
     'inputSchema': {'type': 'object', 'required': ['sketch'], 'additionalProperties': False, 'properties': {
         'sketch': {'type': 'string', 'minLength': 1, 'maxLength': 200,
                    'description': "its number, '12', or a few words of its label"}}}},
]
# The board drawing on its call: the agent asks to see the board's screen, and
# circles something on the board's screen in its own ink, through the line too (drawing.py: HQ shows the ask and draws
# the circle, and the line keeps what waits for HQ's answer).
WORDS = {'type': 'string', 'minLength': 1, 'maxLength': WHAT_MOST}
TOOLS += [
    {'name': 'ask_to_see', 'description': "Ask the board to show you its screen, naming the one thing you want to see "
     "(\"the pricing page\"): use it as soon as they talk about something on their screen that you can't see. This "
     'one step is the asking, and they answer yes or no (HQ shows your ask with Show and Not now), so never tell them '
     'which button to tap. It blocks nothing, so carry on talking: their answer comes with a later turn, and once they '
     'say yes their screen comes with each turn.',
     'inputSchema': {'type': 'object', 'required': ['what'], 'additionalProperties': False, 'properties': {
         'what': {**WORDS, 'description': 'the one thing you want to see, in a few words'}}}},
    # (aimed from the picture, drawn where aimed.)
    {'name': 'draw', 'description': "Circle something on the board's screen in your own ink, to catch its eye, the "
     "way you'd point at a screen: aim from your latest picture of their whole screen, and HQ draws the circle exactly "
     'where you aim, with your words beside it in your hand (a few words, or none). Circle only what that picture '
     "shows: if it isn't in view, scroll it into view first (drive), look at the screen now (screen), then aim from "
     "that picture. The circle follows what it's on as they scroll and goes when that goes or the call ends: it's never "
     'kept.',
     'inputSchema': {'type': 'object', 'required': ['at'], 'additionalProperties': False, 'properties': {
         'at': {'type': 'object', 'required': ['x', 'y', 'width', 'height'], 'additionalProperties': False,
                'properties': {k: FRACTION for k in ('x', 'y', 'width', 'height')},
                'description': "the box round what you circle, on your latest picture of their whole screen, in "
                "fractions of the picture's width and height (0 to 1) from its top left, as the screen tool's region: "
                '{x: 0.5, y: 0, width: 0.5, height: 0.5} is the top right quarter'},
         'words': {'type': 'string', 'maxLength': BESIDE_MOST, 'description': 'a few words beside the circle, or none'}}}},
]
# The agent driving a piece of work on the board's screen: it suggests opening
# something and moves the board's screen while it talks, through the line too (driving.py: HQ shows the suggestion and
# moves the screen, and the line keeps what waits for HQ's answer). Open shows too
TOOLS += [
    {'name': 'open_work', 'description': "Suggest opening a piece of work on the board's screen, to show it rather than "
     "describe it: something you or a colleague made (its preview page), or one of HQ's own screens (a job and its "
     "report, a card on the phone, review notes). Use it when the conversation is about something they'd understand "
     'faster by seeing, above all when they want to be walked through finished work. HQ shows a card, “<your name> '
     'suggests opening <what>”, with Open (Open and show while their screen isn\'t shown to you: the one tap opens it '
     'and lets you see their screen, so don\'t ask to see it as well) and Not now; something already open just comes '
     'forward. It blocks nothing, so carry on talking: their answer comes with a '
     "later turn. Once it's open, talk them through it as you would beside them: drive scrolls to what you're talking "
     'about and points at it, draw circles what matters. The screen stays theirs: they can scroll, draw or take over at '
     'any moment, and when they do, follow where they go.',
     'inputSchema': {'type': 'object', 'required': ['what', 'address'], 'additionalProperties': False, 'properties': {
         'what': {**WORDS, 'description': "what it is, in a few words, as the card shows it (“the teacup shop's new "
                  'product page”)'},
         'address': {'type': 'string', 'minLength': 1, 'description': 'a preview page, https://<name>.preview.<zone>/... '
                     "as its link gives it, or one of HQ's screens: /?open=jobs&job=<id>, /?open=phone&card=<id>, "
                     '/?open=book (the book as it is), /?open=book&owner=<agent>, /?open=projects, /?open=computer, /?open=gazette, /?open=intercom'}}}},
    {'name': 'drive', 'description': "Move the board's screen while you talk them through what's on it: scroll the "
     "words you're about to talk about into view (to, named by the words it shows: a heading, a label, a price), "
     'scroll a screen down or up or to the top or bottom of the page (by), or put your pointer on a spot you aim at on '
     'your latest picture of their whole screen (point). One move at a time, with exactly one of to, by and point; HQ '
     'answers once it has moved, or why not. After a scroll, look at the screen now (screen) before you point or circle: '
     "aim from what it shows. They're moving it too: if they've scrolled or gone somewhere else, go with them rather "
     'than pulling them back.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
         'to': {**WORDS, 'description': 'the words on their page to scroll into view, as they show there'},
         'by': {'type': 'string', 'enum': list(BY), 'description': 'a screen down or up, or to the top or bottom'},
         'point': {'type': 'object', 'required': ['x', 'y'], 'additionalProperties': False,
                   'properties': {'x': FRACTION, 'y': FRACTION},
                   'description': "the spot to point at on your latest picture of their whole screen, in fractions of "
                   "its width and height (0 to 1) from its top left"}}}},
]
# The call's notes, its page in the board's Notebook (callnotes.py): the agent's notes, one per change, and their title,
# through the line too (the coordinator's Ink store cuts each note's picture and writes it in). A change about what the
# board shows comes with its picture by default. write_down is the call's one
# way to write something down, a promise with its owner and time too, and on the phone the call's list alone
TOOLS += [
    {'name': 'write_down', 'description': "Write down one thing to be done, the moment it's settled: a change the "
     'board asked for or agreed to, or something you told the board you or a colleague will do (write it down before '
     "you say it's done). Something you noticed on your own, ask about first (\"I see X, is that on your screen "
     "too?\"). It's on the call's list straight away, even if the line drops, and the board sees whether it happened. On the board's "
     "call in HQ it's a note in the call's notes too, its page in the board's Notebook: your words on a post-it, with "
     'a picture of the part of what the board drew or showed that it is about, or your words alone. A change about '
     'something the board is showing on a screen other than these notes (a slide, an app, a page of HQ), or drew on in '
     'one of its own notes, comes with a picture of that part by default, so whoever reads it sees exactly what the '
     'board meant; circle the spot in it with mark_notes where that helps. Leave from and region out for a change '
     'about the notes themselves, which you never picture (a picture of the notes nests pictures of them in it), with '
     'nothing on a screen to show, or on the phone, which has no notes. When the board says and draws several changes '
     '("this should be smaller", an arrow: "and this should move here", a cross: "then we don\'t need this"), write '
     "one note per change, each with a picture of just its own part, never one for all of them. Its picture comes from "
     "one of the board's own notes on this call (from: 'note 3', its number as the line gave it; the region is a part "
     "of that note's picture), or from its shown screen at the moment it showed or drew it (from: 'now', '-20s', "
     "'17:03:12' or '#12' as the screen tool gives moments; the region a part of the whole screen then). Each note "
     "appears in the board's Notebook as you write it, as the board watches. Nothing written down goes to anyone by "
     "itself: the call's follow-up reads it with the whole call and hands it out (one about work under way, given as "
     'job, has reached that work already). So never also queue a job for it, unless it has to start on the call: then '
     'give the job its item.',
     'inputSchema': {'type': 'object', 'required': ['words', 'goal'], 'additionalProperties': False,
                     'properties': {
         'from': {'type': 'string', 'description': "for a picture: 'note 3', or a moment of the shown screen: 'now', "
                  "'-20s', '17:03:12', '#12'"},
         'region': {'type': 'object', 'required': ['x', 'y', 'width', 'height'], 'additionalProperties': False,
                    'properties': {k: FRACTION for k in ('x', 'y', 'width', 'height')},
                    'description': "for a picture: the part of what it comes from that the change is about, with a "
                    'little room round it, in fractions of its width and height (0 to 1) from its top left'},
         'words': {'type': 'string', 'minLength': 1, 'maxLength': WHAT,
                   'description': 'the one thing to be done, in a short plain line ("Make the price smaller")'},
         'goal': GOALS,
         'owner': {**ID, 'description': "who sees it through: your own id or a colleague's (lowercase, e.g. ada), if "
                   'you know; left out, the follow-up decides'},
         'deadline': WHEN,
         'board_set': BOARD_SET,
         # (askwindow.ts: the board's ask takes its window as it's queued, not after the call.)
         'job': {'type': 'integer', 'minimum': 1, 'description': "the owner's job already queued or running that it "
                 'is about (its number, from your briefing or the job tool), with owner and deadline: it is that '
                 "job's, done when it is, and its deliverable takes the time at once, so it goes ahead of work that "
                 'can wait while the call is still on'},
         'deliverable': {'type': 'string', 'pattern': DELIVERABLE.pattern, 'description': 'with job, for a job you '
                         'queued on this call in no deliverable: the open deliverable it serves (<project>/<slug>), '
                         'which it goes on, with the time'}}}},
    {'name': 'title_notes', 'description': "Give the call's notes a short title, once it's clear what the call is "
     'about ("Shop page prices"), and again if that changes: a title, not a summary. The Notebook puts the call\'s date '
     'and time in front of it ("28 Oct, 22:55, Shop page prices"), so give the topic alone.',
     'inputSchema': {'type': 'object', 'required': ['title'], 'additionalProperties': False, 'properties': {
         'title': {'type': 'string', 'minLength': 1, 'maxLength': TOPIC_MOST,
                   'description': f'the topic, at most {TOPIC_MOST} characters: whole in the Notebook\'s bar'}}}},
]
# The call's notes worked as the board works them: read, drawn on, changed, moved and deleted, none of it a step the
# board's Undo takes back: that's only the board's own (callnotes.py; the coordinator's ink/callpage.ts). A note's px
# and after.
PAGE_PX = {'type': 'number', 'minimum': -100000, 'maximum': 100000}
POINT = {'type': 'array', 'items': PAGE_PX, 'minItems': 2, 'maxItems': 2}
TOOLS += [
    # (read_notes carries the board's ink read from its strokes)
    {'name': 'read_notes', 'description': "What's in the call's notes now, in the order the Notebook lays them out in "
     'columns, a line each: its number (#id), whose it is, what it is (a note, a note with a picture, a drawing), its '
     'words, the box of its contents in its own px (x, y, width, height, y down: every note is the same width), and '
     "what the board's handwriting and marks on it say, read from its strokes, with what that reading wasn't sure of. "
     'Read them before you mark, move or delete something you didn\'t just write: the board changes them too. '
     'The numbers are for your tools: never say them.',
     'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}}},
    {'name': 'mark_notes', 'description': "Draw in the call's notes in your own ink, as the board draws with its pen, "
     'shapes and highlighter, on one note (around: its number; box and points in its own px) or as a drawing of its '
     'own after the last note: a rectangle or ellipse round a note\'s contents (around alone) or a box, a line or an '
     'arrow from one point to another, a pen line through points, or a highlight over a note\'s contents, a box or '
     'along points. Use it to point at what you mean on a note: a circle round the part that matters, an arrow to '
     'where something should go, a highlight on the words that matter. A mark asks for nothing: what the team must do '
     'is written down (write_down). It appears as the board watches.',
     'inputSchema': {'type': 'object', 'required': ['mark'], 'additionalProperties': False, 'properties': {
         'mark': {'type': 'string', 'enum': list(MARKS)},
         'around': {'type': 'integer', 'minimum': 1, 'description': 'the number of the note the mark goes on, as '
                    'read_notes gives it: a rect, ellipse or highlight alone goes round or over its contents'},
         'box': {'type': 'object', 'required': ['x', 'y', 'width', 'height'], 'additionalProperties': False,
                 'properties': {k: PAGE_PX for k in ('x', 'y', 'width', 'height')},
                 'description': "the box, in the note's own px"},
         'points': {'type': 'array', 'items': POINT, 'minItems': 2, 'maxItems': 500,
                    'description': "[[x, y], ...] in the note's own px: from and to for a line or an arrow, the way a pen "
                    'line or a highlight goes'},
         'filled': {'type': 'boolean', 'description': 'a rect or ellipse filled in'}}}},
    {'name': 'change_note', 'description': "Change one thing in the call's notes, as the board can: the words of one "
     'of your own notes (its item on the list takes them too, until it has gone to its work), anything in them moved '
     'right after another (after: its number), or deleted. Use it when the board asks for it or a note of yours is '
     'wrong, rather than writing another beside it. The board sees it happen.',
     'inputSchema': {'type': 'object', 'required': ['id'], 'additionalProperties': False, 'properties': {
         'id': {'type': 'integer', 'minimum': 1, 'description': 'its number, as read_notes or write_down gives it'},
         'words': {'type': 'string', 'minLength': 1, 'maxLength': WHAT,
                   'description': 'your note\'s new words, one plain line'},
         'after': {'type': 'integer', 'minimum': 1, 'description': 'the number of the note it goes right after, as '
                   'read_notes gives it'},
         'delete': {'type': 'boolean', 'enum': [True]}}}},
    {'name': 'try', 'description': "Have a few versions of something in the call's notes made for the board to pick "
     'from, when it asks to see options of a change ("show me a few versions of this"): its owner builds the real '
     'thing in a few ways (up to four), and each appears under it in the notes as it\'s made. Write the change down '
     'first (write_down), then use this on it. Then tell the board plainly that it\'s started and the versions appear '
     "under it one by one, and how long only as this tool's answer says. Never also queue a job for it.",
     'inputSchema': {'type': 'object', 'required': ['id', 'why'], 'additionalProperties': False, 'properties': {
         'id': {'type': 'integer', 'minimum': 1, 'description': 'its number, as read_notes or write_down gives it'},
         'why': {'type': 'string', 'minLength': 1, 'maxLength': WHAT,
                 'description': "what the board asked to see, in its own words, one plain line"}}}},
]

# Several people in the board's room, told apart by their voices (voices.py).
TOOLS += [
    {'name': 'name_voice', 'description': "Name a voice the line hears in the board's room ('Voice 2') once you know "
     'who it is: they said their name, or the board introduced them. The transcript and your messages name it so from '
     'then on.',
     'inputSchema': {'type': 'object', 'required': ['voice', 'name'], 'additionalProperties': False, 'properties': {
         'voice': {'type': 'string', 'description': "the voice as your messages name it now ('Voice 2')"},
         'name': {'type': 'string', 'minLength': 1, 'maxLength': NAME_LENGTH, 'description': "their name ('Sam')"}}}},
]
# Saved voices: later calls recognise a person by their voice (voices.py, the coordinator's voiceprints.ts).
TOOLS += [
    {'name': 'save_voice', 'description': "Save the voice of someone in the board's room (or the board's own), so later "
     'calls recognise them by name. Only when the board asks you to: never offer or suggest it yourself. Call it first '
     'with their name alone: it answers what to tell them and ask. Then, once they have agreed and talked a little, '
     'call it with their voice, their words agreeing and your question.',
     'inputSchema': {'type': 'object', 'required': ['name'], 'additionalProperties': False, 'properties': {
         'name': {'type': 'string', 'minLength': 1, 'maxLength': NAME_LENGTH, 'description': "their name ('Esme')"},
         'voice': {'type': 'string', 'description': "their voice as your messages name it now ('Voice 2')"},
         'consent': {'type': 'string', 'maxLength': 600, 'description': 'their own words agreeing, as you heard them'},
         'asked': {'type': 'string', 'maxLength': 1500, 'description': 'your question asking them, as you said it'}}}},
    {'name': 'forget_voice', 'description': 'Delete a saved voice, when its person asks you to forget it (or the '
     'board does): later calls no longer recognise them.',
     'inputSchema': {'type': 'object', 'required': ['name'], 'additionalProperties': False, 'properties': {
         'name': {'type': 'string', 'minLength': 1, 'maxLength': NAME_LENGTH, 'description': 'the name it was saved under'}}}},
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
    SCREEN_TOOL,
]


class Waits:
    """One call's hq: the environment it runs in (HQ_ENV), its waits on the coordinator and the tools still waiting.

    A tool waits for the coordinator's real answer while the coordinator is alive: a slow coordinator is still there,
    and a fixed cutoff would leave hand-offs unconfirmed that went through. While hq waits, a look at the coordinator's
    /health every `probe_seconds`, on its own `alive_seconds`, tells slow from down: a coordinator that answers neither
    is down, and the tool gives up within seconds. One that's alive but never answers this request meets
    `ceiling_seconds`, a few times the slowest real hand-off in the call logs (under a minute), so a call never hangs. A
    refused connection or a reset still ends it at once (hq). The agent hears back within `still_seconds` all the same,
    so the call is never silent for long: a tool still waiting then says so and carries on in the background (WORK), and
    the waiting tool hears it."""

    def __init__(self, env, still_seconds=20, probe_seconds=5, alive_seconds=5, ceiling_seconds=180):
        self.env, self.still_seconds, self.probe_seconds = env, still_seconds, probe_seconds
        self.alive_seconds, self.ceiling_seconds = alive_seconds, ceiling_seconds
        self.up = None  # when the coordinator last answered a look at /health, time.monotonic()
        self.pending = []  # each tool still waiting, as (what it is, its future)

    def ran(self, argv, words=None):
        """hq's (exit code, stdout, stderr), however long the coordinator takes while it's alive. GaveUp once it's down
        or past the ceiling, with hq stopped."""
        ends = time.monotonic() + self.ceiling_seconds
        with subprocess.Popen(argv, env=self.env, stdin=subprocess.DEVNULL if words is None else subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) as p:
            while True:
                try:  # (hq that answered during a look gives its answer, past the ceiling too)
                    out, err = p.communicate(words, timeout=None if p.poll() is not None else
                                             max(0, min(self.probe_seconds, ends - time.monotonic())))
                    return p.returncode, out.strip(), err.strip()
                except subprocess.TimeoutExpired:
                    words = None  # (sent: communicate takes it once)
                why = 'ceiling' if time.monotonic() >= ends else None if self.alive() else 'down'
                if why and p.poll() is None:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.communicate()
                    raise GaveUp(why)

    def alive(self):
        """Whether the coordinator answers a look at its /health within `alive_seconds` (noted in `up`)."""
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    f"{self.env['HQ_URL']}/health", timeout=self.alive_seconds) as r:
                if r.status != 200:
                    return False
        except (OSError, http.client.HTTPException):
            return False
        self.up = time.monotonic()
        return True

    def awaited(self, name, a):
        """(ok, text) of the board's tool, as soon as the coordinator answers, or within `still_seconds` that it's
        still waiting."""
        future = WORK.submit(used, self, name, a)
        if wait([future], self.still_seconds).done:
            return future.result()
        what = next((f'{name} ({a[k]})' for k in ('title', 'what', 'query', 'words') if isinstance(a.get(k), str)), name)
        self.pending.append((what, future))
        return True, self.on_its_way(what)

    def on_its_way(self, what):
        """The answer for a tool still waiting: slow, not down, only when the coordinator answered a look at /health
        within `still_seconds`."""
        up = self.up is not None and time.monotonic() - self.up < self.still_seconds
        return (STILL_WAITING if up else STILL_CHECKING).format(what)

    def waiting(self):
        """(ok, text): the answers that came for the tools still waiting, within `still_seconds`, and what's still
        waiting."""
        if not self.pending:
            return True, 'Nothing is waiting for the coordinator: every tool of this call has its answer.'
        # (one look: one landing between two would be lost)
        done = wait([future for _, future in self.pending], self.still_seconds).done
        came = [(what, outcome(future)) for what, future in self.pending if future in done]
        self.pending[:] = [(what, future) for what, future in self.pending if future not in done]
        lines = [f'{what}: {text}' for what, (_, text) in came] + [self.on_its_way(what) for what, _ in self.pending]
        return all(ok for _, (ok, _) in came), '\n\n'.join(lines)


LOOK_UPS = ('search', 'history', 'call', 'intercom', 'eta', 'estimate')


def look(waits, name, a):
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
    return looked(waits, name, commands[name])


def when(waits, a):
    """(ok, text): runs `hq when` from an argument list: the work, its size, whose it is, its prerequisite and the
    board's time, each checked so none reads as another's flag."""
    if 'extra_seat' in a:
        if a['extra_seat'] not in ('5x', '20x'):
            return False, 'extra_seat takes 5x or 20x'
        if any(k in a for k in ('what', 'agent', 'size', 'by', 'after')):
            return False, 'extra_seat replays the existing plan: omit new work and its flags'
        return looked(waits, 'when', ['hq', 'when', '--extra-seat', a['extra_seat']])
    what, agent, size, by = (a.get(k, '') for k in ('what', 'agent', 'size', 'by'))
    if not isinstance(what, str) or not what.strip() or what.startswith('-'):
        return False, 'when needs what the work is'
    if not isinstance(agent, str) or (agent and not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', agent)):
        return False, "agent is an agent's id, like ada"
    if not valid_size(size):
        return False, 'size is JSON with time, tokens, feedback_rounds and confidence'
    if not isinstance(by, str) or (by and not re.fullmatch(r'[0-9:TZ -]{4,20}', by)):
        return False, ("by is the board's own time with its date and no zone (2026-10-26 09:00, on the company's "
                       'clock), or a UTC time: 14:30 or 2026-10-26T08:00Z')
    after = a.get('after')
    if 'after' in a and (type(after) is not int or after < 1):
        return False, 'after is a job number, like 123'
    argv = ['hq', 'when', what, '--size', size, *(['--agent', agent] if agent else []),
            *(['--after', str(after)] if after is not None else []), *(['--by', by] if by else [])]
    return looked(waits, 'when', argv)


def looked(waits, name, argv):
    """Run a lookup and return (ok, text)."""
    code, out, err = waits.ran(argv)
    if code:
        return False, f'hq {name} failed: {(err or out)[:300] or "the coordinator refused it"}'
    # Successful lookups return every line so long transcripts remain complete.
    return True, out


def run(waits, args, words):
    """hq, from an argument list in the allowlisted environment, with the words on stdin: (exit code, stdout, stderr).
    Never the words in argv: any uid can read /proc/<pid>/cmdline."""
    return waits.ran(['hq', *args], words)


class GaveUp(Exception):
    """hq stopped waiting: the coordinator is down ('down'), or alive with no answer past its ceiling ('ceiling')."""


def plain(what):
    """The refusal for a "what" that isn't one plain line within the limit (never cut), or None."""
    return one_line_refusal('what', what, WHAT, 'the board reads it', 'make it one short line')


def goal_refusal(goal):
    """The refusal for a "goal" that isn't one plain line within the limit (never cut), or None."""
    return one_line_refusal('goal', goal, GOAL, 'why the board wants it, in its own terms', 'say why in one short line')


def one_line_refusal(name, value, limit, why, shorter):
    """A tool field's one-line check, with its own limit and refusal wording."""
    if not value or '\n' in value or '\r' in value:
        return f'{name} needs one plain line: {why}'
    if len(value) > limit:
        return f'{name} too long ({len(value):,} > {limit:,}): {shorter}; the follow-up has the whole call'


def goal_first(goal, text):
    """A brief or an addition as its job reads it: why the board wants it, then the work."""
    return f'Why the board wants this: {goal}\n\n{text}'


def on_stdin(goal, words):
    """The goal and the words for hq's --goal - (item add and replace, say), as one JSON object on stdin."""
    return json.dumps({'goal': goal, 'words': words})


def hq(waits, name, a):
    """(ok, text): runs hq for a valid call. Too long is refused, never cut; every answer says it's on a list, not with
    anyone yet."""
    if name == 'job':
        return job(waits, a)
    if name == 'add':
        return add(waits, a)
    if name == 'expedite':
        n = a.get('job')
        if type(n) is not int or n < 1:
            return False, 'job is a job number, like 123'
        return answered(run(waits, ['expedite', str(n)], ''), 'Nothing expedited', 'it may or may not be expedited', by='hq expedite')
    if name == 'hang_up':
        return True, HANG_UP_ANSWER
    if name == 'reach':
        return reach(waits, a)
    if name == 'manage':
        return manage(waits, a.get('command'))
    if name == 'write_down':
        return write_down_by_phone(waits, a)
    if name != 'replace':
        return False, f'no tool {name}: hand work on with job, write down what is to be done with write_down'
    what, item, goal = str(a.get('what', '')).strip(), a.get('item'), str(a.get('goal', '')).strip()
    if type(item) is not int or item < 1:
        return False, "item must be the earlier item's number"
    timed = {k: a[k] for k in ('deadline', 'board_set') if k in a}  # (its work stays the earlier item's)
    if refused := plain(what) or goal_refusal(goal) or timed_refusal(timed):
        return False, refused
    return item_on_list(waits, ['item', 'replace', str(item), what], what, goal, timed)


def timed_refusal(a):
    """The refusal for something written down or corrected whose time, or the work under way it names, won't do, or
    None."""
    deadline, work, deliverable = a.get('deadline'), a.get('job'), a.get('deliverable')
    if refused := readable(deadline):
        return refused
    if a.get('board_set') is True and not deadline:
        return 'board_set goes with deadline: the time the board set'
    if work is not None and (type(work) is not int or work < 1 or not deadline):
        return 'job is a job number, like 123, and goes with deadline'
    if deliverable is not None and (work is None or not (type(deliverable) is str and DELIVERABLE.fullmatch(deliverable))):
        return 'deliverable goes with job, and is one of the open deliverables, like shop/launch-deck'


def note_refusal(a):
    """Why a note written down won't do, on the phone and in HQ alike: its words, goal, owner, or its time and the work
    it names, or None."""
    words, goal, owner = str(a.get('words', '')).strip(), str(a.get('goal', '')).strip(), a.get('owner')
    if owner is not None and not (type(owner) is str and COLLEAGUE.fullmatch(owner)):
        return 'owner must be a colleague id, like ada'
    return (one_line_refusal('words', words, WHAT, 'the board reads it', 'make it one short line')
            or goal_refusal(goal) or timed_refusal(a))


def write_down_by_phone(waits, a):
    """write_down on the phone, which has no notes: hq item add task, on the call's list alone (owner left out: "",
    the CEO's to see through until the follow-up decides)."""
    if 'from' in a or 'region' in a:
        return False, "There's no picture on the phone: write it down in your words alone"
    if refused := note_refusal(a):
        return False, refused
    words, goal = str(a['words']).strip(), str(a['goal']).strip()
    return item_on_list(waits, ['item', 'add', 'task', a.get('owner') or '', words], words, goal, a)


def item_on_list(waits, args, what, goal, a):
    """(ok, text) of hq item add or replace on the call's list, with its time and the work it names."""
    deadline, work, deliverable = a.get('deadline'), a.get('job'), a.get('deliverable')
    # (the words, as the agent gave them, are the quote: the follow-up has the call's own around them)
    flags = ['--goal', '-', *(['--deadline', deadline] if deadline else []),
             *(['--board-set'] if a.get('board_set') is True else []), *(['--job', str(work)] if work else []),
             *(['--deliverable', deliverable] if deliverable else [])]
    r = run(waits, [*args, '-', *flags], on_stdin(goal, what))
    return answered(r, 'Nothing recorded', 'it may or may not be on the list', UNNOTED)


def job(waits, a):
    agent = str(a.get('agent', ''))
    if not COLLEAGUE.fullmatch(agent):
        return False, 'agent must be a colleague id, like ada'
    item = a.get('item')
    title, brief = str(a.get('title', '')).strip(), str(a.get('brief', '')).strip()
    goal = str(a.get('goal', '')).strip()
    if not title or not brief:
        return False, 'job needs a title and a brief'
    if refused := goal_refusal(goal):
        return False, refused
    if item is not None and (type(item) is not int or item < 1):
        return False, 'item must be the item number write_down or replace answered with'
    if item is None:
        brief = goal_first(goal, brief)
    code = a.get('code')
    if not (type(code) is str and CODE.fullmatch(code)):
        return False, 'code must be one word of 2 to 8 letters for what the task does, like COVERS'
    deliverable, drawn = a.get('deliverable'), a.get('new_deliverable')
    if refused := deliverable_refusal(deliverable, drawn):
        return False, refused
    if len(title) > TITLE:
        return False, (f'title too long ({len(title):,} > {TITLE:,}): keep it to one short line and put the rest in '
                       'the brief')
    if len(brief) > BRIEF:
        return False, f'brief too long ({len(brief):,} > {BRIEF:,}, the goal counted): split it into two jobs'
    now = a.get('now', False)
    if type(now) is not bool:
        return False, 'now must be true or false'
    after = a.get('after')  # (before the agent: hq job reads --after there only)
    if after is not None and (type(after) is not int or after < 1):
        return False, 'after is a job number, like 123'
    size, refs, why = a.get('size'), a.get('refs'), a.get('why')
    if not valid_size(size):
        return False, 'size is required JSON with time, tokens, feedback_rounds and confidence'
    if not isinstance(refs, list) or any(type(ref) is not int or ref < 1 for ref in refs):
        return False, 'refs must list the clean past job numbers, or [] when none fits'
    if not isinstance(why, str) or not why.strip():
        return False, 'why must explain the scope comparison, or why no past job fits'
    if (only := a.get('only')) is not None and only not in ONLY_IDS:
        return False, f"only must be one of {', '.join(ONLY_IDS) or 'none: the company has no such work'}"
    flags = [*(['--item', str(item)] if item else []), *deliverable_flags(deliverable, drawn),
             *(['--only', only] if only else []),
             *(['--now'] if now else []), *(['--expedite'] if a.get('expedite') is True else []), '--code', code, '--size', size, '--why', why,
             *(['--refs', ','.join(map(str, refs))] if refs else [])]
    # (the goal too: on the board's call in HQ a job with no item carries its note in the call's notes.
    r = run(waits, ['job', *(['--after', str(after)] if after else []), agent, title, '-', *flags, '--goal', '-'],
            on_stdin(goal, brief))
    ok, text = answered(r, 'No job was queued', 'the job may or may not be queued', by='hq job')
    return ok, f"{text}\nNot started yet: it's on {agent}'s list, and nobody is on it until it runs." if ok else text


def deliverable_refusal(deliverable, drawn):
    """Why job's deliverable or new_deliverable won't do, or None: an open one's id, or one drawn for the work with a
    project id, and a name and a done when that read as words, never as hq's flags."""
    if deliverable is not None and not (type(deliverable) is str and DELIVERABLE.fullmatch(deliverable)):
        return 'deliverable must be one from the open deliverables, like shop/launch-deck'
    if drawn is None:
        return None
    if deliverable is not None:
        return 'give deliverable or new_deliverable, not both'
    projected = type(drawn) is dict and type(drawn.get('project')) is str and PROJECT.fullmatch(drawn['project'])
    if not projected or not all(drawn_words(drawn)) or any(w.startswith('-') for w in drawn_words(drawn)):
        return 'new_deliverable needs a project id (like shop), a name and a done when'
    return None


def deliverable_flags(deliverable, drawn):
    """hq job's --deliverable flag for a checked deliverable or new_deliverable (deliverable_refusal): <project>/<slug>,
    or new:<project> "name" "done when"; none without either."""
    if drawn is not None:
        return ['--deliverable', f"new:{drawn['project']}", *drawn_words(drawn)]
    return ['--deliverable', deliverable] if deliverable else []


def drawn_words(drawn):
    """new_deliverable's name and done when, trimmed."""
    return [str(drawn.get(k, '')).strip() for k in ('name', 'done_when')]


def valid_size(size):
    """The coordinator validates the time, token and confidence fields in this JSON argument."""
    if not isinstance(size, str):
        return False
    try:
        return isinstance(json.loads(size), dict)
    except ValueError:
        return False


def add(waits, a):
    """add: hq extend <job> -, the words on stdin. Its answer says where they went (the brief, or the running job)."""
    n, words, goal = a.get('job'), str(a.get('words', '')).strip(), str(a.get('goal', '')).strip()
    if type(n) is not int or n < 1:
        return False, 'job must be the number the job tool answered with'
    if not words:
        return False, 'add needs what the board added or changed'
    if refused := goal_refusal(goal):
        return False, refused
    words = goal_first(goal, words)
    if len(words) > ADD:
        return False, (f'too long ({len(words):,} > {ADD:,}, the goal counted): keep the addition short; the '
                       'follow-up has the whole call')
    return answered(run(waits, ['extend', str(n), '-'], words), 'Nothing was added', 'it may or may not have been added')


def reach(waits, a):
    """reach: hq say <agent> - --job <n> --what "line" --goal -, the goal and the words on stdin. Its answer says
    where they went."""
    agent, n = str(a.get('agent', '')), a.get('job')
    words, what = str(a.get('words', '')).strip(), str(a.get('what', '')).strip()
    goal = str(a.get('goal', '')).strip()
    if not COLLEAGUE.fullmatch(agent):
        return False, 'agent must be a colleague id, like ada'
    if type(n) is not int or n < 1:
        return False, "job must be the running job's or review's number from your briefing"
    if not words:
        return False, 'reach needs what the board wants that work to know'
    if len(words) > ADD:
        return False, (f'too long ({len(words):,} > {ADD:,}): keep it to what the work needs now; the follow-up has '
                       'the whole call')
    if refused := plain(what) or goal_refusal(goal):
        return False, refused
    reply = run(waits, ['say', agent, '-', '--job', str(n), '--what', what, '--goal', '-'], on_stdin(goal, words))
    return answered(reply, 'Nothing was sent', 'it may or may not have gone')


def manage(waits, command):
    """manage: one of hq's management commands (MANAGE), from an argument list. Its answer is hq's, or why not."""
    if not (isinstance(command, list) and command and all(type(w) is str and w for w in command)):
        return False, 'command is the hq command\'s words, one per item, like ["cancel", "123", "why"]'
    if any('\n' in w or '\r' in w for w in command):
        return False, 'each word is one line'
    name, sub = command[0], command[1] if len(command) > 1 else None
    name = 'deliverable' if name == 'thread' else name  # (the old name, still taken: hq's main.ts ALIASES)
    if name not in MANAGE:
        return False, (f'hq {name} is not a management command on a call: {", ".join(sorted(MANAGE))}. Hand work on '
                       'with job, write down what is to be done with write_down')
    takes, given = MANAGE[name], '' if sub is None else '#' if re.fullmatch(r'(findings:)?[0-9]+', sub) else sub
    if takes is not None and given not in takes:
        shown = ', '.join({'': '(nothing more)', '#': 'a number'}.get(t, t) for t in sorted(takes))
        return False, f'on a call, hq {name} takes {shown}'
    # hq's management commands (api.ts change): 1 is a refusal or a wrong command, so nothing changed; 6 and 7 reached
    # no HQ; anything else may have come after HQ made the change
    code, out, err = run(waits, command, '')
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
        return ("deadline must be a time from now (2h, 90m), the board's own with its date and no zone "
                "(2026-10-26 09:00, on the company's clock), or a UTC time (14:30)")


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
    """(ok, content) of the sketch tool: the voice line's answer on its socket (a sketch's pictures, a long one's pieces
    down it, and its line), or its refusal."""
    asked = a.get('sketch')
    if not isinstance(asked, str) or not asked.strip() or len(asked) > 200:
        return False, [{'type': 'text', 'text': "sketch is its number, '12', or a few words of its label"}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': "Sketches can't be shown on this call."}]
    return shown(line_asked({'sketch': asked}))


def ask_to_see(a):
    """(ok, content) of the ask_to_see tool: the voice line's answer on its socket (asked, or why not)."""
    if not (what := what_asked(a.get('what'))) or set(a) - {'what'}:
        return False, [{'type': 'text', 'text': ASK_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': ASK_WORDS['none']}]
    return said(line_asked({'ask_to_see': what}))


def draw(a):
    """(ok, content) of the draw tool: the voice line's answer on its socket once HQ has drawn the circle (or why not)."""
    if not (ink := ink_asked(a)):
        return False, [{'type': 'text', 'text': INK_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': INK_WORDS['none']}]
    return said(line_asked({'draw': ink}))


def open_work(a):
    """(ok, content) of the open_work tool: the voice line's answer on its socket (suggested, or why not).
"""
    if not (work := work_asked(a)):
        return False, [{'type': 'text', 'text': OPEN_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': OPEN_WORDS['none']}]
    return said(line_asked({'open_work': work}))


def drive(a):
    """(ok, content) of the drive tool: the voice line's answer on its socket once HQ has moved the board's screen (or
    why not)."""
    if not (move := move_asked(a)):
        return False, [{'type': 'text', 'text': DRIVE_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': DRIVE_WORDS['none']}]
    return said(line_asked({'drive': move}))


def write_down_in_hq(a):
    """(ok, content) of the write_down tool on the board's call in HQ: the voice line's answer on its socket once the
    note is written in (or why not). On the phone it's hq's (write_down_by_phone)."""
    if refused := note_refusal(a):
        return False, [{'type': 'text', 'text': refused}]
    if not (asked := written_asked(a)):
        return False, [{'type': 'text', 'text': WRITE_DOWN_WORDS['shape']}]
    return said(line_asked({'write_down': asked}))


def read_notes(a):
    """(ok, content) of the read_notes tool: the voice line's answer on its socket."""
    if a:
        return False, [{'type': 'text', 'text': PAGE_WORDS['shape']}]
    return page_said({'read_notes': {}}, PAGE_WORDS)


def mark_notes(a):
    """(ok, content) of the mark_notes tool."""
    if not (asked := mark_asked(a)):
        return False, [{'type': 'text', 'text': MARK_WORDS['shape']}]
    return page_said({'mark_notes': asked}, MARK_WORDS)


def change_note(a):
    """(ok, content) of the change_note tool."""
    if not (asked := change_asked(a)):
        return False, [{'type': 'text', 'text': CHANGE_WORDS['shape']}]
    return page_said({'change_note': asked}, CHANGE_WORDS)


def try_versions(a):
    """(ok, content) of the try tool."""
    if not (asked := try_asked(a)):
        return False, [{'type': 'text', 'text': TRY_WORDS['shape']}]
    return page_said({'try': asked}, TRY_WORDS)


def page_said(asked, words):
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': words['none']}]
    return said(line_asked(asked))


def title_notes(a):
    """(ok, content) of the title_notes tool: the voice line's answer on its socket."""
    if not (title := title_asked(a.get('title'))) or set(a) - {'title'}:
        return False, [{'type': 'text', 'text': TITLE_WORDS_SAID['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': TITLE_WORDS_SAID['none']}]
    return said(line_asked({'title_notes': title}))


def name_voice(a):
    """(ok, content) of the name_voice tool: the voice line's answer on its socket."""
    if not isinstance(a.get('voice'), str) or not isinstance(a.get('name'), str) or set(a) - {'voice', 'name'}:
        return False, [{'type': 'text', 'text': VOICE_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': VOICE_WORDS['none']}]
    return said(line_asked({'name_voice': {'voice': a['voice'], 'name': a['name']}}))


def save_voice(a):
    """(ok, content) of the save_voice tool: the voice line's answer on its socket."""
    if not isinstance(a.get('name'), str) or set(a) - {'name', 'voice', 'consent', 'asked'} or \
            any(not isinstance(a[k], str) for k in ('voice', 'consent', 'asked') if k in a):
        return False, [{'type': 'text', 'text': ENROL_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': ENROL_WORDS['none']}]
    return said(line_asked({'save_voice': a}))


def forget_voice(a):
    """(ok, content) of the forget_voice tool."""
    if not isinstance(a.get('name'), str) or set(a) - {'name'}:
        return False, [{'type': 'text', 'text': FORGET_WORDS['shape']}]
    if not SCREEN_SOCKET or not SCREEN_KEY:
        return False, [{'type': 'text', 'text': FORGET_WORDS['gone']}]
    return said(line_asked({'forget_voice': {'name': a['name']}}))


def said(got):
    """(ok, content) of the line's answer in words: what it did ({ok}), or its refusal ({error})."""
    return 'error' not in got, [{'type': 'text', 'text': str(got.get('error', got.get('ok')))}]


def line_asked(asked):
    """The voice line's answer on its socket to one ask, by this session's key."""
    with socket.socket(socket.AF_UNIX) as line:  # (the line always answers or closes: it waits on the coordinator)
        line.connect(SCREEN_SOCKET)
        line.sendall((json.dumps({**asked, 'key': SCREEN_KEY}) + '\n').encode())
        return json.loads(b''.join(iter(lambda: line.recv(1 << 16), b'')))


def shown(got):
    """(ok, content) of the line's answer: its refusal, or a picture (a sketch's: its pieces) and its line, as MCP
    content."""
    if 'error' in got:
        return False, [{'type': 'text', 'text': str(got['error'])}]
    # (a long sketch's pieces down it)
    pictures, line = got.get('pictures') or [got['picture']], got.get('line')
    return True, [*({'type': 'image', 'data': picture['data'], 'mimeType': picture['type']} for picture in pictures),
                  *([{'type': 'text', 'text': line}] if line else [])]


def used(waits, name, a):
    """(ok, text) of the board's tool, or why hq stopped waiting for the coordinator (GaveUp)."""
    if name == 'report':
        return reads.report(a, waits.env)
    if name == 'git':
        return reads.git(a)
    looking = name == 'when' or name in LOOK_UPS
    try:
        return when(waits, a) if name == 'when' else (look if looking else hq)(waits, name, a)
    except GaveUp as e:
        if e.args[0] == 'down':
            return False, DOWN if looking else DOWN + DOWN_HANDED
        ended = NO_ANSWER.format(waits.ceiling_seconds // 60)
        return False, f'{ended} Try again later.' if looking else UNSURE.format(
            f'Not confirmed: {ended} It may or may not have gone through: check it before you do it again.')


def outcome(future):
    """A finished tool's (ok, text), or how it failed (as answer() words a tool that raised)."""
    try:
        return future.result()
    except Exception as e:
        return False, f'failed: {str(e)[:200]}'


# The board's tools that the voice line answers, in words or a picture, by name
LINE_TOOLS = {'sketch': sketch, 'ask_to_see': ask_to_see, 'draw': draw, 'open_work': open_work, 'drive': drive,
              'write_down': write_down_in_hq, 'title_notes': title_notes, 'read_notes': read_notes, 'mark_notes': mark_notes,
              'change_note': change_note, 'try': try_versions, 'name_voice': name_voice,
              'save_voice': save_voice, 'forget_voice': forget_voice}


def line_answers(name, offered):
    """Whether the voice line answers a tool on its socket, in words or a picture: one of LINE_TOOLS on the board's
    call, write_down only on its call in HQ, which has notes (on the phone it's hq's: write_down_by_phone)."""
    in_hq = bool(SCREEN_SOCKET and SCREEN_KEY)
    return name in LINE_TOOLS and offered is TOOLS and (name != 'write_down' or in_hq)


def answer(msg, waits, offered=TOOLS):
    """The reply to one JSON-RPC message, or None for a notification. waits: the call's (Waits); offered: its tool
    set."""
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
        # Its own content: a picture and its line, or the line's words
        if name == 'screen' or line_answers(name, offered):
            ok, content = {'screen': screen, **LINE_TOOLS}[name](arguments)
            return {'jsonrpc': '2.0', 'id': mid, 'result': {'content': content, 'isError': not ok}}
        if offered is PARTNER_TOOLS:
            ok, text = partner(name, arguments)
        elif name == 'waiting':
            ok, text = waits.waiting()
        elif name == 'hang_up':
            ok, text = hq(waits, name, arguments)
        else:
            ok, text = waits.awaited(name, arguments)
        aloud = [] if offered is PARTNER_TOOLS or name == 'hang_up' else [{'type': 'text', 'text': ALOUD}]
        result = {'content': [{'type': 'text', 'text': text}, *aloud], 'isError': not ok}
    elif method == 'ping':
        result = {}
    else:
        return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'no method {method}'}}
    return {'jsonrpc': '2.0', 'id': mid, 'result': result}


if __name__ == '__main__':
    tool_set = PARTNER_TOOLS if sys.argv[1:] == ['partner'] else TOOLS
    waits = Waits(HQ_ENV)
    for line in sys.stdin:
        msg = None
        try:
            msg = json.loads(line)
            reply = answer(msg, waits, tool_set)
        except Exception as e:  # (a bad line or a stuck hq: the agent hears it failed, the server carries on)
            mid = msg.get('id') if isinstance(msg, dict) else None
            reply = {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32603, 'message': str(e)[:200]}}
        if reply:
            print(json.dumps(reply), flush=True)
