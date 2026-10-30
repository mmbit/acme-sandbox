// book-check.mjs's board talking to a post-it's mic: on HQ's page over the stand-in voice line, and from an artifact, a
// preview in HQ's viewer, through HQ's recording for its frame over the same line (shell/framemic.js). The preview never gets the microphone (the board, call 154): every page's and frame's asks
// for it are counted, window.micsAsked.
import assert from 'node:assert/strict';
import { ui, until } from './bookkit.mjs';

// The board's words: said in two pieces with a pause between
const PIECES = ['Make this', 'headline shorter'];
export const SAID = PIECES.join(' ');
let hushed = false,
  // the pieces /api/voice has transcribed in this recording
  piecesHeard = 0;
// /api/voice's asks counted, their answers (and the voice line's last words) kept waiting while held is set
// (booktalk.mjs's askLeftBehind). A gate on
// voiceServed's one route, not a page route of its own: one removed while HQ's uploads still come lets Playwright send
// them on to the network, and its handler then hands them to this route, which answers them a second time (Route is
// already handled).
export const transcriber = { held: null, sent: 0 };

// The stand-in voice line on HQ's page (book-check.mjs's /__review/dictate): the first piece comes as the microphone's
// audio does, all the words when it ends (hush(true): the board says nothing)
export function voiceLine(ws) {
  let frames = 0,
    said = 0;
  ws.onMessage(m => {
    if (typeof m !== 'string') {
      frames += m.length;
      if (!hushed && said < 1 && frames > 16000)
        ws.send(JSON.stringify({ type: 'heard', text: PIECES[said++], partial: true }));
      return;
    }
    if (JSON.parse(m).type !== 'end') return;
    // (its last words kept waiting while transcriber.held is set: booktalk.mjs's askLeftBehind; the line may be gone by
    // then)
    Promise.resolve(transcriber.held).then(() => {
      try {
        ws.send(JSON.stringify({ type: 'heard', text: hushed ? '' : SAID, partial: false }));
        ws.send(JSON.stringify({ type: 'done' }));
      } catch {
        /* closed */
      }
    });
  });
}
export const hush = on => (hushed = on);
// A recording's pieces counted from its first again (talked() starts so; booktalk.mjs's talkedInViewer too)
export const piecesAfresh = () => (piecesHeard = 0);

// The microphone and /api/voice for a preview's frame: HQ's recording, each piece it cuts transcribed in turn, the
// whole clip (where no piece was) all the words. c: book-check's { base }
export async function voiceServed(c, context) {
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
  await context.route(`${c.base}/api/voice**`, async r => {
    transcriber.sent++;
    await transcriber.held;
    const piece = r.request().headers()['content-type'] === 'audio/wav';
    await r.fulfill({ json: { text: piece ? (PIECES[piecesHeard++] ?? '') : SAID } });
  });
}

// The post-it's mic tapped, the words said as they're heard, and tapped again: the mark never started it (the board,
// call 154). on: the page or the preview's frame; pieces: its words come piece by piece as they're said (HQ's recording
// for a frame), the board done talking before it taps again
export async function talked(on, { pieces = false } = {}) {
  const sheet = on.locator(ui('.sheet')),
    mic = sheet.locator('.mic'),
    heard = (re, what) => until(async () => re.test(await sheet.locator('textarea').inputValue()), what);
  piecesAfresh();
  await sheet.waitFor({ state: 'visible' });
  assert.equal(await mic.evaluate(b => b.classList.contains('on')), false, 'the mark started no recording');
  await mic.click();
  await heard(/^Make this$/, 'the words coming as they’re said, once the mic is tapped');
  // (piece by piece, the last piece comes before the mic's tapped again: on the voice line, after)
  if (pieces) await heard(/^Make this headline shorter$/, '...and the rest as it’s said');
  await mic.click();
  if (!pieces) await heard(/shorter$/, 'the last words coming in, the mic tapped again');
}
