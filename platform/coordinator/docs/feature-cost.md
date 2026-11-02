# Feature cost



Feature cost accompanies the ETA in `hq projects`, `hq deliverable` and clean comparisons from `hq estimate`. The
board's projects view shows none of it. It supplies recorded measurements and the agent's saved expectation.
Matching never invents a token or seat budget. The planning agent weighs scope and value against these costs, with no
automatic value score.

A feature defaults to its deliverable. Group initial pieces with `hq deliverable feature <member> <original>`.
Group board feedback with `hq deliverable feedback <member> <original> --round <label>`. Every deliverable built
from the same feedback round takes the same label. Linking an existing group moves its members too. This changes
accounting only. Dependencies, scheduling, branch boundaries, windows and releases stay independent.
Feedback links require a nonblank string label. Initial-work links store no round label. Cost and milestone writes
authorize the resolved feature, even when the caller names one of its members. Membership changes also authorize
the source feature and every deliverable whose membership will change before writing any links. Permission denials
return 403.

`company/features.yaml` supplies explicit historical membership. It contains `features`, each with an original
`feature` deliverable, optional initial `work` deliverables and `feedback` entries with `round` and `deliverables`.
Live links override those entries. Deliverable aliases keep both sources working after a move or rename.

## Measurements

`estimate.jobs[].whole.cost` follows the same task window and equal review/preview allocation as whole-task time.
`estimate.jobs[].feature_cost` includes the feature's linked feedback, even after its initial merge. Feature costs
also appear at `thread.cost` and on the board's project and completed-deliverable responses.


Usage comes from the existing session-increment ledger. A job remains incomplete when any run in the measured
window lacks its own closing report. An earlier report cannot cover a later retry, and partial totals stay out of
weekly token calibration. Input, cache writes, reused input and output remain separate
and sum to tokens. Team usage already included by the engine is not added again. A resumed session contributes only
its increment. Failed, cancelled and repeated work still consumes resources and remains in feature actuals.

Each recorded job has one allocation, through its deliverable, branch, pull request, explicit review-fix assignment,
recorded review-follow-up findings or a preview's held branches. A shared review or preview is split among its
owners. It is never added once per owner. Automatic review follow-ups with one source feature join that feature.
A follow-up shared by distinct features is allocated to them, without inventing a single source feature.

The disjoint cost split is work, reviews, fixes and board feedback. Feedback includes its work and subsequent
reviews and fixes. Review rounds remain separate from board feedback rounds. The latter count distinct explicit
labels, not deliverables or task titles. Unlinked history is not guessed from words.

Seat use comes from positive or zero weekly meter changes between observations in the same reset window. The gain
is divided by overlapping run milliseconds on that seat. Corrected and delayed observations reprice adjacent
intervals. Reset crossings and missing readings are excluded. Interval allocations persist after the observation
history expires. Meter use is attributed, rather than a provider measurement of an individual job. Idle gains have
no job owner. Native seat-week fractions are not normalized across subscription sizes or engines.

Token counts are not subscription credits, API-equivalent money, or a conversion to a seat's week. Missing meter
history stays unknown. Metered run time and jobs with incomplete token reports accompany recorded totals. A measured
seat total can cover only part of a feature. It excludes unmetered work and is not a claim of complete coverage.
Historical token reports remain available even where old seat readings are gone. New meter attribution begins
with this implementation's observations. No past subscription percentage is reconstructed from token counts.

Project totals deduplicate the feature roots touched by that project, including linked rounds in other projects.
They show the full cost of the related features. The same cross-project feature can therefore appear on both
projects. Those project totals must not be summed into a company total. A missing feature expectation is counted,
and a partial project budget is labelled as such.

## Expectations and approval

`hq deliverable cost <original> <file.json | ->` appends the agent's expectation:

```json
{
  "tokens": { "work": 1000000, "reviews": 200000, "fixes": 100000, "feedback": 700000 },
  "seat_weeks": null,
  "feedback_rounds": 1,
  "refs": [],
  "why": "Explain the scope comparisons, or why no past job fits.",
  "confidence": { "level": "low", "why": "No close feature yet, especially for board feedback." }
}
```

This covers the whole feature through approval, including anticipated board rounds. A linked round does not add a
second copy of that budget. Use `null` for unmeasured seat use. An owner, the CEO or Process can record it. Every
revision retains its author, time, references and reasoning. This feature budget is separate from the job estimates
saved at queue time. Their token entry is documented in [Time and token estimates](token-estimates.md). New feature budgets also require `confidence: {level, why}`, the agent's judgment of the whole through-approval
expectation. Choose low, medium or high and explain the number and closeness of examples, including feedback gaps.
It is retained beside each saved budget. Historical missing confidence remains null. The weekly review compares the
judgment with the actual miss when approval and coverage permit it, without automated confidence scoring.

`hq deliverable milestone <feature> delivered|approved <file.json | ->` takes `{at,evidence}`. The command selects
the feature and milestone. Additional file fields cannot replace either or select the speaker. `at` is a past ISO
instant with its zone. Evidence names the observed first delivery or the board's approval. Approval cannot precede
recorded delivery. A job finishing, merging, deploying or being closed by its owner never records board approval.
The read shows both milestones as unknown until someone records the observation.

When first delivery is recorded, the feature exposes `after_delivery`, through recorded approval if present or
as a running lower bound otherwise. Token attribution uses usage-report timestamps, and meter attribution uses
interval endpoints. Delayed reports can cross a milestone, so these are recorded observations, not exact per-turn
accounting. They provide an honest comparable for feedback work without asserting that first delivery was approval.
