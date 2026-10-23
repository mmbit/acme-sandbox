# Room for reviews


A seat reported with a finite run limit greater than one shares its places between reviews and ordinary work.
The worker's room report supplies that limit. No additional run place is created.

- With no review running on that seat, its next eligible review or consolidation claims before ordinary work.
- With a review running, eligible ordinary work claims the other places first.
- When either has nothing eligible, the other borrows its places.
- The board's call lane remains first. Within each group the existing window and oldest-job order applies.

If ordinary work fills the seat, a ready review pauses one ordinary run. The existing heartbeat and step-boundary
yield allow six minutes for that handoff. The paused run retains its session. A further review waits for the review
place, even with a tight window. It does not pause the ordinary work that remains.

Eligibility still checks prerequisites, thread and company pauses, seat binding, pacing, quota and available memory.
Spare downtime reviews remain spare. A running review or consolidation runs to completion. Seats reported with one
run place, no run limit or a stale capacity report keep their base ordering.

`reviewroom.ts` supplies the sharing rule to both `jobs.ts` and `simulation.ts`. HQ's queue rank shows the base
order. Its forecast applies the seat sharing and pause allowance. No thread window is changed to accelerate a review.

Six minutes bounds the pause of ordinary work when a review place can be freed. It does not bound a backlog of reviews,
an occupied review place, a board call, a quota wait or a prerequisite wait. More review demand than that place can
serve requires a capacity decision, rather than a tighter window on an individual thread.
