# Review configuration in org.yaml

The company supplies general review candidates in `roles.reviewers` and eligible consolidators in
`roles.consolidator` (one ID or a preference list). The first eligible consolidator triages each round.
The default is the company's CEO. Co-authors may review and rule on work they wrote together. A sole author is
excluded from panel and consolidator candidates, including the CEO and on retries. If the listed consolidators
are ineligible, general reviewers are considered next, then other Claude or Codex staff.

The triage reads the diff, thread goal, engine availability and open blocking findings. Its recorded JSON chooses
readers, assigned files, domain labels and reasons, plus the eligible consolidator for the ruling. No path globs,
line thresholds, domain seat tables or fixed panel sizes select the reviewers. `review.domains`, `review.slice`,
`review.plainKits` and `review.coversAsDocumentation` no longer control selection.

On a fix round, the diff starts at the last ruled commit. Without an explicit replacement list, only the eligible
finders of unresolved blockers read again. Adding a reader requires a reason. Omitting a finder requires a named
exception with a reason. Triage can hold the review for an owner decision when repeated fixes stop making progress.
The existing formal stage briefings, finding outcomes, owner inbox and failed-review retries still apply.

`review.rounds` supplies the formal stage boundaries. `review.visual` supplies mandatory preview checks and their
records. `engineOnly` records work restricted to an engine. These checks do not choose panel size.

HQ stores each decision in `review_triage`, keyed by its triage job, with PR, round, commit, ruled base and selection.
The job rows returned to the projects view include `triage: {job, base, selection}`. The selection contains its
reason, consolidator and `reviewers: [{agent, reason, files, domain, security}]`. Older rows have `triage: null`.

With thread planning on, a `changes` or `close` ruling creates one item in the project owner's inbox. Each finding
carries its domain and files. The owner draws fix tasks on the thread, naming the finding IDs they address. HQ does
not create an author's fix job. The last fix task's push starts the next round and its fix check. A `close`
item (the change shouldn't land at all) lets the owner drop the work, or redraw it only if it's still wanted in another
form. A `board` ruling waits for the board's decision. Work that isn't right yet stays on its pull request for as many
rounds as it takes: nothing closes it for that. With thread planning off, `changes` makes the author's fix job on the
same branch, and a close queues no re-land.
