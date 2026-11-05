#!/usr/bin/env node
// A guest goes on with the call the board left (callguests.ts, bookguestcall.js, callguest.js askHangUp), on the real
// coordinator, the voice line played by the check: the board's Hang up with Esmee on the call's page asks first, and
// Leave it to Esmee tells the line 'leave'; Esmee's iPad, on the call's page, shows nothing while the board is on, then
// the bar with the AI and transcript notice; her tap starts the microphone, takes a one-time ticket the line redeems,
// and carries the call (the agent's voice playing, her microphone going out); the board calling back in quiets it; left
// to her again, the agent's hang-up ends it on her device.
// Screenshots of each step.
//   node platform/hq/guestcall-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { launched } from '../../shared/browser/browser.mjs';
import { devices, said } from './book/devicecheck.mjs';
import { coordinator } from './book/guestserver.mjs';

const LANDSCAPE = { width: 1180, height: 820 },
  PORTRAIT = { width: 820, height: 1180 };

const state = await coordinator();
const { h, origin } = state;
// (Chromium's own fake microphone, a beep: call-check.mjs)
const browser = await launched({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
assert.ok(browser, 'no Chromium for Playwright');
const check = devices(browser, state),
  { shot } = check;
// A device with a microphone that plays the call's sound
async function device(viewport, cookie) {
  const opened = await check.open(viewport, cookie, { permissions: ['microphone'], bypassCSP: true });
  // (an audio worklet's own request never reaches the route: its script comes through fetch, which does, as a blob,
  // under bypassCSP)
  await opened.context.addInitScript(() => {
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function (url, options) {
      const script = await (await fetch(url)).text();
      return add.call(this, URL.createObjectURL(new Blob([script], { type: 'text/javascript' })), options);
    };
  });
  return opened;
}
// A scan of the call's code, as her iPad's camera opens it: her name, and her session's cookie
async function scan(link, name) {
  const r = await fetch(h.base + new URL(link).pathname, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: `name=${encodeURIComponent(name)}`,
    redirect: 'manual',
  });
  assert.equal(r.status, 303);
  return {
    cookie: r.headers.get('set-cookie').split(';')[0],
    notebook: Number(new URL(r.headers.get('location'), origin).searchParams.get('notebook')),
  };
}
const until = async (ready, what, ms = 20_000) => {
  for (const stop = Date.now() + ms; !(await ready()); await new Promise(r => setTimeout(r, 50)))
    if (Date.now() > stop) throw new Error(`still waiting: ${what}`);
};

try {
  const { call, token } = await h.liveCall('juno');
  said(await h.board('/api/notebooks/call', { call }));
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  const esmee = await scan(link, 'Esmee');

  // The board's HQ on its call, the line played: Hang up with Esmee on the page asks, Leave it to Esmee says 'leave'
  const board = await device(LANDSCAPE, h.boardCookie);
  const line = { got: [] };
  await board.context.routeWebSocket(/\/voice\/ws$/, ws =>
    ws.onMessage(m => {
      if (typeof m !== 'string') return;
      const e = JSON.parse(m);
      line.got.push(e);
      if (e.agent) ws.send(JSON.stringify({ type: 'call', id: 'line', call, key: 'k' }));
    }),
  );
  const listening = board.page.waitForRequest(r => new URL(r.url()).pathname === '/api/events', { timeout: 60_000 });
  await board.page.goto(`${origin}/?intro=0&open=intercom`);
  await listening;
  await board.page.click('#call');
  await board.page.waitForFunction(() => document.querySelector('#call-guest')?.disabled === false, null, {
    timeout: 30_000,
  });
  // (her join, as HQ's events bring it: callguest.js)
  await board.page.evaluate(
    at => document.dispatchEvent(new CustomEvent('call:guest', { detail: { call: at, name: 'Esmee' } })),
    call,
  );
  await until(() => line.got.some(e => e.type === 'guest' && e.name === 'Esmee'), 'the line told her name');
  await board.page.click('#call-end');
  const card = board.page.locator('#call-guest-card');
  await card.getByText('Esmee can go on with Juno on their own device.').waitFor();
  await shot('1-board-hang-up-asks', board.page);
  await card.getByRole('button', { name: 'Leave it to Esmee' }).click();
  await until(() => line.got.some(e => e.type === 'leave'), "the line heard 'leave'");
  assert.ok(!line.got.some(e => e.type === 'bye'), "no 'bye': the call goes on");
  await board.page.getByText('You left the call with Juno').waitFor();
  await shot('2-board-left', board.page);

  // Her iPad on the call's page: nothing while the board is on
  const her = await device(PORTRAIT, esmee.cookie);
  const voice = { tickets: [], frames: 0, ws: null, bye: false };
  await her.context.routeWebSocket(/\/voice\/guest$/, ws => {
    voice.ws = ws;
    ws.onMessage(async m => {
      if (typeof m !== 'string') return void voice.frames++;
      const { type, ticket } = JSON.parse(m);
      if (type === 'bye') return void (voice.bye = true);
      voice.tickets.push(ticket);
      // (the line redeems it with the coordinator, as guest_call does)
      const r = await h.voice('guest-ticket', { ticket });
      if (r.status !== 200) return ws.close({ code: 4000, reason: 'gone' });
      voice.carried = r.body;
      ws.send(JSON.stringify({ type: 'call', id: 'line' }));
      ws.send(JSON.stringify({ type: 'state', state: 'speaking' }));
      ws.send(JSON.stringify({ type: 'said', text: 'Hoi Esmee.' }));
      ws.send(Buffer.from(new Int16Array(320 * 25).fill(800).buffer));
    });
  });
  await her.page.goto(`${origin}/guest/notebooks/?notebook=${esmee.notebook}`);
  await her.page.locator('#book .bk-paper').waitFor({ state: 'attached', timeout: 60_000 });
  await her.page.waitForTimeout(2000);
  assert.equal(await her.page.locator('.bk-guest-call').isVisible(), false, 'no bar while the board is on');

  // The line's word that the board left: the bar, the notice first
  said(await h.voice('call-away', { agent: 'juno', token, away: true }));
  const bar = her.page.locator('.bk-guest-call');
  await bar
    .getByText('Juno is een AI-assistent. We houden een geschreven verslag van dit gesprek bij, nooit het geluid.')
    .waitFor({ timeout: 10_000 });
  await bar.getByText('Je browser vraagt om je microfoon.').waitFor();
  await shot('3-her-bar', her.page);
  await bar.getByRole('button', { name: 'Praat met Juno' }).tap();
  await bar.getByText('Je praat met Juno op dit apparaat.').waitFor({ timeout: 10_000 });
  await bar.getByText('Praat', { exact: true }).waitFor();
  assert.deepEqual(voice.carried, { call, name: 'Esmee', lang: 'nl' });
  await until(() => voice.frames > 10, 'her microphone going out');
  await shot('4-her-call', her.page);

  // The board calls back in: her device quiets, and says why
  voice.ws.close({ code: 4002, reason: 'board' });
  said(await h.voice('call-away', { agent: 'juno', token, away: false }));
  await bar.getByText('Het gesprek loopt weer via het andere apparaat.').waitFor({ timeout: 10_000 });
  await shot('5-board-back', her.page);
  await bar.waitFor({ state: 'hidden', timeout: 15_000 });
  assert.equal(voice.tickets.length, 1, 'one ticket, used once');

  // Left to her again, and the agent hangs up: her device ends the call as her own hang-up would, and says it ended
  said(await h.voice('call-away', { agent: 'juno', token, away: true }));
  await bar.getByRole('button', { name: 'Praat met Juno' }).tap();
  await until(() => voice.tickets.length === 2, 'her second ticket');
  await bar.getByText('Praat', { exact: true }).waitFor({ timeout: 10_000 });
  voice.ws.send(JSON.stringify({ type: 'hangup' }));
  await bar.getByText('Het gesprek is afgelopen.').waitFor({ timeout: 10_000 });
  assert.ok(voice.bye, "her device said 'bye'");
  await shot('6-agent-hung-up', her.page);
  check.clean();
  console.log(
    'PASS guestcall: the board leaves its call to Esmee, her iPad carries it, the board comes back, the agent hangs up',
  );
} finally {
  await check.close();
}
