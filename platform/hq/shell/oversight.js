// Settings › Overseer: the key HQ made for the Overseer to read the status report and the CEO's notes, copied with the
// address and how to read them, ready to paste to the Overseer; and a new key, which ends the old one.
import { esc } from '../util.js';
import { loadOversight, renewOversightKey } from './data.js';
import { askAgain } from '/ask.js';
import { sfx } from './audio.js';

export async function oversight(el, { dev, ago }) {
  const shown = await loadOversight(dev);
  el.innerHTML = `<div class="alerts oversight"><p class="cap"><i class="prompt">&gt; </i>THE OVERSEER · READ ONLY</p>
    <p>The Overseer reads the server’s status report and the CEO’s notes here, with a key of its own. Nothing else, and it
    can’t change anything.</p>
    <p class="acts"><button class="cta" data-copy>Copy for the Overseer</button><button data-renew>New key</button></p>
    <p class="msg" role="status"></p>
    <p class="dim">${shown.read ? `Last read ${esc(ago(shown.read))}.` : 'Not read yet.'}</p></div>`;
  const msg = el.querySelector('.msg');
  el.querySelector('[data-copy]').onclick = async e => {
    sfx.blip();
    const text = forOverseer(shown);
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied';
      msg.textContent = 'Paste it to the Overseer.';
    } catch {
      // (no clipboard: the text itself, selected, to copy by hand)
      let box = el.querySelector('textarea');
      if (!box) {
        box = Object.assign(document.createElement('textarea'), { readOnly: true, rows: 7 });
        e.target.closest('.acts').after(box);
      }
      box.value = text;
      box.select();
    }
  };
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
        el.querySelector('.msg').textContent = 'New key made. Copy it for the Overseer again.';
      } catch (err) {
        renewButton.disabled = false;
        msg.textContent = err.refusal?.error ?? 'Didn’t change';
      }
    },
  });
}

// What the Overseer needs, in one paste
const forOverseer = ({ company, address, key }) =>
  [
    `${company}'s HQ, read only, for the Overseer.`,
    `Address: ${address}`,
    `Key: ${key} (send it as the header "Authorization: Bearer <key>")`,
    'GET status: the server status report. Add ?since=<the x-as-of header of your last read> for only what changed (a diff).',
    "GET notes: the CEO's notes to you. ?since= works the same.",
  ].join('\n');
