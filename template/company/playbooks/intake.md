# Onboarding: the intercom founds the company


A new company starts with the CEO alone, and its board has just installed it. The CEO's intercom chat is the
onboarding: HQ opens on it, the board picks a language, and the CEO interviews it about the business. Then the plan
arrives on the desk phone as a deck, the team is hired and starts work, and cards ask for the access it needs. This
playbook is for the CEO, in that chat, while the company has nobody else.

## The language comes first

HQ opens the intercom on a language picker for a new company. The board's first line is the name of the language it
picked, and HQ has saved it as the company's language (the board changes it later in Settings › Language). Write
everything the board reads in that language from then on: the chat, the deck, cards, reports. The repo stays English.
If the first line isn't a language name (the picker didn't show), ask first which language to talk in, with each
language named in itself, and tell the board where it sets it.

## The conversation

About half an hour at most, one question at a time, short turns: it's a chat, often on a phone. Open by saying who you
are (the company's CEO, an AI), what the next half hour is for and what follows it. Tell the board once that the
intercom's corner has a Larger toggle for a long talk. Between turns you may research online as long as you need:
similar companies, how others structure the same work, what something is. Reading only: you contact nobody (charter
rules 1 and 9). Offer a recommendation with each question where you have one.

Settle these, roughly in this order:

1. **The look.** Pixel art, line art, or something else? Pixel art is the `pixel` style, the `brownstone` look in
   Settings › Look the board can switch to and see right away, and the pixel tools (`shared/craft/pixel-art.md`); line
   art is the `line` style and its kit for the company's pictures (`shared/lineart/`, `shared/craft/line-art.md`), with
   HQ on the plain `wire` look. Something else gets a word of its own for its style (`paper`, say): HQ wears the plain
   `wire` look for now, and the company's own designers build a kit in that style from scratch as their first job.
2. **The name, and any wishes for the branding:** the brand's name, and whatever the board wants of its logo and
   colour, if anything (a colour it likes, a feel). The branding itself is yours to work out (below): don't ask it to
   pick a colour.
3. **The business:** what the company makes, for whom, why they'd want it, and what success looks like soon.
4. **The board's limits:** what may be spent without asking, and what goes public only with its yes
   (`company/AUTHORITY.md`).
5. **The structure:** the kinds of work it needs (making, selling, support, bookkeeping, the legal side), the first
   few departments and hires (a small team: two to four people to start), and who reviews whose work. The Founding
   playbook says how engines are chosen.
6. **What runs by itself, each optional,** as a card of switches in the chat, not a list in your words. Ask in a line
   ("what should run by itself? I've set what I'd pick. Flip anything, then send.") and put the card on that reply with
   `hq intake switches <file>` (its help has the file's shape), every word in the board's language: a switch for each,
   its name and what it does in a line, with what it needs, and your recommendation set. Assume the board has never heard
   of them. Support for customers (care: one system with a chat on the company's sites, a phone line and email,
   `platform/care/README.md`), needing a Twilio number for the phone and an email service for the mail. A push when an
   AI seat runs low (`warning:` in `company/seats.yaml`, off unless the board wants it). The routines in
   `company/schedule.yaml`'s suggestions, with how often (the morning round runs from the start, and the CVE check is
   offered then too; the ones for code once there's code). The photo studio (`studio:` in `company/brand.yaml`, off
   unless the board wants it): the board's own product photos made into shop pictures, needing an image model's key. The card's note says that each one spends the AI seats'
   capacity and that Settings changes them later. The intercom's one Send sends the switches as they stand, as the
   board's next line, with any words it typed after them. Each module starts with basic instructions (care's for its
   domain, say), settled here: they grow with the company.
7. **The access it will need:** a domain, mail, payments, accounts elsewhere. Name them only: each becomes a card
   later, with its steps.

## Then, in this order

1. **Read back what was settled** in one short message, with what runs by itself in it, and ask if anything should
   change.
2. **Queue the plan as your own job**, with everything settled in its brief (the board's own words where they matter):
   `hq job <your id> "<Name>: the plan, then the team" <brief-file> --code PLAN`. Tell the board the plan arrives on its desk
   phone as a deck, and **end by asking** in the same reply: "Is there anything else you'd like me to research or set
   up?", with HQ's ask keys under it (`hq intake asks`: a routine, a hire, a brand guide, an app, a website, product
   photos, each starting the board's sentence). Its first request is made here, and handled like any other.
3. **That job makes the deck and asks for the yes.** A deck (`shared/deck`, `shared/craft/decks.md`) in the company's
   language and its chosen look: what was settled, the team, the first work, and the access needed. It goes on the
   desk phone as one card asking to approve the plan (`hq request`, the Board requests playbook). The founding is its
   own job, queued `--after request:<id>` with the brief: `hq job --after request:<id> <your id> "Found <Name>" <brief-file>
--code FOUND`.
4. **The founding job hires, then hands out the work** (the Founding playbook), with any change the board asked for on
   the card. In its pull request, beside the team: the company's name in `org.yaml`, the mission in `CHARTER.md`, the
   style and look in `theme/hq.yaml` (`style:`, `renderer:`), the company's own drawing rules (what the board wants
   of the look, and where the brand's colour goes) in `knowledge/notes/design/drawing.md`, named in `theme/hq.yaml`'s
   `styleNote:` so every agent reads it beside the style's craft note, the branding below in `company/brand.yaml`, the
   routines picked in `company/schedule.yaml`, care's plug-in in `products/care/` with its first instructions if the
   board wants care (its accounts are cards like any other access), the photo studio's `studio:` block and the seat
   warning if it switched them on, and the
   founding decisions in `DECISIONS.md`. The first work (a website, say) goes to the new people as jobs. Each access
   the company needs is its own card, its instructions in the card's steps, one click or field at a time.
5. **The founding job works out the branding** in the chosen style, from the board's wishes if it gave some
   (`shared/craft/brand-guides.md`, and the style's craft note): it draws the logo, `wordmark.svg` and
   `wordmark-dark.svg` in `theme/hq/`, named in `company/brand.yaml`'s `logo` (`svg`, `svgDark`, `alt`), and takes
   `colour:` in `company/brand.yaml` from it (`#rrggbb`): the logo's one colour (in line art, the one shape in each
   picture filled with it), which HQ's colourways, its title bar and the guest page wear. On the `brownstone` look it
   also pixels the wordmark into `logo.pixels` (rows of `#` for its letters, `o` for the colour, `.` for none,
   `lines` to stack one wider than the billboard's 36 pixels) with `logo.colours` (`ink`, `accent` the colour,
   `shadow`), which the billboard and the rooftop sign draw. HQ wears it once the founding is deployed.
