A refactoring pass over the area this entry names, for habitability: code the next person can read, understand and
change with confidence, measured against CODE_STYLE.md. DRY, simplicity, clear names and structure, consistency. Not
bugs, not hardening, not features, and no change in behaviour: the code gets smaller and plainer, never bigger, with
no extra error checking or handling.

- Read CODE_STYLE.md and the area. Pick the few changes that make it clearly smaller, plainer or more alike:
  duplicated code folded into one place, dead code removed, a needless layer taken out, names and patterns made
  consistent with the rest.
- Formatting: what `npm run gates -- --all` lists as unformatted in the area gets `npx prettier --write`, in a commit
  of its own. No line past 120 columns.
- Comments (CODE_STYLE.md, "Comments and prose"): an opening banner cut to the one line on what the file is for,
  comments that outweigh the code or repeat it cut, and no job, card, request or pull request numbers (only the
  foundation's `company:` marker keeps one). A comment that says why, where the why isn't obvious.
- Only real code: never decks, ads, demos, films, research or one-off scripts.
- Foundation code (platform/, infra/, shared/): mark each change `company: job #<n>, not upstream yet`, and skip
  files a foundation merge changed in the last week (git log --author=Overseer --since='1 week ago' -- <file>):
  another company may be mid-refactor.
- Stay out of the way: skip any file an open job or pull request touches (hq jobs, hq report).
- A bug you find isn't this pass's work: queue it for the owner (check hq jobs <owner> first).
- If a convention in CODE_STYLE.md doesn't fit the area, fix the guide in the same pull request.

One pull request, readable in one sitting, with fewer lines than before; tests pass, and it says how you checked that
behaviour is unchanged. Nothing worth doing: change nothing, no pull request, and say so in a line.
