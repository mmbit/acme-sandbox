# Board requests, blockers and directives

The board is one human with limited time. Work never stalls silently and never stalls unnecessarily. Never explain
basics to the board and never patronise it: keep it short, precise and decidable. It reads on a phone or tablet held
upright: pictures, decks and films for it are portrait-first.

## When an agent needs the board

A credential, a real-world action (signing up for a service), a decision or an approval.

1. **Raise a board request** (`hq request`), not a chat message. It lands on the desk phone in HQ as a short card.
   It has `kind` (decision | approval | credential | action, or notice for news that asks nothing, below; `review` is
   HQ's own), `urgency` (now | today | whenever), and everything the board needs in the request itself: it doesn't open
   files, branches or pull requests. Optional form fields (text, choice, yes/no, number, date, secret, image or file, voice note) and
   attachments.
2. **Park, don't wait.** The job records its state in its work notes and releases its seat. The coordinator
   requeues it, with the answer, when the request is resolved.
3. **Show work the day it can be opened.** A site, a build or a design the board will see goes to it as a
   presentation card (`hq ask ... --product <slug>`) once it's on its preview and its checks have passed. It never
   waits for a go-live step like the domain: the approval to go live is a card of its own.
4. **Keep moving around the blocker.** Build against a test environment, a mock or a stub behind the same interface.
5. **The CEO batches.** Several small requests become one. Reminders are gentle and rare. Finished work waits for the
   next digest too.

## What rings the board

A card marked `now` rings the board's devices with its title; any other waits quietly on the desk phone. Nothing else
pushes to the board, so the urgency is the whole choice: `now` only when the board must act now or asked to hear the
moment something is ready, and the board's own word on it (fewer today, one when X is ready) holds. Late work never
reaches the board by itself: the CEO sees it in `hq summary`, and whether the board hears (a card) and the thread's new
window (`hq window`) is the CEO's call. <!-- --> Work that's ready doesn't either: the
summary's "Finished since the last check" lists the threads and the board's items whose work, follow-ups included, is
merged and deployed, and that's where the CEO learns that what the board asked to hear the moment it's ready is ready.

- **`now`** for urgent work that's stuck and needs the board, or a real risk of missing an important target (the
  seats at or near their limit before a deadline), or what the board asked to hear the moment it's ready.
- **Never** for a slip of minutes, news, thanks or a time moving on: news goes in the newsletter, and a slip with
  nothing for the board to do goes nowhere.

**A notice** is a card that only tells the board something it would want to know, with nothing to decide, set up or
answer: `hq ask notice <urgency> "title" <body-file> --topic "..."`. The board closes it with "Got it" and may add a note.
Nothing waits for it: send it and go on. A note it types reaches you like any answer; a plain "Got it" reaches nobody.
News the board asked to hear the moment it's ready is a notice marked `now`.
- **When the board is told a time**, it's what it will get and when: "The new product page: 16:00". No job titles or
  numbers, and no old time beside the new one. For work under way, the time is its thread's ETA in
  `hq thread <project>/<slug>` (`hq projects` lists them all), the one the projects view shows the board.

## The card

```
<What you need and why, in at most two sentences, and roughly how long it takes the board.>

Choose:
- Option A (recommended): what it means for us, at most 20 words.
- Option B: what it means for us.

Steps:
1. Open https://… and sign up with `the address to use`.

---
Only what the board might want before choosing (what's blocked, a deadline, a risk), at most about 60 words.
```

- **Title**: at most eight words. **A decision is a choice** under `Choose:`, the recommended one marked, at most
  six, in one list: its first blank line ends it.
  **Recommend:** one line when there's no list; **Options:** short answers separated by `|`.
- **Steps:** at most eight, one action each; values in backticks (they get a copy button), pages as full links.
- **Claude: yes** for web tasks the board can do with Claude in Chrome. Claude never handles keys.
- **Questions are fields.** Anything the board must answer beyond the one choice goes in `--questions <file.json>`
  on `hq ask` or `hq request`: a yes or no, a number with its unit, a short text, or a choice (the shape `hq` shows).
  Each is its own field on the desk phone, and the answer lists each with the board's answer. Never numbered lines in
  the text, and never under the `---`, which is background the board probably won't need.
- **A card that brings work back for a look** ("good now, or more changes?", `--back`) leads with pictures: under a
  line `Before and after:`, one line per change, `- What changed: <before picture> <after picture> <its live link>`.
  The desk phone shows the two side by side, the link under them (in HQ's viewer, with review mode), and the card's
  words under More. HQ gives it its answers, Good now or "I'll leave notes in review" (which closes the card: the notes
  bring their own job), so it has no choices of its own. Shoot both the same way (`shared/review/shot.mjs`), commit
  them under `products/_cycles/`, and file the card with `--when deployed:<this job>`: HQ shows pictures from main. A
  film is its clip; nothing to see is `No pictures: why`.
- **No repo paths.** A document the board can read is named by its file (`board-requests.md`): the desk phone links
  it to the Library. Describe anything else in words.
- To shorten or correct an open request: `hq rewrite <id> <file>`.

## Risks: the "implausible" bar

Before a risk goes on a card, ask whether it is plausible that it actually happens to us. If not, it doesn't reach
the board at all: handle it, note it in the files, move on.

## Credentials

The board enters keys only in HQ. They are stored encrypted by the coordinator and never appear in the repo, chat,
prompts or logs. Agents use gated tools that run in the coordinator, enforce approvals and log every call.

## Directives

The board can just say what it wants (intercom, typed in HQ, on a call). The CEO logs it in `DECISIONS.md`, checks
the open jobs (`hq jobs`), and briefs the right department, which replies with a short proposal. If it costs money,
touches customer data or changes something public, the proposal comes back as an approval.
