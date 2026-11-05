// The fallback scale for task work estimates when no clean past job is comparable.
// Scheduler terminology: coordinator/src/eta.ts. This scale sizes work, not elapsed time to delivery.
export const DEFAULT_ESTIMATE_SCALE = `Only when no comparable past job fits, use this fallback scale in agent time:
most small tasks finish in under 20 minutes, and even big tasks finish well under an hour. These are starting anchors,
not limits. Judge the task's work and explain why no comparison fits. As clean comparable jobs accumulate, use their
actual agent times instead of this fallback.`;

export const TOKEN_ESTIMATE_GUIDANCE = `Every new estimate gives time and tokens together. Use the existing --size argument as JSON:
'{"time":"35m","tokens":{"work":1000000,"reviews":200000,"fixes":100000,"feedback":0},"feedback_rounds":0,"confidence":{"level":"medium","why":"Two similar scopes, but limited feedback history"}}'.
The time covers task work until first delivery for feedback. The plan adds review and fix time once. Tokens cover
work, reviews, fixes and expected feedback after delivery. Keep --refs and --why for the scope comparison.
Read hq estimate's whole.cost for the task-aligned split and feature_cost for linked feedback, expected/used totals
and observed cost since first delivery. These are recorded numbers, never a token estimate chosen by the tool.
Reason from the closest scopes: explain why this task sits between the named examples, rather than copying an
average. Weigh tool waits separately from tokens. Expect feedback on visible experience, feel and performance.
Backend work and refactoring normally have zero board feedback rounds. Explain any exception and uncertain coverage.
Use the same JSON with hq when and hq estimate set. The CEO gives the token total and split beside any time it quotes.
For a feature, save a separate full budget through board approval with hq deliverable cost <original> <file.json>:
tokens, seat_weeks (null if unmeasured), feedback_rounds, refs, why and confidence. Do not sum repeated feature budgets or add
job feedback allowances to that budget a second time. Link initial pieces with hq deliverable feature <member> <original>.
Link feedback explicitly with hq deliverable feedback <member> <original> --round <label>, reusing the board's round
label across its pieces. First delivery and board approval are distinct observations, never inferred from a merge.
Tokens include input, cache writes, cache reuse and output. They do not convert to subscription percentages.
Missing historical meters and token reports stay unknown. Every estimate includes confidence with level (low, medium
or high) and why. Judge it yourself from the number and closeness of the past examples. Explain gaps and any
difference in certainty between time, tokens and feedback. Save it in --size JSON, CEO revisions and feature budgets.
No tool assigns confidence and there are no count thresholds. The weekly review checks your judgment against actual
time and token misses, and names kinds of work where examples are few or distant. Meter allocation limits are
measurement uncertainty, separate from your estimate confidence. The weekly audit groups observed time and token
misses by saved confidence level. Keep the original evidence note: revisions do not replace it in calibration.`;

// The one time the board hears, wherever an agent gives it one (a call, the intercom, a call's follow-up, a job): the
// plan's, with no margin of our own on top and never a later second time beside it; doubt goes with its reason.
export const ONE_TIME =
  "Give the board one plain time: the plan's time to tell the board, as the tool gives it (live four times in five), " +
  'never an ETA, a "done about" or a planned finish, which are as likely late as early. That time holds the plan\'s ' +
  'margin already: add none of your own, never work a time out in your head, and never put a second, later time ' +
  'beside it. A real reason to think it may run long is said as that reason, with the one time. Good: "Live at a ' +
  'quarter to one; it may run over, as it\'s the first build on the new engine." Bad: "Ready at a quarter to one, ' +
  'live at the latest a quarter to two." Asked whether a time holds, read the plan\'s time again and answer plainly ' +
  'from it ("yes, it\'ll most likely make it", or why not), never a sum worked out in your head.';
