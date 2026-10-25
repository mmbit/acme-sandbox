// A walk-through on the join link's page (joinpage.ts): the shared preview in a frame filling the page, the call
// minimised over it (HQ's CallBubble, with the agent's drawing as its face), and, only when the guest joined to show our
// pages, the watch-along recording what the frame shows.
//   - The recorder records the document it runs in, and the page's own parts (.own: the lobby, the call screen) are
//     marked data-watchalong-hide, as the bubble is: only the frame's page comes through, recording itself when asked
//     (shared/watchalong/framed.js, served with review.js whether its viewer may take notes or not; README.md "In a frame").
//   - The eye shows while the frame's page records: it says hello as it loads ({hq: 'watchalong', hello}), and bye as
//     it goes. A page that isn't ours says neither, and records nothing.
//   - Pause stops the recording at once and the call goes on; only the guest resumes it. Leaving or the call's end stops
//     it. Joining without showing records nothing at all: the recorder isn't even loaded.
import { CallBubble } from './callbubble.js';
import { Figure } from './figure.js';

export class WalkThrough {
  // words: the page's; token: the join link's, which starts the recording; tile: the agent's tile on the call screen,
  // where the bubble grows from and goes back to; audio(): the call's sound, for the bubble's own; onHangUp: leave
  constructor({ words, token, tile, reduced, audio, onHangUp }) {
    this.token = token;
    this.tile = tile;
    this.audio = audio;
    this.preview = document.querySelector('iframe.walk');
    this.ours = false;
    this.watching = null;
    this.on = false;
    this.join = null;
    const face = document.createElement('span');
    face.className = 'cb-figure';
    face.append(tile.querySelector('.drawing svg').cloneNode(true));
    this.face = new Figure(face.querySelector('svg'), reduced);
    this.bubble = new CallBubble({
      words: {
        call: words.callWith,
        pause: words.pause,
        resume: words.resume,
        hangUp: words.leave,
        open: words.open,
        watched: words.watched,
        paused: words.paused,
      },
      face,
      // (the call screen's own Leave drawing)
      icons: { hangUp: document.querySelector('.leave svg').outerHTML },
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onHangUp,
      onOpen: () => this.open(),
      onSound: () => this.settled(),
    });
    addEventListener('message', e => this.heard(e));
    // (loaded once this page listens: its page's hello comes as it loads)
    this.preview.src = this.preview.dataset.src;
    document.querySelector('.pages').addEventListener('click', () => this.minimise());
    addEventListener('keydown', e => e.key === 'Escape' && this.on && this.minimise());
  }

  // In the call: the preview, the call minimised over it, and the recording if they joined to show our pages
  async joined(show) {
    this.on = true;
    const join = (this.join = {});
    document.body.classList.add('walking');
    this.minimise();
    if (show && !this.watching) await this.startWatching(join);
  }

  // The call is over for this page: the recording stops, the call screen comes back over the frame
  over() {
    this.on = false;
    this.join = null;
    void this.watching?.stop();
    this.watching = null;
    void this.bubble.hide();
    document.body.classList.remove('min');
  }

  // (join: the join it starts for, so a start still on its way when the guest leaves never records a later one)
  async startWatching(join) {
    const answer = await fetch('/api/watchalong/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.token }),
    });
    if (!answer.ok) return console.error(`[join] the walk-through's recording didn't start: ${answer.status}`);
    const [{ events }, { watch }] = await Promise.all([answer.json(), import('./watchalong.js')]);
    if (this.join !== join || this.watching) return;
    this.watching = watch({
      url: events,
      typed: 'hidden',
      onEnd: () => {
        this.watching = null;
        this.showWatching();
      },
    });
    this.showWatching();
  }

  pause() {
    this.watching?.pause();
    this.showWatching();
  }

  resume() {
    this.watching?.resume();
    this.showWatching();
  }

  // The frame's page, ours or gone (framed.js's hello and bye to the page that frames it)
  heard(e) {
    if (e.source !== this.preview.contentWindow || e.data?.hq !== 'watchalong') return;
    if (e.data.hello) this.ours = true;
    else if (e.data.bye) this.ours = false;
    else return;
    this.showWatching();
  }

  // (its Pause comes and goes, so it settles into its corner again at its new width)
  showWatching() {
    const w = this.watching;
    this.bubble.watching(!w ? 'off' : w.paused ? 'paused' : this.ours ? 'watched' : 'off');
    this.bubble.settle();
  }

  minimise() {
    if (document.body.classList.contains('min')) return;
    const from = this.tile.getBoundingClientRect();
    document.body.classList.add('min');
    this.showWatching();
    this.bubble.show(from);
  }

  async open() {
    document.body.classList.remove('min');
    await this.bubble.hide(this.tile.getBoundingClientRect());
    document.querySelector('.pages').focus({ preventScroll: true });
  }

  // Each frame of the page: while minimised, the bubble's face alive with the call (state: idle | listening | thinking |
  // speaking). → whether it is minimised.
  frame(now, state, level) {
    if (!document.body.classList.contains('min')) return false;
    this.bubble.voice(level, state === 'speaking');
    this.bubble.state(state);
    this.face.state = state;
    this.face.level = level;
    this.face.frame(now);
    return true;
  }

  // A soft knock as the bubble lands in its corner, played into the call like its voice so the line's echo canceller
  // takes it out too
  settled() {
    const audio = this.audio();
    if (!audio?.voice) return;
    const { ctx, voice } = audio,
      t = ctx.currentTime + 0.01;
    const tone = ctx.createOscillator(),
      gain = ctx.createGain();
    tone.frequency.setValueAtTime(520, t);
    tone.frequency.exponentialRampToValueAtTime(340, t + 0.09);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.04, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    tone.connect(gain).connect(voice);
    tone.start(t);
    tone.stop(t + 0.14);
  }
}
