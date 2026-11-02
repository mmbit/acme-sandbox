// The cog's small pop-up, the rail's (bookcontrols.js), beside it: this device's preferences (shared/review/prefs.js keeps them), each
// kept the moment it's changed. A press anywhere else, or Escape, closes it.
import { prefs, setPrefs, HOLDS } from '/__review/prefs.js';
import { hide, besideRail } from './bookui.js';
import { word } from './bookscope.js';

const HOLD_NAMES = { short: 'holdShort', medium: 'holdMedium', long: 'holdLong' };

// cog: the rail's button that opens it
export function mountPrefs(cog) {
  cog.setAttribute('aria-haspopup', 'dialog');
  cog.setAttribute('aria-expanded', 'false');
  let card = null;
  const close = () => {
    card?.remove();
    card = null;
    cog.setAttribute('aria-expanded', 'false');
    setPressed(false);
    removeEventListener('pointerdown', away, true);
    removeEventListener('keydown', away, true);
  };
  const away = e => {
    if (e.type === 'keydown' ? e.key === 'Escape' : !(card.contains(e.target) || cog.contains(e.target))) close();
  };
  const setPressed = on => cog.setAttribute('aria-pressed', on ? 'true' : 'false');
  cog.addEventListener('click', () => {
    if (card) return close();
    hide();
    card = filled();
    besideRail(card, cog);
    cog.setAttribute('aria-expanded', 'true');
    setPressed(true);
    card.querySelector('input')?.focus({ preventScroll: true });
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', away, true);
  });
}

function filled() {
  const p = prefs(),
    card = document.createElement('div');
  card.className = 'bk-card bk-prefs';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', word('preferences'));
  // (whether a finger always scrolls, and how long the pen held still outside the book takes to start a voice note:
  // review mode's, pentouch.js. Nothing in the book waits on a hold.)
  card.innerHTML = `<p class="bk-prefs-head">${word('onThisDevice')}</p>
    <label><input type="checkbox" name="penPans"${p.penPans ? ' checked' : ''}> ${word('penPans')}</label>
    <fieldset><legend>${word('voiceHold')}</legend>${Object.entries(HOLDS)
      .map(
        ([k, ms]) =>
          `<label><input type="radio" name="hold" value="${k}"${p.hold === k ? ' checked' : ''}> ${word(HOLD_NAMES[k])} <small>${ms} ms</small></label>`,
      )
      .join('')}</fieldset>`;
  card.addEventListener('change', e => {
    const input = e.target;
    setPrefs({ [input.name]: input.type === 'checkbox' ? input.checked : input.value });
  });
  return card;
}
