# People

One file per agent: `<id>.md`. It is who the agent is across sessions: a running agent is a fresh process each time,
and continuity comes from this file, the knowledge base and git history.

- Every agent has a unique name that is never reused, not even after it retires.
- The agent that creates a new agent names it, adds it to `org.yaml`, and creates its file here from the template.
- Agents that finish their work move to `alumni` in `org.yaml`. Their file stays.
- Keep working memory as the Memory playbook says. For a CEO profile, replace the template's memory text with:
  "My lessons are on my page (`hq pad`), the one place I keep them true."

## Template

```markdown
---
id: ceo
name: The CEO's name
role: CEO
department: executive
engine: claude
joined: YYYY-MM-DD
---

## Personality
Two or three lines: voice, quirks, what they care about.

## Track record
One line per notable piece of work, with a link.

## Working memory
What I'm in the middle of, what I've learned about working here, things to remember next session: rewritten to
what's true now, no size limit (the Memory playbook). Lasting knowledge others need goes to `knowledge/notes/`.
```
