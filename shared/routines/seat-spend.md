# Seat spend

A weekly read of where the AI seats' week went, so the same seats carry more real work. Seats always get used up:
the question is how much of each week bought work that landed, and what didn't.

## Read the week

From the status report (`hq report`), the last 7 days:

- **Per kind of job** ("usage per kind of job"): work, `pr fix`, review, consolidate, scheduled, chat, meeting,
  downtime. The review loop is `pr fix` + review + consolidate.
- **Per change** ("pull requests by status", "usage per pull request"): merged changes, their cost each, and the share
  after the first round (`after_share`), foundation and other apart.
- **Per agent and per model** ("usage per agent", "usage per model"), and the costliest jobs: runs above 1 are resumes,
  which write their context again.
- **Job families** ("every job of the last 24 hours", read on two or three days with `hq report --at`): titles that
  repeat on one pull request (its tail of fixes, re-tests and reviews), jobs HQ files itself (`queued_by` null: stalls,
  crashes, sorts, judges, follow-ups), and failed, stopped or cancelled runs that spent.
- **The seats** (`hq estimate` with no words): each seat's week used, and its share per agent-hour.

## What sessions read before they start

Every session pays for its start once in full and again on each turn, so context that creeps into it costs every job.
From the report's "up-front context per kind of job" (or HQ's Numbers, Tokens): each kind's median opening and its
share of the kind's tokens, against last week's line. A kind whose opening grew by a tenth or more: find what came in.

- The parts every work session loads: the shared memory index (`MEMORY.md` in your home's memory folder; keep it
  under 16 KB, one line per memory that says when to open it: stage a compaction as the docs-sweep routine says), `AGENTS.md`, the
  briefing (the worker's `briefing()`, and the brief, open-jobs list and lines it adds), and Claude Code's own system
  prompt, tools and skills (a new CLI can add some: the ones only a person at a terminal uses go on the worker's off
  list).
- The first reads the briefing asks for: profiles over 20 KB are read into every job of their agent.
- For each part that grew: is it relevant to most of the sessions that read it? What isn't goes, moves to where it's
  looked up when needed, or is loaded only for the kinds that use it.

**Resumes.** From "resumed runs": how many runs resumed a session, how long they had sat idle and what each wrote
again. Past an hour idle the prompt cache is gone and a resume re-reads its whole context. Compare it with a fresh
session that starts from the summary the first session wrote at its end (its closing report, written while warm):
never have a summary made just before the restart, which re-reads the whole context to write it.

## The measure

Write one line a week into the company's seat-spend note (its table, newest first): the week's Claude cost, merged
changes, cost per merged change, the review loop's share, the after-first-round share, a work session's median
opening, and the share that bought no change (failed or no-change runs, work redone or cancelled, meta jobs). Cost per merged change and the no-change share
are the two numbers to bring down; a rise in either is the week's first question.

## Flag waste, fix the cause

Look for spend that bought nothing the company needed: a job spawned to do nothing (a re-run that changes nothing, a
sort of one item), the same work redone, a review round that found nothing new, a long session re-read for a small
change, a check that runs more often than what it checks changes. Judge each by what it cost against what it caught;
a check that catches real problems earns its price.

Fix the cause in the code or the prompt that spawns it, never by asking agents to be careful. At most three changes a
week: small ones in this job, the rest proposed (`hq propose`), each sized on past jobs and with its expected saving
in seat share and its risk to quality. A generic fix goes in the foundation, marked for upstream, so every company on
it gets the saving. Anything that would lower quality or change what the board gets goes to the board as a card.

End with the week's line and what you changed or proposed.
