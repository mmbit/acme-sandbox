// The call's agent's raised hand, in a design session (the voice line's design.py): it has something worth adding and
// won't talk over the people in the room. The hand shows big on the call's screen, over the agent's little screen, and
// on the bubble while the call is small, with what it's about under it, and a soft beep goes once as it goes up. The
// line gives the agent its moment at a natural pause; a tap on the hand gives it now ({ type: 'hand' } to the line).
// The line lowers it ({ type: 'hand', up: false }) as the agent speaks.
import { esc } from '../util.js';
import { cue } from './audio.js';

// A raised hand, palm out, drawn in one stroke of the call's ink (currentColor)
const HAND = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M16 26V11a3 3 0 0 1 6 0v11V7a3 3 0 0 1 6 0v15V9a3 3 0 0 1 6 0v15-9a3 3 0 0 1 6 0v15c0 8-6 14-14 14-5 0-8-2-11-6l-7-9a3 3 0 0 1 5-4z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

// The line's word on the hand: up (with what it's about) or down
export function handFromLine(c, ev) {
  const up = ev.up === true;
  if (up && !c.hand) cue('handUp');
  c.hand = up ? { about: String(ev.about ?? '') } : null;
  paintHand(c);
}

// The hand drawn where the call shows now: on its screen, and on its bubble while it's small. A tap on either gives
// the agent its moment at once.
export function paintHand(c) {
  for (const host of [c.layer?.querySelector('#call-screen'), c.bubble?.el]) {
    if (!host) continue;
    let key = host.querySelector(':scope > .call-hand');
    if (!c.hand) {
      key?.remove();
      continue;
    }
    if (!key) {
      key = document.createElement('button');
      key.type = 'button';
      key.className = 'call-hand';
      key.setAttribute('data-no-ink', '');
      key.onclick = e => {
        e.stopPropagation(); // (not the bubble's tap, which opens the call)
        tapped(c);
      };
      host.append(key);
    }
    const label = `${c.name} has a hand up${c.hand.about ? `: ${c.hand.about}` : ''}. Tap to let ${c.name} speak.`;
    key.setAttribute('aria-label', label);
    key.title = label;
    key.innerHTML = `${HAND}${c.hand.about && host !== c.bubble?.el ? `<span>${esc(c.hand.about)}</span>` : ''}`;
  }
}

function tapped(c) {
  if (c.ws?.readyState !== 1) return;
  c.ws.send(JSON.stringify({ type: 'hand' }));
  c.layer?.querySelector('.call-hand')?.classList.add('called');
  c.bubble?.el.querySelector('.call-hand')?.classList.add('called');
}
