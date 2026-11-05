// The guest room's call bar, on a call's page (bookguest.js): once the board has left the call to its guests (HQ's
// hang-up, the coordinator's callguests.ts), a guest goes on talking with the agent on their own device. The bar says
// first, in the room's language, that the agent is an AI and the call is written down, never its sound (the
// walk-through note's notice, as the join page said it, with the privacy page's link as the partner join page has it),
// and that the browser asks for the microphone; their tap starts the microphone and the call's sound (callaudio.js, as
// HQ's call screen) and carries the call over the voice line's /voice/guest, on a one-time ticket for their session
// (POST /guest/scan/voice).
//   page → line  {ticket}, then the microphone as HQ's call screen sends it (mic-worklet.js), {type: 'bye'}
//   line → page  {type: 'call', id}, state, said, clear, hangup (and others the board's screen takes, let be); every
//                20 ms the agent's voice
//   closes       4000 the call is over (or not theirs to carry), 4001 another guest's device took it, 4002 the board
//                came back into it; anything else drops: a new ticket, back into the call (the line holds it)
// In the top layer (a popover): the book's spread leaves the rest of the page untappable.
import { CallAudio } from '../callaudio.js';
import { esc, stylesheet } from '../../util.js';
import { filled, words } from './notebookwords.js';

stylesheet('shell/ink/bookguestcall.css');
// A dropped connection's tries to get back into the call (the line holds it ten minutes)
const TRIES = 8;
// How long the bar says the board's device carries the call again, before it goes
const SAID_MS = 8000;

// The bar for the room's language: show(book) with the call's page as the room last read it (its call: {agent, away,
// privacy}), or null once the room has ended
export const callBar = lang => {
  const bar = new GuestCallBar(words[lang].call);
  return book => bar.show(book);
};

class GuestCallBar {
  agent = '';
  away = false;
  privacy = null; // (the privacy page's address for the call's language, or none)
  c = null; // (the call on this device: its audio, its connection)
  said = ''; // (why the bar shows with nothing to carry: moved, back, ended, a failure)

  constructor(w) {
    this.w = w;
    const bar = (this.bar = document.createElement('section'));
    bar.className = 'bk-guest-call';
    bar.popover = 'manual';
    bar.setAttribute('aria-live', 'polite');
    bar.addEventListener('click', e => {
      if (e.target.closest('.bk-gc-talk')) this.talk();
      else if (e.target.closest('.bk-gc-hangup')) this.hangUp();
    });
    document.body.append(bar);
  }

  words(key) {
    return esc(filled(this.w[key], { agent: this.agent }));
  }

  show(book) {
    if (!book) {
      if (this.c) this.stop(this.c, 'ended');
      return this.bar.remove();
    }
    this.agent = book.call?.agent ?? this.agent;
    this.privacy = book.call?.privacy ?? this.privacy;
    const was = this.away;
    this.away = !!book.call?.away;
    if (this.away && !was && this.said === 'back') this.said = ''; // (left to them again)
    this.draw();
  }

  draw() {
    const { bar, c, said } = this,
      offer = this.away && !c;
    bar.classList.toggle('on', !!c);
    if (!c && !offer && !said) {
      if (bar.matches(':popover-open')) bar.hidePopover();
      return;
    }
    bar.innerHTML = c
      ? `<p class="bk-gc-state"><span class="bk-gc-dot" aria-hidden="true"></span><b>${esc(this.agent)}</b> <span>${this.words(
          c.state || 'connecting',
        )}</span></p><p>${this.words('on')}</p><button type="button" class="bk-gc-hangup">${this.words('hangUp')}</button>`
      : `${said ? `<p class="bk-gc-said" role="status">${this.words(said)}</p>` : ''}${
          offer
            ? `<p>${this.words('left')}</p><p class="bk-gc-notice">${this.words('notice')}${
                this.privacy
                  ? ` <a href="${esc(this.privacy)}" target="_blank" rel="noopener noreferrer">${this.words('privacy')}</a>`
                  : ''
              }</p><p class="bk-gc-mic">${this.words('mic')}</p><button type="button" class="bk-gc-talk">${this.words(
                'talk',
              )}</button>`
            : ''
        }`;
    if (!bar.matches(':popover-open')) bar.showPopover();
  }

  // Their tap: the call's sound and the microphone, opened in it (iOS starts them only in a tap), then the line
  async talk() {
    if (this.c) return;
    this.said = '';
    const me = (this.c = { state: '', tries: 0 });
    me.audio = new CallAudio({
      worklet: 'shell/mic-worklet.js',
      lead: 0.05,
      send: frame => me.live && me.ws?.readyState === 1 && me.ws.send(frame),
      lost: () => this.stop(me, 'micDenied'),
    });
    me.audio.awake.keep();
    me.audio.open();
    this.draw();
    try {
      await me.audio.start();
    } catch {
      return this.stop(me, 'micDenied');
    }
    if (this.c === me) this.connect(me);
  }

  async connect(me) {
    let ticket = '';
    try {
      const r = await fetch('/guest/scan/voice', { method: 'POST' });
      ticket = r.ok ? (await r.json()).ticket : '';
    } catch {
      // (none: said below)
    }
    if (this.c !== me) return;
    if (!ticket) return this.stop(me, this.away ? 'dropped' : 'back');
    const ws = (me.ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/voice/guest`));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ ticket }));
    ws.onmessage = m => this.c === me && me.ws === ws && this.heard(me, m.data);
    ws.onclose = e => this.c === me && me.ws === ws && this.closed(me, e.code);
  }

  heard(me, data) {
    if (data instanceof ArrayBuffer) return me.live && me.audio.play(new Int16Array(data));
    const ev = JSON.parse(data);
    if (ev.type === 'call') {
      me.live = true;
      me.tries = 0;
      me.state = 'listening';
    } else if (ev.type === 'state' && this.w[ev.state]) me.state = ev.state;
    else if (ev.type === 'clear') me.audio.stopPlayback();
    else if (ev.type === 'said') me.audio.startSentence('voice');
    // (the agent ended the call: as their own hang-up)
    else if (ev.type === 'hangup') return this.hangUp();
    else return;
    this.draw();
  }

  closed(me, code) {
    const was = me.live;
    me.live = false;
    // (4000 on a call they carried, or once back in: the call is over; on their first try it was never theirs)
    if (code === 4000) return this.stop(me, was || me.tries || !this.away ? 'ended' : 'dropped');
    if (code === 4001) return this.stop(me, 'moved');
    if (code === 4002) return this.stop(me, 'back');
    if (++me.tries > TRIES) return this.stop(me, 'dropped');
    me.audio.stopPlayback();
    me.state = '';
    this.draw();
    setTimeout(() => this.c === me && this.connect(me), Math.min(500 * me.tries, 3000));
  }

  // Their hang-up ends the call: the board left it to them
  hangUp() {
    const me = this.c;
    if (!me) return;
    if (me.ws?.readyState === 1) me.ws.send(JSON.stringify({ type: 'bye' }));
    this.stop(me, 'ended');
  }

  stop(me, why) {
    if (this.c !== me) return;
    this.c = null;
    this.said = why;
    me.ws?.close();
    me.audio.close();
    this.draw();
    // (the board back on its own device: said for a while, then the bar goes)
    if (why === 'back')
      setTimeout(() => {
        if (this.said !== 'back' || this.c) return;
        this.said = '';
        this.draw();
      }, SAID_MS);
  }
}
