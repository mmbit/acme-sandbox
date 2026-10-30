// Dictation: the mic button taps to talk, taps to stop (a mark never starts it). The words come as they're
// said, as on a call: the microphone's audio goes as it's heard, 16 kHz PCM, over a WebSocket next to the script
// (/__review/dictate, which the coordinator hands to the voice line's recogniser), and each phrase's words come back
// while the board talks, into the note. The clip is recorded too: where that line can't be reached (or drops), the whole
// clip is transcribed by the coordinator's speech-to-text (POST /__review/voice). In HQ's viewer the page's frame has no
// microphone, so HQ records for it, the same way, at the board's tap on HQ's own mic key laid over this one (hqmic.js).
import { ACCENT } from './base.js';
import { gotStream } from './micallowed.js';
import { liveLine } from './liveline.js';
import { askHq, endHq, setupHqMic } from './hqmic.js';

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
    gotStream();
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
// The live line: its words replace what it said before in the note, after the words that were there already
function live(r, rec, source) {
  rec.line = liveLine(r.ROUTE, rec.ctx, source, {
    heard: text => (r.rec === rec || (rec.ending && !rec.cancelled)) && words(r, rec, text),
    over: () => r.rec === rec && stopMic(r),
  });
}
// The heard words past the ones the note held when the reviewer last typed (a look's words revised since: past the
// ones both share, a word the recogniser only recased or repunctuated still the same one), after the reviewer's own,
// where their caret stays
const plain = w => w.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function words(r, rec, heard) {
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
  rec.finished?.(null); // (HQ's recording, hqmic.js, isn't waited for either)
  rec.line?.close();
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
  rec.ending = true; // (its last words still come in)
  const liveOk = !!rec.line && !rec.cancelled && (await rec.line.end());
  rec.ending = false;
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

export function setupDictation(r) {
  r.rec = null;
  r.stopping = null;
  r.endingRec = null;
  if (!canRecord) {
    r.mic.disabled = true;
    r.mic.title = 'This browser can’t record here';
  }
  r.mic.onclick = () => (r.rec ? stopMic(r) : startMic(r));
  if (r.framed) setupHqMic(r);
}
