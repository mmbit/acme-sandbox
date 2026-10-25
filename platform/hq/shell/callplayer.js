// A walk-through call watched back, full screen over HQ (the computer's Calls opens it): the watch-along's player
// (shared/watchalong/player.js) on the call's recording, its notes and what we heard on it beside the moments, in the
// look on stage with its sounds. Never the transcript: the coordinator doesn't send it.
import { esc, stylesheet } from '../util.js';
import { sfx } from './audio.js';
import { look, cover } from './stage.js';
import { icon } from './icons.js';
import { prose } from './prose.js';
import { who, heardLine } from './desk.js';
import { dayTime } from '../world/clock.js';

// The player's sounds, from the look's pack
const SOUNDS = {
  play: () => sfx.watchPlay(),
  pause: () => sfx.watchPause(),
  jump: () => sfx.watchJump(),
  tick: () => sfx.watchTick(),
  speed: () => sfx.blip(),
};

// The player opening or open: a second tap while it loads opens nothing
let current = null;

// c: the call as the call log has it ({ id, agent, ts })
export async function openCallPlayer(c) {
  if (current) return;
  const box = (current = dialogFor(c));
  let ink, Player;
  try {
    [ink, { Player }] = await Promise.all([
      import('/__review/ink.js'),
      import('/shared/watchalong/player.js'),
      stylesheet('shell/callplayer.css'),
    ]);
  } catch (e) {
    current = null;
    throw e;
  }
  document.body.append(box);
  box.showModal();
  cover(true); // (HQ's scene under it neither updates nor draws while the player covers it)
  sfx.open();
  const shown = { player: null, reading: null };
  closes(box, shown);
  try {
    await play(box, c, ink, Player, shown);
  } catch (e) {
    if (!box.isConnected) return;
    console.error('[hq] the call player:', e);
    const status = +String(e.message).match(/\d{3}$/)?.[0];
    say(
      box,
      shown.player,
      status === 404
        ? 'Nothing of this call was recorded to watch back.'
        : status
          ? `The recording didn’t load (error ${status}). Try again in a minute.`
          : 'The recording didn’t load: HQ couldn’t reach the coordinator. Try again in a minute.',
    );
  }
}

function dialogFor(c) {
  const box = document.createElement('dialog');
  box.className = 'cp';
  box.dataset.look = look;
  box.setAttribute('aria-label', `Call with ${who(c.agent)}, watched back`);
  box.innerHTML = `<header class="cp-bar"><button type="button" class="cp-close" aria-label="Close" title="Close">${icon('close')}</button>
    <div class="cp-title"><b>Call with ${esc(who(c.agent))}</b><span class="cp-when"></span></div></header>
    <div class="cp-player"><p class="cp-say" role="status">Loading the recording…</p></div>`;
  return box;
}

// Its close key and Escape close it (the player alone, not the computer under it), and so does a job's link in the
// notes, which opens the job (desk.js) with the player out of its way
function closes(box, shown) {
  const close = () => {
    if (!box.isConnected) return;
    shown.reading?.cancel().catch(() => {});
    shown.player?.destroy();
    box.close();
    box.remove();
    current = null;
    cover(false);
    removeEventListener('click', onJob, true);
    sfx.close();
  };
  const onJob = e => e.target.closest?.('a.job-link[data-job]') && box.contains(e.target) && close();
  addEventListener('click', onJob, true);
  box.querySelector('.cp-close').onclick = close;
  box.addEventListener('cancel', e => (e.preventDefault(), close()));
  box.addEventListener('keydown', e => e.key === 'Escape' && (e.stopPropagation(), e.preventDefault(), close()));
}

// The recording as it comes: its head line (the moments, notes and items), then its events, a chunk at a time
async function play(box, c, ink, Player, shown) {
  const response = await fetch(`/api/calls/recording?call=${Number(c.id)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`recording ${response.status}`);
  const reading = (shown.reading = response.body.pipeThrough(new TextDecoderStream()).getReader());
  let rest = '',
    player = null;
  for (;;) {
    const { value, done } = await reading.read();
    if (!box.isConnected) return;
    const lines = (rest + (value ?? '') + (done ? '\n' : '')).split('\n');
    rest = lines.pop();
    const items = lines.filter(Boolean).map(line => JSON.parse(line));
    if (!player && items.length) player = shown.player = start(box, items.shift(), ink, Player);
    if (items.length) player.add(items);
    if (done) break;
  }
  if (!player) throw new Error('recording 404');
}

function start(box, head, ink, Player) {
  box.querySelector('.cp-when').textContent = dayTime(head.start + head.clockMs);
  const place = box.querySelector('.cp-player');
  place.replaceChildren();
  const player = new Player(place, {
    replay: '/shared/watchalong/replay.html',
    ink,
    moments: head.moments,
    start: head.start,
    end: head.end,
    side: sideHtml(head),
    icons: { play: icon('next'), pause: icon('pause'), back: icon('skip-back'), forward: icon('skip-ahead') },
    sound: name => SOUNDS[name]?.(),
  });
  place.querySelector('.wp-play').focus();
  return player;
}

// Beside the moments: what the call's follow-up noted (its reply) and what we heard on it, as the call log shows them
function sideHtml(head) {
  const items = head.items ?? [];
  const notes = head.notes
    ? `<section class="cp-notes"><p class="wp-cap">Notes</p><div class="call-notes prose">${prose(head.notes)}</div></section>`
    : '';
  const heard = items.length
    ? `<section class="cp-heard calls"><p class="wp-cap">What we heard · ${items.length}</p><ul class="heard">${items.map(heardLine).join('')}</ul></section>`
    : '';
  return notes + heard;
}

// A line in place of the player, or over its stage once it's playing what came
function say(box, player, text) {
  if (player) return player.say(text);
  const place = box.querySelector('.cp-player');
  place.replaceChildren(Object.assign(document.createElement('p'), { className: 'cp-say', textContent: text }));
}
