// Dictation (the desk phone's answer, the notebook's voice note): one recording,
// its pieces transcribed as they come and onWords told the words so far, in order. stop() gives { text, short }: the
// pieces' words, or the whole clip's where a piece failed or nothing was heard; short (under SHORT seconds) sends no
// clip. It fails where the transcriber does. api: the transcriber's address, where it isn't HQ's own (a guest's
// notebook).
import { record } from './voice.js';
import { transcribe } from './data.js';
import { liveLine } from '/__review/liveline.js';

export const SHORT = 0.6;
export function dictate({ lang = 'en', api, onWords }) {
  const parts = [],
    pending = [];
  let failed = false,
    cancelled = false;
  const words = () => parts.filter(Boolean).join(' ').trim();
  const rec = record({
    lang,
    onSegment: clip => {
      const i = parts.push('') - 1;
      pending.push(
        transcribe(clip, lang, api).then(
          text => {
            parts[i] = text;
            if (!cancelled) onWords?.(words());
          },
          () => {
            failed = true;
          },
        ),
      );
    },
  });
  return {
    ready: rec.ready,
    level: rec.level,
    seconds: rec.seconds,
    cancel: () => {
      cancelled = true;
      rec.cancel();
    },
    async stop() {
      const short = rec.seconds() < SHORT,
        clip = await rec.stop();
      await Promise.all(pending);
      if ((!words() || failed) && clip && !short)
        return { text: ((await transcribe(clip, lang, api)) || '').trim(), short };
      return { text: words(), short };
    },
  };
}

// Dictation as it's said, review mode's post-it in the viewer (framemic.js): the audio goes over the live line as it's
// heard, as on HQ's own post-it (shared/review/liveline.js), and onWords hears every word so far, phrase by phrase, a
// moment after each is said; over() the line's end unasked (its five minutes). The same { ready, level, cancel, stop }
// as dictate's; where the line can't be had (or drops), stop() has the whole clip transcribed. Called in the tap: the
// line's audio context is made there, so Safari lets it run.
export function dictateLive({ lang = 'en', onWords, over }) {
  const AC = window.AudioContext || window.webkitAudioContext,
    ctx = AC ? new AC() : null;
  const rec = record({ lang });
  let line = null,
    said = '',
    cancelled = false;
  const ready = rec.ready.then(() => {
    if (!ctx || cancelled) return;
    ctx.resume?.();
    line = liveLine(new URL('/__review/', location.href), ctx, ctx.createMediaStreamSource(rec.stream), {
      heard: text => {
        said = text.trim();
        if (!cancelled) onWords?.(said);
      },
      over: () => !cancelled && over?.(),
    });
  });
  return {
    ready,
    level: rec.level,
    seconds: rec.seconds,
    cancel: () => {
      cancelled = true;
      line?.close();
      rec.cancel();
      ctx?.close?.();
    },
    async stop() {
      const short = rec.seconds() < SHORT,
        clip = await rec.stop(),
        live = !!line && (await line.end());
      ctx?.close?.();
      if (live || short || !clip) return { text: said, short };
      return { text: ((await transcribe(clip, lang)) || '').trim(), short };
    },
  };
}
