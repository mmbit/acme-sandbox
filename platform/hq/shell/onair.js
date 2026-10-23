// The computer's On Air: the company's shows (shared/onair/README.md), their newest episodes and podcast links.
import { esc, jobName, store } from '../util.js'; // (jobName)
import { loadOnAir, loadSchedule, renewOnAirLink, runRecurring } from './data.js';
import { sfx } from './audio.js';
import { companyFormats } from '../world/clock.js';

const SPEEDS = [1, 1.25, 1.5, 2],
  EPISODES = 10;
const DAY = day => companyFormats().day(day, 'en', { weekday: true, short: true });
const speed = () => store.get('onair.speed', 1);

export async function onair(el, { dev, who }) {
  // HQ draws its open app again every few seconds: never while an episode plays
  if ([...el.querySelectorAll('audio, video')].some(a => !a.paused)) return;
  const [shows, rec] = await Promise.all([loadOnAir(dev), loadSchedule(dev).catch(() => [])]);
  const when = Object.fromEntries(rec.map(r => [r.id, r]));
  const lang = s => {
    const l = store.get(`onair.lang.${s.id}`);
    return s.feeds.some(f => f.lang === l) ? l : s.feeds[0]?.lang;
  };
  const episode = (s, e) => {
    const x = e.langs[lang(s)] ?? Object.values(e.langs)[0];
    return (
      `<li><b>${esc(x.title)}</b><span class="st">${esc(DAY(e.date))}</span>
      ${x.summary ? `<span class="dim">${esc(x.summary)}</span>` : ''}` +
      `<audio controls preload="none" src="${esc(x.audio)}"></audio>` +
      (x.video ? `<button class="act" data-watch="${esc(x.video)}" data-listen="${esc(x.audio)}">Watch</button>` : '') +
      '</li>'
    );
  };
  const show = s => {
    const r = when[s.run],
      line = [
        s.hosts.map(who).join(' and '),
        r ? (r.next ? `${r.when}, next ${r.next}` : r.when) : '',
        s.audience === 'board' ? 'for you' : `for ${s.audience}`,
      ]
        .filter(Boolean)
        .join(' · ');
    const pill = f =>
      `<button role="radio" aria-checked="${f.lang === lang(s)}" data-lang="${esc(f.lang)}">` +
      `${esc(f.language)}</button>`;
    const which = f => (s.feeds.length > 1 ? `, ${esc(f.language)}` : '');
    const feed = f =>
      `<button class="act" data-feed="${esc(f.url)}">Podcast link${which(f)}</button>` +
      (f.video ? `<button class="act" data-feed="${esc(f.video)}">Video podcast link${which(f)}</button>` : '');
    return (
      `<section class="oa" data-show="${esc(s.id)}">` +
      `<p class="cap"><i class="prompt">&gt; </i>${esc(s.name.toUpperCase())}</p>
      <p class="dim">${esc(line)}</p>${s.about ? `<p>${esc(s.about)}</p>` : ''}
      <div class="oa-bar">${
        s.feeds.length > 1
          ? `<div class="pills" role="radiogroup" aria-label="Language">${s.feeds.map(pill).join('')}</div>`
          : ''
      }
        <button class="act" data-run="${esc(s.run)}">Make one now</button></div>
      ${
        s.episodes.length
          ? `<ul class="rows">${s.episodes
              .slice(0, EPISODES)
              .map(e => episode(s, e))
              .join('')}</ul>`
          : '<p class="dim">No episodes yet.</p>'
      }
      <p class="oa-bar">${s.feeds.map(feed).join('')}
        ${s.audience === 'public' ? '' : '<button class="act" data-renew>New link</button>'}</p></section>`
    );
  };
  el.innerHTML = shows.length
    ? `<p class="oa-bar"><button class="act" data-speed>Speed ${speed()}×</button></p>${shows.map(show).join('')}`
    : '<p><i class="prompt">&gt; </i>No shows yet.</p><p class="dim">A show is a few lines in company/shows.yaml.</p>';
  const all = () => el.querySelectorAll('audio, video');
  const player = a => {
    a.defaultPlaybackRate = a.playbackRate = speed();
    a.onplay = () => all().forEach(b => b !== a && b.pause());
  };
  all().forEach(player);
  const tapped = (selector, act) =>
    el.querySelectorAll(selector).forEach(
      b =>
        (b.onclick = () => {
          sfx.blip();
          act(b);
        }),
    );
  tapped('[data-speed]', b => {
    const next = SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length];
    store.set('onair.speed', next);
    all().forEach(a => (a.defaultPlaybackRate = a.playbackRate = next));
    b.textContent = `Speed ${next}×`;
  });
  // an episode with a video: Watch swaps its player for the video at the same moment, Listen swaps back
  tapped('[data-watch]', b => {
    const was = b.parentElement.querySelector('audio, video'),
      watch = was.tagName === 'AUDIO',
      next = document.createElement(watch ? 'video' : 'audio');
    Object.assign(next, { controls: true, playsInline: true, src: watch ? b.dataset.watch : b.dataset.listen });
    next.currentTime = was.currentTime;
    player(next);
    if (!was.paused) next.play().catch(() => {});
    was.pause();
    was.replaceWith(next);
    b.textContent = watch ? 'Listen' : 'Watch';
  });
  const of = b => shows.find(s => s.id === b.closest('[data-show]').dataset.show);
  tapped('[data-lang]', b => {
    store.set(`onair.lang.${of(b).id}`, b.dataset.lang);
    onair(el, { dev, who });
  });
  tapped('[data-run]', async b => {
    b.disabled = true;
    try {
      const started = await runRecurring(dev, b.dataset.run);
      b.textContent = `Started ${jobName(started.job, started.job_code)}`;
    } catch (e) {
      b.textContent = e.refusal?.error ?? 'Didn’t start';
    }
  });
  tapped('[data-feed]', async b => {
    try {
      await navigator.clipboard.writeText(b.dataset.feed);
      b.textContent = 'Copied';
    } catch {
      // no clipboard: the link itself, selected, to copy by hand
      const i = Object.assign(document.createElement('input'), { value: b.dataset.feed, readOnly: true });
      b.replaceWith(i);
      i.select();
    }
  });
  // a new link ends the old one in every podcast app that has it: the first tap says so, the second does it
  tapped('[data-renew]', async b => {
    if (!b.dataset.sure) {
      b.dataset.sure = '1';
      b.textContent = 'The old link stops working · tap again';
      return;
    }
    b.disabled = true;
    try {
      await renewOnAirLink(dev, of(b).id);
      onair(el, { dev, who });
    } catch (e) {
      b.textContent = e.refusal?.error ?? 'Didn’t change';
    }
  });
}
