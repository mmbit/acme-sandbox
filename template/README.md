# A new company

An AI-run company on the acme-foundation platform. Fill this in once the board has shared its vision.

- `company/`: the constitution. Start with `CHARTER.md`, then `AUTHORITY.md`, `org.yaml` and `playbooks/`.
- `theme/hq.yaml`: which HQ renderer the company uses, and its settings. `theme/hq/`: the company's own HQ files (logo,
  icons, dev-mode mock data), served over the foundation's of the same name; `node platform/hq/serve.mjs` shows them.
- `kits/`: the company's own libraries and tools, and the parts that plug into the platform (its own coordinator routes,
  HQ apps and `hq` commands): `kits/README.md` says how. `products/`: what it sells. `products/care/`: the support chat's
  plug-in; switching the chat on, the company's steps and the board's: `platform/care/docs/switch-on.md`.
- `company/projects.yaml`: the board's projects, which HQ groups every job under (projects, their threads, their jobs).
  Starting with work already under way: `platform/coordinator/docs/projects.md`.
- `platform/`, `shared/`, `infra/`: the foundation's files. Take updates with `git merge foundation/main`; change
  them upstream first (the Process team). `shared/craft/` is the craft library every company starts with.
- `company/migrations.sql`: the company's own one-off database fixes (a job or a card for its live work), in
  `-- once: <id>` sections the coordinator runs once at its start; never in `platform/coordinator/src/db.ts`.

## Starting over

The board can start the company over on a clean slate (`infra/reset.py`), keeping the server, its address and mail,
the seats' sign-ins, the keys on the desk phone and the board's own sign-in. Only the board does this, through its
Claude Code: the server ignores a reset that an agent or a merged pull request brings.

1. Write `company/reset.yaml`: an `id` (lowercase, like `2026-10-03-clean-slate`, never used before) and `keep`, the
   company's files and folders that stay as they are (say `company/brand.yaml` and `theme/`; `company/infra.env`
   always stays). Files that should start different from the template go in `company/reset/` at their own path
   (`company/reset/company/org.yaml` becomes `company/org.yaml`): the CEO's entry, say.
2. `python3 infra/reset.py start` on an up-to-date main: everything of the company's goes back to the template (the
   foundation's own folders stay), except what's kept, with the prepared files laid over it, and `infra/reset` names
   the id. Read the change, then commit it and push it to main yourself.
3. Within a minute the server stops the coordinator, worker and voice line, closes the open pull requests of `job/*`
   branches and deletes those branches (all of them kept in a git bundle), moves the runtime data aside, and starts
   again on a new database: job numbers start at 1. The deploy report says how it went.

Everything moved aside is in `/var/lib/<SERVER_NAME>/archive/<id>/` on the server (the old database with its jobs,
calls, chat, cards, memory and mail; mail, photos and approvals; the jobs' clones and sessions; the agents'
auto memory; the calls' sessions; the job branches' bundle) until someone removes it there (`rm -r`).
