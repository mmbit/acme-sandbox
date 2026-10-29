// Review mode: the feedback tool on shared product previews (shared/review/README.md).
// The coordinator serves this file only to the board (a valid preview key on <slug>.preview.<zone>); everyone
// else gets only the watch-along's answer to HQ's frame (shared/watchalong/framed.js, which it serves after this file
// for the board too), so it never runs for customers. Tap the pin (or draw on the page with a pen), then tap
// anything or draw on it, say or type the note, and it goes to HQ with a screenshot of the screen as it was and the last
// few things the board did here (the trail). The UI lives in a closed shadow root: product styles can't touch it.
// Its parts are modules beside it (tool.js puts them together), behind the same gate.
(() => {
  // In a frame it runs only directly inside HQ's preview viewer, where the board opens most demos: the coordinator
  // fills in HQ's origin, the script says hello to it, and starts once HQ answers from that origin. A product page
  // that frames itself (or another preview) gets no second pin.
  const HQ = '{{HQ_ORIGIN}}',
    framed = window.top !== window;
  // For an outside reviewer (a link the board shared) the coordinator writes in the company's name: whose crew the notes go to.
  const OUTSIDE = '{{OUTSIDE}}',
    outside = !OUTSIDE.startsWith('{{');
  // Their notes become scraps on their review page, drawn in their own colour (INK, #rrggbb).
  const THEIRS = '{{INK}}',
    INK = outside && /^#[0-9a-f]{6}$/i.test(THEIRS) ? THEIRS : null;
  // The menus' colours are the guest pages': the coordinator writes in the company's
  // (guests.ts palette); served as the file is, the guest pages' neutral ones
  const LOOK = '{{LOOK}}',
    NEUTRAL =
      ':host { --accent: #3a63c8; --bg: #f4f5f8; --card: #fff; --ink: #1b2130; --muted: #5d6577; --line: #e3e6ec; --on: #fff; ' +
      '--soft: color-mix(in srgb, var(--accent) 9%, var(--card)); --shadow: 0 1px 2px rgb(20 28 45 / .06), 0 6px 20px rgb(20 28 45 / .07); --btn-r: 99px }';
  if (window.__reviewMode || (framed && window.parent !== window.top)) return;
  window.__reviewMode = true;
  // its notes go next to the script: /<slug>/__review/ for a shelf on the front's preview door (infra/products.py)
  const ROUTE = new URL('.', document.currentScript?.src || new URL('/__review/review.js', location.href));
  // A page that loads the tool itself (its script tag carries data-summoned: HQ, for the board's notes on HQ) hears its
  // menu's Open the book as a 'review:book' event (detail: whose sheet). A
  // 'review:cover' event (detail true, then false) hides the tool while the page frames another page with its own pin.
  // A 'review:pin' event gets the pin itself in its detail.
  // Such a page summons the pin and puts it away ('review:summon', detail true or false: on HQ, the board's opening the
  // book or the book's pin control; the Pencil writes either way); the pin starts away there.
  const summoned = !!document.currentScript?.hasAttribute('data-summoned');
  // ...and data-book: HQ's own pages, where the Pencil writes on the page and its notes go to the board's book
  // (pencil.js).
  const book = summoned && !!document.currentScript?.hasAttribute('data-book');
  const toHq = m => {
    if (!framed) return;
    try {
      parent.postMessage({ hq: 'review', ...m }, HQ);
    } catch {
      /* not served by the coordinator */
    }
  };
  const config = {
    HQ,
    framed,
    OUTSIDE,
    outside,
    INK,
    LOOK: LOOK.startsWith('{{') ? NEUTRAL : LOOK,
    ROUTE,
    summoned,
    book,
    toHq,
    covered: false,
    away: summoned,
  };
  // (heard from the start: a cover asked for while the tool still loads holds once it's up)
  addEventListener('review:cover', e => (config.covered = !!e.detail));
  addEventListener('review:summon', e => (config.away = !e.detail));
  let tool = null;
  const start = () => (tool ??= import(new URL('tool.js', ROUTE).href).then(m => m.start(config)));
  if (!framed) start();
  else {
    addEventListener('message', e => {
      if (e.source !== parent || e.origin !== HQ || e.data?.hq !== 'hq') return;
      start().then(ui => {
        if (e.data.pin) ui.toggle(); // the pin button in HQ's viewer bar
      });
      if (e.data.ask) toHq({ hello: 1 }); // HQ asks every page its frame loads
      // the call's agent driving the preview (drive.js: HQ's calldrive.js).
      if (e.data.drive)
        import(new URL('drive.js', ROUTE).href)
          .then(m => m.drive(e.data.drive))
          .catch(err => ({ done: false, why: `The preview couldn't do it (${err?.message || err}).` }))
          .then(answer => toHq({ driven: { ...answer, id: e.data.drive.id } }));
    });
    // HQ hides its pin button until the next page says hello (when it arrives: Chromium drops it.)
    addEventListener('pagehide', () => toHq({ bye: 1 }));
    addEventListener('pageshow', e => e.persisted && toHq({ hello: 1 }));
    toHq({ hello: 1 });
  }
})();
