// The watch-along's player: a recording replayed (rrweb's replayer, in replay.html's frame), the pen's ink drawn over
// it as it was drawn, a scrubber with ticks for the taps, pages and ink, and the moments beside it following along. It
// knows nothing of the page around it: a frame (HQ's call player) hands it the events as they load, the moments and a
// side panel's HTML, and styles its parts. README.md has the design.
//   - Smooth on a tablet: one requestAnimationFrame clock while playing or scrubbing moves the scrubber by transforms
//     and draws the ink; nothing is measured while it runs (sizes are read on resize only). Seeking forward goes on
//     from where the replay is; only a seek back rebuilds it from the page's snapshot.
//   - The ink is drawn on a canvas over the replay, in device pixels, so it stays crisp at any scale.
import { inkAt, paint, placer } from './strokes.js';
import { Scrubber, clock } from './scrubber.js';

export const SPEEDS = [1, 2, 4];
export const STEP_MS = 5000; // what back and forward skip (the arrow keys too)
const SEEK_SHARE = 2; // a drag waits twice as long as its last seek took before the next
const WORDS = {
  play: 'Play',
  pause: 'Pause',
  back: 'Back 5 seconds',
  forward: 'Forward 5 seconds',
  speed: 'Playback speed',
  scrubber: 'Time in the recording',
  moments: 'Moments',
  loading: 'Loading the recording…',
};
const svg = d =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  play: svg('<path d="M8 5v14l11-7z" fill="currentColor"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="4"/>'),
  back: svg('<path d="M12 4.5a7.5 7.5 0 1 1-7.5 7.5M12 1.5 9 4.5l3 3"/>'),
  forward: svg('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5M12 1.5l3 3-3 3"/>'),
};
// rrweb's event types and incremental sources the ink needs
const FULL_SNAPSHOT = 2,
  INCREMENTAL = 3,
  CUSTOM = 5,
  CANVAS_MUTATION = 9;

export class Player {
  // box: an element to fill. replay: the replay page's address. ink: ink.js's module (its draw). moments: the
  // recording's, { n, at, kind, words } (moments.ts). start, end: the recording's first and last event, on the page's
  // clock. side: HTML under the moments. words: the player's own (WORDS). icons: { play, pause, back, forward } as
  // markup, the page's own drawings (else simple ones of this file's). sound(name): 'play' | 'pause' | 'jump' | 'tick'
  // | 'speed'.
  constructor(box, { replay, ink, moments, start, end, side = '', words = {}, icons = {}, sound = () => {} }) {
    Object.assign(this, { box, ink, moments, start, end, sound });
    this.words = { ...WORDS, ...words };
    this.icons = { ...ICONS, ...icons };
    this.at = start; // where the replay is, on the page's clock
    this.loadedTo = start;
    this.playing = false;
    this.speed = SPEEDS[0];
    this.inkEvents = []; // (what the ink needs of the events: snapshots, ink, canvas pictures without their pixels)
    this.waiting = []; // events come before the replayer is built
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build(replay, side);
    this.frameLoop = () => this.tick();
  }

  // The player's parts, styled by the frame; only what placing them needs is set here
  build(replay, side) {
    const w = this.words,
      i = this.icons;
    this.box.classList.add('wp');
    if (this.box.tabIndex < 0) this.box.tabIndex = -1; // (focus stays in the player, for its keys, as the stage is tapped)
    this.box.innerHTML = `<div class="wp-stage"><div class="wp-screen"><iframe class="wp-replay" title="${attr(w.scrubber)}" tabindex="-1"></iframe><canvas class="wp-ink"></canvas></div><p class="wp-say" role="status"></p></div>
      <div class="wp-transport"><div class="wp-scrub"></div><div class="wp-keys">
        <button type="button" class="wp-back" aria-label="${attr(w.back)}" title="${attr(w.back)}">${i.back}<span class="wp-n">5</span></button>
        <button type="button" class="wp-play" aria-label="${attr(w.play)}" title="${attr(w.play)}"><span class="wp-i-play">${i.play}</span><span class="wp-i-pause">${i.pause}</span></button>
        <button type="button" class="wp-forward" aria-label="${attr(w.forward)}" title="${attr(w.forward)}">${i.forward}<span class="wp-n">5</span></button>
        <span class="wp-time" aria-hidden="true"><b>0:00</b> / ${clock(this.end - this.start)}</span>
        <button type="button" class="wp-speed" aria-label="${attr(w.speed)}" title="${attr(w.speed)}">1×</button>
      </div></div>
      <div class="wp-side"><p class="wp-cap">${esc(w.moments)} · ${this.moments.length}</p><ol class="wp-moments"></ol><div class="wp-more">${side}</div></div>`;
    const find = s => this.box.querySelector(s);
    Object.assign(this, {
      stage: find('.wp-stage'),
      screen: find('.wp-screen'),
      frame: find('.wp-replay'),
      canvas: find('.wp-ink'),
      said: find('.wp-say'),
      playKey: find('.wp-play'),
      time: find('.wp-time b'),
      speedKey: find('.wp-speed'),
      list: find('.wp-moments'),
    });
    Object.assign(this.screen.style, { position: 'relative', overflow: 'hidden', margin: 'auto', flex: 'none' });
    Object.assign(this.frame.style, { position: 'absolute', left: 0, top: 0, border: 0, transformOrigin: '0 0' });
    Object.assign(this.frame.style, { pointerEvents: 'none', visibility: 'hidden' });
    Object.assign(this.canvas.style, { position: 'absolute', inset: 0, width: '100%', height: '100%' });
    this.canvas.style.pointerEvents = 'none';
    this.list.style.position = 'relative';
    this.say(w.loading);
    this.scrubber = new Scrubber(find('.wp-scrub'), this, w.scrubber);
    this.listMoments();
    this.wireKeys();
    this.fits = new ResizeObserver(() => this.fit());
    this.fits.observe(this.stage);
    this.ready = new Promise(done => (this.frame.onload = done)).then(() => this.frame.contentWindow.ready);
    this.frame.src = replay;
  }

  listMoments() {
    this.list.replaceChildren(
      ...this.moments.map((m, i) => {
        const li = document.createElement('li'),
          b = document.createElement('button');
        b.type = 'button';
        b.className = `wp-moment wp-${m.kind}`;
        b.dataset.i = i;
        b.innerHTML = `<span class="wp-at">${clock(m.at - this.start)}</span><span class="wp-words">${esc(m.words)}</span>`;
        li.append(b);
        return li;
      }),
    );
    this.list.onclick = e => {
      const b = e.target.closest('.wp-moment');
      if (b) this.jump(this.moments[Number(b.dataset.i)].at);
    };
    // (a list the viewer scrolls stays where they put it a while)
    const touched = () => (this.listTouched = performance.now());
    for (const type of ['wheel', 'touchmove']) this.list.addEventListener(type, touched, { passive: true });
    this.shown = -1;
  }

  wireKeys() {
    const on = (s, fn) => (this.box.querySelector(s).onclick = fn);
    on('.wp-play', () => this.toggle());
    on('.wp-back', () => this.jump(this.at - STEP_MS));
    on('.wp-forward', () => this.jump(this.at + STEP_MS));
    on('.wp-speed', () => this.faster());
    this.box.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && e.target.closest('button, a')) return; // (a key in focus is pressed by it)
      const keys = {
        ' ': () => this.toggle(),
        ArrowLeft: () => this.jump(this.at - STEP_MS),
        ArrowRight: () => this.jump(this.at + STEP_MS),
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      keys[e.key]();
    });
  }

  // Events in order as they load: the replayer is built once a snapshot of the page is in, and takes the rest as
  // they come (a long call's arrive for a while)
  add(events) {
    for (const event of events) {
      const light = inkPart(event);
      if (light) this.inkEvents.push(light);
    }
    this.inked ||= this.inkEvents.some(e => e.type === CUSTOM);
    if (!events.length) return;
    this.loadedTo = events.at(-1).timestamp;
    this.scrubber.loaded((this.loadedTo - this.start) / Math.max(1, this.end - this.start));
    if (this.replayer) {
      for (const event of events) this.replayer.addEvent(event);
      if (this.stalled && this.playing) this.go();
      return;
    }
    this.waiting.push(...events);
    if (!this.building && this.waiting.some(e => e.type === FULL_SNAPSHOT)) this.building = this.replay();
  }

  async replay() {
    const Replayer = await this.ready;
    const events = this.waiting;
    this.waiting = [];
    const replayer = new Replayer(events, {
      root: this.frame.contentDocument.body,
      UNSAFE_replayCanvas: true, // (HQ's canvases are recorded as pictures, which only a frame running scripts draws)
      mouseTail: false,
      triggerFocus: false,
      showWarning: false,
      skipInactive: false,
      speed: this.speed,
    });
    this.replayer = replayer;
    this.place = placer(replayer);
    replayer.on('resize', size => this.fit(size));
    replayer.on('finish', () => this.finished());
    this.fit({ width: Number(replayer.iframe.width), height: Number(replayer.iframe.height) });
    this.frame.style.visibility = '';
    this.say('');
    this.seek(this.at);
  }

  // ---- playing
  toggle = () => (this.playing ? this.pause() : this.play());
  play() {
    if (this.playing) return;
    if (this.at >= this.end - 50) this.at = this.start; // (at the end: from the top)
    this.playing = true;
    this.sound('play');
    this.go();
    this.paintPlayKey();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.replayer?.pause();
    this.sound('pause');
    this.paintPlayKey();
    this.draw();
  }
  faster() {
    this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
    this.replayer?.setConfig({ speed: this.speed });
    this.speedKey.textContent = `${this.speed}×`;
    this.sound('speed');
  }
  // A jump (a moment, back or forward): there, playing on if it was
  jump(at) {
    this.sound('jump');
    this.seek(at);
  }
  // At a time on the page's clock (what happened at that very time too: a moment's tap or page drawn)
  seek(at) {
    this.at = Math.max(this.start, Math.min(at, this.end));
    if (this.replayer) {
      const offset = Math.min(this.at, this.loadedTo) - this.start + 1;
      if (this.playing) this.go(offset);
      else this.replayer.pause(offset);
    }
    this.draw();
  }
  go(offset = this.at - this.start) {
    this.stalled = false;
    this.replayer?.play(offset);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frameLoop);
  }
  finished() {
    if (!this.playing) return;
    // (the recording isn't all in yet: it goes on as the rest comes)
    if (this.loadedTo < this.end) return void (this.stalled = true);
    this.at = this.end;
    this.playing = false;
    this.paintPlayKey();
    this.draw();
  }
  paintPlayKey() {
    const word = this.playing ? this.words.pause : this.words.play;
    this.playKey.classList.toggle('playing', this.playing);
    this.playKey.setAttribute('aria-label', word);
    this.playKey.title = word;
  }

  // ---- the scrubber held: the thumb and the time follow the finger at once, the replay as often as its seeks allow
  // (a seek back rebuilds the page: HQ's takes some 100 ms on a slow tablet), never more than a third of the time, so
  // the drag stays smooth; it plays on as it's let go if it was playing
  grab() {
    this.resume = this.playing;
    this.playing = false;
    this.replayer?.pause();
    this.seekCost = 0;
    this.seekEnd = 0;
  }
  drag(at) {
    this.at = Math.max(this.start, Math.min(at, this.end));
    this.scrubber.show((this.at - this.start) / Math.max(1, this.end - this.start));
    if (this.dragWait) return;
    const wait = Math.max(0, this.seekEnd + SEEK_SHARE * this.seekCost - performance.now());
    this.dragWait = setTimeout(() => {
      this.dragFrame = requestAnimationFrame(() => {
        const begun = performance.now();
        this.seek(this.at);
        // (its cost counts the frame that draws the page it rebuilt)
        this.dragFrame = requestAnimationFrame(() => {
          this.seekEnd = performance.now();
          this.seekCost = this.seekEnd - begun;
          this.dragWait = this.dragFrame = 0;
        });
      });
    }, wait);
  }
  release(at) {
    clearTimeout(this.dragWait);
    cancelAnimationFrame(this.dragFrame);
    this.dragWait = this.dragFrame = 0;
    this.seek(at);
    if (!this.resume) return;
    this.playing = true;
    this.go();
    this.paintPlayKey();
  }

  // ---- the clock: each frame while playing, the replayer's time drives the scrubber, the moments and the ink
  tick() {
    this.raf = 0;
    if (!this.playing) return;
    if (this.replayer && !this.stalled && !this.scrubber.held)
      this.at = Math.min(this.end, this.start + this.replayer.getCurrentTime());
    this.draw();
    this.raf = requestAnimationFrame(this.frameLoop);
  }
  draw() {
    const done = (this.at - this.start) / Math.max(1, this.end - this.start);
    this.scrubber.show(done);
    const text = clock(this.at - this.start);
    if (text !== this.time.textContent) this.time.textContent = text;
    this.follow();
    this.drawInk();
  }
  // The moment the replay is at, marked and kept in view (unless the viewer scrolled the list just now)
  follow() {
    let i = this.shown;
    while (i + 1 < this.moments.length && this.moments[i + 1].at <= this.at + 1) i++;
    while (i >= 0 && this.moments[i].at > this.at + 1) i--;
    if (i === this.shown) return;
    this.list.children[this.shown]?.firstChild.removeAttribute('aria-current');
    this.shown = i;
    const item = this.list.children[i];
    if (!item) return;
    item.firstChild.setAttribute('aria-current', 'true');
    if (performance.now() - (this.listTouched ?? -1e9) < 4000) return;
    const top = item.offsetTop - (this.list.clientHeight - item.offsetHeight) / 2;
    this.list.scrollTo({ top, behavior: this.reduced ? 'auto' : 'smooth' });
  }
  drawInk() {
    if (!this.inked || !this.size) return;
    const strokes = this.replayer ? inkAt(this.inkEvents, this.at) : [];
    if (!strokes.length && !this.inkShown) return;
    const g = this.canvas.getContext('2d'),
      k = this.scale * devicePixelRatio;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    paint(this.ink, g, strokes, this.place, { until: this.at });
    this.inkShown = strokes.length > 0;
  }

  // ---- the screen, scaled to fit the stage by a transform; the ink's canvas as big, in device pixels
  fit(size = this.size) {
    if (!size?.width || !size?.height) return;
    this.size = size;
    // (the stage's room inside its padding, less the screen's own border: a frame's bezel)
    const stage = getComputedStyle(this.stage),
      edge = this.screen.offsetWidth - this.screen.clientWidth;
    const room = {
      width: this.stage.clientWidth - parseFloat(stage.paddingLeft) - parseFloat(stage.paddingRight) - edge,
      height: this.stage.clientHeight - parseFloat(stage.paddingTop) - parseFloat(stage.paddingBottom) - edge,
    };
    const scale = Math.min(room.width / size.width, room.height / size.height);
    if (!(scale > 0)) return;
    this.scale = scale;
    const w = size.width * scale,
      h = size.height * scale;
    Object.assign(this.screen.style, { width: `${w}px`, height: `${h}px` });
    Object.assign(this.frame.style, {
      width: `${size.width}px`,
      height: `${size.height}px`,
      transform: `scale(${scale})`,
    });
    this.canvas.width = Math.round(w * devicePixelRatio);
    this.canvas.height = Math.round(h * devicePixelRatio);
    this.inkShown = true; // (the canvas was cleared: draw it again)
    this.scrubber.measure();
    this.draw();
  }

  // A line over the stage (loading, a failure); '' for none
  say(text) {
    this.said.textContent = text;
    this.said.hidden = !text;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.playing = false;
    this.fits.disconnect();
    this.scrubber.destroy();
    this.replayer?.pause();
    this.box.replaceChildren();
  }
}

// What the ink needs of an event: page snapshots, ink, and that a canvas was pictured (not the picture)
function inkPart(event) {
  if (event.type === FULL_SNAPSHOT) return { type: event.type, timestamp: event.timestamp, data: {} };
  if (event.type === CUSTOM && event.data?.tag === 'ink') return event;
  if (event.type === INCREMENTAL && event.data?.source === CANVAS_MUTATION)
    return { type: event.type, timestamp: event.timestamp, data: { source: CANVAS_MUTATION, id: event.data.id } };
  return null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const attr = esc;
