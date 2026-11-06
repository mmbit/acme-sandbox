Your weekly sweep of the company's written memory, so what agents read into their context stays short, current and
consistent. In scope: `company/DECISIONS.md`, the profiles in `company/people/` (track records and working memory), the
notes in `knowledge/notes/`, the department pages and playbooks, and the shared Claude memory (the memory folder in
your home). Never the charter, `AUTHORITY.md`, `org.yaml`, code, briefs' decisions or the board's own words.

**What to look for.** Contradictions (between files, or a file and itself), notes that drifted from main or from a
later decision, duplicates, and sprawl: a small decision from a week ago doesn't need its paragraph of reasoning read by
every agent for months. Compress it to what still holds (the rule, who, the date) and move the full old text to
`knowledge/archive/`, with the line "> Archived <date> by <your name>: <reason or what replaced it>" as a blockquote
under each piece's heading, so search and git keep it and each piece's hit carries its note. Working memory over its
40 lines: fold lasting lessons into a line, drop what's finished.

**Rules.** Never change what a decision or note means. Where two sources disagree, don't pick a side: queue the owner
a short job (`hq job`) and leave both. One small pull request per sweep, content only, so it gets the light
documentation read: that read is the second pair of eyes, and nothing is cut before it. List each cut in the PR's
summary (what, where it went). Nothing worth doing this week: a line in your profile, done.

**Screen first.** Customer details, anyone's personal details (the board's included: a name, a home, a phone number,
an email address) and secrets (charter rules 7 and 8): read everything you'd move, quote or stage for them before it
goes anywhere. None of it ever goes into the archive, the PR, your report, a message or a job brief: point to it by
file and line, or a memory file by its sha256, and say what kind it is (a key, a person's details), no more. One found
is an incident, not a cut. Stop handling that piece (no moving, compressing or quoting it) and tell whoever handles
security and the CEO at once, one `hq say` each, with that pointer alone. A key found outside the environment needs
replacing: put it on the desk phone now (`hq ask credential`, naming the key, never its text; only the board enters
keys). Then go on with the rest of the sweep. The security lead decides what else the incident needs; the cleanup
below comes on top of that, never instead. A repo file holding one is also a job for its owner, with the same pointer.

**The shared memory.** No job changes it: a job works on its own copy, and nothing in that copy goes back
(`platform/worker/src/copyback.ts`, on purpose: a job's notes may hold what it read at a private source). So an edit,
merge or deletion made in your home's memory folder is lost when your job ends. Don't make one, and don't queue a
job to apply one: list in the PR's summary what you'd merge or archive and why, by file name (a file that holds any
of the above by its sha256 alone, as an incident). What should last goes in the repo (the Knowledge playbook).
