// A call guest's screen for the call's agent: their room on a call's page records itself while the call is on (the
// watch-along, as the board's Show my screen: the coordinator's callguests.ts screenOf), so the agent sees what they see
// and point at, the call's page and the prototypes they open over it, with their name. Never what they type: the
// recording keeps only that they typed. The join page said so before they joined. It goes with the call: nothing of it
// is kept to watch back.
// While it's shown, the room's bar has the eye and Pause, as the board's minimised call (an open prototype's bar while
// one is open: bookguestwork.js): Pause stops the recording at once and the agent sees nothing of it; Show again starts
// it anew. The server keeps the pause for the call, so a reload or a scan again doesn't show it again.
import { watch } from '/shared/watchalong/watchalong.js';
import { button, island, setPressed } from './bookui.js';
import { icon } from '../icons.js';
import { esc } from '../../util.js';
import { filled } from './notebookwords.js';

// Canvas pictures a second, as the board's call screen records (callscreen.js)
const CANVAS_FPS = 0.5;
// What ends it for good: the call is over, or its recording can take no more
const FINAL = ['over', 'full', 'too big'];

// The room's screen, started once and again after a drop (the room asks each time it reads the call: show(book), with
// the call's page as it read it). w: the room's screen words (notebookwords.js screen).
export const guestScreen = (api, w) => {
  const screen = new GuestScreen(api, w);
  return book => screen.show(book);
};

class GuestScreen {
  watching = null;
  asking = 0; // (the screen route's answers awaited)
  asked = 0; // (the newest ask: an older one's answer is let be)
  done = false;
  paused = false;
  told = true; // (the server has the pause as it is here)
  agent = '';

  // The eye while the agent sees it, and the key: Pause, or Show again while paused (the board's bubble's icons)
  constructor(api, w) {
    this.api = api;
    this.w = w;
    const eye = (this.eye = document.createElement('span'));
    eye.className = 'bk-guest-eye';
    eye.setAttribute('role', 'img');
    eye.innerHTML = icon('eye');
    const key = (this.key = button({ onClick: () => (this.paused ? this.ask({ paused: false }) : this.pause()) }));
    key.classList.add('bk-text', 'bk-guest-pause');
    island('send').append(eye, key);
    this.draw();
  }

  show(book) {
    this.agent = book?.call?.agent ?? this.agent;
    this.draw();
    if (this.done || this.asking) return;
    if (this.paused ? !this.told : !this.watching) this.ask(this.paused ? { paused: true } : {});
  }

  draw() {
    const { eye, key, paused, w } = this,
      on = !this.done && (paused || !!this.watching);
    eye.hidden = !on || paused;
    key.hidden = !on;
    const watched = filled(w.watched, { agent: this.agent });
    eye.setAttribute('aria-label', watched);
    eye.title = watched;
    const says = paused ? w.resume : w.pause;
    // (written only when its words change: icons.js draws an empty icon in after, and writing it again blinks)
    if (key.getAttribute('aria-label') !== says) {
      key.innerHTML = `${icon(paused ? 'eye' : 'pause')}<span>${esc(says)}</span>`;
      key.setAttribute('aria-label', says);
    }
    setPressed(key, paused);
  }

  // Their Pause: the recording stops here at once, then the server is told (again with the room's next read, if it
  // didn't hear)
  pause() {
    const was = this.watching;
    Object.assign(this, { paused: true, told: false, watching: null });
    void was?.stop();
    this.draw();
    this.ask({ paused: true });
  }

  // The screen route: {} starts it unless it's paused; { paused } pauses it, or starts it again
  async ask(body) {
    const mine = ++this.asked;
    this.asking++;
    try {
      const r = await fetch(`${this.api}/screen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // (404: the call is over; 409: they joined without showing it, as was theirs to choose)
      if (r.status === 404 || r.status === 409) this.done = true;
      const said = r.ok && mine === this.asked ? await r.json() : null;
      if (!said || mine !== this.asked) return;
      this.paused = said.paused;
      this.told = true;
      if (!this.paused && !this.watching) this.start(said.events);
    } catch (err) {
      console.error('[hq] the screen for the call wasn’t started:', err);
    } finally {
      this.asking--;
      this.draw();
    }
  }

  start(url) {
    const me = (this.watching = watch({
      url,
      typed: 'hidden',
      canvasFps: CANVAS_FPS,
      // (one stopped by their Pause is no longer watching: its last batch may reach a session already ended)
      onEnd: why => {
        if (this.watching !== me) return;
        this.watching = null;
        this.done = FINAL.includes(why);
        this.draw();
      },
    }));
  }
}
