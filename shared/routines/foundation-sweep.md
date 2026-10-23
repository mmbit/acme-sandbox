
This week's sweep of the foundation for the foundation keeper (org.yaml's `roles.foundation`): the one question the
keeper also asks on every pull request's first round, asked of the code as it stands. Is each thing here a setting, a
list entry or a plug-in point any company could use, or a branch for one company or one need?

- The foundation: `platform/`, `infra/`, `shared/`, `.github/`, `docs/`, `CODE_STYLE.md` and the gates' config at the
  root. Read it as it is on main, starting with what changed since the last sweep's note (`git log --since`), then one
  area in depth that no sweep has read yet, so the whole foundation is covered over the weeks.
- What to look for: a company's name, brand, data or one-off in a foundation file (`git grep -i` for each company the
  foundation is shared with, and for your own); an if-else on a brand or a company; a fixed list of one company's
  things; a one-of-each assumption built into the code (one phone number, one deployment of an engine, one of a kind
  where a company could want two) instead of read from the company's own files.
- Not what to look for: bugs, style and hardening (the refactoring passes and the panel have those), and plug-in points
  nobody needs yet: simplicity wins where it suffices.
- Each finding: the file and line, why it's one company's or one need's, and the generic form (a setting, a list entry
  in the company's files, a registry the platform reads).
- Findings go in one short note in the knowledge base (the Knowledge playbook), replacing last week's, with the date it
  was read against: what you found, what's already queued, and what was clean.
- A fix the role's own team does goes to it as a job (`hq job`), one per finding or one for several in the same files;
  bigger work beyond that is a proposal (`hq propose`). Check `hq jobs` and the open pull requests first: a finding
  already queued gets no second job. A design another company has to agree to goes through whoever aligns the
  foundation between companies, as the entry's prompt says.

A quiet week: one line in the note ("nothing new, read against <commit>"), no jobs.
