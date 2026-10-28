// Dictation: the mic button taps to talk, taps to stop (a mark never starts it: the board, call 154). The words come as they're
// said, as on a call: the microphone's audio goes as it's heard, 16 kHz PCM, over a WebSocket next to the script
// (/__review/dictate, which the coordinator hands to the voice line's recogniser), and each phrase's words come back
// while the board talks, into the note. The clip is recorded too: where that line can't be reached (or drops), the whole
// clip is transcribed by the coordinator's speech-to-text (POST /__review/voice). In HQ's viewer the page's frame has no
// microphone, so HQ records for it (askHq).
import { ACCENT } from './base.js';

export const CSS = `
      .mic { position: relative; width: 52px; height: 52px; border-radius: 50%; background: #2b2230; color: #fff; display: grid; place-items: center; flex: none; }
      .mic svg { width: 24px; height: 24px; position: relative; }
      .mic::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: ${ACCENT}; transform: scale(var(--lvl, 0)); opacity: .45; transition: transform .08s; }
      .mic.on { background: ${ACCENT}; } .mic.on::before { transform: scale(calc(1 + var(--lvl, 0))); }
      .mic.busy { animation: spin 1s linear infinite; background: conic-gradient(${ACCENT}, #2b2230); }
      @keyframes spin { to { transform: rotate(1turn) } }
      .mic[disabled] { opacity: .35; cursor: default; }`;

const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
export const canRecord = !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

// r.rec: the recording under way (heard in the board's language, which the coordinator reads). ctx: an audio context
// made at an earlier gesture (pentouch.js: the pen's touch, the mic asked for only once it draws or holds.)
export async function startMic(r, ctx = audioContext()) {
  if (r.framed) {
    ctx?.close?.();
    return askHq(r);
  }
  const rec = (r.rec = { chunks: [], said: r.text.value.trim(), shown: [], taken: [], ctx });
  // What the reviewer types meanwhile stays: the words in the note then are theirs, and only words heard after go in
  rec.typed = () => {
    rec.said = r.text.value;
    rec.taken = rec.shown;
    rec.edited = true;
  };
  r.text.addEventListener('input', rec.typed);
  r.mic.classList.add('on');
  r.msg.textContent = 'Listening… tap the mic to stop';
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    if (r.rec !== rec) {
      rec.stream.getTracks().forEach(t => t.stop());
      return; // (endMic, which took r.rec, closes the context)
    }
    const type = TYPES.find(t => MediaRecorder.isTypeSupported?.(t));
    rec.mr = new MediaRecorder(rec.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    rec.mr.ondataavailable = e => e.data.size && rec.chunks.push(e.data);
    rec.mr.start(1000);
    rec.t0 = performance.now();
    rec.limit = setTimeout(() => r.rec === rec && stopMic(r), 300_000); // (the voice line's five minutes)
    if (!rec.ctx) return;
    rec.ctx.resume?.();
    const source = rec.ctx.createMediaStreamSource(rec.stream);
    breathing(r, rec, source);
    live(r, rec, source);
  } catch (err) {
    if (r.rec === rec) {
      r.rec = null;
      r.mic.classList.remove('on');
      rec.ctx?.close?.();
      r.text.removeEventListener('input', rec.typed);
    }
    r.msg.textContent =
      err?.name === 'NotAllowedError'
        ? 'The microphone is blocked for this page. Type the note instead?'
        : 'Could not start the microphone.';
  }
}
// The audio context, made at the tap, so Safari lets it run
export const audioContext = () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  return AC ? new AC() : null;
};
// the mic button breathes with the voice
function breathing(r, rec, source) {
  const an = rec.ctx.createAnalyser(),
    buf = new Uint8Array(256);
  source.connect(an);
  an.fftSize = 256;
  const tick = () => {
    if (r.rec !== rec) return r.mic.style.setProperty('--lvl', 0);
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += (v - 128) ** 2;
    r.mic.style.setProperty('--lvl', Math.min(0.6, Math.sqrt(s / buf.length) / 30).toFixed(2));
    requestAnimationFrame(tick);
  };
  tick();
}
// The live line: its words replace what it said before in the note, after the words that were there already.
// rec.live: open while it carries the words, 'failed' once it can't (the clip then does)
function live(r, rec, source) {
  const url = new URL('dictate', r.ROUTE);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    rec.live = 'failed';
    return;
  }
  ws.binaryType = 'arraybuffer';
  rec.live = ws;
  rec.done = new Promise(resolve => (rec.finished = resolve));
  rec.closed = new Promise(resolve => ws.addEventListener('close', resolve));
  streaming(rec, ws, source);
  ws.onmessage = e => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    const wanted = r.rec === rec || (rec.ending && !rec.cancelled);
    if (m.type === 'heard' && typeof m.text === 'string' && wanted) words(r, rec, m.text);
    // (done unasked: the line's five minutes are up, so the mic stops there)
    if (m.type === 'done') {
      rec.liveDone = true;
      rec.finished(true);
      ws.close();
      if (r.rec === rec) stopMic(r);
    }
  };
  // (closed before its words were all in: the clip has them)
  ws.onclose = () => {
    rec.untap();
    if (rec.live === ws && !rec.liveDone) rec.live = 'failed';
    rec.finished(false);
  };
  ws.onerror = () => (rec.live = 'failed');
}
// the audio as it's heard, down to 16 kHz PCM, over the line
function streaming(rec, ws, source) {
  const tap = rec.ctx.createScriptProcessor(4096, 1, 1),
    mute = rec.ctx.createGain(),
    rate = rec.ctx.sampleRate;
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(rec.ctx.destination);
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
  rec.untap = () => {
    tap.onaudioprocess = null;
    try {
      source.disconnect(tap);
    } catch {
      /* gone */
    }
  };
}
// The heard words past the ones the note held when the reviewer last typed (a look's words revised since: past the
// ones both share, a word the recogniser only recased or repunctuated still the same one), after the reviewer's own,
// where their caret stays
const plain = w => w.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function words(r, rec, heard) {
  const said = heard.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < rec.taken.length && plain(said[i] ?? '') === plain(rec.taken[i])) i++;
  const fresh = said.slice(i).join(' ');
  rec.shown = said;
  r.spoken ||= said.length > 0; // (how a note's words came, for the book)
  rec.heard = true;
  if (rec.edited && !fresh) return;
  const { text } = r,
    { selectionStart: from, selectionEnd: to } = text,
    typing = r.root.activeElement === text;
  text.value = [rec.said.trimEnd(), fresh].filter(Boolean).join(' ');
  if (typing) text.setSelectionRange(from, to);
  else text.scrollTop = text.scrollHeight;
}
// One stop at a time: r.stopping is the running one, so Pin it can wait for its words, and r.endingRec its recording,
// so a cancel meanwhile still drops them (its last words would land in the next note).
export function stopMic(r, cancel) {
  if (!r.rec) {
    if (cancel && r.endingRec) dropped(r.endingRec);
    return r.stopping ?? Promise.resolve();
  }
  const rec = (r.endingRec = r.rec);
  if (cancel) dropped(rec);
  const p = (r.stopping = endMic(r, rec).finally(() => r.text.removeEventListener('input', rec.typed)));
  return p.finally(() => r.stopping === p && (r.stopping = r.endingRec = null));
}
// A cancelled recording: no word of it goes in, and the line's last phrase isn't waited for
function dropped(rec) {
  rec.cancelled = true;
  rec.finished?.(null); // (HQ's recording, askHq, isn't waited for either)
  if (rec.live && rec.live !== 'failed') rec.live.close();
}
async function endMic(r, rec) {
  if (rec.hq) return endHq(r, rec);
  const m = r.mark;
  r.rec = null;
  clearTimeout(rec.limit);
  r.mic.classList.remove('on');
  const clip = await new Promise(res => {
    if (!rec.mr || rec.mr.state === 'inactive' || rec.cancelled) {
      try {
        rec.mr?.stop();
      } catch {
        /* stopped */
      }
      return res(null);
    }
    rec.mr.onstop = () => res(new Blob(rec.chunks, { type: rec.mr.mimeType || 'audio/webm' }));
    rec.mr.stop();
  });
  rec.stream?.getTracks().forEach(t => t.stop());
  const liveOk = await lastPhrase(rec);
  rec.ending = false;
  rec.untap?.();
  rec.ctx?.close?.();
  if (rec.cancelled) return;
  if (liveOk) {
    r.msg.textContent = rec.heard
      ? 'Check the words, then pin it.'
      : 'No words came through. Try again, a little closer?';
    return;
  }
  if (!clip) return;
  if (performance.now() - rec.t0 < 600 || clip.size < 200) {
    r.msg.textContent = 'That was very short. Tap, talk, then tap again.';
    return;
  }
  await transcribed(r, rec, clip, m);
}
// the live line's last phrase: it says done once the words are in (or a few seconds pass); whether it brought them
async function lastPhrase(rec) {
  let liveOk = !!rec.liveDone && !rec.cancelled;
  if (!liveOk && rec.live && rec.live !== 'failed' && !rec.cancelled) {
    rec.ending = true; // (its last words still come in)
    // (a line still connecting is asked once it opens: a mark settles within seconds of its first line.)
    const ws = rec.live,
      end = () => ws.send(JSON.stringify({ type: 'end' }));
    if (ws.readyState === WebSocket.OPEN) end();
    else if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', end, { once: true });
    liveOk = await Promise.race([rec.done, new Promise(res => setTimeout(() => res(false), 6000))]);
  }
  // (closed before the clip goes: the coordinator takes one at a time)
  if (rec.live && rec.live !== 'failed') rec.live.close();
  if (rec.closed && !liveOk && !rec.cancelled)
    await Promise.race([rec.closed, new Promise(res => setTimeout(res, 2000))]);
  return liveOk;
}
// the whole clip, transcribed next to the script
async function transcribed(r, rec, clip, m) {
  r.mic.classList.add('busy');
  r.mic.disabled = true;
  r.pinIt.disabled = true;
  r.msg.textContent = 'Turning your words into text…';
  try {
    const res = await fetch(new URL('voice', r.ROUTE), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': clip.type || 'audio/webm' },
      body: clip,
    });
    if (!res.ok) throw res.status;
    const said = ((await res.json()).text || '').trim();
    if (r.mark !== m) return; // that note was cancelled meanwhile (finally still frees the mic)
    if (said) {
      words(r, rec, said);
      r.msg.textContent = 'Check the words, then pin it.';
    } else r.msg.textContent = 'No words came through. Try again, a little closer?';
  } catch (code) {
    r.msg.textContent =
      code === 413
        ? 'That was too long for one go: try it in two.'
        : code === 429
          ? 'The transcriber is busy with this page. Type this one instead?'
          : 'The transcriber isn’t available right now. Type it instead?';
  } finally {
    r.mic.classList.remove('busy');
    r.mic.disabled = false;
    if (r.mode === 'note') r.pinIt.disabled = false;
  }
}

// ---- in HQ's viewer: HQ's page records (its framemic.js), and its words come back here as they're heard. rec.hq: the
// recording's number, so a word from an earlier one is never taken for this one's.
let asked = 0;
function askHq(r) {
  const rec = (r.rec = { hq: ++asked, said: r.text.value.trim(), shown: [], taken: [] });
  rec.typed = () => {
    rec.said = r.text.value;
    rec.taken = rec.shown;
    rec.edited = true;
  };
  rec.done = new Promise(resolve => (rec.finished = resolve));
  r.text.addEventListener('input', rec.typed);
  r.mic.classList.add('on');
  r.msg.textContent = 'Listening… tap the mic to stop';
  r.toHq({ mic: 'start', id: rec.hq });
}
// HQ's answers: the words so far, the voice's level, the mic refused, or the words once it's stopped
function fromHq(r, e) {
  const m = e.data?.mic;
  if (e.source !== parent || e.origin !== r.HQ || e.data?.hq !== 'hq' || !m) return;
  const rec = [r.rec, r.endingRec].find(x => x?.hq && x.hq === m.id);
  if (!rec || rec.cancelled) return;
  if (typeof m.heard === 'string') words(r, rec, m.heard);
  if (typeof m.level === 'number' && r.rec === rec) r.mic.style.setProperty('--lvl', Math.min(0.6, m.level).toFixed(2));
  if (m.failed && r.rec === rec) {
    r.rec = null;
    r.mic.classList.remove('on');
    r.text.removeEventListener('input', rec.typed);
    r.msg.textContent =
      m.failed === 'NotAllowedError'
        ? 'The microphone is blocked for HQ. Type the note instead?'
        : 'Could not start the microphone.';
  }
  if ('done' in m) rec.finished(m);
}
async function endHq(r, rec) {
  r.rec = null;
  r.mic.classList.remove('on');
  r.mic.style.setProperty('--lvl', 0);
  r.toHq({ mic: rec.cancelled ? 'cancel' : 'stop', id: rec.hq });
  if (rec.cancelled) return;
  const m = r.mark;
  r.mic.classList.add('busy');
  r.mic.disabled = true;
  r.msg.textContent = 'Turning your words into text…';
  const end = await Promise.race([rec.done, new Promise(res => setTimeout(() => res(null), 60_000))]);
  r.mic.classList.remove('busy');
  r.mic.disabled = false;
  if (rec.cancelled || r.mark !== m) return;
  if (end?.done) words(r, rec, end.done);
  r.msg.textContent = end?.done
    ? 'Check the words, then pin it.'
    : end?.why === 'short'
      ? 'That was very short. Tap, talk, then tap again.'
      : end?.why === 'transcriber' || !end
        ? 'The transcriber isn’t available right now. Type it instead?'
        : 'No words came through. Try again, a little closer?';
}

export function setupDictation(r) {
  r.rec = null;
  r.stopping = null;
  r.endingRec = null;
  if (r.framed) addEventListener('message', e => fromHq(r, e));
  if (!canRecord) {
    r.mic.disabled = true;
    r.mic.title = 'This browser can’t record here';
  }
  r.mic.onclick = () => (r.rec ? stopMic(r) : startMic(r));
}
