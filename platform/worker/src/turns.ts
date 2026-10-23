// A few at a time across the worker, the rest waiting their turn in the order they came: for checks that each take
// every core (a node --test run starts a file per core), where ten at once slow each other down.
export function fewAtOnce(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  // runs `run` once there's room; `waited` hears how long it waited (ms), when it had to
  return async <T>(run: () => Promise<T>, waited?: (ms: number) => void): Promise<T> => {
    const askedAt = Date.now();
    const queued = running >= limit;
    if (queued) await new Promise<void>(go => waiting.push(go));
    else running++;
    try {
      if (queued) waited?.(Date.now() - askedAt);
      return await run();
    } finally {
      // a finished run hands its place straight to the next in line, so a newcomer can't take it first
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
