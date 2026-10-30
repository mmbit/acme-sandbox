// The small model's calls of one kind made as they come (worker.ts readLoop): each call claimed starts at once and the
// next is claimed straight after, up to atOnce in flight, so no call waits for another to answer (the book's judge never
// waits behind the board's handwriting being read). With nothing due, or atOnce in flight, it looks again after idleMs
// or as a call ends.
export async function callsAsTheyCome(o: {
  claim: () => Promise<false | { answered: Promise<unknown> }>; // a call claimed, going; false when none was due
  atOnce: number;
  idleMs: number;
  going: () => boolean;
  sleep: (ms: number) => Promise<unknown>;
  failed: (err: unknown) => void;
}) {
  const calls = new Set<Promise<unknown>>();
  while (o.going()) {
    if (calls.size >= o.atOnce) {
      await Promise.race(calls);
      continue;
    }
    const call = await o.claim().catch(err => {
      o.failed(err);
      return false as const;
    });
    if (!call) {
      await Promise.race([o.sleep(o.idleMs), ...calls]);
      continue;
    }
    const answering: Promise<unknown> = call.answered.catch(o.failed).finally(() => calls.delete(answering));
    calls.add(answering);
  }
}
