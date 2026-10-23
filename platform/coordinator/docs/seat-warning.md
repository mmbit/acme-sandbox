# Seat warnings

The CEO or Process sets this through `hq` after the board's word. No new screen is needed.
The board's devices must already have Web Push enabled in HQ.

```sh
hq seat-warning
hq seat-warning --week-percent 90 --week-hours 0
hq seat-warning --week-percent 85 --five-hour-percent 90 --week-hours 2
hq seat-warning off
```

Each write replaces the whole setting. Omitted thresholds are off. Percent is the share used,
above 0 and at most 100. Hours is the time remaining until projected exhaustion, provided that
exhaustion comes before that window resets. Use 0 hours to warn about any projected exhaustion
before reset. Both windows may have a percentage, a lead time, or both.

The projection uses `headroom.ts`'s measured consumption per agent-hour multiplied by that seat's
current active runs. It assumes that workload continues. With no measured consumption or no active
runs, the run-out time is unknown. A percentage warning still works. It is a warning, not a change
to admission, pacing or the seat's stop level.

The setting is kept in HQ as `seats.warning`. Without an explicit choice, HQ reads `warning` from
the optional `company/seats.yaml`. Without that file, warnings are off. A company can supply:

```yaml
warning:
  week: { percent: 90, hours: 0 }
```

The agent API is `GET /api/agent/seat-warnings` and `POST /api/agent/seat-warnings`, with a body of
`{"warning":{"week":{"percent":90,"hours":0}}}`. The other window is `five_hour`.
An explicit `{"warning":null}` stays off even if the company file supplies defaults.

One arriving seat reading checks both windows and sends at most one push per seat. Each threshold
remembers its crossing in the database, including across coordinator restarts. A reading below the
threshold rearms it. A new reset rearms it too. Missing usage readings preserve the crossing.
If both conditions cross in one reading they share the same push. The push uses `push.ts`'s existing
best-effort delivery, so a failed delivery does not repeat on every reading.

For intake, offer: “Would you like a notification when the AI subscription your company works on
is nearly used up, or is likely to run out before it renews?” After the board chooses its levels,
run `hq seat-warning --week-percent 90 --week-hours 0` for those example levels, or the thresholds
it chose. Leave it off when declined. Existing HQ notification enrolment connects the devices.

