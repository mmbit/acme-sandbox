# The voice line

Live calls with the team, streamed both ways (`server.py`). One call is one WebSocket:

- **HQ's call screen**: `/voice/ws`, behind the board's login (Caddy asks the coordinator) and only from HQ's own
  origin. 16 kHz 16-bit PCM both ways, plus small JSON events (`state`, `heard`, `said`, `clear`). HQ plays the agent's
  voice from an `<audio>` element fed by a MediaStream, the one thing Safari's echo canceller takes out while the
  microphone is on; played straight from Web Audio, a phone's speaker put the agent's words back into the microphone
  and this line heard them as the board talking over the reply.
  The browser's canceller still lets some through on some devices (calls #45, #91, #93), so while the voice plays each
  microphone frame carries it too, after the microphone's 320 samples (1,280 bytes instead of 640), and the line takes
  it out with WebRTC's own canceller (AEC3, LiveKit's build) before it listens (`echo.py`). It uses the canceller's
  output once that has heard 6 s of the agent's voice: before then AEC3 is settling and takes the board's words out
  with the echo. At hang-up it logs how loud the voice came back in the microphone, before and after (`call: ada echo:
...`), and at dialling which browser and system the call came from. `replay.py echo <folder>` plays real recorded
  echo (Microsoft's AEC Challenge) over a reply through the real models and the canceller.
  On a weak connection the microphone's frames back up and reach the line late, in a burst (nothing is lost on the
  way). The line can't tell from the audio, so twice a second HQ sends
  `{type: 'ping', t}` (its `performance.now()`, against the line's monotonic clock: setting either changes nothing)
  beside the frames, and the line answers each as it reads it, after the frames before
  it, with how late it came against the quickest ping so far (`{type: 'pong', late}`; `Call.pinged`). While a ping
  comes over `LATE` (1 s) late, or none has come for `SILENT` (1.5 s), the line is behind and doesn't answer what it has
  heard: it waits until it has caught up, or at most until the audio of every moment up to then has come (an uplink
  that never catches up, `Call.owed`), and answers everything the board said, never a late first part as if just said.
  A dropped connection loses none of it either: from pickup on, HQ keeps each microphone frame until the line says it
  has it (`heard`, its samples so far, with each pong), and so keeps what was still queued in the socket that dropped
  and what the microphone made while reconnecting, none of it dropped. The resumed connection's `call` event says what
  the line has, and HQ sends the rest first, with a ping from when each half second of it was made: the baseline stays
  across connections (the same two clocks), so it reads as late and the line answers everything the board said once it
  is in, as after a burst. Each reconnect is logged (`call: ada reconnected`). HQ's call screen says "Weak connection"
  while the line hears the board over 1.5 s late, nothing has come back from it for 4 s (its reply's audio counts: the
  pongs come behind it) or HQ's own frames wait unsent, and its timeline has each spell (`lagging`, `caught up`). At
  hang-up the line logs how late the board's audio came at most and how many answers waited (`call: ada line: ...`). A
  phone, a room or an older HQ sends no pings: nothing waits.
- **The phone line**: `/voice/twilio`, Twilio's media stream (8 kHz mu-law). The coordinator (`phone.ts`) admits a
  call only if Twilio signed it, it comes from the board's number and the board typed its PIN; it then hands
  Twilio a one-time ticket, which this service trades back for who the call is with. A call we placed to a partner
  (a call out, below) comes in the same way: its ticket answers with the call out's number.
- **The join link's page**: `/voice/join` (`room.py`), public through Caddy and gated by the link's token, which the
  coordinator trades for the call out (`join-ticket`). One room per call out, up to 6 people, below.

The loop: Silero VAD cuts the board's words at pauses, Parakeet v3 transcribes them, a warm Claude session per
call answers (streamed; it reads what a job reads but has no shell: the company's files, every branch and the status report, the web, and its own tools (Trust, below) (a call out: its partner tools only, below); its prompt from the coordinator: who the agent is, the team, what's going on,
and the desk phone request the call is about, if any), and each sentence is spoken as it arrives: Pocket TTS 3.3.0
in the agent's own voice in English, Dutch and German (`pockets`, all three preloaded and pinned by sha256).
The coordinator's `voiceOf` uses org.yaml's `voice` when set, otherwise jane for she/her and alba for he/him.
Other pronouns, or none, use the line's default.
Measured before Dutch left Piper: Pocket's first audio 0.24 s against Piper's
0.50, Parakeet heard it back as well (6.7% of words wrong against 7.2%), but `bill_boerst` garbles Dutch (15.9%, words
dropped), so a voice in `NOT_IN_DUTCH` speaks Dutch through Piper; Pocket adds about 0.75 GB for the two languages.
Neither reads a euro amount as money (Pocket TTS made "€4" "off or
off"), "06" swallowed the words after it and "310" came out "three ten", so `aloud()` writes every number out in the
call's language just before it's spoken: "€29,95" is "twenty-nine euros ninety-five" or "negenentwintig euro
vijfennegentig", "310" "three hundred and ten" or "driehonderdtien", "06" and an order reference a digit at a time ("oh
six", "nul zes"), and percentages, times ("ten PM", "tweeëntwintig uur"), dates, ordinals, "#90", ranges and years as
they're said. A range of euros says its euros once: "€35–40" and "€35 to €40" are "thirty-five to forty euros" (Pocket
TTS said the end of "thirty-five euros to forty euros" twice), unless the second counts something else ("€5–10
minutes"). "1,250" is thousands in English, "1.250" in Dutch and German. A call in German (`de`, wherever the line
takes `nl`) says them in German: "neunundzwanzig Euro fünfundneunzig", "ein Euro", "vierzehn Uhr dreißig", "am siebten
Oktober". Letters Pocket reads as a word of its own language are spelled as the language says them just before it speaks
(`SPELLED` in server.py: "AI" was "een ei" in Dutch and "eine Key" in German; "aa-ie" and "Ka-I", never with dots;
Piper says "AI" right). HQ's caption and the transcript keep the figures

Talking over the agent (`Call.hear`): the reply plays on while the line makes sure it's the board. It stops as soon
as the words read as an interruption (`stray()`, English, Dutch and German): a word that means stop ("wait", "no",
"nee", "wacht", and on a German call "nein", "Moment", "was"), a question of two words or more ("Is that all?", "En dan?"), or three words that aren't all filler or little words, in a look at the words so far (0.5 s in, then every
quarter second, beside the audio so the line never falls behind); a finished sentence of two real words ("Hold on.")
counts at the board's pause, or once two looks in a row hear it (a look mishears: "Make chin." for a hum). Only words stop it: a knock, a
bottle put down, a pour or a breath can sound like talking to the VAD for 2 s and more, with no words in it (call #77). A cough, a creak, a breath, or a lone "okay",
"mhm", "oké, prima" (or what the recogniser makes of a hum on the phone line, "And they can.") doesn't stop it and
isn't answered; nor is a short answer said while it still plays ("Yes, please.", "Sounds good.", "Ja, graag."). If the
board carries on within a second, it counts again ("Okay, so what about..." is one message), and a sound held over the
reply's last moments is a normal turn if the reply has played out by the time the board stops (so is carrying on
after a let-go "okay": nothing is taken back once the reply has played out, "Okay. So what about..." is answered). In
the replay a real "Wait, stop" stops the reply about 0.6 s after the board starts and "Hold on, ..." about 0.9 s, on HQ's
path and the phone's. A first look earlier than 0.5 s lets a misheard "Yeah, right?" stop it on the phone. If the board started talking before hearing 1.2 s of the reply, the reply is taken back and the whole
message answered, counted from when the board started, not from when the line was sure. While the agent is still
thinking (none of the reply heard yet), any word does that, and a sound with no words takes nothing back. With no reply
playing, turns work as before. Tests: `test_server.py` (stand-in models and clock); `replay.py` plays these sounds through the real
models, also over the phone line's 8 kHz.

Pictures during a call: on HQ's call screen the board can attach or paste a picture while the call is live. The phone
line has no screen: it asks for its call's context with `phone`, and that agent's briefing doesn't offer pictures. HQ
redraws it as a JPEG, uploads it for the call (`POST /api/pictures?call=<id>&key=<key>`, the coordinator's
`pictures.ts`: the key comes with the call's context and the `call` event, and the coordinator refuses the key of a call
that has ended, whose number can come back) and sends its number over the socket (`{type: 'picture', id}`). The line
fetches it with its own token (`GET /api/voice/picture`, only a picture of that live call), checks it's a JPEG or PNG
whose data decodes, and tells HQ it has it (`received`). The picture then goes to the agent as an image block in the
same message as the board's next words. If the board says nothing, it goes on its own once the line has been quiet for 2
s, with a short note ("I've shared a picture on screen."). Once the model has that message (its first request started),
HQ hears `seen` and shows that the agent has it. A turn that ends before that (an error, or the board talked over it
first) leaves its message in the session, which sends it with its next request (the CLI keeps it): HQ keeps `received`
for those pictures until that request starts, then hears `seen`. The same
picture shared again (the same bytes, while the line still has the first) isn't sent again: HQ hears for its number
what it hears for the first's. At most 6
pictures wait for a turn, and a call shows at most 20 MB of them (the session sends them all again with every turn);
past that, or for a picture the line can't use, HQ hears `failed` with the reason. The transcript gets a line where it
was shared (`Board: (shared picture #17 on screen)`), so `hq call` and the follow-up find it, and the follow-up saves it
with `hq picture`. The follow-up's brief lists every picture uploaded on the call: one refused or cut off by the hang-up
has no such line. If the call agent stops and is restarted, the new session has none of the pictures the old one saw or
was being shown: HQ hears `failed` (`lost`) for each, so the board can share it again, and the recap names them. The
line keeps the last state it sent for each picture, and sends them all again when HQ resumes the call on a new
connection: one sent while HQ was away is lost with the old connection. HQ, for its part, sends a number again on each
new connection until the line answers it, and the line takes in a number it knows only once. The agent sees the pictures
in the order the board picked them: HQ sends a number only once the pictures picked before it are uploaded (or failed),
and the line keeps each picture's place from when its number came, so one still being fetched holds back the ones after
it.

A walk-through: the caller shows our pages while they talk (the board on its HQ call, a guest in a call out's room;
the phone has no screen and never asks), and the coordinator keeps a live mirror of their screen
(`shared/watchalong`).

With each of the caller's turns (an unprompted pictures-only one too) the line asks the
coordinator's `screen-turn` (`{purpose, ref, after, seen, briefed}`: `call` and the call's number, or `callout` and the
call out's) within 1.5 s, as it sits between the caller's last word and the model: no answer in time, or a refusal,
and the turn goes as it would have, with one log line, and an agent that has seen the screen this session hears it
couldn't be read (its moments come with the next turn). With a watch-along on, the turn's message carries, in front of
the caller's words, the coordinator's briefing until the session has had it, then the moments since the agent's last
turn as lines (`#12 17:03:12 tapped "Add to basket" (button)`), and, after any shared pictures, a picture of the screen
as their turn ended when it changed since the last one the session has.

Screen pictures count against the same 20 MB
as shared ones, and a call has at most 40 of them, the screen tool's included; past either, lines only, and the agent
hears once that pictures have stopped.

Paused, the agent hears once that the caller paused showing their screen, and
gets nothing more (the tool refuses too) until it's on again.

The transcript gets one line for a turn with moments,
before the caller's words (`Board: (on screen: #12 ...; #13 ...; a picture of the screen went with it)`): paths,
labels and "typed", never values, as the coordinator words them.

A restarted session has neither the briefing nor the
picture, and gets both again.

The agent's `screen` tool (below) asks through the line, never with the call's token:
the line listens on its own socket (`/data/call/screen.sock`, 0600), and each session's CLI gets its path and a key of
its own in its environment (`SCREEN_SOCKET`, `SCREEN_KEY`: `hq` never gets them). The line finds the call by the key
(a restarted session's new one; an ended call's answers nothing), refuses on a call with no screen, while paused and
past the budget, and otherwise asks the coordinator's `screen` and counts the picture.

The board's sketches: the agent's `sketch` tool, on the board's own calls,
shows a sketch from the board's Sketchbook by its number or a few words of its label, through the same socket and key (a
`sketch` ask; the phone has no key, so no sketches there). The line refuses it on a call out (the partner's words could steer a look-up) and past the 20 MB, asks
the coordinator's `sketch` (`{call, sketch}`: a live call's only) and counts the picture against the 20 MB, not the
screen's 40. The coordinator sends a PNG at most 1568 px on its long side, with a line saying which sketch it is and
when it was drawn and last changed; a label that matches several gives the latest with something drawn and names the
rest, and one that matches none lists the latest sketches.

The board drawing on its call (`drawing.py`, the board's own HQ calls only): each note the board draws with the Pencil
comes as a `note` event on the call's WebSocket; the line fetches it (`GET note?id=&call=`: its number on the call's
page, the board's words, the page, the page around it as a picture) and gives it to the agent as a shared picture,
with the board's next words or alone after the quiet, its words in a line in front of theirs and its picture counted
against the 20 MB (one that doesn't fit goes without it, and the agent hears so). HQ hears `received` or `failed`
(`unreadable`, `too many`), again on a resume. The agent's `ask_to_see` sends HQ an `ask` (its card, Show and Not now,
blocking nothing) and answers at once; the board's tap (`asked`) reaches the agent with its next turn, or alone after
the quiet. Its `draw` sends an `ink` (a ring at a box the agent aims at on its picture of the board's screen, in
fractions of the picture: HQ draws it there and chooses nothing; it follows what it's on as the page scrolls, goes with
it and with the call, and is never kept) and waits up to 5 s for HQ's `inked`. After the agent's own scroll (`drive`)
it is refused until the agent has a picture of the screen as it is now. Both go through the screen socket and are refused on a call out (rule 9), on the phone and while
HQ's connection is down; an ask also while the screen is shown or another ask waits.
The call's notes page in the board's Notebook (`callnotes.py`): the agent's
`scrap` puts one change on it, a plain note (its words on a post-it, no picture) or cut from one of the board's notes
on the call (`from: 'note 3'`) or from its shown screen at a moment (`'-20s'`, `'#12'`), a region of that picture with
the change in its words, and `title_page` names the page in a few words. The agent works the page as the board does
too: `read_page` lists what's on it, `mark_page` draws a rectangle, ellipse, line, arrow, pen line or highlight, and
`change_page` changes its own note's words, or moves or deletes anything there, each a step the board's Undo takes
back. All go through the screen socket to the coordinator's Ink store
(`POST scrap`, `POST title`: `ink/callnotes.ts`; `POST page`, `POST mark`, `POST change`: `ink/callpage.ts`), never to
HQ's socket: the store tells the board's screens. Refused on a call out, on the phone and
once the call is over. The line's drawing and driving halves import nothing of it (test_server's split test).
The transcript is written to the line's volume as the call goes, the board's words as each piece is heard, even ones
not answered yet: while the board talks on, a pause that sounds finished sends the message so far and its next words take it back, so a
long message may exist nowhere else until the board stops. If the line restarts mid-call, it hands that transcript over
when it starts again. A deploy doesn't recreate the line while a call is on: the line keeps a file per live call in
`/data/live`, and `infra/sync.sh` waits until there's none.

After the call the transcript goes back to the coordinator (`call.ts`), and the call gets one follow-up job: the job that
asked the desk phone request the call was about, or a new "Follow up on your call with the board" job (the CEO's too). It
records what was said as items and hands them out (the call ledger: `platform/coordinator/src/ledger.ts`). The
call's row exists from call-context on, so a promise the call token records (`POST /api/agent/item`) survives a
dropped line. If the call agent dies mid-call, the line starts a fresh one with the same call token (POST call-context
with it): the same call goes on, with what was promised on it.
A call placed before the agent's last call is followed up carries on from it: the briefing has that call's transcript
and what's noted on it, and says where the new call starts. Its follow-up waits for the earlier one's, then acts on the
new call's part only, correcting the earlier call's items where the board changed them (`call.ts` carriedOn).

The call agent's tools (`hq_tools.py`), each of which puts something on a list and says so, never "sent":

- `job(agent, title, brief, size, refs, why, item?, now?, after?)`: a job on a colleague's list ("Queued job #n for ada: … Not started yet").
  With `item` (a promise or a correction noted on this call), the job carries it, and it's handled when the job is done.
  It waits until the call ends (a wake, `wakes.ts` ended), so what the board adds on the call (`add`) goes into its
  brief and it starts whole. `now` (`hq job --now`) starts it at once, the agent's judgment or the board's word
  each time.
  Use `estimate` first for clean past jobs, their scope and actual agent time. The call agent judges the scope and
  supplies `size`, `refs` and `why` to `job`. `when` also requires that chosen `size`. The queued estimate stays fixed
  until the CEO adjusts it after slippage.
  `after` (`hq job --after`) queues it behind another job, when the agent judges an agreed deadline worth protecting
  from it. The job tool's answer gives each agreed deadline's facts (a thread's window: its finish, its slack, what
  this job did to it and its slack 6 h and a day ago, `deadlines.ts`). It then names the other threads the job moves, for
  the agent's planning. The briefing says the board hears of shifts only when an agreed deadline moves or when it
  asks, a tight or shrinking margin being the agent's to plan with (`call.ts`). The `when` tool's answer gives the
  same facts for the work it adds to the plan.
- `promise(owner, what)`: the promise on the call's own list the moment it's made, with the agent's words as the quote
  ("Noted as promise #12 on this call, for ada"). The follow-up hands it out after the call.
- `replace(item, what)`: the board changes an open item from an earlier call (the briefing lists them with their
  numbers): the new item goes on this call's list, and the earlier one's jobs that never ran are cancelled while the
  board is on the line. A running one runs on, and hears the correction from the call's follow-up after
  the call (when it goes through the last correction, or ends done), even if the call replaces its own correction.
- `reach(agent, job, words, what)`: the board's settled word to work already under way, for real need only, as often
  as the board's word needs (`hq say` on a call, `call.ts` reach). A running Claude job's session reads it at its next
  step; a pull request's review gets it through the call's list, which its reviews and ruling that haven't started yet
  read, and every later round. The number must be the named colleague's, and it goes on the call's
  list as a message item, handled, so the follow-up doesn't send it again: it checks the words against the
  transcript, and corrects or withdraws them if they were misheard. A job this call queued takes `add`; one not
  running, on Codex, or on a customer's call is the follow-up's.
- `manage(command)`: run one of hq's management commands as its words (`["cancel", "123", "why"]`).
  `hq_tools.py`'s `MANAGE` defines the commands and subcommands. Others are refused before hq runs.
  The coordinator opens their routes to the call token (`server.ts` `MANAGE_ROUTES`) and applies its
  own rules on who may do what, as for the agent's jobs: the CEO's call may cancel any agent-queued job, a colleague's
  only its own. Its short lines (a why, a name) go as hq's arguments, as off the call. The agent says aloud what it did,
  which is what its follow-up reads in the transcript; the briefing tells it to act on the call, never leave it to the
  follow-up. A change whose answer is lost (no answer, a server error, an answer that isn't JSON) stops hq with exit 3
  (`api.ts` `change`), which the tool answers as not confirmed, to check before doing it again; exit 1 is a refusal
  or a wrong command, 6 and 7 reached no HQ. On a call about a customer's details (its card, or a look-up on the call
  that handed it them) a change carrying the agent's words (a why, a name, a title, a topic) is refused (`server.ts`
  `CUSTOMER_CALL_SHUT`): they would reach HQ's feed and colleagues who don't hold them. One that only names what's
  there or sets a number or a time goes ahead. What's left
  out of `MANAGE` speaks as a job a call doesn't have, needs a job's folder, would pass by the marking of who holds a
  customer's details, or (a card's rewrite, an Overseer note) would carry misheard words or have no run to release it.
- `screen(at?, region?, since?)`: on a walk-through, the caller's screen through the voice line (above), on the board's
  calls and a partner's: now (1568 px), at a past moment (`at`: `-20s`, `17:03:12` or `#12`), a `region` zoomed (`x`,
  `y`, `width`, `height` as fractions of the screen), or the moment list `since` a time. A picture comes with its
  moment's line.
- `search`, `history`, `call` and `intercom`: read-only look-ups (below); they put nothing anywhere. <!-- intercom: -->
- `eta(query)`: where planned work stands now. `hq projects <words>` finds the open threads a project's or thread's name
  or a few words name ("The checkout", "the levels") and answers each with its ETA, agent time left, window
  (planned finish, deadline, slack or by how much it misses), what it waits on and what goes on next, all by name: the
  coordinator's `outlooks.ts findOutlooks` reads the forecast as last played (the same outlook `hq thread` and the projects view
  show), so it answers in well under a second. A card a thread waits on reads "the board: <its title>". With no query
  it runs `hq now` (the coordinator's `goingon.ts`, the same words the briefing opens its company section with, fresh):
  everyone HQ counts at work, each on its run with its seat, thread and window and, while a hold is on, why it runs;
  then each open desk phone card with the work that waits on it. Read-only.
- `estimate(query, agent?)`: clean past jobs, their actual agent time, briefs, reports and changed files. Search only
  finds candidates. The queuer judges scope from those candidates and supplies the estimate when queuing.
- `when(what, size, agent?, after?, by?)`: plays the chosen agent time into the plan and returns its live finish.
- `waiting()`: every tool above waits for the coordinator's real answer while the coordinator is alive, never a fixed
  cutoff (board, call 127: a slow coordinator is still there, and a cutoff left hand-offs unconfirmed that had gone
  through); `hq` itself waits too (`api.ts` request: no time-out unless a command gives one). While `hq` waits,
  `hq_tools.py` looks at the coordinator's `/health` every `probe` (5 s), on its own `alive` (5 s) time-out. A
  coordinator that answers neither is down: `hq` is stopped and the agent hears plainly that the coordinator is down
  and the hand-off is unconfirmed (it may have gone through before it stopped answering: checked after the call). One
  that stays alive but never answers meets `ceiling` (3 minutes, a few times the slowest real hand-off in the call
  logs): "Not confirmed", check before doing it again (board, call 128). A refused connection still says at once, for
  certain, that nothing was handed on, a reset or a server error that it may have been. So the call isn't silent for
  long, a tool that hasn't heard back in `still` (20 s) answers that it's still on its way and carries on in the
  background (what's under way at hang-up still lands); `waiting` waits up to `still` again and gives each one's own
  answer, or says it's still waiting. It says "slow, not down" only when `/health` answered in the last `still`. The waits
  are the call's own `Waits`, which a test makes with short ones.

- `hang_up()`: ends the call, only once the board has clearly wrapped up (a goodbye, asking to end it, or a thank-you that
  closes the business, not one mid-business), with a short goodbye of the agent's own that fits the call ("Thank you, talk
  soon." is one example, not a set line): no recap unless the board asks for one, no slip line (its description
  and the briefing say so: the model decides, nothing matches the board's words). The tool runs nothing: the line sees it in the reply's stream (`HANG_UP_TOOL`) and, once the goodbye has played and the line has been quiet `GOODBYE_QUIET_SECONDS`
  (1.5 s, `Call.leave`), plays a hang-up tone (`hang_up_tone()`, three short 425 Hz beeps, 0.77 s, a phone call's end, so a board listening
  hands-free hears the line close) and, `TONE_TAIL_SECONDS` (0.5 s) after it has played, hangs up: HQ gets `hangup` and ends the call as its own button does (`bye`, with how the voice
  played; an HQ that doesn't within `HANG_UP_WAIT_SECONDS`, 5 s, is closed with 4000), and the phone line closes
  Twilio's stream (nothing follows its `<Connect>`). The goodbye is said once in either order: hung up in the
  goodbye's own model response (other tool calls beside it or not), the model's reply to the tools' answers isn't
  said; hung up first, the words after it are the goodbye. Talking over the
  goodbye (not a lone "bye"), Interrupt, or any words after it keep the call open, up to the end of the
  tone and its tail: they're the next turn. The transcript ends "(<agent> ended the call.)", and everything after is a normal hang-up's.
  There is no `say` and no `forward`: a chat bubble reaches nobody, and a hand-off is a job.

No number for work is said aloud on the board's calls (a job, card, pull request, call, item or pin): the board can't see
them, and "sixteen thousand three hundred twenty-one" makes a call run long. The briefing says so (`call.ts`
instructions), and every answer of these tools but `hang_up`'s carries `ALOUD` as its own last part (`hq_tools.py`
answer()), since the agent speaks right after reading an answer full of numbers. The numbers stay in the answers, for the
agent's next tool, and in the transcript and follow-up. A partner call's tools number no work and carry none. (No
filter over the agent's words: the briefing and the answers it reads are where it learns what to say.)

Calls out (to a partner, after the board approved the card: the coordinator's `callouts.ts` decides who, when and
dials; the line never does). The ticket (Twilio's stream) or the join ticket (the page) says `callout`, and
call-context with it answers the partner briefing, the company's fixed `opening` and `objected` words in the call's
language, `who` (the partner: the transcript's name for the other side) and `tools: 'partner'`. The agent speaks
first, in the opening's words, never the model's (`Call.open`): once the other side's first words have ended ("Print
API, Sanne speaking.", written down, not answered) or after `OPENING_QUIET_SECONDS` (3 s) of quiet from pickup, as a
turn of its own they can talk over like any reply. Its next message tells the model the opening was said and what
they answered, and it goes on from what they say next. The partner tools (`hq_tools.py partner`, `guard.PARTNER`,
and no built-in tool: nothing of the company's files is read out to an outsider) are `note(what)`, `no_transcript()`
and `hang_up()` (also for a voicemail or a menu it can't get through, without a message). No look-ups: an outsider's
words never steer a search of the company's files, jobs or the board's answers (house rule 9), and what the call needs
is in the why its agent filed. `note` and `no_transcript` run nothing and answer at once: the line reads them from the
reply's stream (`Used`: a tool step's whole input). A note is kept in order with the call. `no_transcript` makes the line say the
company's `objected` words itself, drop the transcript so far (the file on `/data/calls` is rewritten with the notes
only) and keep no more lines. The hand-over (`call-end`) carries `callout`, `lines` (empty when they objected), `notes`
and `objected`.
A room (`room.py`): the page is HQ's (its `Origin` is checked like the board's), and the first person's join makes it, with one `Call`; a seventh is turned away (4009). Each
person's frames go through their own `Echo`, then a mixer on a 20 ms clock: the agent hears the sum (one VAD, one
recogniser), and each person gets 320 samples of the agent and the others, never themselves, then the agent's own 320
while its voice is in the frame (the page moves the agent's mouth from those). The agent's `state`, `said` and `tick`
go out as the mixer reaches their audio; `people` (the list, muted marks), `talking` (the loudest person) and `hangup`
as they happen. A segment's speaker is the person loudest over it, and the transcript and the agent read it as
"Sanne: ...". The opening is said after 1.5 s of quiet once the first person is in. A person whose connection drops
gets their place back with `rejoin`, which carries the `key` the room message gave them alone, never the `id` everyone's
list shows. Once six places are held, a newcomer takes the place of whoever has been away longest. Words still being recognised when their speaker's place is gone, after a bye or so, go to whoever was
loudest of those left. The room ends 2 minutes after the last person leaves, or when the agent hangs up
(everyone hears `hangup`, then 4000), and a link is good for that one call (4004 after).

## Dictation

Review mode writes a note's words down while the board says them (`dictate.py`), with the calls' own VAD and Parakeet.
`/voice/dictate` is internal: Caddy doesn't route it, and only the coordinator reaches it, for its
`/__review/dictate` (`feedback.ts`), with this line's token (`Authorization: Bearer`, else 1008) and `?lang=` (the
board's language, for `unhesitating`; blank for an outside reviewer, whose words are written as heard). In: binary frames of 16 kHz mono 16-bit PCM, any length, then
`{"type":"end"}` when the mic stops. Out: `{"type":"heard","text","partial"}` with all the words so far, once each
phrase ends (`partial: false`) and from a look at the phrase still being spoken every 0.8 s of it (`partial: true`, one
look at a time, beside the audio). After `end` the last phrase ends where the audio did, its words go, then
`{"type":"done"}` and the line closes. A dictation runs 5 minutes at most (a note's 4,000 characters), and takes in 5 minutes of
audio at most however fast it comes, then ends the same way with `"limit": true` on `done`. Two run at once: a third is closed at once with 1013 `busy`. Each logs one
line at its end, how long and how many phrases, never the words. Tests: `test_dictate.py`.

## A care call on the phone line

A stranger who rings the shop's number can be put through to the voice line by
the coordinator (`phone.ts`). Its ticket then says `kind: 'care'` and brings the care deployment that answers (`engine`,
the line's in brand.yaml's `phoneLines`; `care` when it names none), the agent who answers, the opening's
languages in order (`langs`: the line's `languages` for the caller's country code, else its default), the
agent's voice, and its voice per language where the company names one (`voices`): one of the line's Piper voices (alex
for Dutch, thorsten and kerstin for German, native speakers, CC0; kerstin) or one of Pocket TTS's preloaded voices in that language's
model. Pocket says the same words differently each time, so the fixed words kept in `SAID` (the opening) are made from
one seed: the take every caller hears after a restart is a known one. The ticket names the seed per language where the
company does (`seeds`: the line's `seeds` in brand.yaml, a take it heard read back right in its voice), else the line's `SEED`.

- **The brain**: `Care`, the second brain behind `Agent`'s surface. Its turns go to the care service, not the CLI:
  `POST /phone/start` (the call's CallSid, and the opening's first language, in which care reads its prompt into the
  model's cache while the opening plays) once, `/phone/turn` for each of the caller's messages (its reply streams
  back as NDJSON: the reply's `lang` as the model tagged it, text, a `step` as a tool starts, `used` once it has run,
  then `end`, or `unanswered`), and
  `/phone/end` with how the call ended (`hung_up`, `caller`, `limit`, `error`). Each turn and the end also say which
  languages the caller has been informed in by then, their AI and transcript lines heard played whole, the AI line alone
  once they objected (`informed`, `Call.informed`): care keeps what they say only
  once their reply's language is one of them. Each care deployment (a product built from platform/care, its slug the
  deployment's name) has its own address and key, both given by infra: `CARE_ENGINES`, JSON from each slug to its
  `url`, `calls` (its cap, below) and `token`, the name of the variable that holds its key (infra's
  `care_engines.py` names it), taken out of the environment at the start so nothing the line runs inherits it. An entry
  that isn't `{url, calls, token}` is left out,
  with a line in the log. The ticket's `engine` picks the deployment, and every request of the call goes to its address
  with its key. Talking over a reply closes that turn's request, and care keeps what it had written. There is no seat, no
  pictures and no call-context. Care keeps the words: the line writes no transcript and hands nothing to `call-end`, and
  as always no audio is kept. Only the empty marker in `/data/live` is written, so a deploy waits for the call to end.
- **The opening**: in the ticket's first language care's AI line, its transcript line and its ask; in each language
  after it only the AI line and care's `fine` ("English is fine too."). The company's numbers give one language each
  (its line's `languages` in brand.yaml), so its opening is that language's three lines alone. One flow, with no pause for the caller to wonder whether to speak. Its audio is kept (`SAID`), so
  the next call's opening plays at once. Words said over it stay in the line (`care_first`), never sent to care, until
  what of its notice lines they missed has been said again and has played whole; after that, the caller's words go to
  care as they come.
- **The language**: care's model hears the caller's language and tags each reply with it (`lang`); nothing reads it from
  their words. The line speaks from there in that language, in the voice the ticket gives for it (else the agent's own),
  and mid-call when it changes. A reply in a language whose AI or transcript line the caller hasn't heard (the opening
  didn't have it, as English after a Dutch opening, or they talked over it) says the AI line first, in care's short
  `reply_ai` words where it has them ("I'm Poppy, an AI assistant."), and the transcript line after the reply's words,
  so the reply answers them straight away (`notice_after`); none once the caller has said they'd rather we kept none
  (`no_transcript`). A line counts as heard once it has played with nothing cutting it (`missed`). Once a second reply to the caller has played in a language they were informed in (one short first
  reply can't show which they understand), the call has settled (`settled`): no notice line plays again, whatever
  language a later reply is in, as care settles the call's language the same way and moves it only when the caller asks
  (`switch_language`; care's README, "The phone").
- **The steps**: `hang_up` works as the CLI's (the goodbye, the quiet, the tone). The line then posts
  `/api/voice/phone-done` with the CallSid before it closes Twilio's stream, so HQ answers `/api/twilio/after` with a
  hang-up. `no_transcript` makes the line say care's `objected` words in the caller's language.
- **Where a reply's wait goes**: each reply logs, counted from the caller's last
  word, when the line asked care (the VAD's 0.45 s pause, the transcription and any wait for more), care's first
  words, the first audio sent, and how many hold sounds played (`call: <agent> reply timed: ...`); the `replied` line
  adds care's account of its model calls (how many, its first words, the prompt's tokens read from the cache and
  written: a big write is a cold cache). `infra/call-times.sh` keeps both, and the reply's language changes.
- **The hold sound on the phone** is the thinking sound a fifth higher and 12 dB up (`thinking(phone=True)`, about
  -30 dBFS against speech's -20): HQ's, at -42 dBFS under 500 Hz, was lost in a phone's earpiece and a mobile
  network's codec.
- **The limits and the fallback**: at most a deployment's `calls` (2 when `CARE_ENGINES` gives none) of its care calls
  at once, counted per deployment (`CARE_LIVE`), each at most `CARE_CALL_SECONDS` (10 minutes). In each of these cases the line closes Twilio's stream at once and sends no
  phone-done, so HQ plays today's recorded message, which gives the email address and the website:
  - a call past its deployment's `calls` (a third, by default), while another deployment can still take one;
  - care refusing the start (503: off, at its cap, down) or not answering;
  - a deployment the line doesn't know, or one without its address or key (the log names the deployment);
  - the time limit;
  - a turn that comes back `unanswered` or fails.

  `load_check.py` measures what the line takes with care calls and a board call at once, using the real models,
  scripted brains and callers talking in real time. Measured on 17 October on 4 cores of a shared machine, over 150 s,
  for 2 care calls plus a board call:
  - memory: the process peaks at 2.3 GB, plus 0.42 GB for Pocket's Dutch model, which the job's memory couldn't hold
    alongside (`LOAD_CHECK_NO_POCKET_DUTCH`). Each call adds tens of MB.
  - CPU: 1.2 to 1.5 cores on average, against 0.5 for a board call alone.
  - first audio: about 1 s after the caller stops, with the brains answering at once.

  Each sentence used to wait for one lock shared by every call's synthesis. With that lock, overlapping replies left
  3 to 8 s of gaps in each call's audio, the longest 2.3 s. Synthesis now runs in parallel (the note under `SPELLED`
  in server.py). With two Dutch care calls (both on Piper's one model) and a board call, gaps are 0.1 to 0.3 s in
  all per call. Parallel and serial synthesis on one model give the same audio: Pocket TTS sample for sample up to
  1e-6, the difference between two serial runs; Piper exactly, with its noise off.

  `phone_timing.py` times a stranger's call from pickup, one per language (a Dutch, a German and a British number),
  with the real models and the care port standing in: when the first words play, how long the opening is, and how
  long from the caller's last word to the answer, for a caller who waits for the whole opening. Run it again after a
  change to the opening's words or languages. Measured on 22 October on 4 cores, the care port answering at once (a
  real reply adds the model's 1.5 to 2.5 s), each number's opening in its one language, under `ONE_POCKET` (the job's
  memory couldn't hold every Pocket model: the Dutch and German sentences were made by the English model, as long to
  make but not the same length as their own voice's): pickup to the answer 20.7 s (Dutch), 17.2 s (German), 18.5 s
  (English), from 23.4, 23.6 and 17.0 s with the short English after Dutch or German (21 October). The opening is
  15.2 s, 11.6 s and 12.2 s (Pocket's own Dutch voice makes the Dutch one 12.9 s, from 20.5 s with the short English);
  the caller's last word to the answer 0.8 to 2.0 s. The first words play after 0.2 s on a call after a restart, at
  once after that (`SAID`).

<!-- this paragraph and the barge-in figures above -->

Measured on a 4-core CPU: first audio about 2.5 to 3 s after the board stops talking (0.65 to 0.85 s to hear the
pause and transcribe, about 1.5 to 2 s for the model's first words, 0.2 s to start speaking; the phone adds its own
network's). The line asks the model at the pause once the board sounds finished: the model takes over a second to
speak, and if the board carries on before then, the reply is taken back (`WAIT_SECONDS`, counted from the end of the words, so
the transcription is part of it). Whether it sounds finished is Pipecat's Smart Turn v3.2 (`endpoint.py`, BSD-2-Clause,
8 MB, about 90 ms a pause on one core, beside the transcription): it hears the turn's last 8 s up to 0.2 s after its
words (`TRAIL`), the voice trailing off mid-thought or ending, where the recogniser writes a full stop at almost every
pause. Mid-thought, the line waits 1.5 s more before it asks (`WAIT_SECONDS['open']`). With the board's Pencil still
moving as it stops talking (HQ says when it's down and lifted, while its screen is shown), the line waits for the pen to
rest 1.5 s, review mode's own "the mark is done", at most 8 s (`PEN_REST_SECONDS`, `PEN_MOST_SECONDS`): the turn's
picture has what was drawn while it spoke, and its words said meanwhile go with it. On Pipecat's test set (one of its nine
files: 873 English, 160 Dutch, 142 German clips, cut at Silero's pause as the line does) it calls a mid-thought pause
finished 10, 13 and 15 times in 100, and a finished turn mid-thought 4, 2 and 1 times in 100; through 8 kHz (the phone
line's band) it calls 14, 22 and 31 mid-thought pauses in 100 finished. On a
call out, the agent says its words before it writes a note or hangs up: nothing
plays while it writes a step. About 2.3 GB of memory idle (Parakeet 0.8, Pocket's three languages 1.5).

The call's model and effort come from the coordinator with each call (`company/models.yaml`, `calls`): Opus 5.5 at low
effort since 2026-09-28, the board's choice (the model that runs the company). The log prints the model at the start of
each call and, per reply, when the first words came (`first words after … s`, or `with no words` for a turn stopped
before any): compare those before changing it. A reply whose agent started a tool step before its first words says
when (`first words after 8.5 s (after a tool step at 0.9 s)`): that wait is mostly the model writing a job's brief and
the tool running, not the model's time to speak, so the model's own time is the replies without one.
Each reply's line also says where its first seconds went: the step's tool (`step mcp__hq__job`), the tokens of the turn's
first request (`tokens in 6, cache read 18000, cache write 420`: a call's first reply writes the whole briefing to the
cache, a later one reads it, so a later reply with a big cache write and no cache read is a cache that missed), and the
thinking before the first words (`thought 1.2 s from 0.9 s`, or `no thinking`; `tokens unknown` for a turn stopped before
the model answered). The call's first line gives its briefing's size (`briefing 46210 bytes`). The call agent's model
always thinks when it judges it useful (Opus 5.5 can't turn thinking off; effort is the lever, `low` here), and the
briefing asks it to answer without deliberating. The call agent doesn't load the checkout's CLAUDE.md: the briefing has
AGENTS.md already (it was 5 KB more in every first request).
`infra/call-times.sh` keeps these lines across redeploys, and the server status shows the last 7 days (the daily model
check reads them). It also keeps a line per turn from the call agents' own session records (`turns.py`, logged as each
session ends: `call: session <id> turn <n> on <model>: tokens …; thinking until 1.8 s (230 tokens); then words …`),
numbers and tool names only: its "thinking until" is when the turn's last thinking block was written, counted from the
board's words, not how long the thinking ran (the reply's `thought` is).
The session records themselves (every word, and the pictures the agent saw) go as soon as that session's CLI ends, at the
hang-up or a restart mid-call, and at start-up for any a crash left: the transcript HQ keeps is the call's only copy

A tool step is never silence on the line: while one runs, a soft two-note tick plays whenever the line has been quiet
for 2 s (at once if it already was), until the agent's words come; text the agent wrote before a step is said at once.
The wait for a reply's first words is held the same way by a sound of its own, softer and without the tick's attack
(`thinking()`: a low swell, a third of a second, 6 dB under the tick). Neither
plays until the board has been quiet for 1.5 s since its last words (`HUSH`; the VAD's quiet count starts 0.45 s in),
nor while it talks: the line asks the model 0.65-0.85 s after the words, and a pause mid-sentence is no wait to mask
. The thinking sound isn't the reply being heard: the board carrying on over it
wasn't finished, and the reply is taken back. These are the line's only sounds of its own: a spoken hold line
("One moment, I'll queue that.") replaced the tick for a while, and the tick was preferred. The call's briefing tells
the agent so: it needn't announce a tool, and after one it carries on from what was said, never starting the reply
over (a call heard its opening twice). A tick counts as the reply being heard: the board talking over it is like talking
over any reply (a lone "okay" lets the step carry on). HQ gets a `tick` event before each tick or thinking sound, as it
gets `said` before a sentence.
Measured on 1 October: a job's hand-off took 7 to 8.5 s from the start of the reply to the job's number (the brief is
written first), and the first words came 1.5 to 2.4 s after that.

The line is never silent when the agent can't answer either. A seat at its
limit ends every turn in the CLI's own message ("You've hit your session limit", written as the model, `<synthetic>`);
read as a reply, it would be logged and dropped, and the board would talk to silence. So `Agent.ask` raises
`Unanswered` from the CLI's own signals, never the model's words: a `rate_limit_event` with status `rejected` (its
`resetsAt`), the message's `error` (`rate_limit`, `authentication_failed`) and the result's `is_error` and
`api_error_status`. The line then says, in fixed words and the agent's voice: "<Agent> can't answer right now: our
Claude seat is at its limit until 00:10. What you say is still written down, and <Agent> follows up after the call."
(signed out, or any other error, likewise; shorter on later turns; in Dutch on a Dutch call), on the company's clock
(`company.timeZone`, sent with the call's context; a reset on another day says the day too). HQ gets a `notice` event
and shows the words on the call screen until a reply gets through; the transcript keeps them as `(The line, not
<Agent>: …)`. A call agent that died and won't start again is said the same way. At pickup, the coordinator says
whether any Claude seat has room (`callSeat`: none ready or draining, every one asleep at its limit or signed out); if
none has, the line says so before the board starts talking.

The line takes the seat with the most room, a draining one too (the reserve a draining seat keeps for the board's own
work), and with none, the one that wakes first (the worker's `lineSeat`); the worker re-picks the moment a seat changes
state. The reserve holds because a Claude seat that starts draining also pauses the jobs running on it at their next
step (`drainPauses`); left running, they would spend it in minutes. When the worker has moved the line to another
seat, a turn that hit the limit goes again at once on a fresh session that knows the call so far, so the board hears
only the answer. The CLI turns later requests away itself once it knows it's limited (no request, no
`rate_limit_event`), so the session keeps the reset it last read. `limit_model.py` is a model API that answers as a
seat at its limit does (HTTP 429 with the unified rate-limit headers): `test_server.py`'s `RealCli` and `line_check.py
--limit` run the real CLI against it.

What the board hears is checked two ways. `line_check.py` runs two scripted replies with tool steps (words, look-ups and a job; a job
before any words) through the real `Call` and the real Pocket TTS, keeps every frame sent, and fails on anything sent
that isn't the agent's own sentences or the tick, a tick outside a tool step or less than 2 s after the sound before
it, a long step with no tick, a sentence said twice, a frame's audio sent twice, or a frame that starts after a gap in
the middle of a sentence (a stutter, as HQ schedules them); it writes the reply as a WAV and as frames for
`platform/hq/call-check.mjs`, which plays them on HQ's own call screen against a stand-in line, in Chromium or (with
`BROWSER=webkit`) Safari's engine, and stops the call's audio context mid-reply to check the playback pauses with it.
`line_check.py --limit` runs a call on a seat at its limit through the real CLI (against `limit_model.py`), the real `Call` and Pocket TTS,
and fails unless the board hears the line's own notice both times, whole and without a stutter.

Why that pause: HQ plays the agent's voice from Web Audio through a MediaStream into an `<audio>` element (so Safari's
echo canceller takes it out). On Apple devices WebKit feeds that stream through a small buffer the context fills as
it renders; if the context stops (iOS interrupts or suspends it, or it stalls) while the element plays on, every
underrun re-reads the buffer's last 50 ms, so the listener hears one sliver of the voice looping about 17 times a
second until the context runs again (`AudioSampleDataSource::pullSamples`, which re-syncs its read position on each
underrun). HQ plays the element only while the context's clock moves (checked every 100 ms and on every state change),
pauses it when the clock stops, and plays it again from fresh audio once it moves; a tap resumes a context iOS stopped.

On the server, HQ says at hang-up how the voice played (`call: ada hung up; HQ played 412 frames via stream at 48000
Hz, 0 stutters, 0 interruptions, 0 stalls`: through the MediaStream or straight out, the phone's sample rate, frames
that came after the one before in the same sentence had run out (the line's `said` and `tick` events mark where a
sentence or a tick starts, so the joins between them and the pauses between replies aren't counted), how often iOS
took the audio away, and how often the context's clock stopped with the element paused for it); `call-times.sh` keeps
that line with the timings, so a call that sounded wrong can be read afterwards. Measured on 2 October: Pocket TTS speaks
a 3 s sentence in 1.2 s on the server's CPU (first audio after 0.15 to 0.27 s) and stays ahead of playback with four
other busy processes on the same cores.

Trust (`guard.py`, tested by `test_guard.py`): the line holds `VOICE_TOKEN`, which the coordinator accepts only on
`/api/voice/*` (call-context, call-end, call-ticket). Each call gets its own call token from call-context, good as that agent
until call-end revokes it for `hq job` (and the look-ups below), hq's management commands (`manage`) and for putting a
promise or a correction of an open item on its own call's list (`POST /api/agent/item`), nothing else of a job's (what
speaks as the job a call doesn't have: status, cards filed or waited for, a follow-up's items and reply): it reads no call's items (every call's open items, one line each, as its briefing has them), and earlier calls as its agent
does (`memory.ts`): any ended call, but one about a card for keys only if it is its own agent's and one about a customer
only for org.yaml's `roles.customerData`. The call agent runs as the same uid as the line, so
the line makes itself non-dumpable (its environment and memory in /proc become root's) and hands the agent an
allowlisted environment. The container sees one Claude seat's token (`/seat`, kept by the worker's keeper), the
server's checkout of main (`/repo`, read only) and its own `/data`; no other seat, no job's files. The agent's Read,
Grep and Glob are denied `/seat`, `/data`, `/proc` and the rest, but that only holds for Claude's own tools: the uid can
read `/seat`, so anything it runs could too. That is why it has no shell: a shell could read the seat's sign-in and
send it anywhere, steered by any text the agent
reads (a web result, a misheard word). The fence is around the shell, not the management: the agent manages the
company's work through `manage` as its jobs do through hq. Its tools are MCP tools (`hq_tools.py`)
that runs hq from an argument list with only the call's `HQ_*` in its environment (never the seat's sign-in), and on a
call hq takes the brief and the words on stdin and no file (`HQ_CALL`). A call's job is a short title (140 characters) and the
whole brief (8,000); longer is refused with the reason, never cut (`hq_tools.py` and the coordinator both check), and
the tool answers with the job's number. A promise's or a correction's line is the same: one line of 200 at most.
Its other built-in tools, the board's call only, never a call out: WebSearch, which runs at Anthropic (the line opens no
connection for it, and the agent gets the results' text), and WebFetch, from this container, as a job's from the worker.

The board's call agent has what a job's agent has, but a shell, so it answers on the line instead of "I can't check that". Two tools read what a job reads (`reads.py`), each
from an argument list it builds itself:
- `report`: the server's status report (`hq report`), live, at or since a time: with no section, the list of its
  sections; then the sections whose heading has the words asked, or only the lines with some words (a job, a pull
  request). Jobs, pull requests and findings, deploys, seats and usage, errors and each service's last log lines.
- `git`: the company's code, every branch, from the worker's mirror (`/work/mirror.git`, mounted read-only at `/mirror`
  by a volume subpath, never the jobs' folders beside it): `log`, `show` (a commit, or a file or folder at a
  revision), `diff` (a range), `grep` (a fixed string) and `branches`, a job's unmerged work (`job/<n>`, `origin/` taken
  off) and its unpushed commits (`outgoing/job/<n>`) included. A revision or a path that could read as an option, a
  pathspec's magic or a way out of the repository is refused before git runs; every path comes after `--`, diffs run
  with `--no-ext-diff --no-textconv`, and git reads no system or global config (`test_reads.py`).
A long answer comes in pages, each under the CLI's limit for an MCP tool's answer (25,000 tokens), saying where the
rest starts (`from`), never cut. `manage` also takes the reads a job has: `hq overseer` (the notes sent), `hq route log`,
`hq items` and `hq estimate --audit|--accuracy|--calibration`, the coordinator opening their routes to a call's token
(`server.ts` CALL_READS).

What stays shut, each for a named risk: the shell, since the uid reads `/seat` and a command steered by any text the
agent reads could send the seat's sign-in anywhere (below); a customer's details (mail, care cases, orders, photos:
charter rule 7), since a call's transcript and summary are read by every agent and a call can't be marked as holding
them, as a job reading them is; everything of the company's on a call out (rule 9, below); the line's own folders and
`/proc` to Read, Grep and Glob.
A chat bubble reaches nobody: on a call, `hq say` only reaches one job under way by its number (`reach`).
A call out's token opens no coordinator route (`server.ts` `PARTNER_ROUTES` is empty): its agent has only the partner
tools (note, no_transcript and hang_up) and looks nothing up.
Five more tools, `search`, `history`, `call` (one call in full, by number), `intercom` (the board's intercom: a day
in full, or lines by words and meaning) and `eta` (where planned work stands), run `hq search`, `hq history`,
`hq call`, `hq intercom` and `hq projects <words>` (`hq now` with no words) read-only. The call token opens the
coordinator's search, history, call, intercom, outlooks and now routes. Search and history show shared files and the work their access rules permit,
intercom shows the board's chat, and call reads ended calls subject to the customer and key restrictions
(`platform/coordinator/src/memory.ts`, `intercom.ts`; the Library note "Memory search"). Outlooks shows matching open
threads across the company, with their plans, job titles, agent and thread names, and the titles of board cards they
wait on. A coordinator refusal reaches the tool as hq's refusal.
If `hq_tools.py` can't start, calls still work without its tools, and the log says so at start and per call.
The line is on its own Docker network (`voice`) with Caddy and the coordinator only, so a worker job can't open
`ws://voice:8080` itself: the board's calls come in through Caddy, which checks the board's session first.
