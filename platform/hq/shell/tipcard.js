// A tip on the desk phone (tips.js): TIP, its title and two lines, its film when it has one, Show me and Got it. It lands
// with the look's key press and the phone's chime, once per page. And Settings › Tips, the switch that turns them off.
import { esc, stylesheet } from '../util.js';
import { sfx } from './audio.js';
import { tipOf, filmName } from './tips.js';
import { showMe } from './showme.js';
import { loadTips, saveTips } from './data.js';
import { look } from './stage.js';
import { names } from './brand.js';

stylesheet('shell/tips.css');
const landed = new Set();
// The company's tip films by file name, from its theme/hq/films/ (films/listing.mjs): loadFilms, in HQ's boot before the
// desk renders.
let filmed;
const fetchFilms = () =>
  fetch('films/films.json').then(r => {
    if (!r.ok) throw new Error(`HQ's list of tip films didn't load: HTTP ${r.status}`);
    return r.json();
  });
// Asked once more a second later (straight after a deploy the coordinator may still be starting); a second failure
// stops HQ's start, as the looks' list does
export async function loadFilms() {
  filmed = new Set(await fetchFilms().catch(() => new Promise(r => setTimeout(r, 1000)).then(fetchFilms)));
}

// A tip's film in the look on stage (tip-films.mjs records one per look), and its still, the Library's tile: its address,
// or null when the company has none, so the tip shows as text only.
const addressOf = name => (filmed.has(name) ? `films/${name}` : null);
export const filmAddress = tip => addressOf(filmName(tip.key, look));
export const stillAddress = tip => addressOf(filmName(tip.key, look, 'jpg'));

// about: the card a tip about the phone points at (cardAbout), -1 when no card has its control: then it has no Show me
export function tipHtml(r, when, about) {
  const tip = tipOf(r.tip, names),
    showable = tip.steps.length && (!tip.about || about >= 0);
  // its film in the look on stage.
  const src = filmAddress(tip),
    film = src
      ? `<figure class="film"><video src="${esc(src)}" autoplay muted loop playsinline disablepictureinpicture></video></figure>`
      : '';
  return `<article class="req tip">
      <p class="meta"><span class="tag-k">tip</span> ${esc(when)}</p>
      <h3>${esc(r.title)}</h3><div class="body prose"><p>${esc(r.body)}</p></div>${film}
      <div class="row btns">${showable ? '<button class="send" data-show-me>Show me</button>' : ''}<button class="got" data-got>Got it</button><span class="msg" id="answer-msg"></span></div>
    </article>`;
}

// The card a tip about the desk phone is about, in the phone's cards: the first with its steps' controls (tips.js about),
// or -1
export const cardAbout = (r, reqs) => {
  const tip = tipOf(r.tip, names);
  return tip.about ? reqs.findIndex(x => x.kind !== 'tip' && tip.about(x)) : -1;
};

// phone: { close() the desk phone, open(where) HQ at a tip's place (its opens), toCard() the card a tip about the phone
// is about (cardAbout), end(shown) the tip filed }
export function wireTip(el, r, phone) {
  const tip = tipOf(r.tip, names);
  if (!landed.has(r.id)) {
    landed.add(r.id);
    sfx.press();
    setTimeout(() => sfx.ding(), 90);
  }
  el.querySelector('[data-got]').onclick = () => {
    sfx.press();
    phone.end(false);
  };
  const show = el.querySelector('[data-show-me]');
  if (show) show.onclick = () => runTip(tip, r.details, phone);
}
// Show me: HQ opened where the tip's steps start, then its steps, those already done left out (tips.js done). Also the
// Library's manual's (manual.js).
export function runTip(tip, details, phone) {
  sfx.press();
  if (tip.about) phone.toCard();
  else if (tip.opens) phone.open(tip.opens);
  else phone.close();
  showMe(
    tip.steps.filter(s => !s.done?.()),
    details,
    phone.end,
  );
}

// Settings › Tips: one switch, for the whole company. Off files the tips waiting with the answered cards.
export async function tipSettings(el, { dev }, note = '') {
  const tips = await loadTips(dev).catch(() => null);
  if (!tips) {
    el.innerHTML = '<p class="dim">No signal from the coordinator. Try again in a moment.</p>';
    return;
  }
  el.innerHTML = `<div class="push-app"><p class="cap"><i class="prompt">&gt; </i>THE WHOLE COMPANY</p><ul class="rows settings">
    <li class="switch-row"><b id="tips-label">Tips</b><span class="ctl"><button type="button" class="switch" role="switch" data-tips aria-checked="${!tips.off}" aria-labelledby="tips-label"><i></i></button></span>
    <span class="dim">A card on the ${esc(names.phone)} the first time a feature matters, with Show me. One a day at most, and it never rings.</span><p class="push-said" role="status">${esc(note)}</p></li></ul></div>`;
  const button = el.querySelector('[data-tips]');
  button.onclick = async () => {
    button.disabled = true;
    sfx.toggle(tips.off);
    const saved = await saveTips(dev, !tips.off).catch(() => null);
    tipSettings(el, { dev }, saved ? '' : 'Nothing changed: the coordinator didn’t answer. Try again in a moment.');
  };
}
export const tipsSummary = dev => loadTips(dev).then(tips => (tips.off ? 'Off' : 'On'));
