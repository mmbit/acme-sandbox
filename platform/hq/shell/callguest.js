// The call screen's Join from an iPad: whoever is in the room with the board joins this call's page from a device of
// their own, with their own pen, muted (the coordinator's callguests.ts). The card shows at once the call's one QR code
// and its link, the same for every device and every scan, in the call's language; their join page says first that the
// agent is an AI and the call is written down, asks their name (remembered on the device), and the call's page opens.
// Good until the call ends. (the QR code in place of a guest's name and email)
import { act } from './data.js';
import { esc } from '../util.js';
import { qrCode, qrPath } from '/shared/qr/qr.js';

let joining = null; // (the call whose joins it hears, guestKey.)

// The key waits for the call to pick up (call.js asks again then), and goes with its end
export function guestKey(c) {
  joining = c; // (whose joins it hears)
  const key = c.layer?.querySelector('#call-guest');
  if (key) key.disabled = !c.call || !!c.over;
}

// The line hears of each guest added, so the agent takes its part in a shared session from then on, before their
// voice is told apart from the board's (the line's voices.py joined): at once, and again at each pick-up after a
// reconnect (the line takes each name once).
export function guestsToLine(c) {
  if (c.ws?.readyState !== 1) return;
  for (const name of c.guests ?? []) c.ws.send(JSON.stringify({ type: 'guest', name }));
}

// Each join from the QR code, on the iPad: the coordinator's event (events.js), the name on the call's guests and to
// the line.
document.addEventListener('call:guest', e => {
  const c = joining;
  if (!c || c.over || e.detail?.call !== c.call) return;
  if (!(c.guests ??= []).includes(e.detail.name)) c.guests.push(e.detail.name);
  guestsToLine(c);
});

// The key shows the card with the call's QR code, and again hides it
export async function addGuest(c) {
  const card = c.layer?.querySelector('#call-guest-card');
  if (!card) return;
  if (!card.hidden) return void (card.hidden = true);
  card.hidden = false;
  card.dataset.ask = 'join';
  card.innerHTML = '<b>Join from an iPad</b><p>Making the code…</p>';
  try {
    // (the call's own language: its join page speaks it)
    const { link } = await act('/api/calls/guest', { call: c.call, lang: c.dial?.lang ?? 'en' });
    if (!card.hidden) shown(card, link);
  } catch (err) {
    card.querySelector('p').textContent = err.message;
  }
}

function shown(card, link) {
  const qr = qrCode(link, { level: 'M' }),
    n = qr.size + 8;
  card.innerHTML = `<b>Join from an iPad</b>
    <svg class="guest-qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="Scan to join this call’s page"><rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(qr)}"/></svg>
    <p>Scan on each iPad, or open the link: it opens this call’s page with its own pen, muted. Anyone who scans it can draw on this page only, until the call ends.</p>
    <a class="guest-link" target="_blank" rel="noopener noreferrer"></a>
    <button type="button" class="guest-close">Close</button>`;
  const a = card.querySelector('.guest-link');
  a.href = a.textContent = link;
  card.querySelector('.guest-close').onclick = () => (card.hidden = true);
}

// Hanging up with guests on the call's page asks first: end the call for everyone, or leave it to them, one of them
// going on with the agent on their own device (the line holds it for them: the coordinator's callguests.ts). Hang up
// again ends it.
export function askHangUp(c, { end, leave }) {
  const card = c.layer?.querySelector('#call-guest-card');
  if (!card || !c.guests?.length || !c.live) return end();
  if (!card.hidden && card.dataset.ask === 'hang-up') return end();
  const who = esc(listed(c.guests)),
    name = esc(c.name),
    own = c.guests.length > 1 ? 'devices' : 'device';
  card.dataset.ask = 'hang-up';
  card.hidden = false;
  card.innerHTML = `<b>Hang up</b><p>${who} can go on with ${name} on their own ${own}. Call ${name} again to come back, or to end it.</p>
    <div class="guest-keys"><button type="button" class="guest-leave">Leave it to ${who}</button><button type="button" class="guest-end">End for everyone</button><button type="button" class="guest-close">Cancel</button></div>`;
  card.querySelector('.guest-leave').onclick = leave;
  card.querySelector('.guest-end').onclick = end;
  card.querySelector('.guest-close').onclick = () => (card.hidden = true);
}
// Names as words: Esmee; Esmee and Sam; Esmee, Sam and Ana
export const listed = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
