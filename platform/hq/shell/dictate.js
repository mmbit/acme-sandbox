// Dictation (the desk phone's answer, the notebook's voice note, review mode's post-it in the viewer): one recording,
// its pieces transcribed as they come and onWords told the words so far, in order. stop() gives { text, short }: the
// pieces' words, or the whole clip's where a piece failed or nothing was heard; short (under SHORT seconds) sends no
// clip. It fails where the transcriber does. api: the transcriber's address, where it isn't HQ's own (a guest's
// notebook).
import { record } from './voice.js';
import { transcribe } from './data.js';

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
