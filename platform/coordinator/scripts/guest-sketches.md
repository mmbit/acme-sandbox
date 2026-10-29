# Move saved guest sketches once


Run this operator command only after the reviewer Notebook change is deployed. Use the coordinator's runtime,
company settings and data volume. Take a database and book-files backup first. The command does not run during
startup or a notebook read.

From `platform/coordinator`, with the deployment's `DATA_DIR` and `REPO_DIR` in the environment:

```sh
node scripts/guest-sketches.ts inventory
node scripts/guest-sketches.ts copy SOURCE_PAGE TARGET_PAGE
```

The inventory lists each legacy page that still has drawings, typed words or pictures, its invited person and active
destination membership pages. A person can have several review rounds and invited notebooks. Open the source and
the intended destination in HQ, then choose the page that belongs with that work. Never choose the latest invitation
automatically. A sent or archived destination must be reopened first.

Copy each source once. Its drawing becomes one group below anything already on the chosen destination. Typed words,
placed pictures and waiting pictures come with it. Pictures get new Notebook filenames. The original page and files
stay in place. The command records the destination and refuses a second destination or a source edited after copying.
Repeating the same unchanged copy returns `copied: false`.

Open the destination as that guest and check its ink, words and pictures against the source. Keep the backup and the
source until that check is complete. Record only counts and the verification outcome in the job report. This checkout
has no live migration result: the deployed data still needs this one-time operator pass.
