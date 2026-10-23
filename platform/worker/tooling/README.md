# Tooling measurements


`hq tooling --since 2026-10-20T00:00Z --until 2026-10-21T00:00Z` returns JSON counts from completed runs.
Only jobs in the department designated by `roles.process` can read it. It defaults to the last three days.
`hq tooling --help` works without contacting HQ. No transcript-reading permission is needed.

The worker classifies native tool inputs in memory, then sends a single snapshot with its finish report.
The classifier produces a closed vocabulary of categories and nonnegative numbers. The coordinator trusts the
authenticated worker's generated snapshot and engine. No command arguments,
file paths, queries, output, prompts, messages, customer content or hashes of that content leave the classifier.
Team members are excluded, so one lead's run cannot count the same work twice.

- Version 2 adds global `completed`, `failed` and `milliseconds` for visible calls with an observed outcome.
  These count each call once regardless of category overlap. `calls - completed - pending` counts finished calls
  without a usable outcome. Version 1 has no global outcomes or unknown-reason breakdown. Missing fields are
  unmeasured, never zero.
- `unknownReasons` breaks unknown calls into fixed buckets with the same category counters: `shellSyntax` for
  unsupported or dynamic syntax, `shellProgram` for an unclassified literal executable, `readOptions` for
  unsupported literal `cat`/`head`/`tail` reads (options, counts or stdin), `fileSearch`, `fileChange`, `web`, `mcp`
  and `otherTool` for unsupported native operations.
  These identify classifier coverage, not waste or intent. A shell batch can match several reasons, so their
  counts and spans must not be added together. Native tool names and arguments are never retained.
- Version 3 adds `firstCall` and `startupBoundary`: the fixed classifier labels of the first visible call and the
  call that closed the lookup prefix. Null means that event was not observed. These explain zero prefixes without
  retaining an event log. Version 1 and 2 boundary labels stay unmeasured.
- Version 3 `diagnostics` subdivides coverage gaps with the same counters. Syntax reasons distinguish parser
  rejection, conditional lists, compound control flow, assignments, redirects and dynamic words. A conditional
  or compound node is never walked to invent executed commands. For a command with several unsupported features,
  assignment takes precedence over redirect, then dynamic words. Parser rejection takes precedence over AST reasons.
  Literal program families distinguish directory operations, search, version control, interpreters, output utilities,
  environment wrappers and other programs. Read diagnostics distinguish option terminators from flags, counting
  a bare `-` stdin operand as `readFlags` in historical snapshots before the stdin correction described below.
  These are fixed executable families, not inferred purpose. A directory listing, script or file edit is ordinary
  task work until evidence establishes otherwise. No executable name, option, input or parser error is retained.
  Version 2 unknown bucket names remain unchanged. Heredoc bodies no longer produce legacy categories or program
  families. An enclosing statement containing a heredoc is conservatively `shellSyntax` / `shellRedirect`, including
  an interpreter fed a script body. Body substitutions are not attributed. Following statements are still classified.
  A structural parse error rejects the whole input as `shellParse`, without salvaging a truncated script. The pinned
  grammar rejects some valid syntax, including multiple heredocs on one command. These calls remain unmeasured
  beyond `shellSyntax` / `shellParse`. Historical snapshots retain the earlier parser's body-classification error.
  Diagnostic families can overlap
  in a batch. Do not sum their counts, times or next-call spans. Missing diagnostics in old versions are not zeros.
- Version 4 recognizes a bounded set of literal `cat`, `head` and `tail` file reads. `cat` accepts the short
  flags `A b e E n s t T u v`, including clusters, and the full long names `--show-all`, `--number-nonblank`,
  `--show-ends`, `--number`, `--squeeze-blank`, `--show-tabs` and `--show-nonprinting`. `head` and `tail` accept
  `-q`, `-v`, `-z`, `--quiet`, `--silent`, `--verbose` and `--zero-terminated`. Their `-n`/`--lines` and
  `-c`/`--bytes` counts may be attached or separate, including `--lines=20`. Counts are decimal integers with
  an optional sign and magnitude at most JavaScript's maximum safe integer. Multiplier suffixes, obsolete count
  forms, abbreviated long options and all other options stay unknown. A count value is never a file operand,
  even if it resembles a classified path. `--` ends option parsing and all following words are file operands.
  A missing file, `-` stdin operand, missing/invalid count, unknown option, help/version or any follow mode makes
  the entire read command `readOptions` unknown, with no inferred file categories. Bare reads with no arguments
  are newly unknown in version 4. For example, `hq search topic | head` now ends the startup prefix in that call,
  while version 3 counted it as a startup search lookup. `readFlags` and `readTerminator` describe rejected reads
  with real flags or a terminator. The stdin correction treats a bare `-` as an operand, including before `--`.
  Stdin-only reads and stdin mixed with files have neither diagnostic unless real options or `--` are present.
  Real options take precedence over `readTerminator`. Words after `--` are operands, even when they resemble options.
  Reads with no arguments have neither diagnostic. Historical version 3 and earlier version 4 snapshots retain
  stdin's false `readFlags` label. The correction keeps snapshot version 4 and the same unknown execution boundaries,
  so diagnostic comparisons must account for its deployment. The read parser returns either file operands or a fixed
  rejection diagnostic and returns immediately on an unsupported option or invalid/missing count.
  The call classifier maps that result to labels without interpreting read arguments again.
  Only explicit literal operands reach lookup/source classification. Assignment, redirect, heredoc, dynamic,
  conditional and compound syntax retain their previous unknown boundaries. Other executable families and
  `sed` classification are unchanged. Historical versions retain their old boundaries and absent fields remain
  unavailable, never zero. A classification change alone establishes neither improved live coverage nor savings.
- `startupCalls`: lookup tool calls before the first operation outside lookup/setup work. A batch is one tool call.
  A mixed batch ends startup and contributes only to the all-run counters. `startup` breaks down prefix lookup calls.
- `startupMilliseconds`: wall time from the first tool call to that boundary. Includes agent reasoning and waits
  between calls. Null means no boundary was observed. `firstToolMilliseconds` separately counts worker setup and
  initial thinking before the first call. Neither is a measure of model compute alone.
- `lookups`: all-run lookup categories. Charter, profiles, department charter, rules, memory index, notes,
  knowledge search, history/calls/intercom, help. Repeated category calls are measurable without retaining searches.
- `sources`: direct read candidates in the HQ CLI (by command module), coordinator, kits and infrastructure. They do **not** establish
  intent. A task implementing tooling will legitimately read these files. Searches and scripts are not source reads. The memory module combines search/history/call/intercom.
- `commands`: HQ command families, with a fixed `other` bucket. Multiple families in one shell call each get a count.
- `activities`: browser checks, gates and tests separately. These count invocations, not suite scheduling costs.
- Each category records `calls`, `completed`, `failed`, and summed tool `milliseconds`. Overlapping calls can overlap
  in time. `untilNextMilliseconds` additionally charges the span from an invocation to the next visible tool
  invocation, including intervening reasoning and waits. The last call has no next span. It is an observed cost
  proxy, not causal attribution. Do not add overlapping category spans together. Claude failures use the native tool-result error bit. Codex command failures use the exit code.
  Other Codex operations have a known outcome only when status is `completed` or `failed`.
  An outer command can succeed after an inner command failed. A nonzero test exit is not proof of misunderstood syntax.

`calls` counts lead Claude tool calls and visible Codex tool operations, including command execution, file changes,
web search and MCP calls. Each Codex operation begins at its first observed start, update or completion event,
ends the preceding invocation span and is counted once. Reasoning, agent messages, todo lists and error notices are excluded.
Unsupported visible operations end the lookup prefix and increment `unknown` without retaining their inputs.
Codex code-mode orchestration and hidden native operations remain outside the count.
An unknown call can still have known categories when a shell batch mixes supported and unsupported commands.

The worker uses [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) through `web-tree-sitter` to
separate heredoc redirections and bodies before classification. These pinned WASM dependencies run without native
compilation or install scripts. Node has no built-in Bash parser, and `bash-parser` misparses heredoc body lines as
commands. Inputs without heredocs continue through [bash-parser](https://github.com/vorpaljs/bash-parser).
It reads executable literal command nodes, respecting comments, escapes and quoting. Simple lists, pipelines,
common shell wrappers and direct Read calls are supported. Conditional lists (`&&` and `||`), compound control flow,
dynamic words, redirects, heredocs and unsupported tools end the lookup prefix conservatively as unknown.
Parser errors are not retained because they may include input text. No model prose is classified.
`pending` counts calls without an observed result. Calls that finish without a numeric Codex exit code have no
completed outcome. Source-command purpose, refusal reason and exact retries remain unmeasured.

Every completed claimed run appears in the report, including unmeasured runs with `metrics: null`.
Old abbreviated logs cannot restore outcomes or trimmed startup steps, so they are never treated as measured zeros.
`complete: false` marks a worker takeover or unsupported CLI. A resumed session is flagged separately.
The recorded engine is the worker's actual CLI family, and `requestedEngine` is the job's engine. The department
is its agent's current department. Run IDs support disjoint cohorts. No job title or agent message is returned.

The interval filters run start times, not end times. Freeze a report by recording its run IDs and extraction time.
A later query of the same interval can include a run that was unfinished at extraction. For a bounded cohort,
also require `ended <= until` and report runs that cross the end separately.
