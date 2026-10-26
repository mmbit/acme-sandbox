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
- **Looks**: the company's HQ theme and renderer choice in `theme/hq.yaml`. Wire's colourways name the one thing lit
  `accent`, `side` and `onAccent`: a company's `theme/hq.yaml` still saying `knop` and `onKnop` renames them at the
  carry, or Wire falls back to its own Day and Night.
- **Shows**: `company/shows.yaml`.
- **Covers**: each artifact's `picture` (artifact.yaml, product.yaml or a company/artifacts.yaml entry), shot from the
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
  Sketchbook (the board moved the pencil work to Onlyonery on 24 October). The guest room's Sketchbook stays, off where
  brand.yaml says `computer: { sketchbook: false }`.

## Open

- `platform/hq/shell/desk.js`: decks built before 4 October tag their messages `{ onlyonery: 'deck' }`, so the desk
  still answers to one company's name. Generic form: rebuild those decks, then drop the old tag.
- Review mode's notes into the board's book: the board's notes on any product
  preview land on its open sheet for the product's owner, guests the board invites into its book (Reviews' people
  rows) write on that sheet in their colour, and the board's Send and Discard (review mode, HQ's viewer) and Reviews'
  waiting notes are gone, for every company, with no setting. Before it carries, Knop's agreement is asked through the
  Overseer; a switch only if Knop asks for one.
