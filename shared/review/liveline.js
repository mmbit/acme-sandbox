// The live line, dictation's words as they're said: the microphone's audio as it's heard, down to 16 kHz PCM, over a
// WebSocket next to the script (<route>dictate, which the coordinator hands to the voice line's recogniser), and all the
// words so far back as each phrase is said. Review mode's post-it records over it (dictation.js), and so does HQ for
// the page in its viewer (platform/hq/shell/dictate.js dictateLive), which loads it from /__review/. No imports.
//
// route: the folder the line is in; ctx and source: the audio context (made at the tap, so Safari lets it run) and the
// microphone's node in it. heard(words): every word so far; over(): the line ended unasked (its five minutes). Returns
// { end(), close() }: end() asks for its last phrase and says whether the line brought the words (if not, the clip has
// them); close() drops it, its last phrase unwaited.
export function liveLine(route, ctx, source, { heard, over }) {
  const ws = opened(route);
  if (!ws) return { end: async () => false, close() {} };
  // failed: closed before its words were all in, or never open. done: its words are all in.
  let failed = false,
    done = false,
    finished;
  const all = new Promise(resolve => (finished = resolve)),
    closed = new Promise(resolve => ws.addEventListener('close', resolve)),
    untap = streaming(ctx, source, ws);
  ws.onmessage = e => {
    const m = said(e.data);
    if (m?.type === 'heard' && typeof m.text === 'string') heard(m.text);
    // (done unasked: the line's five minutes are up, so the mic stops there)
    if (m?.type === 'done') {
      done = true;
      finished(true);
      ws.close();
      over?.();
    }
  };
  ws.onclose = () => {
    untap();
    if (!done) failed = true;
    finished(false);
  };
  ws.onerror = () => (failed = true);
  return {
    // its last phrase: it says done once the words are in (or a few seconds pass)
    async end() {
      const ok = done || (!failed && (await lastPhrase(ws, all)));
      untap();
      // (closed before the clip goes: the coordinator takes one at a time)
      ws.close();
      if (!ok) await Promise.race([closed, new Promise(res => setTimeout(res, 2000))]);
      return ok;
    },
    close() {
      finished(false);
      untap();
      ws.close();
    },
  };
}

// The line's socket, or null where it can't be made
function opened(route) {
  const url = new URL('dictate', route);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  try {
    return Object.assign(new WebSocket(url), { binaryType: 'arraybuffer' });
  } catch {
    return null;
  }
}
// The line asked for its last phrase (a line still connecting once it opens: a mark settles within seconds of its first
// line): whether its words were all in within a few seconds
function lastPhrase(ws, all) {
  const ask = () => ws.send(JSON.stringify({ type: 'end' }));
  if (ws.readyState === WebSocket.OPEN) ask();
  else if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', ask, { once: true });
  return Promise.race([all, new Promise(res => setTimeout(() => res(false), 6000))]);
}
// what the line said, or null
function said(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
// the audio as it's heard, down to 16 kHz PCM, over the line; returns what stops it
function streaming(ctx, source, ws) {
  const tap = ctx.createScriptProcessor(4096, 1, 1),
    mute = ctx.createGain(),
    rate = ctx.sampleRate;
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(ctx.destination);
  let at = 0; // where the next 16 kHz sample falls in the incoming audio
  tap.onaudioprocess = e => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const x = e.inputBuffer.getChannelData(0),
      step = rate / 16000,
      out = new Int16Array(Math.ceil((x.length - at) / step));
    let n = 0;
    for (; at < x.length - 1 && n < out.length; at += step, n++) {
      const i = Math.floor(at),
        v = x[i] + (x[i + 1] - x[i]) * (at - i);
      out[n] = Math.max(-1, Math.min(1, v)) * 0x7fff;
    }
    at -= x.length;
    ws.send(out.subarray(0, n));
  };
  return () => {
    tap.onaudioprocess = null;
    try {
      source.disconnect(tap);
    } catch {
      /* gone */
    }
  };
}
