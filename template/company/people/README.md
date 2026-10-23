# People

One file per agent: `<id>.md`. It is who the agent is across sessions: a running agent is a fresh process each time,
and continuity comes from this file, the knowledge base and git history.

- Every agent has a unique name that is never reused, not even after it retires.
- The agent that creates a new agent names it, adds it to `org.yaml`, and creates its file here from the template.
- Agents that finish their work move to `alumni` in `org.yaml`. Their file stays.

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
What I'm in the middle of and what to remember next session. Under 40 lines; lasting knowledge goes to `knowledge/notes/`.
```
