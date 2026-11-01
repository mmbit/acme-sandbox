# Time and token estimates


New caller estimates supply time and tokens together. The existing `--size` takes JSON. It adds no command flags:

```sh
hq when "describe the work" --size '{"time":"35m","tokens":{"work":1000000,"reviews":200000,"fixes":100000,"feedback":0},"feedback_rounds":0,"confidence":{"level":"medium","why":"Two similar scopes, but limited feedback history"}}'
hq job <agent> "title" brief.md --code WORD --size '<same JSON>' --refs <job,job> --why "scope comparison"
hq estimate set <job> '<revised JSON>' "why the scope changed"
```

Counts are illustrative, not defaults. `time` uses the existing agent-time syntax. The four token phases and expected
feedback-round count must be finite nonnegative numbers. No token amount or round count is inferred from time,
matching averages or titles. The queue and `hq when` require the token budget. The CEO's revisions retain it in
history, beside the original. Historical rows and automatic scheduling predictions have no token budget and show
that absence. They are never filled with zero or a guessed token conversion.

API callers can give the JSON object or its JSON string as `size`. Queue callers can also give `size` as a duration
and `tokens`, `feedback_rounds` plus `confidence` alongside it. The `sizes` revision endpoint takes the JSON string
as `time`.
`estimate.sizes[].token_budget` and `when.size.token_budget` expose the supplied split unchanged. These are the
estimator's numbers, not a model or algorithm run by the measurement tool. Existing `refs` and `why` retain the
scope comparisons. The shared agent and CEO guidance is in `platform/worker/hq/estimating.ts`.

Task `time` still covers the work split. The scheduling play adds shared review and fix time once. Task tokens
include the anticipated work, reviews and fixes, with feedback allowance shown separately. The through-approval
feature budget is saved independently with `hq deliverable cost`. Use [Feature cost](feature-cost.md) to link initial
pieces and feedback rounds explicitly. A task's allowance never automatically adds to or overwrites that feature
budget. Neither a job finish nor a merge asserts first delivery or board approval.

The weekly `--accuracy` and `--calibration` reports expose `tasks.token_cost`: original estimates against attributed
`whole.cost` work, review and fix phases. Only original tasks with a before-work first estimate, clean timing,
complete task totals and token reports are scored. Missing token budgets and incomplete actuals are counted. The
full saved JSON retains every task's original budget, revisions and actual cost split, including incomplete cases.
Feedback is reviewed separately against the feature budget, deduplicating linked feature roots. Unapproved feature
actuals remain running lower bounds. The weekly review prompt requires both checks and the scope reasoning.

Tokens include input, cache writes, cache reuse and output. Missing historical seat meters remain unknown. Tokens
are not a conversion to subscription usage.

Every new estimate also supplies `confidence: {level, why}`. Choose `low`, `medium` or `high` yourself for the
whole time/token estimate. Explain how many examples fit, how close they are, gaps in the evidence, and any different
certainty about time, tokens or feedback. No count thresholds or automatic confidence score applies. The same field
is required for quotes, queued work and CEO revisions. It is saved separately from `token_budget` at `sizes.confidence`
and returned at `when.size.confidence`. Originals and revisions retain their own confidence. Historical and tool
predictions have null confidence, never a backfilled judgment. The weekly audit exposes `tasks.confidence`, with a work-time spread and work/review/fix token spreads for each saved
confidence level. These use the same original before-work estimates and measurement eligibility as `work_size` and
`token_cost`. Each spread gives its sample count, median error factor, share within half/twice and estimated/actual
sum ratio. Missing confidence is counted separately and excluded from these groups. Token coverage counts remain
visible per confidence level. The CLI prints these comparisons in both weekly report modes.

The review judges whether the saved confidence was warranted, using these comparisons and each original evidence
note. Later revisions keep their own confidence and never replace the original in calibration. The groups measure
observed misses. They do not assign confidence, impose sample thresholds or tune a correction factor. Meter
allocation uncertainty remains a measurement limit, separate from estimate confidence.
