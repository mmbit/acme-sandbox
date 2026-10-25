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

**The shared memory.** It isn't in git, and what you change in your home's memory folder goes live when your job ends,
before anyone has read it. So leave that folder exactly as it is, and stage the changes instead: one file in the PR,
`company/upkeep/memory-<date>.md`, one entry per memory file you'd change or delete: its name, the sha256 of its text
now, the change (delete, or the new text) and why. Show the old text only once it's screened clean. A memory file that
holds any of the above is staged for deletion by its sha256 and the reason alone, never its text, nor its name if that
gives anything away; its safe lessons can be a new entry of their own. Never stage `MEMORY.md` (the index) for
deletion, only new text for it: the shared memory takes nothing back from a copy left empty
(`platform/worker/src/copyback.ts`), so the index stays even when every other file goes.

Before staging, check the plans already in `company/upkeep/` whose application job has ended (`hq jobs <your id>`):
your home's memory folder is the shared memory as your job began, so each entry has taken if its file is gone (a
delete) or has its new text's sha256 (a change). Take the entries that took out of their plan, in this PR. One that
didn't (another job changed the file since, say) is staged again this week with its sha256 now, if it's still wanted,
and leaves the old plan; one about an incident goes to the security lead and the CEO again. A plan with no entries left
is deleted. Leave a plan whose application hasn't run yet alone, and stage nothing for a file it covers.

Then queue the application for after your PR merges:
`hq job --after $HQ_JOB <your id> "Apply the memory sweep of <date>" <brief> --downtime`. The brief says: apply only
what the staged file says as it stands on main (`git show origin/main:company/upkeep/memory-<date>.md`; not on main
because the PR was closed: apply nothing); before each entry, check the file in your home's memory folder (the shared
memory as the job began) still has the staged sha256, and skip and list any that changed since; change that folder and
nothing else, and leave the staged file as it is: what took only shows in the shared memory once this job has ended,
so the next sweep checks it and retires the plan. No memory changes this week: no staged file, no application job.
