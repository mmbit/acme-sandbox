
# Code style

**Code we're proud of**, not code that only works. Anyone can jump in anywhere and understand it on its own, change it
comfortably and confidently, and find the right file by its name.

This covers code that lasts: `platform/`, `infra/`, `shared/`, `kits/`, `products/<slug>/`, `template/` and `theme/`.
Throwaway work (decks, ads, demos, films, research, one-off scripts: `.prettierignore` lists them) keeps its leeway.
Its review asks only whether it misses the board's vision in an important way, and whether it really breaks or is
unsafe: no findings on style, conventions or documentation, and no rounds of fixes for them. Review triage judges what
is throwaway (a prototype, a demo reel, a concept film, a presentation: whatever runs once or twice and goes to the
archive).
Where code and a rule disagree, the code comes up to the rule: new code from the start, old code in its area's
refactoring pass (the Maintenance playbook).

## The gates

`npm run gates` before you stop (`-- --all` for the whole repo, per area). The worker runs it on every pull request,
with the tests of the areas it touches ("Tests"), and one that fails goes back to its author before review. Prettier formats, ESLint finds bug patterns, TypeScript
checks types. Whatever they enforce isn't repeated here.

- **Prettier decides formatting.** Nobody formats by hand, and review doesn't discuss it.
- **The gates hold what a change adds:** a new or already formatted file, the lines you edit, a type error you cause
  anywhere, a file or function it makes cross a size limit. Older code waits for its area's pass.
- **The only overrides:** an ESLint disable comment that says why (`-- strips the terminal's colour codes`), its
  size-limit twin in Python and shell (`# max-lines -- why`, `# max-lines-per-function -- why` above a function), and
  `// prettier-ignore` on a table that reads better aligned.

## Naming

- **A real noun, kept whole:** `responseBody`, `receivedMessage`. Never `data`, `info`, `result`, an abbreviation or
  an empty suffix (`Manager`, `Service`, `Helper`). Short names only in a short scope (`i`, `g`, `x`).
- **One concept, one name in every layer:** the setting, form field, column, API field, variable and CSS class all
  read `department`.
- Plain words over jargon. The unit in the name: `STALE_MS = 10 * 60_000`. A closed set of strings is a named union
  (`type SeatState = 'login' | 'ready'`). Browser code lists the values in a comment.
- **Routes:** a table maps `'METHOD /path'` to a handler that only adapts the request to a module function:
  `list<Nouns>`, `get<Noun>`/`find<Noun>`, `create<Noun>`, `<verb><Noun>`. Paths use plural nouns, an action is a
  last-segment verb (`/api/requests/answer`). An HTML page is a constant `<noun>Page`.

## Comments and prose

For comments, docs, commit messages and UI text alike.

- **Default to no comment.** One earns its place by saying what the code can't: where a number comes from, an
  ordering constraint, an outside quirk, a reader in another module.
- **A comment says what the code needs today.** Never history: no earlier versions, roads not taken, or the job, card
  or call behind a change. Git keeps that. A comment may point to a rule that decides it (`(house rule 7)`). The one
  number allowed is the foundation's `company: job #<n>, not upstream yet` tag.
- **The test for a comment:** would the code as it stands raise this question on its own? If not, delete it.
- **A file opens with one line on what it's for** (Python: a docstring). A manual goes in the README. A test file's
  first line says how to run it: `// node --test src/usage.test.ts   (uses a throwaway DATA_DIR)`.
- **Plain language:** one idea per sentence, active voice, no sentence opening on a gerund, no phrasing that parses
  only after reading the code. Five cases make a list. No em dashes or semicolons in prose, sentence case, `//` over
  `/** */`.

## Shape

- **Similar code looks similar.** Restructure until it does: name the repeated expression, bundle the repeated
  arguments. When Prettier wraps one branch and not its twin, restructure.
- **Entry points first, then helpers in call order**, depth first. A shared helper goes after its last caller.
- **Name intermediate results** rather than nest calls into a multi-line expression. A tuple that keeps coming back
  becomes an object.
- **Plain modules:** top-level state, exports as the API, `import * as jobs from './jobs.ts'`. Short helpers are arrow
  consts, longer ones `function`s.
- **Classes only for a live thing with state and a lifetime** (a call, an audio worklet) or an error type. No layers:
  no services, controllers, repositories, or a wrapper around one call.
- **One file per concern**, named in one lowercase word (`ledger.ts`), its test beside it. Split by concern, not by
  layer.
- **Size limits.** A function past 50 lines, or a file past 400 (tests aside), splits by concern: in the change that
  crosses the line, or the area's next pass. The gates hold it: a file that crosses 400, and a long function that's new
  or newly long (one moved under its old name stays old), in Python too, and in shell its file. A data table or a page's markup takes a disable comment that says why. A long file gets
  `// ---- storage` markers until its pass.

## Platform and product

- **Generic is generic, ours is ours.** The platform (`platform/`, `infra/`, `shared/`) holds engines, tools and app
  frames that fit any company. A company's name, rules, wording, prices and products come from its own folders
  (`products/`, `kits/`, `company/`, `theme/`) through a documented setting. No company in a platform file.
- **One engine per job.** Routing, pages, orders and payments, print, money and dates, the support chat's order lookup:
  each is one kit or engine. Engines talk through their documented interfaces, never each other's internals.
- **Apps sit on kits: import, never copy.** An app holds only what is its own (its product, its look, its words) and
  imports the rest by path (`kits/README.md`, "Using a kit"). A kit grows when an app needs more. Review sends back
  any copy, however small.
- **What every app writes the same way is the kit's export.** A kit's README shows a call, never a block for each app
  to paste: routes, a page or a setup that two apps would write alike come from the kit (routes as a table the app
  spreads into its own).
- **The template is where an app starts.** `products/_template/` is already on the kits, so a new app begins there,
  never as a copy of the last app.
- **A company's part plugs in:** a kit's `coordinator.ts`, `hq/app.js` and `hq-<command>.sh`
  (`template/kits/README.md`), and the platform offers a hook (a registry, a list) wherever a kit steps in.

## Language and dependencies

- **No build step.** Node 24 runs TypeScript as is (types at a boundary, `any` at the edges). Browser code is plain ES
  modules: no bundler, no framework.
- **A page asks in its own UI, never in the browser's dialogs** (`alert`, `confirm`, `prompt`). A button that asks
  once more asks in its own spot ("Tap again to discard") with `askAgain` (`shared/ask/ask.js`), never a copy of it.
  ESLint holds this, in an `.html` page's inline scripts too.
- **Node and the web platform first:** `node:http`, `node:sqlite`, `node:test`, `Intl`, `URLPattern`. A dependency
  needs a reason nothing built in covers.
- **Config from the environment**, read once near the top (`process.env.X ?? default`). Secrets only from there,
  never logged.
- SQL is lower case in the platform and upper case in product apps: one case per file.

## Errors

- **Trust what's ours.** The language and its runtime, the platform, established libraries and our own code, data and
  config are trusted: no check, catch, retry or fallback for a case only they could cause. A problem in our own code is
  fixed where it is, never guarded against where it's used. The guard often adds more risk than the case it guards.
- **Check what comes in, and fail loudly.** Checks belong where outside input comes in: a request or a form, a
  person's typing or upload, a third party's reply, the network, a file or setting someone supplies, model output.
  There a failure stops the work with an error, so nothing ends up half done or quietly corrupt. Recover only where
  that means something: one more try of a network call, fetching a record again by a unique key of ours. A failure that
  leaves the other side's state unknown (a 500 halfway through an order) stops and says so.
- **Never a fallback that looks like a real result.** A value that couldn't be had throws, and bubbles up if a retry
  isn't safe. A default, a placeholder or a lesser output in place of the real one is the worst case: no error, a
  customer lost and nothing in the logs. HQ shows mock data only on localhost.
- **A `catch` that swallows or logs** belongs only where it keeps the system alive: a server's request handler, the
  worker's loops, fire-and-forget work. An empty `catch` says why: `catch { /* already there */ }`.
- A recoverable error with no built-in type is an `Error` subclass named `<Failure>Error`. A refusal says why and
  what to do instead: an agent reads it. An HTTP handler that denies returns the status as a number.

## Judgment

- **The model decides what needs judgment.** How many versions to make, whether something needs a preview, who
  answers, which model size, what's worth flagging: a prompt decides it, with direction and a few good examples. Never
  a fixed count, an if-rule, a keyword list or a cap. A rule fits the cases its author pictured and fails the next one.
  Not every annotation needs a preview, and not every preview needs four versions.
- **A hard limit earns its place.** It names the real risk it guards (safety, money, the law), weighed against the
  capability it costs, and its code says why. A limit that guards a real risk (keys, a customer's details, money, the
  law, the review's gates) stays hard: judgment works inside it, never lifts it. Over-restriction is a failure too: an
  agent sandboxed from checks it could run makes more mistakes, not fewer. Never add a limit by reflex.

## Limits

- **Arbitrary limits are dangerous.** A cap picked as a round number does more harm than the case it guards against:
  on deadlines, jobs at once, characters, notifications a day, messages a call may pass on, or a test's timeout. It
  cuts what someone needed (a long transcript read only to its first third), refuses what the board asked for (a
  second word to work under way on the same call), or hides something slow behind retries (a test timeout retried
  until it passes).
- **A limit comes from a real constraint** (the memory a run has, a provider's quota, a model's context) and is
  worked out from it, not guessed. Hitting it is never silent: the rest can still be had, or the work stops and
  says why. A timeout is a question: find out why it was slow, never retry it away.

## Logging

- **stdout and stderr, no levels, no library:** `console.log` for what happened, `console.error` with the error
  object when an operation failed. The worker uses its timestamped `log()`, Python `print(..., flush=True)`.
- **A line is a short fact:** sentence case, no full stop, the subject first and detail after a colon
  (`${seat.id}: limit reached`), a failure ending on its cause. Never "successfully".
- **Ids and statuses only.** Never a token, customer data, or the full text of a prompt or the board's request.
- Events for the board go through `publish()` or the worker's event endpoint, written as UI text. HQ's browser logs
  carry an `[hq]` prefix.

## Bash

- `set -euo pipefail` (`set -uo pipefail` for a script that must carry on past a failed step, checking each step it
  needs). Quote every expansion. A comment under the shebang says what it does and needs. Errors go to stderr and exit
  non-zero.

## Tests


A test pays for itself by failing when something someone relies on breaks, and by staying green while the code
underneath it is rebuilt.

- **Test at the edge that someone uses:** an HTTP route, an `hq` command, a kit's exports that other code imports, the
  file a tool writes, a page in a real browser (Playwright, `*-check.mjs`). Assert what that caller sees: the status,
  the stored order, the email that went, the print file's size.
- **Real things over mocks:** a throwaway `DATA_DIR` set before the dynamic `import()`, the real SQLite, the real `hq`
  script, local servers playing Stripe, Print API and GitHub. Mock only what leaves the machine.
- **A shared behaviour is tested once, in its kit**, so every app on the kit gets it. An app tests only what's its own.
- **A refactor keeps the tests green untouched.** A structural change that breaks a test shows it pinned the
  implementation: rewrite it against the behaviour in the same pull request, or delete it.
- **The pipeline runs them once.** `npm run tests` runs the suites of every area a change touches (`platform/<x>`,
  `shared/<x>`, `kits/<x>`, `products/<x>`, `infra`), the way `shared/gates/tests.ts` writes down; the worker runs it on
  every push beside the gates, and HQ keeps the result by the code it tested (the whole tree, and its base), so the same
  code is never tested twice. An author's own run is a look for themselves that HQ doesn't keep: run the test you're
  working on, and leave the suites to the push. A test that fails twice and passes on main goes back to its author
  before review; one that fails on main too, or passes on a second run (flaky: fix it), is named and holds nothing up,
  and the nightly run on main (`npm run tests -- --all`, shared/routines/tests.md) fixes or deletes it by the morning.
  Reviewers get the report and run no tests, so a behaviour worth checking is worth a test. Browser checks
  (`*-check.mjs`) start servers and a browser, so the pipeline skips them: a reviewer runs the ones a change's pages
  need.
- **A regression test fails before its fix.** Fewer, sharper tests: extend one before adding a file. Test names are
  sentences about behaviour. `node:test` with `node:assert/strict` in a `*.test.ts` (or `.js`, `.mjs`) beside the
  code, run from the nearest folder with a `package.json`; Python `test_*.py` (`unittest`) and shell `test_*.sh`, run
  from their folder.
- **What gets deleted** (review sends it back, a pass removes it):
  - a test that reads source text and asserts on it.
  - a test of a helper exported only for the test (test it through its caller).
  - call order, call counts, spies on our own modules, exact internal shapes.
  - a copy of the code under test: a re-implemented function or table.
  - setup that writes a module's stored rows or files by hand (raw SQL, a copied schema, hand-built stored JSON):
    make them through that module's own functions, or one shared fixture, so a change in how something is stored
    touches one file.
  - incidental wording (UI copy, error messages, SQL or HTML strings), unless the words are what's promised.
  - a scratch check kept as a test, and a guard against a failure that can't plausibly happen.
  - pixel geometry in a browser check: exact positions, sizes, corners, colours, gaps, a row that "didn't move". A check
    asserts behaviour: the page opens, a tap does what it should, what's saved or sent, and nothing covers what you need
    or runs off the screen (the board: styling that went right is never tested that way, so the 1% that once went wrong
    isn't either).
