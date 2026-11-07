// A sound on a card, played in a small player of its own there: play and pause, where it is and how long it lasts,
// its name. One sound plays at a time. The desk phone redraws its cards as the world changes, so the sound plays in
// this module's one <audio>, and every player of that file on the page follows it.
import { esc, stylesheet } from '../util.js';
import { icon } from './icons.js';

// the sounds the coordinator serves with their own type (types.ts), which Safari needs to play them
const SOUND = /\.(?:mp3|m4a|wav)$/i;
export const isSound = name => SOUND.test(name);

const audio = new Audio();
let playing = null; // the src in the <audio>, playing or paused
let refused = null; // the src whose play() the browser refused (its type, or the file couldn't be had), said on its player
const lengths = new Map(); // src → its length in seconds, once known

// A player of f { name, src }; more: what follows the name on its row (a key to save it)
export function playerHtml(f, more = '') {
  wire();
  measure(f.src);
  // (drawn as its sound stands once its card is on the page)
  requestAnimationFrame(paintAll);
  return `<div class="listen" data-listen="${esc(f.src)}">
    <button type="button" class="listen-play" aria-label="Play ${esc(f.name)}">${icon('play')}${icon('pause')}</button>
    <span class="listen-name fn">${esc(f.name)}</span><span class="listen-more">${more}</span>
    <input type="range" class="listen-at" min="0" max="1" step="any" value="0" aria-label="Where in ${esc(f.name)}">
    <span class="listen-time"></span></div>`;
}

// Its keys, once for the page: a player is markup, drawn again with its card
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  stylesheet('shell/listen.css');
  document.addEventListener('click', e => {
    const key = e.target instanceof Element && e.target.closest('.listen-play');
    if (key) toggle(key.closest('.listen').dataset.listen);
  });
  document.addEventListener('input', e => {
    if (e.target instanceof Element && e.target.matches('.listen-at'))
      seek(e.target.closest('.listen').dataset.listen, Number(e.target.value));
  });
  audio.addEventListener('playing', () => (refused = null));
  for (const change of ['play', 'pause', 'timeupdate', 'durationchange', 'ended', 'emptied'])
    audio.addEventListener(change, paintAll);
}

function toggle(src) {
  if (playing !== src) choose(src);
  if (audio.paused)
    audio.play().catch(e => {
      if (e.name === 'AbortError') return; // (paused before it started: a tap of ours)
      refused = src;
      paintAll();
    });
  else audio.pause();
}
function seek(src, at) {
  if (playing !== src) choose(src);
  const go = () => (audio.currentTime = at);
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) go();
  else audio.addEventListener('loadedmetadata', go, { once: true });
}
function choose(src) {
  audio.pause();
  refused = null;
  playing = src;
  audio.src = src;
}

// Every player on the page as its sound stands. A sound with no player of it in sight left with its card (the desk
// phone closed, a file's sheet shut): it stops.
function paintAll() {
  const players = [...document.querySelectorAll('.listen')];
  if (playing && !audio.paused && !players.some(p => p.dataset.listen === playing && p.checkVisibility()))
    audio.pause();
  for (const p of players) paint(p);
}
function paint(player) {
  const src = player.dataset.listen,
    on = src === playing,
    length = (on && Number.isFinite(audio.duration) ? audio.duration : lengths.get(src)) ?? 0,
    at = on ? audio.currentTime : 0;
  if (on && length) lengths.set(src, length);
  player.toggleAttribute('data-playing', on && !audio.paused);
  player
    .querySelector('.listen-play')
    .setAttribute(
      'aria-label',
      `${on && !audio.paused ? 'Pause' : 'Play'} ${player.querySelector('.listen-name').textContent}`,
    );
  const bar = player.querySelector('.listen-at');
  bar.max = String(length || 1);
  // (not while a finger drags it)
  if (document.activeElement !== bar) bar.value = String(at);
  bar.style.setProperty('--done', `${length ? (100 * at) / length : 0}%`);
  player.querySelector('.listen-time').textContent =
    src === refused ? 'Can’t play this here: save it' : `${clockOf(at)} / ${length ? clockOf(length) : '–:––'}`;
}
const clockOf = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// A sound's length before it plays, from its first bytes (where the browser loads them unasked)
function measure(src) {
  if (lengths.has(src)) return;
  lengths.set(src, 0);
  const probe = Object.assign(new Audio(), { preload: 'metadata' });
  probe.addEventListener(
    'loadedmetadata',
    () => {
      if (Number.isFinite(probe.duration)) lengths.set(src, probe.duration);
      probe.removeAttribute('src');
      paintAll();
    },
    { once: true },
  );
  probe.src = src;
}
