// The small model's calls of one kind made as they come (worker.ts readLoop): each call claimed starts at once and the
// next is claimed straight after, up to atOnce in flight, so no call waits for another to answer: one at a time, the
// book's judge waited its turn behind the board's handwriting being read (29 Oct: 10-11.5 s from a note's save to its
// verdict, 4.4 s for one with nothing ahead). With nothing due, or atOnce in flight, it looks again after idleMs or as a
// call ends.
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
    const going: Promise<unknown> = call.answered.catch(o.failed).finally(() => calls.delete(going));
    calls.add(going);
  }
}
