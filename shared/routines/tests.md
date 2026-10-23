Tonight's full test run on main: every area's suites, so a test that broke on main is fixed or gone by the morning
instead of failing quietly in every change's report.

1. Fresh main: `git fetch origin main && git checkout --detach origin/main`, then `npm run tests -- --all` (no time
   limit; let it finish). Its report names each failing test ("Failing on main too") and each that passed on a second
   run (flaky).
2. For each one, find why, and in one pull request:
   - the code is wrong (the test caught a real fault): fix the code, or queue its owner a fix with the failure in the
     brief when it's more than a small change (`hq jobs <owner>` first);
   - the test is wrong (pinned an implementation, a time of day, an animation, a removed feature, pixel geometry, or
     anything CODE_STYLE.md's "What gets deleted" lists): rewrite it against the behaviour, or delete it. A flaky test
     is wrong too: make it wait on the state it means, never on a sleep, or delete it.
3. All green on main already: nothing to do, and nothing to say.

No card and no post: the pull request is the record. A suite that can't run at all (a package that won't install, a
missing tool) is a fault like any other: fix it or queue it.
