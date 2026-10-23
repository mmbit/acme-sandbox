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
| `show.md` | An episode of one of the company's On Air shows (`company/shows.yaml`): written, translated and spoken |
