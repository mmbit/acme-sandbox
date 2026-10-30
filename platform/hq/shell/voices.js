// Settings › Voices: the people the board's calls recognise by voice, each with when it was saved and last heard, and a
// Delete that takes it away at once. Voices are saved on a call, by the agent: nothing to add here. desk.js's Settings
// draws it.
import { esc } from '../util.js';
import { sfx } from './audio.js';
import { companyFormats } from '../world/clock.js';
import { loadVoices, deleteVoice } from './data.js';

// h: dev, and desk.js's ago() for the last time a voice was heard
export async function voiceSettings(el, h, note = '') {
  const voices = await loadVoices(h.dev).catch(() => null);
  if (!voices) {
    el.innerHTML = '<p class="dim">No signal from the coordinator. Try again in a moment.</p>';
    return;
  }
  const said = `<p class="push-said" role="status">${esc(note)}</p>`;
  if (!voices.length) {
    el.innerHTML = `<div class="push-app"><p class="dim">No saved voices. Ask the agent on a call to enrol someone.</p>${said}</div>`;
    return;
  }
  const row = v => `<li class="switch-row"><b>${esc(v.name)}</b>
    <span class="ctl"><button type="button" class="act" data-delete="${v.id}" aria-label="Delete ${esc(v.name)}’s voice">Delete</button></span>
    <span class="dim">${esc(savedLine(v, h.ago))}</span></li>`;
  el.innerHTML = `<div class="push-app"><p class="cap"><i class="prompt">&gt; </i>SAVED VOICES</p>
    <ul class="rows settings">${voices.map(row).join('')}</ul>${said}</div>`;
  el.querySelectorAll('[data-delete]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      sfx.blip();
      const deleted = await deleteVoice(h.dev, Number(button.dataset.delete)).catch(() => null);
      voiceSettings(el, h, deleted ? '' : 'Not deleted: the coordinator didn’t answer. Try again in a moment.');
    };
  });
}
export const voicesSummary = dev => loadVoices(dev).then(voices => String(voices.length));

// "saved 29 Oct, on call 248 · last heard 2 d ago", on the company's clock
function savedLine(v, ago) {
  const f = companyFormats(),
    day = f.day(f.dayAt(new Date(v.enrolledAt)), 'en', { short: true });
  const saved = `saved ${day}${v.call ? `, on call ${v.call}` : ''}`;
  return `${saved} · ${v.heardAt ? `last heard ${ago(v.heardAt)}` : 'not heard since'}`;
}
