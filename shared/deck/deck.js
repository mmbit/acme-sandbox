// The deck runtime: swipe, tap, keys, chapters, and video that plays when its slide is on screen.
(() => {
  const $ = (id) => document.getElementById(id);
  const deck = $('deck'), slides = [...deck.querySelectorAll('.slide')];
  let cur = -1, sound = true, swiped = false;
  // In a frame (HQ's viewer) the deck already lies inside the screen's safe area,
  // which HQ keeps clear; a frame can still be told the whole screen's insets (WebKit hands it the page's), and
  // padding for them again left a blank strip at the top of every slide.
  if (window.parent !== window) document.documentElement.classList.add('framed');

  // Transition sounds: foley, never music (the demo kit's player, inlined by build.mjs; null with "sfx": false). Silent until
  // the first tap or key, soft, a new take every time. One mute for them and the videos, remembered on this device.
  const key = 'hq-deck:sound';
  const sfx = typeof deckFoley === 'function' ? deckFoley({ key }) : null;
  try { sound = sfx ? !sfx.muted : localStorage.getItem(key) !== 'off'; } catch {}

  // Chapters (from each slide's data-chapter) drive the progress bar and the menu.
  const chapters = [];
  slides.forEach((s, i) => {
    const name = s.dataset.chapter || '';
    if (!chapters.length || chapters.at(-1).name !== name) chapters.push({ name, start: i, n: 0, color: s.style.getPropertyValue('--accent') });
    chapters.at(-1).n++;
  });
  const progress = $('progress'), menuList = $('menu').querySelector('ol'), items = [];
  chapters.forEach((c) => {
    const b = document.createElement('button');
    b.style.setProperty('--n', c.n); b.setAttribute('aria-label', c.name); b.innerHTML = '<i></i>';
    b.onclick = () => go(c.start);
    progress.append(b); c.bar = b;
    const li = document.createElement('li'), h = document.createElement('h3'), list = document.createElement('ol');
    h.textContent = c.name; if (c.color) h.style.setProperty('--c', c.color);
    for (let i = c.start; i < c.start + c.n; i++) {
      const m = document.createElement('button'), title = slides[i].querySelector('h1, h2') ?? slides[i].querySelector('.kicker');
      m.innerHTML = '<small></small><span></span>'; m.firstChild.textContent = i + 1; m.lastChild.textContent = title?.textContent.trim() || `Slide ${i + 1}`;
      m.onclick = () => { closeMenu(); go(i); };
      const it = document.createElement('li'); it.append(m); list.append(it); items[i] = m;
    }
    li.append(h, list); menuList.append(li);
  });

  // ---- video: plays only on its own slide; sound where the slide asks for it, muted with a "tap for sound" chip if the browser refuses
  const videos = (s) => [...s.querySelectorAll('video')];
  function start(s, resume) {
    for (const v of videos(s)) {
      const fig = v.closest('figure');
      if (!v.src) v.src = v.dataset.src;
      if (!resume) try { v.currentTime = 0; } catch {}
      fig.classList.remove('paused', 'muted');
      const wantSound = v.hasAttribute('data-sound') && sound;
      v.muted = !wantSound;
      v.play().catch(() => {
        if (!wantSound) return fig.classList.add('paused');
        v.muted = true; fig.classList.add('muted');
        v.play().catch(() => fig.classList.add('paused'));
      });
    }
  }
  const stop = (s) => videos(s).forEach((v) => v.pause());
  // The poster stays until the video really plays.
  for (const v of deck.querySelectorAll('video')) v.addEventListener('playing', () => v.closest('figure').classList.add('live'));
  function warm(s) { // fetch the next slide's video ahead of time
    if (s) for (const v of videos(s)) if (!v.src) { v.preload = 'auto'; v.src = v.dataset.src; }
  }
  // Tapping a picture or video shows it as large as the screen allows; the chip turns the sound on, and ▶ plays a video
  // the browser wouldn't start by itself, where it is.
  deck.addEventListener('click', (e) => {
    const chip = e.target.closest('.sound'), play = e.target.closest('.play'), fig = e.target.closest('figure');
    if (!fig || swiped) return; // a swipe that started on a figure isn't a tap on it
    const v = fig.querySelector('video');
    if (v && chip) { setSound(true); v.muted = false; fig.classList.remove('muted'); v.play(); return; }
    if (v && play) { v.play(); fig.classList.remove('paused'); return; }
    enlarge(fig);
  });
  const zoom = $('zoom'), zoomStage = zoom.querySelector('.stage');
  function enlarge(fig) {
    const v = fig.querySelector('video'), img = fig.querySelector('.shell > img');
    let el;
    if (v) {
      el = document.createElement('video');
      Object.assign(el, { src: v.dataset.src, poster: v.getAttribute('poster') || '', controls: true, loop: v.loop, playsInline: true, muted: !sound });
      el.setAttribute('playsinline', ''); el.setAttribute('aria-label', v.getAttribute('aria-label') || '');
      stop(slides[cur]);
    } else if (img) {
      el = document.createElement('img'); el.src = img.currentSrc || img.src; el.alt = img.alt;
    } else return;
    zoomStage.replaceChildren(el); zoom.hidden = false;
    if (v) el.play().catch(() => {}); // within the tap, so the browser lets it play
    sfx?.play('slide', { material: 'paper', dur: 0.3, vol: 0.35 });
    zoom.querySelector('.close').focus();
  }
  function shrink() {
    if (zoom.hidden) return;
    const v = zoomStage.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    zoomStage.replaceChildren(); zoom.hidden = true;
    if (cur >= 0) start(slides[cur], true);
  }
  zoom.onclick = (e) => { if (!e.target.closest('video')) shrink(); };
  function setSound(on) {
    sound = on; $('snd').setAttribute('aria-pressed', on);
    if (sfx) { sfx.setMuted(!on); if (on) sfx.play('clack', { hold: 0.06, vol: 0.5 }); }
    else try { localStorage.setItem(key, on ? 'on' : 'off'); } catch {}
    if (cur >= 0) for (const v of videos(slides[cur])) if (v.hasAttribute('data-sound')) { v.muted = !on; v.closest('figure').classList.toggle('muted', false); }
  }
  $('snd').onclick = () => setSound(!sound);
  $('snd').setAttribute('aria-pressed', sound);

  // A card slid into place, a step higher on every slide of a chapter (up to an octave: harsh.mjs holds each step); a
  // card turned over for a new chapter; dealt for a jump; slid back lower; a dull knock at either end.
  const chapterAt = (i) => chapters.findLast((c) => i >= c.start);
  function cue(i, from) {
    if (!sfx || from < 0) return;
    const k = i - chapterAt(i).start;
    if (Math.abs(i - from) > 1) sfx.play('deal', { surface: 'table', vol: 0.5 });
    else if (i < from) sfx.play('slide', { material: 'card', dur: 0.22, pitch: -2, pan: -0.3, vol: 0.55 });
    else if (k === 0) sfx.play('flip', { material: 'card', pan: 0.2, vol: 0.45 });
    else sfx.play('slide', { material: 'card', dur: 0.22, pitch: Math.min(k, 12), pan: 0.3, vol: 0.7 });
  }

  // ---- navigation
  function go(i) {
    const want = i;
    i = Math.max(0, Math.min(slides.length - 1, i));
    if (i === cur) { if (want !== i) sfx?.play('knock', { size: 0.8, pitch: -3, vol: 0.3 }); return; }
    cue(i, cur);
    if (cur >= 0) stop(slides[cur]);
    slides.forEach((s, k) => { s.classList.toggle('on', k === i); s.classList.toggle('past', k < i); s.inert = k !== i; s.setAttribute('aria-hidden', k !== i); });
    cur = i;
    slides[i].scrollTop = 0; below(slides[i]);
    start(slides[i]); warm(slides[i + 1]);
    $('count').textContent = `${i + 1} / ${slides.length}`;
    chapters.forEach((c) => c.bar.style.setProperty('--f', Math.max(0, Math.min(1, (i - c.start + 1) / c.n))));
    items.forEach((m, k) => m.classList.toggle('here', k === i));
    history.replaceState(null, '', `#${i + 1}`);
    if (i > 0) hinted();
  }
  const next = () => go(cur + 1), prev = () => go(cur - 1);
  // A slide taller than its stage scrolls; its foot fades while there's more below.
  function below(s) { s.classList.toggle('below', s.scrollHeight - s.clientHeight - s.scrollTop > 4); }
  slides.forEach((s) => s.addEventListener('scroll', () => below(s), { passive: true }));
  addEventListener('resize', () => cur >= 0 && below(slides[cur]));
  const hinted = () => $('bar').classList.remove('hinting');
  $('next').onclick = next; $('prev').onclick = prev;

  // Swipe (the slide follows the finger) and tap (left third back, the rest forward).
  let p = null;
  const inert = (el) => el.closest('a, button, figure, .chart, input, select, textarea');
  deck.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0) return;
    p = { x: e.clientX, y: e.clientY, t: performance.now(), drag: false, tap: !inert(e.target) }; swiped = false;
  });
  deck.addEventListener('pointermove', (e) => {
    if (!p || !e.isPrimary) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.drag && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) { p.drag = true; slides[cur].classList.add('drag'); }
    if (p.drag) slides[cur].style.transform = `translateX(${dx * 0.6}px)`;
  });
  function end(e, cancel) {
    if (!p) return;
    const s = slides[cur], dx = e.clientX - p.x, dy = e.clientY - p.y, v = Math.abs(dx) / (performance.now() - p.t);
    s.classList.remove('drag'); s.style.transform = ''; swiped = p.drag;
    if (!cancel && p.drag && (Math.abs(dx) > 60 || v > 0.45)) dx < 0 ? next() : prev();
    else if (!cancel && p.tap && Math.hypot(dx, dy) < 10 && !getSelection().toString()) e.clientX < innerWidth * 0.3 ? prev() : next();
    p = null;
  }
  deck.addEventListener('pointerup', (e) => end(e, false));
  deck.addEventListener('pointercancel', (e) => end(e, true));

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('menu').hidden) { if (e.key === 'Escape') closeMenu(); return; }
    if (!zoom.hidden) { if (e.key === 'Escape') shrink(); return; }
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)) next();
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) prev();
    else if (k === 'Home') go(0);
    else if (k === 'End') go(slides.length - 1);
    else if (k === 'm') setSound(!sound);
    else if (k === 'c') openMenu();
    else return;
    e.preventDefault();
  });

  // Chapter menu
  function openMenu() {
    $('menu').hidden = false; sfx?.play('slide', { material: 'paper', dur: 0.3, vol: 0.35 });
    const here = items[cur]; here?.scrollIntoView({ block: 'center' }); here?.focus({ preventScroll: true });
  }
  function closeMenu() { $('menu').hidden = true; }
  $('chap').onclick = openMenu; $('count').onclick = openMenu;
  $('menu').onclick = (e) => { if (e.target === $('menu')) closeMenu(); };

  // Full screen where the browser allows it (iPad Safari uses the webkit prefix; iPhone has none).
  const root = document.documentElement, fsOn = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (root.requestFullscreen || root.webkitRequestFullscreen) {
    $('fs').hidden = false;
    $('fs').onclick = () => fsOn() ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      : (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  }

  // Charts: tapping or hovering a segment or legend row highlights both.
  for (const chart of deck.querySelectorAll('.chart')) {
    const mark = (k) => chart.querySelectorAll('[data-k]').forEach((el) => el.classList.toggle('hi', el.dataset.k === k));
    chart.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-k]'); if (el) mark(el.dataset.k); });
    chart.addEventListener('pointerleave', () => mark(null));
  }

  // Keep the hidden slides' videos quiet if the page goes to the background.
  document.addEventListener('visibilitychange', () => { if (document.hidden && cur >= 0) stop(slides[cur]); else if (cur >= 0) start(slides[cur], true); });

  // In HQ's preview viewer (a frame) the deck talks to HQ, and only to HQ: the site serving the deck names HQ's origin
  // at /__hq-origin (infra/products.py, the cycles site), and a deck served anywhere else, or framed by any other
  // page, sends nothing and takes nothing.
  if (window.parent !== window) fetch('/__hq-origin').then((r) => r.ok ? r.text() : null).then(hqOrigin).then((hq) => hq && talkToHq(hq))
    .catch(() => { /* no HQ: the deck keeps its own look and its buttons open new tabs */ });

  function talkToHq(hq) {
    // A button to a product preview opens in the viewer too, with a way back to this slide: a new tab would leave HQ,
    // and on a phone often for a browser without the board's preview key. HQ gets the deck's path and slide, not its
    // whole address.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a.btn[href]');
      if (!a || !/^https:\/\/[a-z0-9-]+\.preview\./.test(a.href)) return;
      e.preventDefault(); parent.postMessage({ hq: 'deck', open: a.href, back: location.pathname + location.hash }, hq);
    });
    // ...and it wears HQ's look: HQ answers the hello with its look's stylesheet for decks, laid over deck.css (none
    // for the brownstone, whose look this is). Heard once; the CSP keeps a stylesheet from loading anything.
    addEventListener('message', (e) => {
      const d = e.data;
      if (e.source !== parent || e.origin !== hq || d?.hq !== 'hq-look' || typeof d.css !== 'string' || $('look')) return;
      const style = document.createElement('style'); style.id = 'look'; style.textContent = d.css;
      document.head.append(style); document.documentElement.dataset.look = String(d.look);
    });
    parent.postMessage({ hq: 'deck', hello: true }, hq);
  }
  // An origin and nothing else, or null: a server that answers every path with a page names no HQ.
  function hqOrigin(text) {
    const named = text?.trim();
    try { return new URL(named).origin === named ? named : null; } catch { return null; }
  }

  const fromHash = () => parseInt(location.hash.slice(1), 10) - 1;
  addEventListener('hashchange', () => { const i = fromHash(); if (i >= 0) go(i); });
  $('bar').classList.add('hinting');
  go(fromHash() >= 0 ? fromHash() : 0);
  setTimeout(hinted, 5000);
})();
