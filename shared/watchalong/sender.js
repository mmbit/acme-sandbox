// The watch-along's sender: a recording page's events to the store, in batches (watchalong.js records them). README.md
// has the design.

// A batch goes once a second, or sooner once this many events wait (a full snapshot is one big event)
export const FLUSH_MS = 1000,
  BATCH_EVENTS = 200;
// A post holds at most what the store takes in one batch (store.ts BATCH_BYTES). A page holds what the server hasn't
// taken up to about three minutes of HQ with canvas frames (2.9 MB a minute as posted, measured), then gives up.
const BATCH_BYTES = 8 << 20,
  HELD_BYTES = 8 << 20;
// The store's answers that end a watch-along, and why: 404 unknown, 409 over, 413 an event too large to post, 507 full
const ENDINGS = { 404: 'over', 409: 'over', 413: 'too big', 507: 'full' };

// The page's events to the store, one post on its way at a time: once a second, or sooner once BATCH_EVENTS wait.
// What the server hasn't taken goes again with the next. onEnd(why) once the server says it's over or stays out of reach,
// onSeen(seen) as it says whether the agent sees the page: with nothing to send (a quiet page, or paused) an empty batch
// still asks, so the page hears it all the same.
export function sender(url, onEnd, onSeen) {
  let waiting = [],
    held = [],
    inFlight = null;
  const send = async leaving => {
    held = [...held, ...waiting];
    waiting = [];
    do {
      const batch = firstBatch(held);
      const { status, seen } = batch.length || !held.length ? await post(url, batch, leaving) : { status: 413 };
      if (status !== 200) return refused(status);
      if (typeof seen === 'boolean') onSeen(seen);
      held = held.slice(batch.length);
    } while (held.length);
  };
  const refused = status => {
    if (ENDINGS[status]) onEnd(ENDINGS[status]);
    else if (bytesOf(JSON.stringify(held)) > HELD_BYTES) onEnd('unreachable');
  };
  const flush = (leaving = false) => (inFlight ??= send(leaving).finally(() => (inFlight = null)));
  const tick = setInterval(flush, FLUSH_MS);
  const leave = () => flush(true);
  addEventListener('pagehide', leave);
  return {
    push: event => waiting.push(event) >= BATCH_EVENTS && flush(),
    // everything recorded so far, sent
    drain: async () => {
      await inFlight;
      await flush();
    },
    close() {
      clearInterval(tick);
      removeEventListener('pagehide', leave);
    },
  };
}

// The first events, in order, that one post can hold: none when the first alone is past BATCH_BYTES
function firstBatch(events) {
  let bytes = bytesOf('{"events":[]}');
  const batch = [];
  for (const event of events) {
    bytes += bytesOf(JSON.stringify(event)) + 1;
    if (bytes > BATCH_BYTES) break;
    batch.push(event);
  }
  return batch;
}
const bytesOf = text => new TextEncoder().encode(text).length;

// A batch to the store: its answer's status (0 when the network failed) and seen. One leaving the page goes with
// keepalive, which the browser caps at 64 KB.
async function post(url, events, leaving) {
  const body = JSON.stringify({ events });
  try {
    const answer = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: leaving && bytesOf(body) < 60_000,
    });
    const said = answer.ok ? await answer.json().catch(() => ({})) : {};
    return { status: answer.status, seen: said?.seen };
  } catch {
    return { status: 0 };
  }
}
