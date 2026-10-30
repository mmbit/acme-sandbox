# The foundation's design notes

The page every company's foundation keeper (`company/org.yaml`'s `roles.foundation`), the Overseer and the reader a
review's triage gives the foundation question read before judging a change to the foundation's paths. The rule is CODE_STYLE.md's "Platform and product"; this page is what
follows from it in practice: where a company's part plugs in, what the companies have settled, and what is still open.

A keeper changes it like any foundation file: a pull request at home marked `company: job #<n>, not upstream yet`,
which the Overseer carries. A design both companies must agree to goes through the Overseer, who aligns it with the
other company's keeper and writes the outcome under "Settled".

## The question

Is each change a setting, a list entry or a plug-in point any company could use, or a branch for one company or one
need? Only the first kind belongs in the foundation. A plug-in point nobody needs yet isn't built: simplicity wins
where it suffices.

## Where a company's part plugs in

- **Kits**: a kit's `coordinator.ts` (routes), `hq/app.js` (an HQ app) and `hq-<command>.sh` (an `hq` command), found
  through the registry (`template/kits/README.md`).
- **Routines**: written once in `shared/routines/`; a company runs one from `company/schedule.yaml` with `routine:`
  and keeps only its own additions in `prompt`.
- **Roles**: who does what (`roles:` in `company/org.yaml`), never an agent's name in platform code.
- **Settings**: the server's names and switches in `company/infra.env`; a product's needs in its `product.yaml`.
  `company/brand.yaml` `names: book` names the board's book on its tips book's cover; left out, the cover reads Tips.
  Its `screens` names the screens the board reads on, which a try's versions are shot at; left out, a desktop's.
- **Seat plans**: optional `company/seatplans.yaml` maps worker seat names to confirmed Claude subscription sizes,
  `5` or `20`. For example, `claude-main: 20` declares that seat's 20x plan. Omit seats whose size is unknown.
  `hq when --extra-seat 5x` (or `20x`) and `hq projects [words] --extra-seat 5x` replay the live plan with one fresh
  Claude subscription. The call tools' `extra_seat` field takes the same sizes. Without the file, or with no listed
  subscription with positive measured usage in both windows, the replay reports unavailable. It also needs current
  worker slots and room. An absent per-seat run cap means the added seat shares those worker resources.
  Capacity comes from measured usage, with low confidence. Scaling between plan sizes is an assumption.
  This setting only describes subscriptions for the replay. It neither adds a real seat nor changes the saved plan.
- **Looks**: the company's HQ theme and renderer choice in `theme/hq.yaml`. Wire's colourways name the one thing lit
  `accent`, `side` and `onAccent`: a company's `theme/hq.yaml` still saying `knop` and `onKnop` renames them at the
  carry, or Wire falls back to its own Day and Night.
- **The brand's colours**: `company/brand.yaml`'s `colours`, each a `--<name>` on HQ's `:root` (main.js); its
  `notebook` is the Notebook's accent, the pull tab's colour, asked at onboarding (left out: HQ's ink, never a colour of
  the platform's own).
- **Shows**: `company/shows.yaml`.
- **Artifacts**: found, not registered. A folder with a `deck.json` is a deck (its cover a `thumbnail.jpg`, `cover.jpg`,
  `cover.png` or `thumbnail.png`, else its first slide's picture). A video with a `.render.json` beside it is a film,
  one per scene it was rendered from (a record with no command, an adopted render, takes the `scene.html` beside it),
  named by the scene's `<title>`, its cover the `.jpg` named like it or the folder's `poster.png`. An `artifact.yaml`
  overrides what's found in its folder; with `scene:` it stands for that scene's film.
- **Covers**: each artifact's `picture` (artifact.yaml, product.yaml or a company/artifacts.yaml entry; a found deck's or
  film's is named above), shot from the
  company's own list by `node platform/hq/covers.mjs <list.json>`. The list is a JSON array kept in the company's
  folders, one entry per cover: its `picture` (a path from the repo's root) and what to shoot, a product's `preview`
  and `page`, a repo `page`, HQ's own `hq` address or a `url` with the `start` command that serves it, framed with
  `at`, `hide` and the other fields the tool's header lists. A declared picture that isn't there fails HQ's Artifacts
  list.

## Settled

- **Phone lines and care deployments** (24 October): brand.yaml `phoneLines`, a list of lines routed on the number
  dialled and the caller (each its number, callers, agent, care deployment, words and calls a day); the care engine
  deployed once per product whose `product.yaml` says `engine: care`, the one with `chat: true` serving the shops' chat
  and owning the line to HQ. Both companies are on it. The old single `phoneLine` is still read as one line
  (`phonelines.ts` `lines()`, `platform/voice/phone_timing.py`); the next carry takes that read out.

- **The board's book replaces the first Sketchbook, and HQ's own review notes go into it** (26 October): HQ's first
  Sketchbook screens are gone for every company, and a note pinned on one of HQ's own screens goes to the board's book
  (`/api/book`) rather than Reviews, with no setting: one way for both companies. Knop doesn't use the first
  Sketchbook (the board moved the pencil work to Onlyonery on 24 October).

- **Expedite is also for work the board needs in its hands now** (30 October): the board's rule of 29 October (Knop's
  call 164: merge first, then run the review round) is in `hq expedite`, `hq job --expedite` and the call agent's
  tools for both companies, beside structural HQ fixes. A task already running inside a deliverable still can't be
  expedited: the deliverable merges as one pull request (`regroup.ts takeOut`).

## Open

- The guest room's Sketchbook is gone, for every company: an invited person writes in the Notebook room
  (`/guest/notebooks/`), on their own page of a round from Reviews or a notebook the board invited them into, and
  brand.yaml `guest: { sketchbook }` is gone with it (a company that still sets it gets nothing from it). Before it
  carries, Onlyonery's agreement is asked through the Overseer.
- HQ's Sketchbook app on the computer is gone for every company (Ink 1.1: one notebook, the book), with its
  `/api/sketches/…` routes and brand.yaml `computer: { sketchbook }`; its old sketches still fold into the book at start
  (`ink/sketchmigration.ts`). Before it carries, Onlyonery's agreement is asked through the Overseer (job #14679).
- `platform/hq/shell/desk.js`: decks built before 4 October tag their messages `{ onlyonery: 'deck' }`, so the desk
  still answers to one company's name. Generic form: rebuild those decks, then drop the old tag.
- Review mode's notes into the board's book: the board's notes on any product
  preview land on its open sheet for the product's owner, guests the board invites into its book (Reviews' people
  rows) write on that sheet in their colour, and the board's Send and Discard (review mode, HQ's viewer) and Reviews'
  waiting notes are gone, for every company, with no setting. Before it carries, Knop's agreement is asked through the
  Overseer; a switch only if Knop asks for one.
- Threads called deliverables wherever people read them: HQ's projects view
  (HQ's one-task threads shown as tasks), the `hq` commands (`hq deliverable`, `hq plan deliverable`, `--deliverable`,
  the old names kept as aliases), the worker's briefing, the drawing prompts and the naming guide, and the
  coordinator's own messages (refusals, log and plan-change lines, the summary, the review and call prompts), for
  every company. Before it carries, Knop's agreement is asked through the Overseer. If Knop's board keeps "thread",
  HQ's words come from `company/brand.yaml` `names` (shell/brand.js) and the prompts' from a setting, rather than two
  words in the platform.
  Knop's board kept "deliverable" and asked for it everywhere it reads (call 167): the call agent's tools now say
  deliverable too (`job` and `promise` take a `deliverable` field, `manage` the `deliverable` command and the old
  `thread` quietly), as do the meeting chair's example, the calibration's turn names and the call tools' README.
  Still "thread" for now: the `threads` table and its columns, the `/api/agent/thread*` routes and the API's `thread`
  field, and the coordinator's file and identifier names (`threadtime.ts`, `newthread.ts`, `threadOf`). The board left
  that part to us, and no task holds it: Knop's DECISIONS.md, 29 October, has why.
- Seat savings, for every company: (1) HQ's stall alarms (`platform/coordinator/src/stalljobs.ts`) file one stall job
  for the process role, not one per cause: every stall, of any cause, joins the queued one until it starts, it is
  downtime work (it waits for the seats' spare room), and its agent judges which causes are worth the work. (2) A
  weekly seat-spend read, `shared/routines/seat-spend.md`: cost per merged change and the share of spend that bought
  no change, from the status report's usage tables, at most three fixes a week, generic ones in the foundation; a
  company runs it from its `company/schedule.yaml` and keeps its numbers in its own note. The first has no setting;
  the second is a routine like any other. Before they carry, Knop's agreement is asked through the Overseer; a switch
  only if Knop asks for one.
- Ink's customer-call marking is gone, for every company, with no setting. A call's notebook pages and their tries'
  versions pages read like any page, by every job. The tasks and try runs a call's notes make mark nothing. Only a call
  about a card for keys keeps its pages, versions pages included, for its own agent (`ink/bookreads.ts` callRead),
  who also owns them (`memory.ts` keysAgent), so the board's notes there are that agent's to answer, and what the
  board sends from them goes to that agent (`notebooksend.ts`). An invited guest's notes
  are still outside text. Before it carries, Onlyonery's agreement is asked through the
  Overseer; a switch only if Onlyonery asks for one.
- Review rounds and their follow-ups, for every company, with no switch: on the first round the author fixes or
  answers every finding, and from the second only blocking findings hold the merge. Internal work blocks only on what
  breaks HQ or the work it carries, loops without end or loses data (security and a missed ask block everywhere).
  org.yaml's `review.shipped` says what keeps the release bar, where real bugs and what a customer meets block too. A
  merged pull request's other findings go to its author as one follow-up job in its deliverable, and a follow-up
  job's own pull request leaves none (`platform/coordinator/src/reviewrounds.ts`, `followups.ts`). Before it carries,
  Onlyonery's agreement is asked through the Overseer. A switch comes only if Onlyonery asks for one.
- A call's notes page goes to nobody, for every company, with no setting: as the call ends it goes in as the board
  left it and stays in My journal, unstamped and with no Send (the old book's Send refuses it too). Each scrap and
  promise on it is an item on the call's list, which the call's follow-up hands out with the transcript, so nothing on
  it is queued twice (`platform/coordinator/src/ink/callnotes.ts` ended, `notebooksend.ts` and `ink/booksend.ts`
  sendPage). Before it carries, Onlyonery's agreement is asked through the Overseer.
- `infra/provision.sh` still renames a Hetzner firewall called `web`, the name a server's firewall had before
  firewalls were named for their `SERVER_NAME` (also `harden.sh`'s header): a one-off for a server whose firewall is
  still called `web` in the Hetzner console and guards it alone, which no new company's server has. Generic form:
  none, it goes. The Overseer sees both companies' servers: once each one's firewall carries its `SERVER_NAME`, the
  branch is dropped at a carry.
