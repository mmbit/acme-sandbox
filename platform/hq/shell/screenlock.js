// The screen kept on while a call needs it: the call's own sound (callaudio.js), HQ's and the join page's. The join page
// loads this same file from /join/assets/ (joinpage.ts).
// The browser lets go of a wake lock each time the page is hidden, and the system can let go of it on its own, so it's
// asked for again a second after it's let go (if in view), and each time the page is back. If the page comes back while
// a request is pending, it's asked once more when that settles: the browser may refuse it because the page was hidden
// when it was made. Safari grants the first one only within a few seconds of a tap (later ones on the page without): the
// page asks for it in the tap.

export class ScreenLock {
  stopped = false;

  // mark(kind): each answer, for the call's timeline: 'wake lock held', 'no wake lock', 'wake lock refused' or
  //   'wake lock released'
  constructor(mark = () => {}) {
    this.mark = mark;
    this.shown = () => this.keep();
    document.addEventListener('visibilitychange', this.shown);
  }

  async keep() {
    if (this.stopped || document.hidden || (this.lock && !this.lock.released)) return;
    if (this.locking) return void (this.again = true);
    this.locking = true;
    let lock;
    try {
      lock = await navigator.wakeLock?.request('screen');
      this.mark(lock ? 'wake lock held' : 'no wake lock');
    } catch {
      this.mark('wake lock refused');
    }
    this.locking = false;
    if (this.stopped) return lock?.release();
    if (lock) {
      this.lock = lock;
      lock.addEventListener('release', () => {
        if (this.stopped) return;
        this.mark('wake lock released');
        setTimeout(() => this.keep(), 1000);
      });
    }
    if (this.again) {
      this.again = false;
      this.keep();
    }
  }

  stop() {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.shown);
    this.lock?.release().catch(() => {});
  }
}
