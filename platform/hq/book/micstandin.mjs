// What book-check.mjs's story files hear: the microphone's stand-in, the recording module answered with one that hears
// at once (kit.mjs re-exports it).

// what the stand-in transcriber answers, where the whole clip goes to it (the live line down)
export const HEARD = 'order the blue mugs';

// The voice note's words on the page, as they're heard, once they show the stand-in voice line's first words (SAID's:
// voice.mjs voiceLine).
export const wordsHeard = page =>
  page.waitForFunction(() => document.querySelector('#book .bk-heard')?.textContent.includes('Make this'), null, {
    timeout: 30_000,
  });
// The microphone's stand-in: the recording module answered with one that hears at once, a tone its microphone (the
// browser's own a tone as well), and its words; dictate.js runs for real on it, over book-check's stand-in voice line.
export async function heard(page) {
  await page.route('**/shell/voice.js', r =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `export const MAX_SECONDS = 1200, TRANSCRIBER = true, canRecord = true;
export function record({ onSegment, stream } = {}) {
  const ctx = new AudioContext(),
    s = { ready: Promise.resolve(), stream: stream ?? toneIn(ctx), level: () => 0.4, seconds: () => 1 };
  s.cancel = () => ctx.close();
  setTimeout(() => onSegment?.(new Blob(['piece'], { type: 'audio/wav' })), 100);
  s.stop = async () => (ctx.close(), new Blob(['clip'], { type: 'audio/webm' }));
  return s;
}
function toneIn(ctx) {
  const tone = ctx.createOscillator(), out = ctx.createMediaStreamDestination();
  tone.connect(out);
  tone.start();
  return out.stream;
}`,
    }),
  );
  await page.addInitScript(() =>
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: async () => {
        window.micsAsked = (window.micsAsked ?? 0) + 1;
        const ctx = new AudioContext(),
          tone = ctx.createOscillator(),
          out = ctx.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        ctx.resume();
        return out.stream;
      },
    }),
  );
  // (and allowed already)
  await page.route('**/__review/micallowed.js', r =>
    r.fulfill({
      contentType: 'text/javascript',
      body: 'export const micAllowed = () => true, micBlocked = () => false, gotStream = () => {};',
    }),
  );
  await page.route('**/api/voice**', r => r.fulfill({ json: { text: HEARD } }));
  await page.addInitScript(() => {
    if (navigator.mediaDevices)
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'mic', label: '' }];
  });
}
