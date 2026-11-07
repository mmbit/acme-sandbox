// A few at a time across the worker, the rest waiting their turn in the order they came: for checks that each take
// every core (a node --test run starts a file per core), where ten at once slow each other down. A waiting run whose
// `first` says so as a place frees (urgent work's: the heartbeat's `first`) takes it before those that came earlier;
// the others keep their order among themselves.
export function fewAtOnce(limit: number) {
  let running = 0;
  const waiting: { go: () => void; first?: () => boolean; job?: number }[] = [];
  const holders = new Set<number>();
  // runs `run` once there's room; `waited` hears how long it waited (ms), when it had to
  const take = async <T>(
    run: () => Promise<T>,
    waited?: (ms: number) => void,
    first?: () => boolean,
    job?: number,
  ): Promise<T> => {
    const askedAt = Date.now();
    const queued = running >= limit;
    if (queued) await new Promise<void>(go => waiting.push({ go, first, job }));
    else running++;
    if (job !== undefined) holders.add(job);
    try {
      if (queued) waited?.(Date.now() - askedAt);
      return await run();
    } finally {
      if (job !== undefined) holders.delete(job);
      // a finished run hands its place straight to the next in line, so a newcomer can't take it first
      const firstAt = waiting.findIndex(w => w.first?.());
      const [next] = waiting.splice(Math.max(firstAt, 0), 1);
      if (next) next.go();
      else running--;
    }
  };
  const waits = () =>
    waiting.flatMap(waiter =>
      waiter.job === undefined
        ? []
        : [...holders].filter(on => on !== waiter.job).map(on => ({ job: waiter.job!, on })),
    );
  return Object.assign(take, { waits });
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

// One read at a time, on a timer and once more at the end: a tick while one is under way leaves it to that one; `last`
// waits for the one under way and then reads once more, so no read outlives its caller (a run's lines, runJobIn: their
// git runs as the session's uid, which checksPlace clears).
export function oneAtATime(read: () => Promise<void>) {
  let under: Promise<void> | undefined;
  const tick = async () => {
    if (under) return;
    under = read();
    try {
      await under;
    } finally {
      under = undefined;
    }
  };
  const last = async () => {
    while (under) await under;
    await tick();
  };
  return { tick, last };
}
