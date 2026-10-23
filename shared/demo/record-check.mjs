#!/usr/bin/env node
// Checks that record.mjs lets animations end: a page that awaits a Web Animation's `finished` or listens for its
// finish event gets them on the frame the recording clock passes its end (as a CSS animation's animationend), one the
// page plays again ends again, an endless one keeps moving, and one stopped at playback rate 0 (which can't be
// finished) is seeked without ending the recording. And that an app with a strict CSP gets the cursor's own look, and
// one whose checkout sends it to another address and back is followed there and back
//   node shared/demo/record-check.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, HERE } from './core.mjs';

let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

// Every animation starts 0.2 s into the recording; `log` keeps what fired and when, on the page's (fake) clock.
const page = `<!doctype html><style>@keyframes spin{to{rotate:1turn}} @keyframes grow{to{scale:2}}
  div{width:40px;height:40px;background:#c63} #css.go{animation:grow .3s 2 forwards} #spin.go{animation:spin 1s linear infinite}</style>
  <div id=waapi></div><div id=css></div><div id=spin></div><div id=stopped></div><script>
  const log = window.log = [], at = (what) => log.push([what, Date.now() - t0]); let t0;
  setTimeout(async () => {
    t0 = Date.now();
    const an = document.getElementById('waapi').animate({ opacity: [0, 1] }, { duration: 500, delay: 100, fill: 'forwards' });
    an.onfinish = () => at('onfinish');
    document.getElementById('stopped').animate({ opacity: [0, 1] }, { duration: 300, fill: 'forwards' }).playbackRate = 0;
    for (const id of ['css', 'spin']) document.getElementById(id).classList.add('go');
    document.getElementById('css').onanimationend = () => at('animationend');
    await an.finished; at('finished');
    await new Promise((ok) => setTimeout(ok, 200)); at('after');
    an.play(); await an.finished; at('again');
  }, 200);
</script>`;

const fps = 30;
const dir = mkdtempSync(join(tmpdir(), 'record-check-'));
try {
  const flow = join(dir, 'flow.json');
  writeFileSync(join(dir, 'page.html'), page);
  writeFileSync(
    flow,
    JSON.stringify({
      url: 'file://' + join(dir, 'page.html'),
      viewport: { width: 200, height: 200, scale: 1 },
      fps,
      steps: [
        { wait: 2 },
        { eval: 'window.log', mark: 'log' },
        { eval: "document.getElementById('spin').getAnimations()[0].currentTime", mark: 'spin' },
        { eval: "document.getElementById('stopped').getAnimations()[0].playState", mark: 'stopped' },
      ],
    }),
  );
  await run(process.execPath, [join(HERE, 'record.mjs'), flow], { stdio: ['ignore', 'ignore', 'inherit'] });
  const { events } = JSON.parse(readFileSync(join(dir, 'flow.events.json'), 'utf8'));
  const log = Object.fromEntries(events.find(e => e.type === 'log').value.reverse()); // the first time each fired
  const spin = events.find(e => e.type === 'spin').value;
  const stopped = events.find(e => e.type === 'stopped').value;
  const frame = 1000 / fps,
    firstFrameFrom = (at, end) => at >= end && at < end + frame + 1;
  check(
    firstFrameFrom(log.finished, 600),
    "awaiting a Web Animation's finished resumes once its 600 ms are past",
    `${log.finished} ms`,
  );
  check(firstFrameFrom(log.onfinish, 600), 'its finish event fires', `${log.onfinish} ms`);
  check(firstFrameFrom(log.after, 800), 'the flow after it runs on (a 200 ms timer)', `${log.after} ms`);
  check(
    firstFrameFrom(log.animationend, 600),
    "a CSS animation's animationend fires (2 × 300 ms)",
    `${log.animationend} ms`,
  );
  check(firstFrameFrom(log.again, 1400), 'one played again finishes again', `${log.again} ms`);
  check(spin > 1600, 'an endless animation keeps being seeked', `currentTime ${spin} ms`);
  check(stopped === 'paused', 'one at playback rate 0 is seeked, not finished, and the recording runs on', stopped);

  // The app uses `style-src 'self'` and its payment page on 127.0.0.1 sends a buyer back only to localhost.
  // The overlay's styles must hold, and the recording must follow the page both ways.
  writeFileSync(
    join(dir, 'app.mjs'),
    `import { createServer } from 'node:http';
const csp = { 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'" };
const pay = createServer((q, r) => {
  const back = new URL(new URL(q.url, 'http://x').searchParams.get('back'));
  r.writeHead(200, { 'content-type': 'text/html', ...csp });
  r.end(back.hostname === 'localhost' ? '<a id=pay href="' + back.origin + '/?paid=1">Pay</a>' : 'not sent back');
}).listen(0, '127.0.0.1');
createServer((q, r) => {
  if (q.url === '/app.js') {
    r.writeHead(200, { 'content-type': 'text/javascript' });
    return r.end("if (location.search === '?paid=1') document.body.append(Object.assign(document.createElement('p'), { id: 'done', textContent: 'Paid' }));" +
      "buy.onclick = () => setTimeout(() => { location = 'http://127.0.0.1:" + pay.address().port + "/?back=' + location.origin; }, 50);");
  }
  r.writeHead(200, { 'content-type': 'text/html', ...csp });
  r.end('<body><button id=buy>Buy</button><script src=/app.js></script></body>');
}).listen(process.env.PORT);
`,
  );
  const cursor =
    "document.getElementById('__demo_cursor').shadowRoot.querySelector('.c').getBoundingClientRect().width";
  writeFileSync(
    flow,
    JSON.stringify({
      serve: 'app.mjs',
      viewport: { width: 200, height: 200, scale: 1 },
      fps,
      steps: [
        { wait: 0.2 },
        { eval: cursor, mark: 'cursor' },
        { tap: '#buy' },
        { waitFor: '#pay' },
        { tap: '#pay' },
        { waitFor: '#done' },
        { eval: 'location.host', mark: 'back' },
      ],
    }),
  );
  await run(process.execPath, [join(HERE, 'record.mjs'), flow], { stdio: ['ignore', 'ignore', 'inherit'] });
  const shop = JSON.parse(readFileSync(join(dir, 'flow.events.json'), 'utf8')).events;
  const value = type => shop.find(e => e.type === type)?.value;
  check(value('cursor') === 24, "under style-src 'self' the cursor keeps its 24 px", `${value('cursor')} px`);
  check(
    /^localhost:/.test(value('back') ?? ''),
    'a checkout on another address is followed there and back',
    value('back'),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
