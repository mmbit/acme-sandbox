#!/usr/bin/env node
// The join link's page (platform/coordinator/src/joinpage.ts) in a real browser, against a stand-in voice line: before
// joining, the agent named as an AI all along, the notice and the privacy link, and nothing kept but the name; joining
// (the line gets the token and the name, then the microphone's frames, with what played after them while something
// plays); the agent speaking (its mouth opens with its own voice and shuts after, never with someone else's; the
// captions); a second person joining and talking (their ring, the agent listening); a tool step (thinking); mute; a
// dropped connection coming back into the same room; leaving; the agent hanging up; a closed link; a full room; the
// Dutch and German words; the platform's own figure for an agent without a drawing. At a laptop's size and a phone's.
//   node platform/hq/join-check.mjs [screenshot folder]     (BROWSER=webkit for Safari's engine)
// Against the real voice line instead (platform/voice/room_standin.py: the real room, mixer and call around stand-in
// models; a Python with numpy and websockets): the opening, the mouth with it, a question from the microphone and its
// answer, and leaving.
//   LINE_PYTHON=<python> node platform/hq/join-check.mjs [screenshot folder]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { playwright, errorsOf } from '../../shared/browser/browser.mjs';

const { chromium, webkit } = playwright();
const SHOTS = process.argv[2] ?? mkdtempSync(`${process.env.TMPDIR ?? tmpdir()}/join-shots-`);
const HQ = new URL('.', import.meta.url).pathname;
const DATA = mkdtempSync(`${process.env.TMPDIR ?? tmpdir()}/join-data-`);
// a stand-in company: its brand, and its own drawing of one agent with the named parts the page moves
const REPO = `${DATA}/repo`;
mkdirSync(`${REPO}/company`, { recursive: true });
mkdirSync(`${REPO}/theme/join`, { recursive: true });
writeFileSync(
  `${REPO}/company/brand.yaml`,
  "name: Testco\ncolours: { blue: '#3366cc', gold: '#ffcc33', red: '#dd4455' }\n",
);
writeFileSync(
  `${REPO}/theme/join/ada.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="Ada, drawn">
<g data-part="figure" stroke="#223" stroke-width="4"><g data-part="body"><path fill="#6a5acd" d="M80 420C80 320 140 280 200 280S320 320 320 420Z"/></g>
<g data-part="head"><circle cx="200" cy="170" r="90" fill="#f3c9a8"/><g data-part="brows" fill="none"><path d="M150 130h40M210 130h40"/></g>
<g data-part="eyes" stroke="none"><g data-part="pupils" fill="#223"><circle cx="170" cy="165" r="10"/><circle cx="230" cy="165" r="10"/></g></g>
<g data-part="mouth"><path data-part="mouth-shut" fill="none" d="M180 215q20 14 40 0"/><g data-part="mouth-open"><path fill="#702" d="M180 210h40q0 26-20 26t-20-26z"/></g></g></g>
<g data-part="arm" data-sip="-30 -60 -10"><rect x="230" y="280" width="60" height="70" fill="#fff"/></g></g></svg>`,
);
process.env.REPO_DIR = REPO;
process.env.DATA_DIR = DATA;
const { joinPage, joinAsset } = await import('../coordinator/src/joinpage.ts');

const TOKEN = 'Jx'.repeat(21) + 'Q'; // 43 characters, as the coordinator makes them
const UNTIL = new Date(Date.now() + 3 * 3600e3).toISOString();
const PRIVACY = 'https://shop.example/privacy#calls';
const agentOf = {
  [TOKEN]: { id: 'ada', name: 'Ada' },
  ['Gx'.repeat(21) + 'Q']: { id: 'nobody-drawn', name: 'Bo' },
};
const langOf = { en: 'en', nl: 'nl', de: 'de' };

// The coordinator's side as callouts.ts serves it: the page for an open link, its assets, the look's files
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x'),
    m = /^\/join\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (m && agentOf[m[1]]) {
    const lang = langOf[url.searchParams.get('lang')] ?? 'en';
    const view = {
      token: m[1],
      lang,
      agent: agentOf[m[1]],
      company: 'Testco',
      words: undefined,
      privacy: PRIVACY,
      until: UNTIL,
      ...(url.searchParams.has('later') ? { opens: new Date(Date.now() + 600e3).toISOString() } : {}),
    };
    const { html, csp } = joinPage(view);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    return res.end(html);
  }
  const asset = /^\/join\/assets\/([\w.-]+)$/.exec(url.pathname)?.[1];
  const found = asset && joinAsset(asset);
  if (found) {
    res.writeHead(200, { 'content-type': found.type, 'x-content-type-options': 'nosniff' });
    return res.end(found.body);
  }
  // the platform's own logo, as the page shows it for a company without a look of its own
  if (url.pathname === '/wordmark.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(readFileSync(`${HQ}/wordmark.svg`));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('This link has closed');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;
const line = process.env.LINE_PYTHON ? await realLine(process.env.LINE_PYTHON) : null;
const useWebkit = process.env.BROWSER === 'webkit';
const browser = useWebkit
  ? await webkit.launch()
  : await chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        ...(line ? [`--use-file-for-fake-audio-capture=${line.voice}`] : []),
      ],
    });
const LAPTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
let checked = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checked++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The drawing's motion: headless WebKit (WPE) runs a page's animation frames too seldom and unevenly to measure it, so
// it's checked in Chromium, and WebKit only says how many it skipped
let skipped = 0;
const drawn = (value, message) => (useWebkit ? skipped++ : ok(value, message));
// (a screenshot in WebKit adds a stylesheet of Playwright's own, which the page's CSP refuses: not the page's error)
let shooting = false;
async function shot(page, path) {
  shooting = true;
  await page.screenshot({ path, caret: 'initial' }).finally(() => (shooting = false));
}

// ---- a stand-in voice line: one room, a script per test
// (functions, not consts: the real line's microphone file is made from them before the browser starts)
function voiceOf(seconds, { syllables = 4, pitch = 135, loud = 0.22 } = {}) {
  const n = Math.round(seconds * 16000),
    out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 16000,
      envelope =
        Math.max(0, Math.sin(Math.PI * 2 * (syllables / 2) * t)) ** 0.6 *
        (Math.sin(Math.PI * t * 0.7) > -0.2 ? 1 : 0.15);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * pitch * h * t) * (h === 4 || h === 9 ? 1.2 : 1 / h);
    out[i] = s * 0.3 * envelope * loud * 3;
  }
  return out;
}
function pcm(samples) {
  return Int16Array.from(samples, s => Math.max(-1, Math.min(1, s)) * 32767);
}
// 20 ms frames, in real time: what this person hears (the agent and others), then the agent's own while it speaks
async function stream(ws, { agent = null, other = null }) {
  const frames = Math.max(agent?.length ?? 0, other?.length ?? 0) / 320;
  const start = Date.now();
  for (let k = 0; k < frames; k++) {
    const a = agent?.subarray(k * 320, k * 320 + 320),
      o = other?.subarray(k * 320, k * 320 + 320);
    const heard = new Float32Array(320);
    for (let i = 0; i < 320; i++) heard[i] = (a?.[i] ?? 0) + (o?.[i] ?? 0);
    const mine = a?.some(x => x !== 0) ? pcm(Object.assign(new Float32Array(320), a)) : null;
    const frame = mine
      ? Buffer.concat([Buffer.from(pcm(heard).buffer), Buffer.from(mine.buffer)])
      : Buffer.from(pcm(heard).buffer);
    ws.send(frame);
    const wait = start + (k + 1) * 20 - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

async function room(context, script) {
  const line = { joins: [], frames: [], texts: [], ws: null };
  await context.routeWebSocket(/\/voice\/join$/, ws => {
    line.ws = ws;
    ws.onMessage(m => {
      if (typeof m !== 'string') return void line.frames.push([Date.now(), Buffer.from(m).length]);
      const ev = JSON.parse(m);
      line.texts.push(ev);
      if (ev.type === 'join') {
        line.joins.push(ev);
        script(ws, ev, line);
      }
    });
  });
  return line;
}
const people = (...list) => list.map(([id, name, muted]) => ({ id, name, ...(muted ? { muted } : {}) }));

// How open the mouth is, sampled every 40 ms while fn runs
async function mouthDuring(page, fn) {
  const samples = [];
  let done = false;
  const sampling = (async () => {
    while (!done) {
      samples.push(
        await page.evaluate(() => {
          const el = document.querySelector('[data-part=mouth-open]');
          return new DOMMatrixReadOnly(getComputedStyle(el).transform).d;
        }),
      );
      await sleep(40);
    }
  })();
  await fn();
  done = true;
  await sampling;
  return samples;
}

async function lobbyChecks(context, label) {
  const page = await context.newPage();
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  const errors = errorsOf(page);
  page.on('console', m => m.type() === 'error' && !shooting && errors.push(`${m.text()} (${m.location().url})`));
  const response = await page.goto(`${base}/join/${TOKEN}`);
  ok(/default-src 'none'/.test(response.headers()['content-security-policy']), 'the page has a strict CSP');
  await page.waitForTimeout(400);
  ok(
    (await page.textContent('.plate')).trim() === 'Ada (AI) · Testco',
    'the agent is named as an AI, with the company',
  );
  ok(
    (await page.textContent('.notice')).includes(
      'Ada is an AI assistant. We keep a written transcript of this call, never a recording.',
    ),
    'the notice is there before joining',
  );
  ok((await page.getAttribute('.notice a', 'href')) === PRIVACY, 'the notice links the privacy page');
  ok(
    (await page.getAttribute('.agent', 'data-ai-generated')) === 'true',
    "the agent's tile is marked as AI in the page's data",
  );
  ok((await page.getAttribute('.captions', 'data-ai-generated')) === 'true', 'and so are its captions');
  ok(await page.isVisible('[data-part=mouth-shut]'), 'the drawing is the company’s own (its named parts)');
  ok((await page.textContent('.until')).length > 10, 'the page says until when the link works');
  await shot(page, `${SHOTS}/${label}-lobby.png`);
  await page.click('.join');
  ok(await page.isVisible('.error'), 'joining without a name asks for one first');
  const long = 'Maria Guadalupe Fernández de Córdoba y Figueroa ' + 'é'.repeat(23);
  await page.fill('#name', long);
  await page.click('.join');
  ok(
    (await page.inputValue('#name')) === long && /\b71\b.*\b70\b/.test(await page.textContent('.error')),
    'a name past the most the call takes is kept as typed, and the page says how long it is and what fits',
  );
  ok(
    requests.every(u => u.startsWith(base)),
    'nothing comes from another site',
  );
  ok(errors.length === 0, `no errors on the page: ${errors.join('; ')}`);
  await page.close();
}

async function callChecks(context, label) {
  // the room gives the page its place's private key besides the id everyone's list shows: a rejoin carries the key
  const key = 'k-7f3a9c';
  const line = await room(context, (ws, ev) => {
    ws.send(
      JSON.stringify({
        type: 'room',
        you: 'p1',
        key,
        people: people(['p1', ev.name]),
        agent: { name: 'Ada', look: 'ada' },
      }),
    );
  });
  const page = await context.newPage();
  const errors = errorsOf(page);
  await page.goto(`${base}/join/${TOKEN}`);
  await page.fill('#name', 'Sam: (Partner Co)');
  await page.click('.join');
  await page.waitForSelector('.controls:not([hidden])');
  ok(
    line.joins[0]?.token === TOKEN && line.joins[0]?.name === 'Sam (Partner Co)',
    'the line gets the token and the name, without colons',
  );
  ok(
    (await page.textContent('.people li')).includes('Sam (Partner Co)'),
    'the person is in the list, marked as themself',
  );
  const storage = await page.evaluate(() => ({
    session: { ...sessionStorage },
    local: localStorage.length,
    cookies: document.cookie,
  }));
  ok(
    JSON.stringify(storage.session) === JSON.stringify({ 'join-name': 'Sam (Partner Co)' }) &&
      !storage.local &&
      !storage.cookies,
    'the page keeps only the name, in sessionStorage',
  );
  await page.waitForTimeout(600);
  ok(
    line.frames.length >= 15 && line.frames.every(([, n]) => n === 640 || n === 1280),
    `the microphone's frames reach the line (${line.frames.length})`,
  );

  // the agent speaks: its mouth moves with its voice, the captions show its words; then it shuts
  line.ws.send(
    JSON.stringify({
      type: 'said',
      text: 'Hi, this is Ada from Testco. I’m an AI assistant, calling about our parcel.',
    }),
  );
  const sentBefore = line.frames.length;
  const speaking = await mouthDuring(page, async () => {
    const voiced = stream(line.ws, { agent: voiceOf(2.4) });
    await sleep(1100);
    await shot(page, `${SHOTS}/${label}-speaking.png`);
    await voiced;
    await sleep(600);
  });
  drawn(Math.max(...speaking) > 0.4, `the mouth opens with the voice (${Math.max(...speaking).toFixed(2)})`);
  // (by how many shapes it took)
  const shapes = new Set(speaking.map(v => v.toFixed(2))).size;
  drawn(shapes >= 12, `and moves with it, not stuck (${shapes} shapes)`);
  const shut = await page
    .waitForFunction(() => getComputedStyle(document.querySelector('[data-part=mouth-open]')).opacity === '0', null, {
      timeout: 3000,
    })
    .catch(() => null);
  drawn(shut, 'and shuts once the voice has played');
  ok(
    (await page.textContent('.captions')).includes('calling about our parcel'),
    'the captions show what the agent says',
  );
  ok(
    line.frames.slice(sentBefore).some(([, n]) => n === 1280),
    'while it plays, the frames carry what played, for the echo canceller',
  );

  // a second person joins and talks: their ring, the agent listens and looks at them, its mouth stays shut
  line.ws.send(JSON.stringify({ type: 'people', people: people(['p1', 'Sam (Partner Co)'], ['p2', 'Kim']) }));
  await page.waitForSelector('.people li[data-id="p2"]');
  line.ws.send(JSON.stringify({ type: 'talking', id: 'p2' }));
  const listening = await mouthDuring(page, async () => {
    await stream(line.ws, { other: voiceOf(1.2, { pitch: 210 }) });
  });
  ok(
    await page.evaluate(() => document.querySelector('.people li[data-id="p2"]').classList.contains('talking')),
    'the person talking has a ring',
  );
  ok((await page.getAttribute('.agent', 'data-state')) === 'listening', 'the agent listens while someone talks');
  drawn(Math.max(...listening) < 0.05, "the agent's mouth stays shut while someone else talks");
  await shot(page, `${SHOTS}/${label}-listening.png`);
  line.ws.send(JSON.stringify({ type: 'talking', id: null }));

  // a tool step: thinking
  line.ws.send(JSON.stringify({ type: 'tick' }));
  await page.waitForTimeout(500);
  ok((await page.getAttribute('.agent', 'data-state')) === 'thinking', 'a tool step shows the agent thinking');
  ok(
    await page.evaluate(() => getComputedStyle(document.querySelector('.thought')).opacity > 0.5),
    'with its thought bubble',
  );
  await shot(page, `${SHOTS}/${label}-thinking.png`);
  line.ws.send(JSON.stringify({ type: 'state', state: 'listening' }));

  // mute: the line hears so, and gets no frames
  await page.click('.mute');
  await page.waitForTimeout(150);
  const mutedAt = line.frames.length;
  await page.waitForTimeout(500);
  ok(
    line.texts.some(t => t.type === 'mute' && t.on === true),
    'mute tells the line',
  );
  ok(line.frames.length === mutedAt, 'and sends no microphone while muted');
  await page.click('.mute');

  // a dropped connection: back into the same room
  line.ws.close({ code: 4500, reason: 'dropped' });
  await page.waitForTimeout(1500);
  ok(
    line.joins.at(-1)?.rejoin === key,
    "a dropped connection rejoins the same place in the room, with its private key, not the list's id",
  );
  ok(
    (await page.textContent('.people li')).includes('Sam (Partner Co)') &&
      (await page.$$('.people li small')).length === 1,
    'and is still the one person marked as themself',
  );
  ok(await page.isHidden('.reconnecting'), 'and the page is back in the call');

  // leaving
  await page.click('.leave');
  await page.waitForSelector('.over:not([hidden])');
  ok(
    line.texts.some(t => t.type === 'bye'),
    'Leave says bye to the line',
  );
  ok(
    (await page.textContent('.over')).includes('You left the call.') && (await page.isVisible('.rejoin')),
    'and offers a way back in',
  );

  // rejoin, and the agent hangs up after its last words
  await page.click('.rejoin');
  await page.waitForSelector('.controls:not([hidden])');
  line.ws.send(JSON.stringify({ type: 'said', text: 'Thanks, bye!' }));
  const goodbye = stream(line.ws, { agent: voiceOf(0.8) });
  await sleep(200);
  line.ws.send(JSON.stringify({ type: 'hangup' }));
  await goodbye;
  ok(await page.isVisible('.controls'), 'the hang-up waits for the last words to play');
  await page.waitForSelector('.over:not([hidden])', { timeout: 4000 });
  ok(
    (await page.textContent('.over')).includes('The call has ended.') && (await page.isHidden('.rejoin')),
    'the agent hanging up ends the call, with no rejoin',
  );
  await shot(page, `${SHOTS}/${label}-ended.png`);
  ok(errors.length === 0, `no errors on the page: ${errors.join('; ')}`);
  await page.close();
}

async function refused(context, code, words, label) {
  await room(context, ws => ws.close({ code, reason: 'no' }));
  const page = await context.newPage();
  await page.goto(`${base}/join/${TOKEN}`);
  await page.fill('#name', 'Sam');
  await page.click('.join');
  await page.waitForSelector('.over:not([hidden])', { timeout: 5000 });
  ok((await page.textContent('.over')).includes(words), `${label}: says so`);
  if (label === 'closed') await shot(page, `${SHOTS}/laptop-closed.png`);
  await page.close();
}

async function languages(context) {
  const page = await context.newPage();
  await page.goto(`${base}/join/${TOKEN}?later`);
  ok(
    (await page.isDisabled('.join')) && (await page.textContent('.until')).startsWith('The call opens at'),
    'a call at a set time: Join waits until the link opens, and says when',
  );
  await page.goto(`${base}/join/${TOKEN}?lang=de`);
  ok(
    (await page.textContent('.plate')).trim() === 'Ada (KI) · Testco' &&
      (await page.getAttribute('html', 'lang')) === 'de',
    'German: KI, and the page in German',
  );
  await page.goto(`${base}/join/${TOKEN}?lang=nl`);
  ok((await page.textContent('.notice')).includes('Ada is een AI-assistent.'), 'Dutch words');
  await page.goto(`${base}/join/${'Gx'.repeat(21)}Q`);
  ok(
    (await page.$('[data-part=light]')) !== null && (await page.textContent('.plate')).includes('Bo (AI)'),
    "an agent without a drawing gets the platform's figure",
  );
  await shot(page, `${SHOTS}/laptop-generic.png`);
  await page.close();
}

// ---- the real voice line
// It starts on a free port, the page's /voice/join goes through to it, and the microphone says something loud for a
// second every four (the stand-in hears "Can you hear me?" in anything loud).
async function realLine(python) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const process_ = spawn(python, ['-u', new URL('../voice/room_standin.py', import.meta.url).pathname, String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    process_.stdout.on('data', d => String(d).includes('ready') && resolve());
    process_.on('exit', code => reject(new Error(`room_standin.py ended (${code})`)));
    setTimeout(() => reject(new Error('room_standin.py never said ready')), 60_000);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(port, '127.0.0.1', () => {
      const headers = req.rawHeaders.map((v, i) => (i % 2 ? `${v}\r\n` : `${v}: `)).join('');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });
  const voice = `${DATA}/microphone.wav`;
  writeFileSync(voice, wav([...voiceOf(1.2), ...new Float32Array(2.8 * 16000)]));
  return { process: process_, voice };
}

async function withRealLine() {
  const context = await browser.newContext({ ...LAPTOP, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = errorsOf(page);
  await page.goto(`${base}/join/${TOKEN}`);
  await page.fill('#name', 'Sam');
  await page.click('.join');
  await page.waitForSelector('.controls:not([hidden])', { timeout: 15_000 });
  ok((await page.textContent('.people')).includes('Sam'), 'real line: the room has the person in it');
  const opening = await mouthDuring(page, () =>
    page
      .waitForFunction(
        () => document.querySelector('.captions').textContent.includes('calling about our parcel'),
        null,
        { timeout: 15_000 },
      )
      .then(() => sleep(2500)),
  );
  ok(true, 'real line: the agent says the opening first, in the captions');
  drawn(Math.max(...opening) > 0.3, `real line: the mouth moves with the opening (${Math.max(...opening).toFixed(2)})`);
  await shot(page, `${SHOTS}/real-line-opening.png`);
  await page.waitForFunction(() => document.querySelector('.captions').textContent.includes('I hear you'), null, {
    timeout: 30_000,
  });
  ok(true, 'real line: a question from the microphone gets its answer');
  await page.click('.leave');
  await page.waitForSelector('.over:not([hidden])');
  ok((await page.textContent('.over')).includes('You left the call.'), 'real line: leaving');
  ok(errors.length === 0, `real line: no errors on the page: ${errors.join('; ')}`);
  await context.close();
}

// 16 kHz mono 16-bit WAV
function wav(samples) {
  const data = Buffer.from(pcm(samples).buffer),
    head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
}

try {
  if (line) await withRealLine();
  else
    for (const [label, size] of [
      ['laptop', LAPTOP],
      ['phone', PHONE],
    ]) {
      const context = await browser.newContext({ ...size, permissions: ['microphone'] });
      await lobbyChecks(context, label);
      await callChecks(context, label);
      const page = await context.newPage();
      await page.goto(`${base}/join/${TOKEN}`);
      ok(!(await overflow(page)), `${label}: nothing runs off the side`);
      await page.close();
      if (label === 'laptop') {
        await languages(context);
        await refused(
          await browser.newContext({ ...LAPTOP, permissions: ['microphone'] }),
          4004,
          'This link has closed.',
          'closed',
        );
        await refused(
          await browser.newContext({ ...LAPTOP, permissions: ['microphone'] }),
          4009,
          'This call is full.',
          'full',
        );
      }
      await context.close();
    }
  console.log(
    `join-check: ${checked} checks passed${skipped ? `, ${skipped} on the drawing's motion skipped (WebKit)` : ''}, screenshots in ${SHOTS}`,
  );
} finally {
  await browser.close();
  server.close();
  line?.process.kill();
  rmSync(DATA, { recursive: true, force: true });
}
