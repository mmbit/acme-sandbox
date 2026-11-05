// A few at a time across the worker, the rest waiting their turn in the order they came: for checks that each take
// every core (a node --test run starts a file per core), where ten at once slow each other down. A waiting run whose
// `first` says so as a place frees (urgent work's: the heartbeat's `first`) takes it before those that came earlier;
// the others keep their order among themselves.
export function fewAtOnce(limit: number) {
  let running = 0;
  const waiting: { go: () => void; first?: () => boolean }[] = [];
  // runs `run` once there's room; `waited` hears how long it waited (ms), when it had to
  return async <T>(run: () => Promise<T>, waited?: (ms: number) => void, first?: () => boolean): Promise<T> => {
    const askedAt = Date.now();
    const queued = running >= limit;
    if (queued) await new Promise<void>(go => waiting.push({ go, first }));
    else running++;
    try {
      if (queued) waited?.(Date.now() - askedAt);
      return await run();
    } finally {
      // a finished run hands its place straight to the next in line, so a newcomer can't take it first
      const firstAt = waiting.findIndex(w => w.first?.());
      const [next] = waiting.splice(Math.max(firstAt, 0), 1);
      if (next) next.go();
      else running--;
    }
  };
}

// Waits until `roomy` says there's room, asking every `ms`. While a waiter whose `first` says so waits, the others
// leave the room to it: it takes the room back first.
export function roomInTurn(roomy: () => Promise<boolean>, sleep: (ms: number) => Promise<unknown>, ms: number) {
  const firsts = new Set<object>();
  return async (first: () => boolean) => {
    const me = {};
    try {
      for (;;) {
        const mine = first();
        if (mine) firsts.add(me);
        else firsts.delete(me);
        if ((mine || !firsts.size) && (await roomy())) return;
        await sleep(ms);
      }
    } finally {
      firsts.delete(me);
    }
  };
}
