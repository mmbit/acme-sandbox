# Founding the team

A new company starts with the CEO alone. Its onboarding in the intercom (the Onboarding playbook) or the board's first
call sets the vision; the CEO's founding job, or its follow-up of that call, founds the team, and the team does the
work. The CEO builds nothing itself.

## On the call

Listen, ask, and confirm what the board decides. Hand out no work: there's nobody to hand it to yet. Tell the board
that the follow-up hires the team and gives the work to them.

## The follow-up: hire first

1. **The hiring pull request.** In the follow-up job, and nothing else in it but the founding decisions:
   - departments in `org.yaml`, each with its charter in `departments/`;
   - agents with a name never used before, a role, an engine (`claude` or `codex`) and a look, each with a profile in
     `people/` from the template in `people/README.md`. The engine follows the work: Codex for research, code review
     and coding from a blueprint; Claude for anything that touches UX, design, media or other creative work, which
     Codex can't do well. Claude is the scarcer of the two, so give it the work only it can do. That's how the models
     compare as of October 2026, and it can turn within weeks: the board says when it changes;
   - `org.yaml`'s roles: the review panel (reviewers), who rules on its rounds (consolidator), who builds fixes to how
     the company works (process), and whose name mail arrives in (inbox).
2. **The work, as jobs for the new people.** Record each thing the board asked for with yourself as the owner, then hand
   its work to the colleague whose work it is:
   `hq job --after "$HQ_JOB" <their id> "title" <brief-file> --item <item>`. The job waits until the hiring
   is merged, then starts with them, and they bring their own helpers. HQ refuses a job for someone who isn't on main
   yet without `--after`, and cancels it (and tells you) if the hire never lands.
3. **New products** come from the venture cycle (the Venture cycle playbook): name the department that makes them, and
   its head runs the cycle when the board starts one.
4. **Your own part.** The mission in `CHARTER.md`, priorities, `DECISIONS.md`, and what the board must decide (the desk
   phone). Nothing more.

## Never

- Queue a colleague's work to yourself, even "for now".
- Stand in for a colleague with an in-session helper (a team member). A colleague in `org.yaml`, or in your hiring, is
  never a team member: their work is a job for them.
