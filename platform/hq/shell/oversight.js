// Settings › Overseer: the key HQ made for the Overseer to read the status report and the CEO's notes, copied for the
// board to add as a network secret on the Overseer's cloud environment, never pasted in its chat (infra/overseer/
// AGENTS.md); and a new key, which ends the old one.
import { esc } from '../util.js';
import { loadOversight, renewOversightKey } from './data.js';
import { askAgain } from '/ask.js';
import { sfx } from './audio.js';

export async function oversight(el, { dev, ago }) {
  const shown = await loadOversight(dev);
  el.innerHTML = `<div class="alerts oversight"><p class="cap"><i class="prompt">&gt; </i>THE OVERSEER · READ ONLY</p>
    <p>The Overseer reads the server’s status report and the CEO’s notes here, with a key of its own. Nothing else, and it
    can’t change anything.</p>
    <p>Give it the key as a network secret, never in its chat:</p>
    <ol><li>Open the Overseer’s session at claude.ai/code.</li>
    <li>Tap the caret after its title, then <b>Edit cloud environment</b>.</li>
    <li>Tap <b>Network secrets</b>, then <b>Add secret</b>.</li>
    <li>Host: <b>${esc(new URL(shown.address).host)}</b>. Type: <b>Bearer</b>. Value: the key (<b>Copy the key</b>, below).</li></ol>
    <p class="acts"><button class="cta" data-copy>Copy the key</button><button data-renew>New key</button></p>
    <p class="msg" role="status"></p>
    <p class="dim">${shown.read ? `Last read ${esc(ago(shown.read))}.` : 'Not read yet.'}</p></div>`;
  const msg = el.querySelector('.msg');
  el.querySelector('[data-copy]').onclick = copyKey(el, msg, shown.key);
  const renewButton = el.querySelector('[data-renew]');
  askAgain(renewButton, {
    status: msg,
    label: 'New key',
    again: 'Tap again to end the old key',
    question: 'The Overseer stops reading until it has the new key.',
    act: async () => {
      sfx.blip();
      renewButton.disabled = true;
      try {
        await renewOversightKey(dev);
        await oversight(el, { dev, ago });
        el.querySelector('.msg').textContent =
          'New key made. In the Overseer’s network secrets, delete the old secret and add a new one with this key.';
      } catch (err) {
        renewButton.disabled = false;
        msg.textContent = err.refusal?.error ?? 'Didn’t change';
      }
    },
  });
}

// Copy the key: to the clipboard, or where there's none, the key itself, selected, to copy by hand
const copyKey = (el, msg, key) => async e => {
  sfx.blip();
  try {
    await navigator.clipboard.writeText(key);
    e.target.textContent = 'Copied';
    msg.textContent = 'Paste it as the network secret’s value.';
  } catch {
    let box = el.querySelector('textarea');
    if (!box) {
      box = Object.assign(document.createElement('textarea'), { readOnly: true, rows: 2 });
      e.target.closest('.acts').after(box);
    }
    box.value = key;
    box.select();
  }
};
