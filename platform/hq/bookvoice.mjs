// book-check.mjs's board talking to a post-it's mic: on HQ's page over the stand-in voice line (book-check.mjs's
// voiceLine), and from an artifact, a preview in HQ's viewer, through HQ's recording for its frame (shell/framemic.js:
// pieces cut at the pauses, each transcribed by /api/voice). The preview never gets the microphone (the board, call 154):
// every page's and frame's asks for it are counted, window.micsAsked.
import assert from 'node:assert/strict';
import { until } from './bookplayed.mjs';

const ui = s => `review-mode >> css=${s}`;
// What /api/voice hears: the pieces in turn, the whole clip (where no piece was) all of its words
const PIECES = ['Make this', 'headline shorter'];

// c: book-check's { base }. Returns the voice's { pieces } transcribed so far (set it to 0 before a recording)
export async function voiceServed(c, context) {
  const voice = { pieces: 0 };
  // The microphone's voice: quiet, PIECES said with a pause between, then quiet (Chromium's stand-in beeps, which
  // voice.js cuts at no pause; Linux's WebKit has none). voice.js's cutting starts a moment after the voice does (on a
  // loaded worker more than a second), takes the room's level from what it hears first and cuts no piece shorter than
  // 1.5 s: the quiet before the words and the pause between are long
  await context.addInitScript(() => {
    window.micsAsked = 0;
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: async () => {
        window.micsAsked++;
        const ctx = new AudioContext(),
          tone = ctx.createOscillator(),
          gain = ctx.createGain(),
          out = ctx.createMediaStreamDestination(),
          t = ctx.currentTime;
        gain.gain.setValueAtTime(0, t);
        for (const [from, to] of [
          [1.5, 2.3],
          [4.8, 5.6],
        ]) {
          gain.gain.setValueAtTime(0.5, t + from);
          gain.gain.setValueAtTime(0, t + to);
        }
        tone.connect(gain).connect(out);
        tone.start();
        ctx.resume();
        return out.stream;
      },
    });
  });
  await context.route(`${c.base}/api/voice**`, r => {
    const piece = r.request().headers()['content-type'] === 'audio/wav';
    r.fulfill({ json: { text: piece ? (PIECES[voice.pieces++] ?? '') : PIECES.join(' ') } });
  });
  return voice;
}

// The post-it's mic tapped, the words said as they're heard, and tapped again: the mark never started it (the board,
// call 154). on: the page or the preview's frame; pieces: its words come piece by piece as they're said (HQ's recording
// for a frame), the board done talking before it taps again
export async function talked(on, { pieces = false } = {}) {
  const sheet = on.locator(ui('.sheet')),
    mic = sheet.locator('.mic'),
    heard = re => until(async () => re.test(await sheet.locator('textarea').inputValue()), 15_000);
  await sheet.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await mic.evaluate(b => b.classList.contains('on')), false, 'the mark started no recording');
  await mic.click();
  assert.ok(await heard(/^Make this$/), 'the words come as they’re said, once the mic is tapped');
  if (pieces) assert.ok(await heard(/^Make this headline shorter$/), '...and the rest as it’s said');
  await mic.click();
  assert.ok(await heard(/shorter$/), 'tapped again, the last words come in');
}
