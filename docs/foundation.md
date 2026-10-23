# The foundation's design notes

The page every company's foundation keeper (`company/org.yaml`'s `roles.foundation`) and the Overseer read before
judging a change to the foundation's paths. The rule is CODE_STYLE.md's "Platform and product"; this page is what
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

## Settled

Nothing yet.

## Open

- `platform/hq/shell/desk.js`: decks built before 4 October tag their messages `{ onlyonery: 'deck' }`, so the desk
  still answers to one company's name. Generic form: rebuild those decks, then drop the old tag.
- The voice line's call kinds are branches, not a list, so a partners line or a second voice agent needs foundation
  edits (found by Onlyonery). Generic form: call kinds as entries in the company's own files.
