# Review panel

Code review and security audits use several models: independent Claude and Codex reviewers together catch more than
any single model does. The panel's members are `org.yaml`'s `roles.reviewers`, and `roles.consolidator` rules on each round. Until the CEO
has staffed a panel, the consolidator (the CEO, by default) reviews every change alone: staff one before the work grows.

## Panel size

| Scope | Panel |
|---|---|
| Any change, the platform included | 1 reviewer |
| The office's records only (your own profile, `DECISIONS.md`, briefs, the knowledge base's notes) | none: merged as they are, and deployed without a build or restart |
| Other documentation only (a post with its pictures, playbooks, departments) | the consolidator's light read, no panel |
| Security-critical: sign-in, payments, keys and secrets, approvals, customer data, the server and its deploy, the review and the gates, the sandbox | 2 Claude + 2 Codex, security focus |
| A fix round of a security-critical change whose fixes don't touch sign-in, payments, secrets or approvals | 2 Claude + 1 Codex |
| Scheduled full audit and pre-launch audit | 2 Claude + 2 Codex, whole scope |

File names decide the security-critical rows; judgment adds to them. The consolidator, ruling on a one-reviewer round, calls
the whole panel (`panel`) when the change is security-critical in what it does though no file name shows it: how keys or
credentials are entered, stored or sent, for one.

## The bar

How high the bar is follows what the change is (review.ts tells the panel which):
- **Product**, what customers get (`products/<slug>/`): impeccable. Anything wrong, unclear or rough that would reach a
  customer blocks.
- **Internal tools** (`kits/` tools that jobs run, scripts, research): leeway. Only what breaks the server or a build,
  leaks data or keys, or gives a wrong answer someone will act on blocks; the rest is nonblocking at most. One round,
  not several.
- **The platform**, and kit code that runs in the coordinator or on HQ's origin: no leeway; one reviewer reviews it, the
  whole panel only what's security-critical.

## Major visual changes before they go live

Round 1 also judges whether the diff and previews make a major visual change to something live that people see:
a public site or app, or HQ's own look. A new layout, palette, type, illustration or style that the board would
notice counts. A bug fix, copy edit or single button does not. Reviewers report `major_visual: true` or `false`,
and the consolidator settles the judgment. File patterns never decide it. Later rounds judge newly introduced
visual changes too. `review.live` in `company/org.yaml` may describe the company's own live products and looks.
It is a description for the reviewer, not a path filter.

A major change holds the merge with the existing board-decision mechanism. Ordinary review, fixes and the author's
card preparation can continue. The author gets a job to file one card with `hq ask --decides <decision>`.
It shows before/after pictures of the changed pages on phone and desktop, with **Go live** (recommended) and
**Changes first**. Pictures must be available before the visual change merges. One card covers the thread's visual
changes waiting together. If more join after the card is filed, HQ closes it and asks for a replacement covering
the whole waiting set.

The saved merge ruling, merge checks, kept touch-ups and retries all wait for the answer. **Go live** releases the
hold, and a clean review can merge. **Changes first** retires the old ruling and queues the author's feedback job.
The next push gets review again and a fresh visual decision when it still makes a major change. A visual card never
replaces the code review or a launch approval.

## Steps

1. **Automated checks first:** tests, typecheck, dependency audit and secret scan. A failure goes straight back.
2. **Independent review.** Every reviewer gets the same brief and works alone; nobody sees another's findings.
3. **Consolidation.** Merge duplicates, verify every finding against the code, keep only what can be shown
   concretely (inputs → wrong outcome), rank by severity. Agreement between models raises confidence.
4. **Outcome:** `merge` (the coordinator merges and the server deploys), `changes` (a fix job on the same branch,
   then a new round), `close`, or `board` (only for a decision `AUTHORITY.md` reserves for the board).
5. **Record** a one-line summary on the pull request: the panel, the findings, the outcome.

## What a finding is

**Find before you report, and trust what's ours.** Review drifts into hardening: a reviewer that feels it should report
something starts on "one small thing:" before it has found it, then argues for a guard against a case that can't
happen, and doesn't let go. The guard often adds more risk than the case it guards against.
- **A finding starts from its case:** the concrete input or state that reaches the line, and where it comes from.
  Nothing found is a fine outcome. The report's fields come in that order, the case first and the severity last, and
  the consolidator lists its findings before its decision.
- **The trust rule** (`CODE_STYLE.md`, "Errors"). The runtime, the platform, established libraries and our own code,
  data and config are trusted: a guard against a case only they could cause is no finding. Outside input (a request,
  a person's typing or upload, a third party's reply, the network, a file or setting someone supplies, model output)
  is checked, and fails loudly. Recovery only where it means something: one more try of a network call, fetching a
  record again by a unique key of ours. A fallback that hides a failure is never a fix, and code that adds one is a
  finding.
- **The round decides it, not the reviewer's memory.** Each finding says where its case comes from (`from`: outside,
  ours or none) and what its fix adds (`guard`: none, fail, retry or fallback). The coordinator dismisses a guard whose
  case isn't from outside, and every fallback, before the consolidator reads the reports. The consolidator holds the
  rest to the same rule and lists what it drops (`dismissed`: `trust` or `unshown`). Hardening the change or its fixes
  add is a blocking finding with the rule `trust`.
- **Watched:** the status report's "reviews that over-harden" section counts it per day: the reviewers' findings by
  engine, what the round and the consolidator dismissed, and the share of labelled findings that over-hardened.
  Process reads it every week.

**The change's findings, one per mistake, and what became of each.**
- **Pre-existing findings don't block.** Each push tells the round which lines it adds or alters. A reviewer's finding
  on none of them (its own line give or take three, the other places of its mistake, or the change's line it says
  causes it) is set apart as pre-existing. It never blocks and isn't the author's to fix: the consolidator lists the
  confirmed ones in `pre_existing`, and the status report's "pre-existing findings" section keeps them for the
  code-quality sweep. One the change makes worse names that changed line in `caused_by` and stays the change's. A
  secret in code is never pre-existing: it blocks, and is a security incident, wherever it sits.
- **A bug class is one finding:** the pattern once, its other places in `also`. The author fixes the class, and a later
  round doesn't raise another place of it as new (`earlier`: the earlier finding's number).
- **Each finding's outcome is measured.** The ruling after the author's fixes judges every finding sent to them: fixed,
  not fixed, disputed (who was right) or kept on purpose. The status report's "finding outcomes" section counts them
  per engine and per reviewer, with the share that was noise. Process reads it every week.

## How it runs

- A job that ends with a pull request starts a round. Changes to `infra/`, `.github/`, or anything about auth, payments,
  secrets or approvals take the whole panel (the table above).
- Reviewers write `.hq/review.json` and never change the branch.
- The third round is the last full one. A pull request that only changes the office's records (its author's own
  profile, `DECISIONS.md`, briefs, notes: `platform/coordinator/src/office.paths`) merges without review.
- Keep pull requests small: split what's risky (keys, customer data, auth) from the rest, so the rest lands.
- A foundation file (`platform/`, `shared/`, `infra/`) changed here without coming from upstream is flagged: it
  goes to acme-foundation first, or carries a `# company:` note.

## Rules

- Reviewers flag problems; they don't rewrite the code.
- Any secret found in code is a blocking finding and a security incident.
- "Flaky" is not a root cause.
