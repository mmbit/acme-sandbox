#!/usr/bin/env node
// A call on HQ's own call screen against a stand-in voice line: the frames a real reply sent (recorded by
// platform/voice/line_check.py, sent here at the times the voice line sent them), played through HQ's own play(), and
// what HQ tells the voice line at hang-up. Checks: every frame plays right after the one before inside a sentence (no
// overlap, no gap), the playback numbers reach the line with the bye, frames coming slower than they play count as
// stutters, and a pause before a sentence or a tick doesn't. And when the call's audio context stops mid-reply
// (suspended, or its clock stuck while it says it's running), the <audio> element pauses, so Safari has nothing to loop,
// and plays again once the clock moves; the bye counts the stall. A pause that cancels the element's play() before it
// started (the context stopped right at the call's start) leaves the call on the stream, not on direct audio. The bye
// carries the playback's timeline: each sentence and tick as it starts, when the voice ran dry, each stall and how long,
// and a clock running slower than real time; a sentence cut by Skip before it started isn't in it. Once a reply has
// played out, the stream still gets audio (silence), so Safari has nothing to loop between replies either (Chromium
// only: it reads the stream's track). Pictures the board attaches or pastes on the call reach the line, and the strip
// shows how far each got. A notice from the line (its agent can't answer) shows apart from the words while the call is
// up, and goes with the call. Back from the screen going off, the call asks for the screen's wake lock again, also when
// a pending request was refused as the page hid, and replaces a microphone left muted or ended. The first request comes
// before the microphone starts, while the tap still counts. Dialling with a microphone that comes muted, the call gets a
// new one; one that hears only exact silence, it says so and tries a new one, and goes on hearing whichever it has. A
// stopped audio clock asks for a tap if it cannot wake itself.
// A new call clears the last one's status, hanging up adds no line, and the ON AIR sign lights while the board or the
// agent speaks, never for the line's tick. A line that doesn't go through shows as an error until the board types again.
//   node platform/hq/call-check.mjs <frames.json>          (BROWSER=webkit for Safari's engine)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const { chromium, webkit } = playwright();
const frames = JSON.parse(readFileSync(process.argv[2], 'utf8')); // [[seconds after the reply started, base64 PCM16, sentence]]
const server = await serve(), base = `http://localhost:${server.address().port}`;
const browser = process.env.BROWSER === 'webkit' ? await webkit.launch()
  : await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function call(slow, stall) {
  let sent = null, first = null, skipped = false, said = 0;
  const { context, page, errors } = await callPage();
  if (stall?.how === 'start') await context.addInitScript(() => { window.pauseFirstPlay = true; });
  // each frame HQ schedules: when it starts and how long it is, on the call's AudioContext clock
  await context.addInitScript(() => {
    window.scheduled = []; window.contexts = []; window.speaker = [];
    const AC = window.AudioContext;
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.contexts.push(this); } };
    // (the call's <audio> element: whether it's paused, sampled through the call)
    setInterval(() => { const el = window.lastSpeaker; if (el) window.speaker.push([performance.now(), el.paused]); }, 50);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.srcObject) window.lastSpeaker = this;
      const p = play.call(this);
      // (the first play() paused before it starts, as follow() does when the context stops at the call's start)
      if (this.srcObject && window.pauseFirstPlay) { window.pauseFirstPlay = false; this.pause(); }
      return p;
    };
    // (what reaches the call's stream: when each chunk of audio the context rendered into it came, read from a clone of
    // its track; Chromium only, WebKit has no MediaStreamTrackProcessor for audio)
    window.fed = [];
    const destination = AC.prototype.createMediaStreamDestination;
    AC.prototype.createMediaStreamDestination = function (...a) {
      const node = destination.apply(this, a);
      if (window.MediaStreamTrackProcessor) (async () => {
        const chunks = new MediaStreamTrackProcessor({ track: node.stream.getAudioTracks()[0].clone() }).readable.getReader();
        for (let r; !(r = await chunks.read()).done;) { window.fed.push(performance.now()); r.value.close(); }
      })();
      return node;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
      if (this.buffer?.sampleRate === 16000) window.scheduled.push([when, this.buffer.duration]);
      return start.call(this, when, ...rest);
    };
  });
  let bye = null;
  const mic = []; // (the microphone's frames, and the agent's voice beside them while it plays)
  await context.routeWebSocket(/\/voice\/ws$/, ws => {
    ws.onMessage(async m => {
      if (typeof m !== 'string') return void mic.push(Buffer.from(m));
      const e = JSON.parse(m);
      if (e.type === 'bye') return void (bye = e);
      if (e.type === 'interrupt') return void (skipped = true); // (the line stops the reply)
      if (!e.agent) return;
      ws.send(JSON.stringify({ type: 'call', id: 'line', call: 1 }));
      if (stall?.how === 'notice') ws.send(JSON.stringify({ type: 'notice', text: NOTICE }));
      ws.send(JSON.stringify({ type: 'state', state: 'speaking' }));
      const t0 = Date.now();
      let at = 0, late = 0;
      for (const [i, [t, pcm, sentence]] of frames.entries()) {
        if (skipped) break;
        const pcm16 = Buffer.from(pcm, 'base64'), starts = i === 0 || !sentence || sentence !== frames[i - 1][2]; // (a tick is one frame)
        // (slow.pace: from frame `from` on, each frame takes `pace` times its own length to come, as from a line that
        // fell behind; slow.pause: each sentence comes that many ms later than the line sent it, as after a tool step)
        if (starts && slow?.pause) late += slow.pause;
        at = slow?.pace && i > slow.from ? at + pcm16.length / 2 / 16 * slow.pace : t * 1000 + late;
        await new Promise(r => setTimeout(r, Math.max(0, at - (Date.now() - t0))));
        // (as the line does before a sentence's audio, or a tick: a frame of no sentence)
        if (starts) { ws.send(JSON.stringify(sentence ? { type: 'said', text: sentence } : { type: 'tick' })); said += !!sentence; }
        ws.send(pcm16); first ??= Date.now();
      }
      sent = Date.now() - t0;
    });
  });
  await page.goto(`${base}/?intro=0&open=intercom`);
  await page.click('#call');
  let stalled = null, cut = null, noted = null;
  if (stall?.how === 'notice') { // the call screen as the board sees it while the line says it
    while (first === null) await page.waitForTimeout(20);
    await page.waitForTimeout(1500);
    noted = await page.evaluate(() => { const n = document.querySelector('#call-note'); return { text: n.textContent, shown: !n.hidden && n.offsetHeight > 0 }; });
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  } else if (stall?.how === 'skip') { // the board presses Skip as soon as the line has sent stall.said sentences
    while (said < stall.said) await page.waitForTimeout(5);
    await page.click('#call-skip');
    cut = said;
  } else if (stall && stall.how !== 'start') { // the call's context stops for stall.for ms, stall.at ms into the reply: suspended
    // (as iOS does it, refusing to resume until then: the call tries on every tick), or its clock stuck
    while (first === null) await page.waitForTimeout(20);
    await page.waitForTimeout(stall.at);
    const t0 = await page.evaluate(how => {
      const c = window.contexts.at(-1);
      const t = c.currentTime, p = performance.now(); // (slow: the clock moves at half speed)
      if (how === 'suspend') {
        c.resumeLater = c.resume.bind(c);
        c.resume = () => Promise.reject(new DOMException('Audio interrupted', 'NotAllowedError'));
        c.suspend();
      } else Object.defineProperty(c, 'currentTime', { get: () => how === 'slow' ? t + (performance.now() - p) / 2000 : t, configurable: true });
      return performance.now();
    }, stall.how);
    await page.waitForTimeout(stall.for);
    const t1 = await page.evaluate(how => {
      const c = window.contexts.at(-1);
      if (how === 'suspend') { c.resume = c.resumeLater; c.resume(); } else delete c.currentTime;
      return performance.now();
    }, stall.how);
    await page.waitForTimeout(1000);
    stalled = { t0, t1, speaker: await page.evaluate(() => window.speaker) };
  }
  while (sent === null) await page.waitForTimeout(200);
  await page.waitForTimeout(500); // every frame played (the timeline has a sentence only once it starts)
  for (let i = 0; i < 300 && await page.evaluate(() => { const [when, length] = window.scheduled.at(-1) ?? [0, 0]; return window.contexts.at(-1).currentTime < when + length + 0.3; }); i++) await page.waitForTimeout(100);
  // (the reply has played out: for the next 1.5 s, while the line is quiet, what the stream still gets)
  const quietFrom = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1500);
  const quiet = await page.evaluate(([from]) => window.MediaStreamTrackProcessor ? window.fed.filter(t => t > from && t <= from + 1500).length : null, [quietFrom]);
  const scheduled = await page.evaluate(() => window.scheduled), speaker = await page.evaluate(() => window.speaker);
  await page.click('#call-end');
  for (let i = 0; i < 50 && !bye; i++) await page.waitForTimeout(100);
  if (noted) noted.after = await page.evaluate(() => document.querySelector('#call-note').hidden);
  await context.close();
  assert.deepEqual(errors, []);
  return { scheduled, bye, stalled, speaker, cut, said, quiet, noted, mic };
}

// Pictures on a call: the board attaches one and pastes another while the call is live, at a phone's width. Each is
// uploaded for this call, the line gets its number, and the strip shows it and then what the line says (it has it, then
// the agent has it; a refused one says so). The call's buttons stay on one row. Hanging up stops an upload on its way:
// the call's number can go to the next call.
async function pictures() {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const uploads = [], sent = [];
  let hold = null; // (the third upload waits here until the board has hung up)
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (url.pathname === '/api/gazette') return r.fulfill({ json: [] });
    if (url.pathname === '/api/pictures' && r.request().method() === 'POST') {
      const body = r.request().postDataBuffer(), id = 41 + uploads.length;
      uploads.push({ call: url.searchParams.get('call'), key: url.searchParams.get('key'), type: r.request().headers()['content-type'], jpeg: body?.[0] === 0xff && body?.[1] === 0xd8 });
      if (uploads.length === 3) return hold = r;
      return r.fulfill({ json: { id, type: 'image/jpeg', bytes: body.length } });
    }
    return r.fulfill({ status: 404, body: '' });
  });
  await context.routeWebSocket(/\/voice\/ws$/, ws => ws.onMessage(m => {
    if (typeof m !== 'string') return; // (the microphone)
    const e = JSON.parse(m);
    if (e.agent) return void ws.send(JSON.stringify({ type: 'call', id: 'line', call: 7, key: 'key-of-7' })), ws.send(JSON.stringify({ type: 'state', state: 'listening' }));
    if (e.type !== 'picture') return;
    sent.push(e);
    // the first is shown to the agent, the second refused (a seventh waiting, say)
    ws.send(JSON.stringify({ type: 'picture', id: e.id, state: sent.length === 1 ? 'received' : 'failed', why: 'too many' }));
    if (sent.length === 1) setTimeout(() => ws.send(JSON.stringify({ type: 'picture', id: e.id, state: 'seen' })), 300);
  }));
  await page.goto(`${base}/?intro=0&open=intercom`);
  await page.click('#call');
  await page.waitForFunction(() => !document.querySelector('#call-attach').disabled);
  // two pictures drawn here: a shop's page and a chart, as PNGs
  const drawn = await page.evaluate(() => [['#ffd966', '#5b8def'], ['#5cc26a', '#e8505b']].map(([back, fore]) => {
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 480 }), g = c.getContext('2d');
    g.fillStyle = back; g.fillRect(0, 0, 640, 480); g.fillStyle = fore;
    for (let i = 0; i < 6; i++) g.fillRect(40 + i * 95, 420 - i * 60, 70, i * 60 + 20);
    return c.toDataURL('image/png').split(',')[1];
  }));
  await page.setInputFiles('#call-file', { name: 'shop.png', mimeType: 'image/png', buffer: Buffer.from(drawn[0], 'base64') });
  await page.waitForSelector('#call-pics li.seen img');
  await page.evaluate(png => {
    const bytes = Uint8Array.from(atob(png), ch => ch.charCodeAt(0)), data = new DataTransfer();
    data.items.add(new File([bytes], 'chart.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, drawn[1]);
  await page.waitForSelector('#call-pics li.failed');
  const strip = await page.evaluate(() => [...document.querySelectorAll('#call-pics li')].map(li => ({ state: li.className, img: !!li.querySelector('img')?.naturalWidth })));
  const rows = await page.evaluate(() => [...document.querySelectorAll('#call-screen .row button')].map(b => { const r = b.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right }; }));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  // a third picture is on its way when the board hangs up: the upload stops
  await page.evaluate(() => {
    const abort = XMLHttpRequest.prototype.abort;
    window.aborted = 0;
    XMLHttpRequest.prototype.abort = function () { if (this.readyState !== XMLHttpRequest.DONE) window.aborted++; return abort.call(this); };
  });
  await page.setInputFiles('#call-file', { name: 'shop.png', mimeType: 'image/png', buffer: Buffer.from(drawn[0], 'base64') });
  while (!hold) await page.waitForTimeout(50);
  await page.click('#call-end');
  const aborted = await page.evaluate(() => window.aborted);
  await context.close();
  assert.deepEqual(errors, []);
  const upload = { call: '7', key: 'key-of-7', type: 'image/jpeg', jpeg: true };
  assert.deepEqual(uploads, [upload, upload, upload], 'each picture is redrawn as a JPEG and uploaded for the live call, by its key');
  assert.equal(aborted, 1, 'hanging up stops the upload on its way');
  assert.deepEqual(sent, [{ type: 'picture', id: 41 }, { type: 'picture', id: 42 }], 'the line gets each picture\'s number');
  assert.deepEqual(strip, [{ state: 'seen', img: true }, { state: 'failed', img: true }]);
  assert.ok(rows.every(b => b.top === rows[0].top) && rows.every(b => b.left >= 0 && b.right <= 390), `the call's buttons on one row: ${JSON.stringify(rows)}`);
  console.log('ok: pictures attached and pasted on a call reach the line, and the strip says how far each got');
}
await pictures();

// The board picks four pictures at once. Their uploads end last first, and the second one fails: the line gets the
// others' numbers in the order they were picked, none before the first is uploaded. The first connection drops as the
// first number reaches it (the line never had it), the second drops right after the line takes it in (its answer is
// lost). Each new connection gets every unanswered number again, and the line takes each in once.
async function picturesInOrder() {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
  const ids = { 640: 41, 600: 42, 560: 43, 520: 44 }, uploads = [], connections = [], known = [];
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (url.pathname === '/api/gazette') return r.fulfill({ json: [] });
    if (url.pathname === '/api/pictures' && r.request().method() === 'POST') return void uploads.push({ id: ids[jpegWidth(r.request().postDataBuffer())], r });
    return r.fulfill({ status: 404, body: '' });
  });
  await context.routeWebSocket(/\/voice\/ws$/, ws => {
    const heard = [], n = connections.push(heard);
    let dropped = false;
    ws.onMessage(m => {
      if (typeof m !== 'string' || dropped) return; // (the microphone, or a connection that's gone)
      const e = JSON.parse(m);
      if (e.agent || e.resume) {
        ws.send(JSON.stringify({ type: 'call', id: 'line', call: 7, key: 'key-of-7' }));
        for (const id of known) ws.send(JSON.stringify({ type: 'picture', id, state: 'received' })); // (the line's retell)
        return;
      }
      if (e.type !== 'picture') return;
      heard.push(e.id);
      if (n === 1) return void (dropped = true, ws.close());
      if (known.includes(e.id)) return;
      known.push(e.id);
      if (n === 2) return void (dropped = true, ws.close());
      ws.send(JSON.stringify({ type: 'picture', id: e.id, state: 'received' }));
    });
  });
  await page.goto(`${base}/?intro=0&open=intercom`);
  await page.click('#call');
  await page.waitForFunction(() => !document.querySelector('#call-attach').disabled);
  const drawn = await page.evaluate(widths => widths.map((width, i) => {
    const c = Object.assign(document.createElement('canvas'), { width, height: 400 }), g = c.getContext('2d');
    g.fillStyle = ['#ffd966', '#5b8def', '#5cc26a', '#e8505b'][i]; g.fillRect(0, 0, width, 400);
    return c.toDataURL('image/png').split(',')[1];
  }), Object.keys(ids).map(Number).sort((a, b) => b - a));
  await page.setInputFiles('#call-file', drawn.map((png, i) => ({ name: `picture-${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })));
  while (uploads.length < 4) await page.waitForTimeout(50);
  const upload = id => uploads.find(u => u.id === id).r;
  for (const id of [44, 43]) { await upload(id).fulfill({ json: { id, type: 'image/jpeg', bytes: 1 } }); await page.waitForTimeout(300); }
  await upload(42).fulfill({ status: 500, body: '' });
  await page.waitForSelector('#call-pics li.failed');
  const early = connections.flat();
  await upload(41).fulfill({ json: { id: 41, type: 'image/jpeg', bytes: 1 } });
  await page.waitForFunction(() => document.querySelectorAll('#call-pics li.sent').length === 3, null, { timeout: 15_000 });
  const strip = await page.evaluate(() => [...document.querySelectorAll('#call-pics li')].map(li => li.className));
  await context.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(early, [], 'no number goes before the first picture is uploaded');
  assert.deepEqual(strip, ['sent', 'failed', 'sent', 'sent'], 'the strip in the order they were picked');
  assert.deepEqual(connections, [[41], [41], [41, 43, 44]], 'every unanswered number goes again, in the order they were picked');
  assert.deepEqual(known, [41, 43, 44], 'the line takes each in once, in order');
  console.log('ok: pictures reach the line in the order they were picked, and numbers lost with a connection go again');
}
// (a JPEG's width, from its frame header: tells the uploads apart)
function jpegWidth(jpeg) {
  for (let at = 2; at < jpeg.length;) {
    const marker = jpeg[at + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return jpeg.readUInt16BE(at + 7);
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
}
await picturesInOrder();

// The call screen's status and its ON AIR sign. A call the line drops says so where
// the intercom's messages go, as an error; the next call starts without it, and hanging up (the board or the agent) adds
// no line of its own. The sign lights
// while someone speaks: the board (the microphone, a tone here, loud), or the agent (its voice playing), never the line's
// tick, nor the quiet in between, nor while the call's audio doesn't run.
async function callScreen() {
  const { context, page, errors } = await callPage();
  // the board's microphone: a tone the check turns up (talking) and down (the room's noise); and the newest of HQ's audio contexts,
  // the call's, for the check to suspend
  await context.addInitScript(() => {
    const AC = window.AudioContext;
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.callCtx = this; } };
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AC(), tone = ac.createOscillator(), gain = ac.createGain(), out = ac.createMediaStreamDestination();
      tone.frequency.value = 220; gain.gain.value = 0.001; tone.connect(gain).connect(out); tone.start();
      window.talk = on => { gain.gain.value = on ? 0.3 : 0.001; };
      return out.stream;
    };
  });
  let line = null;
  await context.routeWebSocket(/\/voice\/ws$/, ws => ws.onMessage(m => {
    if (typeof m !== 'string' || !JSON.parse(m).agent) return; // (the microphone)
    line = ws;
    ws.send(JSON.stringify({ type: 'call', id: 'line', call: 9 })); ws.send(JSON.stringify({ type: 'state', state: 'listening' }));
  }));
  // (a second of a 300 Hz tone, as 20 ms frames of 16 kHz PCM)
  const tone = seconds => Array.from({ length: seconds * 50 }, (_, f) => Buffer.from(Int16Array.from({ length: 320 }, (_, i) => Math.sin(2 * Math.PI * 300 * (f * 320 + i) / 16000) * 8000).buffer));
  const lit = () => page.evaluate(() => document.querySelector('.intercom header').classList.contains('on-air') && getComputedStyle(document.querySelector('.intercom .onair')).backgroundColor);
  const message = () => page.textContent('#dir-msg');
  const seen = {};
  await page.goto(`${base}/?intro=0&open=intercom`);
  // a line that doesn't go through (the coordinator answers 404) says so as an error, gone once the board types again
  await page.fill('#dir-title', 'Hello');
  await page.click('#dir-send');
  await page.waitForSelector('#dir-msg .alert.problem svg');
  await page.type('#dir-title', '!');
  seen.typed = [await message(), await page.evaluate(() => document.querySelector('#dir-msg .alert') !== null)];
  await page.fill('#dir-title', '');
  await page.click('#call');
  while (!line) await page.waitForTimeout(50);
  line.close({ code: 4000 }); line = null; // (the line drops the call)
  await page.waitForSelector('#call-screen', { state: 'hidden' });
  seen.dropped = await message();
  seen.droppedError = await page.evaluate(() => document.querySelector('#dir-msg .alert.problem svg') !== null);
  await page.click('#call');
  seen.next = await message();
  while (!line) await page.waitForTimeout(50);
  await page.waitForTimeout(600);
  seen.quiet = await lit();
  await page.evaluate(() => window.talk(true)); await page.waitForTimeout(500);
  seen.board = await lit();
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.evaluate(() => window.talk(false)); await page.waitForTimeout(800);
  seen.after = await lit();
  line.send(JSON.stringify({ type: 'state', state: 'speaking' })); line.send(JSON.stringify({ type: 'said', text: 'Hello.' }));
  for (const f of tone(1.5)) line.send(f);
  await page.waitForTimeout(700);
  seen.agent = await lit();
  await page.waitForTimeout(1500);
  seen.done = await lit();
  line.send(JSON.stringify({ type: 'tick' }));
  for (const f of tone(1.5)) line.send(f);
  await page.waitForTimeout(700);
  seen.tick = await lit();
  // the call's audio suspended (iOS takes it away) while the board talks and the agent speaks: the sign goes dark, and
  // lights again once the audio runs
  await page.evaluate(() => window.talk(true));
  line.send(JSON.stringify({ type: 'state', state: 'speaking' }));
  for (const f of tone(5)) line.send(f);
  await page.waitForTimeout(500);
  seen.beforeSuspend = await lit();
  // (suspended as iOS does it, refusing to resume until it lets the page: the call tries on every tick)
  await page.evaluate(() => {
    const resume = window.callCtx.resume.bind(window.callCtx);
    window.allowResume = () => { window.callCtx.resume = resume; };
    window.callCtx.resume = () => Promise.reject(new DOMException('Audio interrupted', 'NotAllowedError'));
    return window.callCtx.suspend();
  });
  await page.waitForTimeout(800);
  seen.suspended = await lit();
  await page.evaluate(() => window.allowResume()); await page.waitForTimeout(500);
  seen.resumed = await lit();
  // the context running with its clock stuck (follow() pauses the speaker): dark too, lit again once the clock moves
  await page.evaluate(() => { const t = window.callCtx.currentTime; Object.defineProperty(window.callCtx, 'currentTime', { get: () => t, configurable: true }); });
  await page.waitForTimeout(500);
  seen.stuck = await lit();
  await page.evaluate(() => delete window.callCtx.currentTime); await page.waitForTimeout(500);
  seen.moving = await lit();
  await page.evaluate(() => window.talk(false));
  await page.click('#call-end');
  seen.hungUp = [await message(), await lit()];
  // the agent hangs up: nothing is left under the intercom either
  line = null;
  await page.click('#call');
  while (!line) await page.waitForTimeout(50);
  line.send(JSON.stringify({ type: 'hangup' }));
  await page.waitForSelector('#call-screen', { state: 'hidden' });
  seen.agentHungUp = await message();
  await context.close();
  assert.deepEqual(errors, []);
  assert.ok(seen.dropped && seen.droppedError, 'a dropped call says so, as an error');
  assert.deepEqual(seen.typed, ['', false], 'a failed line\'s error goes once the board types');
  assert.equal(seen.next, '', 'a new call starts without the last one\'s status');
  assert.deepEqual([seen.quiet, seen.after, seen.done, seen.tick], [false, false, false, false], `the sign lit with nobody speaking: ${JSON.stringify(seen)}`);
  assert.ok(seen.board && seen.agent && seen.board !== 'rgba(0, 0, 0, 0)', `the sign didn't light for the board or the agent: ${JSON.stringify(seen)}`);
  assert.ok(seen.beforeSuspend && !seen.suspended && seen.resumed, `the sign stayed lit with the call's audio suspended: ${JSON.stringify(seen)}`);
  assert.ok(!seen.stuck && seen.moving, `the sign stayed lit with the call's audio clock stuck: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.hungUp, ['', false], 'hanging up adds no line, and the sign goes dark');
  assert.equal(seen.agentHungUp, '', 'the agent hanging up adds no line');
  console.log('ok: a new call clears the last status; ON AIR lights for the board\'s voice and the agent\'s, not the tick or quiet');
}
await callScreen();

// The screen going off on a call (iOS mutes the microphone until the page is back, and lets go of the screen's wake lock):
// back in view, the lock is asked for again, even if a pending request was refused as the page hid.
// A microphone still muted a second later, or ended, is replaced by a new
// one that the call hears (the ON AIR sign lights for it). One that unmuted by itself is kept. The timeline says what
// happened.
async function screenOff() {
  const { context, page, errors, connected, bye } = await phoneContext();
  const lit = () => page.evaluate(() => document.querySelector('.intercom header').classList.contains('on-air'));
  const state = () => page.evaluate(() => ({ mics: window.mics.length, locks: window.locks.length, held: window.locks.filter(l => !l.released).length }));
  const seen = {};
  await page.goto(`${base}/?intro=0&open=intercom`);
  await page.click('#call');
  while (!connected()) await page.waitForTimeout(50);
  await page.waitForFunction(() => typeof window.rejectLock === 'function');
  // the page hides and comes back while its first lock request is pending, then the browser refuses it: ask again
  await page.evaluate(() => { window.hide(true); window.hide(false); window.rejectLock(new DOMException('Page was hidden', 'NotAllowedError')); });
  await page.waitForFunction(() => window.lockRequests === 2 && window.locks.some(l => !l.released), null, { timeout: 3000 })
    .catch(err => { throw new Error('The call did not retry its refused wake lock after the page came back', { cause: err }); });
  seen.start = await state();
  seen.locksBeforeMic = await page.evaluate(() => window.locksBeforeMic);
  // the screen goes off and the microphone mutes; back on, it's still muted
  await page.evaluate(() => { window.hide(true); window.mics[0].set(true); });
  await page.waitForTimeout(300);
  seen.off = await state();
  await page.evaluate(() => window.hide(false));
  await page.waitForTimeout(400);
  seen.waiting = await state();   // (within the second it gets to unmute by itself)
  await page.waitForTimeout(1200);
  seen.back = await state();
  await page.evaluate(() => window.mics.at(-1).gain.gain.value = 0.3); await page.waitForTimeout(500);
  seen.heard = await lit();
  await page.evaluate(() => window.mics.at(-1).gain.gain.value = 0.001); await page.waitForTimeout(800);
  // off again, and the microphone unmutes by itself before the page is back: kept
  await page.evaluate(() => { window.hide(true); window.mics.at(-1).set(true); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.mics.at(-1).set(false); window.hide(false); });
  await page.waitForTimeout(1500);
  seen.unmuted = await state();
  // the microphone ends with the page in view (a Bluetooth headset gone): replaced at once
  await page.evaluate(() => window.mics.at(-1).set(false, 'ended'));
  await page.waitForTimeout(400);
  seen.ended = await state();
  await page.click('#call-end');
  await page.waitForTimeout(300);
  seen.hungUp = await state();
  await context.close();
  screenOffAssertions(seen, errors, bye());
}
async function phoneContext() {
  const { context, page, errors } = await callPage();
  // each microphone HQ opens (a tone, its track's muted and readyState the check's to set), each wake lock it asks for,
  // and the page's visibility (hiding it lets go of the locks, as the browser does)
  // the first lock request waits until the check refuses it
  // a microphone hears the room's noise (a faint tone), unless window.micPlan says the next one comes 'silent' (exact
  // silence), 'muted' (silent, its track muted) or 'pending' (a silent one, given only at window.releaseMic()); the call's
// audio context is window.callCtx
  await context.addInitScript(() => {
    const AC = window.AudioContext;
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.callCtx = this; } };
    window.mics = []; window.locks = []; window.lockRequests = 0; window.micPlan = [];
    navigator.mediaDevices.getUserMedia = async () => {
      window.locksBeforeMic ??= window.lockRequests;
      const kind = window.micPlan.shift() ?? 'live';
      if (kind === 'pending') await new Promise(resolve => { window.releaseMic = resolve; });
      const ac = new AC(), tone = ac.createOscillator(), gain = ac.createGain(), out = ac.createMediaStreamDestination();
      tone.frequency.value = 220; gain.gain.value = kind === 'live' ? 0.001 : 0; tone.connect(gain).connect(out); tone.start();
      const track = out.stream.getAudioTracks()[0], mic = { gain, muted: kind === 'muted', state: 'live' };
      Object.defineProperty(track, 'muted', { get: () => mic.muted });
      Object.defineProperty(track, 'readyState', { get: () => mic.state });
      mic.set = (muted, state = 'live') => { const ev = state !== mic.state ? 'ended' : muted ? 'mute' : 'unmute'; Object.assign(mic, { muted, state }); track.dispatchEvent(new Event(ev)); };
      window.mics.push(mic);
      return out.stream;
    };
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => {
      if (++window.lockRequests === 1) await new Promise((resolve, reject) => { window.rejectLock = reject; });
      const lock = Object.assign(new EventTarget(), { released: false });
      lock.release = async () => { if (!lock.released) { lock.released = true; lock.dispatchEvent(new Event('release')); } };
      window.locks.push(lock); return lock;
    } } });
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
    window.hide = on => { hidden = on; if (on) window.locks.forEach(l => l.release()); document.dispatchEvent(new Event('visibilitychange')); };
  });
  let line = null, bye = null;
  await context.routeWebSocket(/\/voice\/ws$/, ws => ws.onMessage(m => {
    if (typeof m !== 'string') return; // (the microphone)
    const ev = JSON.parse(m);
    if (ev.type === 'bye') bye = ev;
    if (!ev.agent) return;
    line = ws;
    ws.send(JSON.stringify({ type: 'call', id: 'line', call: 9 })); ws.send(JSON.stringify({ type: 'state', state: 'listening' }));
  }));
  return { context, page, errors, connected: () => line !== null, bye: () => bye };
}
async function callPage() {
  const opened = await openPage(browser, { viewport: { width: 420, height: 912 }, permissions: ['microphone'] });
  await opened.context.route(`${base}/api/**`, async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (path === '/api/gazette') return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  return opened;
}
function screenOffAssertions(seen, errors, bye) {
  assert.deepEqual(errors, []);
  assert.deepEqual(seen.start, { mics: 1, locks: 1, held: 1 }, `the call didn't keep the screen awake: ${JSON.stringify(seen)}`);
  assert.equal(seen.locksBeforeMic, 1, 'the call asks for the wake lock only after the microphone starts, too late for Safari');
  assert.equal(seen.off.held, 0);
  assert.deepEqual(seen.waiting, { mics: 1, locks: 2, held: 1 }, `back in view, the lock isn't asked for again, or the mic was replaced at once: ${JSON.stringify(seen)}`);
  assert.equal(seen.back.mics, 2, `a microphone still muted after the screen came back wasn't replaced: ${JSON.stringify(seen)}`);
  assert.ok(seen.heard, 'the call doesn\'t hear the new microphone');
  assert.deepEqual(seen.unmuted, { mics: 2, locks: 3, held: 1 }, `a microphone that unmuted by itself was replaced: ${JSON.stringify(seen)}`);
  assert.equal(seen.ended.mics, 3, `an ended microphone wasn't replaced: ${JSON.stringify(seen)}`);
  assert.equal(seen.hungUp.held, 0, 'hanging up keeps the screen awake');
  const kinds = bye?.timeline.map(e => e[1]) ?? [];
  for (const kind of ['wake lock held', 'wake lock refused', 'wake lock released', 'mic mute', 'mic unmute', 'mic restarted', 'mic ended']) assert.ok(kinds.includes(kind), `no ${kind} in the timeline: ${JSON.stringify(bye?.timeline)}`);
  console.log('ok: back from the screen going off, the call keeps the screen awake again and replaces a muted or ended microphone');
}
await screenOff();

// A weak connection: the line answers each ping with how late it heard it. Over 1.5 s late, or nothing back from the
// line for 4 s (from the first ping on, its reply's audio counting as an answer), the call's screen says so, until 3 s
// after it caught up; the timeline has each spell.
async function lagging() {
  const { context: ctx, page, errors } = await callPage();
  let line = null, late = 0, answering = false, pings = 0, bye = null;
  await ctx.routeWebSocket(/\/voice\/ws$/, ws => ws.onMessage(m => {
    if (typeof m !== 'string') return; // (the microphone)
    const e = JSON.parse(m);
    if (e.type === 'bye') bye = e;
    if (e.type === 'ping' && answering) { pings++; ws.send(JSON.stringify({ type: 'pong', late })); }
    if (!e.agent) return;
    line = ws;
    ws.send(JSON.stringify({ type: 'call', id: 'line', call: 9 })); ws.send(JSON.stringify({ type: 'state', state: 'listening' }));
  }));
  const seen = {};
  const note = () => page.evaluate(() => { const n = document.querySelector('#call-net'); return n.hidden ? '' : n.textContent; });
  await page.goto(`${base}/?intro=0&open=intercom`);
  await page.click('#call');
  while (!line) await page.waitForTimeout(50);
  await page.waitForTimeout(5000); // (no answer to the connection's first pings either)
  seen.first = await note();
  answering = true; await page.waitForTimeout(4000);
  seen.onTime = [await note(), pings >= 2];
  late = 12; await page.waitForTimeout(1000);
  seen.late = await note();
  late = 0; await page.waitForTimeout(1500);
  seen.caughtUp = await note();
  await page.waitForTimeout(2500);
  seen.after = await note();
  answering = false; // (the pongs held up behind a reply's audio: no sign while it comes)
  const silence = Buffer.alloc(6400); // (0.2 s at a time, so the timeline's 300 keep its spells)
  for (let i = 0; i < 25; i++) { line.send(silence); await page.waitForTimeout(200); }
  seen.replying = await note();
  await page.waitForTimeout(3000);
  seen.unanswered = await note();
  await page.waitForTimeout(2000);
  seen.stopped = await note();
  await page.click('#call-end');
  while (!bye) await page.waitForTimeout(50);
  seen.hungUp = await note();
  await ctx.close();
  assert.deepEqual(errors, []);
  assert.match(seen.first, /^Weak connection: \S+ hears you about [4-5] s late\.$/, JSON.stringify(seen));
  assert.deepEqual(seen.onTime, ['', true], `pings answered on time: ${JSON.stringify(seen)}`);
  assert.match(seen.late, /^Weak connection: \S+ hears you about 12 s late\.$/, JSON.stringify(seen));
  assert.equal(seen.caughtUp, seen.late, 'the sign went as soon as the line caught up');
  assert.deepEqual([seen.after, seen.replying, seen.unanswered], ['', '', ''], `the sign stayed, came while the reply's audio came, or before 4 s without an answer: ${JSON.stringify(seen)}`);
  assert.match(seen.stopped, /^Weak connection: \S+ hears you about [4-6] s late\.$/, JSON.stringify(seen));
  assert.equal(seen.hungUp, '');
  const spells = bye.timeline.filter(e => ['lagging', 'caught up'].includes(e[1])).map(e => e.slice(1));
  assert.deepEqual(spells.map(([kind, ...at]) => [kind, ...at.map(Math.round)]), [['lagging'], ['caught up', 5], ['lagging'], ['caught up', 12], ['lagging']], JSON.stringify(bye.timeline));
  console.log('ok: a line that hears the board late shows as a weak connection, until 3 s after it caught up:', JSON.stringify(seen));
}
await lagging();

// Dialling from an iOS home-screen app back from the background: its microphone can come muted, or live but giving
// only exact silence, and the call's audio may not run, all with no prompt and no error. The call replaces a muted
// microphone at once. After a few seconds of nothing heard while its audio clock moves, it says so and opens a new
// microphone, and hears the board on whichever it has: silence may be a quiet room. One still not given after a few
// seconds more (a permission prompt left open) is said too, and given after hanging up it's let go. A stopped clock
// asks for a tap if it cannot wake itself, and a microphone's words it already said come back once it runs.
// audio: 'running' | 'suspended' | 'until-tap' | 'warned-until-tap' (stopped until a tap after the first warning)
async function silentMicrophone(plan, audio = 'running') {
  const { context, page, errors, connected, bye } = await phoneContext();
  const lit = () => page.evaluate(() => document.querySelector('.intercom header').classList.contains('on-air'));
  await page.goto(`${base}/?intro=0&open=intercom`);
  await page.evaluate(p => { window.micPlan = p; }, plan);
  await page.click('#call');
  while (!connected()) await page.waitForTimeout(50);
  const stop = untilTap => page.evaluate(untilTap => {
    if (untilTap) {
      const resume = window.callCtx.resume.bind(window.callCtx);
      window.allowResume = () => { window.callCtx.resume = resume; };
      window.callCtx.resume = () => Promise.reject(new DOMException('Audio interrupted', 'NotAllowedError'));
    }
    return window.callCtx.suspend();
  }, untilTap);
  if (audio === 'suspended' || audio === 'until-tap') await stop(audio === 'until-tap');
  const t0 = Date.now(), seen = {};
  await page.waitForFunction(() => document.querySelector('#call-screen').hidden || window.mics.length > 1, null, { timeout: 8000 }).catch(() => {});
  seen.after = (Date.now() - t0) / 1000;
  await page.waitForTimeout(3000);
  const warning = () => page.evaluate(() => { const n = document.querySelector('#call-mic'); return n.hidden ? '' : n.textContent; });
  seen.mics = await page.evaluate(() => window.mics.length);
  seen.ended = await page.evaluate(() => document.querySelector('#call-screen').hidden);
  seen.warning = await warning();
  if (!seen.ended && audio === 'warned-until-tap') { await stop(true); await page.waitForTimeout(3000); seen.paused = await warning(); }
  if (!seen.ended) {
    if (audio.endsWith('until-tap')) { await page.evaluate(() => window.allowResume()); await page.click('#call-state'); }
    if (audio === 'warned-until-tap') { await page.waitForTimeout(1000); seen.resumed = await warning(); }
    await page.evaluate(() => window.mics.at(-1).gain.gain.value = 0.3); await page.waitForTimeout(500);
    seen.heard = await lit();
    seen.warningAfter = await warning();
    await page.click('#call-end');
    if (plan.includes('pending')) { await page.evaluate(() => window.releaseMic()); await page.waitForTimeout(300); }
  }
  for (let i = 0; i < 20 && !bye(); i++) await page.waitForTimeout(100);
  seen.timeline = bye()?.timeline.map(e => e[1]) ?? [];
  await context.close();
  assert.deepEqual(errors, []);
  return seen;
}
const muted = await silentMicrophone(['muted']);
assert.ok(muted.mics === 2 && muted.after < 2 && muted.heard, `a muted microphone at dialling wasn't replaced at once by one the call hears: ${JSON.stringify(muted)}`);
const silent = await silentMicrophone(['silent']);
assert.ok(silent.mics === 2 && !silent.ended && silent.heard && !silent.warning && silent.timeline.includes('mic silent'), `a silent microphone wasn't replaced by one the call hears: ${JSON.stringify(silent)}`);
const stopped = await silentMicrophone([], 'suspended');
assert.ok(!stopped.ended && stopped.heard, `the call's stopped audio wasn't woken: ${JSON.stringify(stopped)}`);
const interrupted = await silentMicrophone([], 'until-tap');
assert.ok(!interrupted.ended && interrupted.mics === 1 && /Tap/.test(interrupted.warning) && interrupted.heard && !interrupted.warningAfter, `an interrupted call didn't ask for a tap, stay up with its microphone and recover: ${JSON.stringify(interrupted)}`);
const quietRoom = await silentMicrophone(['silent', 'silent']);
assert.ok(!quietRoom.ended && quietRoom.mics === 2 && /No sound/.test(quietRoom.warning) && quietRoom.heard && !quietRoom.warningAfter && quietRoom.timeline.includes('mic silent'), `a call whose microphone stayed silent didn't say so, or didn't hear the board speak after: ${JSON.stringify(quietRoom)}`);
const warnedInterrupted = await silentMicrophone(['silent', 'silent'], 'warned-until-tap');
assert.ok(!warnedInterrupted.ended && /No sound/.test(warnedInterrupted.warning) && /Tap/.test(warnedInterrupted.paused) && /No sound/.test(warnedInterrupted.resumed) && warnedInterrupted.heard && !warnedInterrupted.warningAfter, `a still-silent microphone's words didn't come back after a tap resumed the call's audio: ${JSON.stringify(warnedInterrupted)}`);
const pending = await silentMicrophone(['silent', 'pending']);
assert.ok(!pending.ended && pending.mics === 1 && /isn’t starting/.test(pending.warning) && pending.heard && !pending.warningAfter, `a new microphone never given wasn't said, or the call stopped hearing the one it had: ${JSON.stringify(pending)}`);
console.log(`ok: dialling, a muted microphone is replaced in ${muted.after} s and a silent one in ${silent.after} s; stopped audio wakes; interrupted audio asks for a tap, and a microphone's words come back after it; one still silent, or a new one not given, is said and the call hears the board speak after`);

// as the voice line sent it: every frame plays straight after the one before within a sentence, nothing overlaps
const { scheduled, bye, quiet, mic } = await call();
assert.equal(scheduled.length, frames.length);
let joins = 0;
for (let i = 1; i < scheduled.length; i++) {
  const gap = scheduled[i][0] - (scheduled[i - 1][0] + scheduled[i - 1][1]);
  assert.ok(gap > -1e-6, `frame ${i} overlaps the one before by ${-gap} s`);
  if (frames[i][2] && frames[i][2] === frames[i - 1][2]) { assert.ok(gap < 1e-3, `frame ${i} starts ${gap} s after the one before, mid-sentence`); joins++; }
}
assert.equal(bye.played.frames, frames.length);
assert.equal(bye.played.stutters, 0);
assert.equal(bye.played.via, 'stream');
assert.ok(bye.played.rate > 0);
console.log(`ok: ${frames.length} frames, ${joins} joins mid-sentence all seamless; bye says`, JSON.stringify(bye.played));
// ...and once the reply has played out, the stream still gets audio (silence): a stream the context stops rendering into
// when the last frame ends is what Safari loops, its last 50 ms over and over until the next reply
if (quiet === null) console.log('skipped: what reaches the stream after the reply (no MediaStreamTrackProcessor here)');
else {
  assert.ok(quiet >= 100, `the stream got ${quiet} chunks of audio in the 1.5 s after the reply (about 150 if it's fed): starved`);
  console.log(`ok: after the reply the stream is still fed, ${quiet} chunks in 1.5 s`);
}
// ...and while it played, the microphone's frames carried it too, after the microphone's own 320 samples, as it played
// (the voice line takes it out of what the microphone heard). The board's
// microphone here is Chromium's fake one, a beep the voice never matches.
{
  const sizes = new Set(mic.map(m => m.length));
  assert.deepEqual([...sizes].sort(), [1280, 640], `frame sizes ${[...sizes]}`);
  const plane = (m, from) => Array.from(new Int16Array(m.buffer, m.byteOffset + from, 320));
  const heard = mic.flatMap(m => m.length === 1280 ? plane(m, 640) : new Array(320).fill(0));
  const sent = frames.flatMap(([, pcm]) => { const b = Buffer.from(pcm, 'base64'); return Array.from(new Int16Array(b.buffer, b.byteOffset, b.length / 2)); });
  // (the best lag of the reply in what came beside the microphone, and how alike they are there: 1 is the same)
  const energy = x => x.reduce((a, v) => a + v * v, 0), first = heard.findIndex(v => v !== 0), n = Math.min(sent.length, 16000 * 4);
  let best = [0, 0];
  for (let lag = Math.max(0, first - 800); lag < first + 800; lag++) {
    let dot = 0; for (let i = 0; i < n; i++) dot += sent[i] * (heard[lag + i] ?? 0);
    const r = dot / Math.sqrt(energy(sent.slice(0, n)) * energy(heard.slice(lag, lag + n)));
    if (r > best[1]) best = [lag, r];
  }
  assert.ok(best[1] > 0.95, `the voice beside the microphone is not the reply as it played (correlation ${best[1].toFixed(3)})`);
  console.log(`ok: ${mic.filter(m => m.length === 1280).length} of ${mic.length} microphone frames carried the agent's voice, the reply as it played (correlation ${best[1].toFixed(3)})`);
}
// ...and its timeline: every sentence and tick as it started, in order, and the voice running dry after each reply
const kinds = k => bye.timeline.filter(e => e[1] === k), starts = frames.filter(([, , s], i) => i === 0 || !s || s !== frames[i - 1][2]);
assert.equal(kinds('voice').length, starts.filter(f => f[2]).length, JSON.stringify(bye.timeline));
assert.equal(kinds('tick').length, starts.filter(f => !f[2]).length, JSON.stringify(bye.timeline));
assert.ok(bye.timeline.every((e, i) => i === 0 || e[0] >= bye.timeline[i - 1][0]), 'the timeline is in order');
assert.ok(kinds('dry').length >= 1 && kinds('dry').at(-1)[0] > kinds('voice').at(-1)[0], JSON.stringify(bye.timeline));
assert.deepEqual([...kinds('slow'), ...kinds('stall')], [], 'a call that played well shows no slow clock or stall');
console.log(`ok: the timeline has ${bye.timeline.length} events:`, JSON.stringify(bye.timeline.filter(e => e[1] !== 'voice').slice(0, 12)));

// a voice line falling behind (frames coming at half speed from the fifth on): HQ counts the stutters, and says so
const stalled = await call({ from: 5, pace: 2 });
assert.ok(stalled.bye.played.stutters >= 20, JSON.stringify(stalled.bye.played));
const dry = stalled.bye.timeline.filter(e => e[1] === 'dry').length; // (each gap runs dry, however short)
assert.ok(dry >= stalled.bye.played.stutters, `${dry} times dry: ${JSON.stringify(stalled.bye.played)}`);
console.log('ok: a line falling behind is counted:', JSON.stringify(stalled.bye.played));

// a pause before each sentence (a tool step, or a sentence that took longer to speak): a gap between sentences, never a stutter
const paused = await call({ pause: 150 });
assert.equal(paused.bye.played.stutters, 0, JSON.stringify(paused.bye.played));
console.log('ok: pauses between sentences are not stutters:', JSON.stringify(paused.bye.played));

// the call's context stops mid-reply for 1.5 s: the <audio> element is paused within 0.35 s of it (Safari would loop the
// stream's last 50 ms while it played on) and plays again within 0.6 s of the clock moving again
for (const how of ['suspend', 'freeze']) {
  const { stalled: s, bye: b } = await call(null, { at: 1500, for: 1500, how });
  const paused = (from, to = Infinity) => s.speaker.filter(([w]) => w >= from && w < to).map(([, p]) => p);
  assert.ok(paused(0, s.t0).some(p => !p), 'the speaker played before the stall');
  assert.ok(paused(s.t0 + 350, s.t1).length > 10 && paused(s.t0 + 350, s.t1).every(p => p), `${how}: the speaker still played into the stall`);
  assert.ok(paused(s.t1 + 600).length > 3 && paused(s.t1 + 600).every(p => !p), `${how}: the speaker didn't play again after it`);
  assert.ok(b.played.stalls >= 1, JSON.stringify(b.played));
  assert.equal(b.played.frames, frames.length);
  const stallEvents = b.timeline.filter(e => e[1] === 'stall'); // (and the timeline says how long the clock was stopped)
  assert.ok(stallEvents.length === 1 && Math.abs(stallEvents[0][2] - 1.5) < 0.4, JSON.stringify(b.timeline));
  console.log(`ok: a stall (${how}) pauses the speaker and it plays on after:`, JSON.stringify(b.played));
}

// the call's clock runs at half speed for 3 s (it moves, so nothing pauses): the timeline shows it, and no stall
const slow = await call(null, { at: 1500, for: 3000, how: 'slow' });
const slowEvents = slow.bye.timeline.filter(e => e[1] === 'slow');
assert.ok(slowEvents.length === 1 && Math.abs(slowEvents[0][2] - 0.5) < 0.1 && slowEvents[0][3] >= 1.9, JSON.stringify(slow.bye.timeline));
assert.ok(slow.bye.timeline.every(e => e[1] !== 'stall'), JSON.stringify(slow.bye.timeline));
console.log('ok: a slow clock is in the timeline:', JSON.stringify(slowEvents));

// Skip while the line has sent sentences ahead of what's playing: the ones that never started aren't in the timeline
// (a sentence the stand-in sent after the Skip, before it heard the interrupt, plays after the cut, as it would on a call)
// (the first sentence the line sent while the one before still played: Skip right after it's sent; a fixed time missed
// it in a reply that starts with tool steps)
const sentences = starts.filter(f => f[2]).map(([t, , s]) => [t, frames.filter(f => f[2] === s).reduce((d, f) => d + Buffer.from(f[1], 'base64').length / 32000, 0)]);
const ahead = sentences.findIndex(([t], i) => i && t < sentences[i - 1][0] + sentences[i - 1][1]);
assert.ok(ahead > 0, 'no sentence in these frames was sent while the one before played');
const skipped = await call(null, { said: ahead + 1, how: 'skip' });
const timed = skipped.bye.timeline, cutAt = timed.find(e => e[1] === 'cut')?.[0];
const voiced = timed.filter(e => e[1] === 'voice'), beforeCut = voiced.filter(e => e[0] <= cutAt).length;
assert.ok(cutAt != null && beforeCut < skipped.cut, `${skipped.cut} sentences sent before the Skip: ${JSON.stringify(timed)}`);
assert.ok(voiced.length - beforeCut <= skipped.said - skipped.cut, `${skipped.said - skipped.cut} sent after it: ${JSON.stringify(timed)}`);
console.log(`ok: Skip leaves the ${skipped.cut - beforeCut} sentences that never played out of the timeline:`, JSON.stringify(timed));
// (and after the cut, as after a reply's end, the stream is still fed: cut mid-word, a starved one loops the word)
if (skipped.quiet === null) console.log('skipped: what reaches the stream after the Skip (no MediaStreamTrackProcessor here)');
else {
  assert.ok(skipped.quiet >= 100, `the stream got ${skipped.quiet} chunks in the 1.5 s after the Skip: starved`);
  console.log(`ok: after the Skip the stream is still fed, ${skipped.quiet} chunks in 1.5 s`);
}

// the element's first play() is paused before it starts: it plays once the clock moves, and the call stays on the stream
// (echo cancelled), not on direct audio for the rest of the call
const start = await call(null, { how: 'start' });
assert.equal(start.bye.played.via, 'stream', JSON.stringify(start.bye.played));
assert.ok(start.speaker.length > 10 && start.speaker.slice(-10).every(([, p]) => !p), 'the speaker never played after its first play() was paused');
assert.equal(start.bye.played.frames, frames.length);
console.log('ok: a pause before play() starts leaves the call on the stream:', JSON.stringify(start.bye.played));

// the line's notice: shown while the call is up, gone with it (the next call starts without it)
const NOTICE = "Juno can't answer right now: our Claude seat is at its limit until 00:10. What you say is still written down, and Juno follows up after the call.";
const notice = await call(null, { how: 'notice' });
assert.deepEqual([notice.noted.text, notice.noted.shown, notice.noted.after], [NOTICE, true, true], JSON.stringify(notice.noted));
console.log('ok: the line\'s notice shows on the call screen while the call is up, and goes with it');
await browser.close();
server.close();
