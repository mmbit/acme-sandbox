// The engines' turns at a free slot: each in rotation, its turn taken the moment a slot picks it, so slots that pick
// while earlier claims are still unanswered alternate too.
export const IDLE_MS = 60_000;

export function roomTurns(now = () => Date.now()) {
  let turnsTaken = 0;
  const lastTurn = new Map<string, number>(),
    emptySince = new Map<string, number>();
  const idle = (engine: string) => now() - (emptySince.get(engine) ?? -Infinity) < IDLE_MS;
  // the engines in turn order: those whose last claim found work (or that haven't claimed yet) first, then those whose
  // claim found nothing less than IDLE_MS ago, each group by the oldest turn first
  const order = <C extends { engine: string }>(ready: C[]) =>
    [...ready].sort(
      (a, b) =>
        Number(idle(a.engine)) - Number(idle(b.engine)) ||
        (lastTurn.get(a.engine) ?? 0) - (lastTurn.get(b.engine) ?? 0),
    );
  return {
    // A free slot's next claim, of the engines with a seat to start on (ready): with room, the one whose turn it is, its
    // turn taken now. Short of room, only a claim with the room it has goes, for the first engine in turn order that may
    // make one now (short: that room, or undefined), and it takes no turn.
    next<C extends { engine: string }>(ready: C[], roomy: boolean, short: (engine: string) => number | undefined) {
      const byTurn = order(ready);
      if (!roomy) {
        for (const c of byTurn) {
          const room = short(c.engine);
          if (room !== undefined) return { ...c, room };
        }
        return undefined;
      }
      const first = byTurn[0];
      if (first) lastTurn.set(first.engine, ++turnsTaken);
      return first;
    },
    // a claim's answer: one that found nothing puts its engine after those with work for IDLE_MS
    found(engine: string, found: boolean) {
      if (found) emptySince.delete(engine);
      else emptySince.set(engine, now());
    },
  };
}
