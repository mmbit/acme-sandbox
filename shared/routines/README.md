# Routines

The recurring jobs every company runs, written once here and shared by all of them. A company runs one from its own
`company/schedule.yaml` with `routine: <name>`: who runs it, when, and its own additions in `prompt`, which come after
the routine's text. A generic improvement goes here, so every company gets it at its next foundation merge; what is
only one company's goes in its entry's `prompt`.

| Routine | What it does |
|---|---|
| `code-quality.md` | A weekly check that the code doesn't slip: the week's changes against CODE_STYLE.md, fixes queued |
| `morning-round.md` | Gets stuck and needlessly waiting work moving, and moves existing work forward first |
| `refactoring.md` | A refactoring pass over one area the entry names: smaller, plainer code, behaviour unchanged |
| `tests.md` | Every night, the full test run on main: a test that's red is fixed (the code or the test) or deleted |
| `support-articles.md` | Every night, support articles for what's new (products, features, offers, policies) in the knowledge base the customer helper answers from <!-- --> |
| `foundation-sweep.md` | A weekly sweep of the foundation for the foundation keeper: company-specific code and one-of-each assumptions, a note and jobs for the fixes <!-- --> |
| `strategy.md` | A weekly look at how the company stays profitable, at most three recommendations, in a meeting or alone |
| `books.md` | The weekly books: reported costs and invoices booked against approvals, costs coming, the month's close to the board |
| `docs-sweep.md` | A weekly sweep of the written memory: contradictions, drift and sprawl compressed or archived, the shared memory staged |
| `security-audit.md` | A weekly security audit of what changed in the apps and sites: realistic paths only, small fixes, the rest queued |
| `seat-spend.md` | A weekly read of where the AI seats' week went: cost per merged change, the share that bought no change, at most three fixes |
| `process-review.md` | A weekly look at whether the way the company works costs more than it brings: at most three changes |
| `newsletter.md` | Every day, a short issue of the company's newsletter: at most five things, at most 100 words, with a cover |
| `cve-watch.md` | Twice a day, major vulnerabilities in what the company runs (Node, the server and its images, Docker, dependencies): patched or mitigated at once, the rest to the Overseer or the board |
| `show.md` | An episode of one of the company's On Air shows (`company/shows.yaml`): written, translated and spoken |
