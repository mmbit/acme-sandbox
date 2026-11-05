// The line running behind on a live call (call.js): its pings, and the call screen's Weak connection note.
import { tell } from './alert.js';

const $ = s => document.querySelector(s);
// The line running behind. On a weak connection the microphone's frames back up and reach the line late, in a burst
// (nothing is lost on the way, nor with a dropped connection: sendFrame), and the line waits for them before it answers
// (platform/voice, LATE). Twice a second a ping goes beside the frames, and the line answers how late it came, on HQ's
// monotonic clock against its own. The screen says so while the line hears the board over 1.5 s
// late, nothing has come back from it for 4 s since this connection's first ping, or the frames wait here unsent
// (bufferedAmount, at the 64 kB a second they come to at most), and until 3 s after it caught up; each spell goes in
// the timeline. (How late the line hears, not how long a pong takes: the pongs come back behind the reply's audio,
// which goes out ahead of its playing, so its audio coming counts as the line answering.)
export const PING_MS = 500;
const LAGGING_S = 1.5,
  UNANSWERED_MS = 4000,
  CAUGHT_UP_MS = 3000;
export function lagging(c) {
  const now = performance.now(),
    ws = c.ws;
  if (!c.live || ws?.readyState !== 1) return;
  if (now - (c.pinged ?? -PING_MS) >= PING_MS) {
    c.pinged = now;
    c.heardAt ??= now;
    ws.send(JSON.stringify({ type: 'ping', t: Math.round(now) }));
  }
  const silent = now - c.heardAt,
    behind = Math.max(c.late, ws.bufferedAmount / 64000, silent > UNANSWERED_MS ? silent / 1000 : 0);
  if (behind > LAGGING_S) {
    if (!c.lagAt) c.audio.mark('lagging');
    c.lagAt = now;
    c.lagMax = Math.max(c.lagMax ?? 0, behind);
    c.lagShown = Math.round(behind);
  } else if (c.lagAt && now - c.lagAt > CAUGHT_UP_MS) {
    c.audio.mark('caught up', undefined, c.lagMax);
    c.lagAt = c.lagMax = 0;
  }
  const n = $('#call-net'),
    text = c.lagAt ? `Weak connection: ${c.name} hears you about ${c.lagShown} s late.` : '';
  if (n && n.textContent !== text) {
    tell(n, text);
    n.hidden = !text;
  }
}
