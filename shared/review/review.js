// Review mode: the board's feedback tool on every product page (shared/review/README.md).
// The coordinator serves this file only to the board (a valid preview key on <slug>.preview.<zone>); everyone
// else gets only the watch-along's answer to HQ's frame (shared/watchalong/framed.js, which it serves after this file
// for the board too), so it never runs for customers. Tap the pin (or draw on the page with a pen), then tap
// anything or draw on it, say or type the note, and it goes to HQ with a screenshot of the screen as it was and the last
// few things the board did here (the trail). The UI lives in a closed shadow root: product styles can't touch it.
(() => {
  // In a frame it runs only directly inside HQ's preview viewer, where the board opens most demos: the coordinator
  // fills in HQ's origin, the script says hello to it, and starts once HQ answers from that origin. A product page
  // that frames itself (or another preview) gets no second pin.
  const HQ = '{{HQ_ORIGIN}}', framed = window.top !== window;
  // For an outside reviewer (a link the board shared) the coordinator writes in the company's name: whose crew the notes go to.
  const OUTSIDE = '{{OUTSIDE}}', outside = !OUTSIDE.startsWith('{{');
  // ...and whether they already sent their notes (then the tool is only its menu's Add more notes)
  const SENT = outside && '{{SENT}}' === '1';
  // The menus' colours are the guest pages': the coordinator writes in the company's
  // (guests.ts palette); served as the file is, the guest pages' neutral ones
  const LOOK = '{{LOOK}}', NEUTRAL = ':host { --accent: #3a63c8; --bg: #f4f5f8; --card: #fff; --ink: #1b2130; --muted: #5d6577; --line: #e3e6ec; --on: #fff; '
    + '--soft: color-mix(in srgb, var(--accent) 9%, var(--card)); --shadow: 0 1px 2px rgb(20 28 45 / .06), 0 6px 20px rgb(20 28 45 / .07); --btn-r: 99px }';
  if (window.__reviewMode || (framed && window.parent !== window.top)) return;
  window.__reviewMode = true;
  // its notes go next to the script: /<slug>/__review/ for a shelf on the front's preview door (infra/products.py)
  const ROUTE = new URL('.', document.currentScript?.src || new URL('/__review/review.js', location.href));
  // A page that summons the tool itself (its script tag carries data-summoned: HQ, for the board's notes on HQ) gets it
  // put away from its menu, and back with a 'review:summon' event; its Send my notes is the page's 'review:send' event, and
  // a 'review:notes' event (notes sent or discarded on that page) counts them again.
  // A 'review:cover' event (detail true, then false) hides the tool while the page frames another page with its own pin.
  const summoned = !!document.currentScript?.hasAttribute('data-summoned');
  let started = false, ui = null;
  const toHq = m => { if (framed) try { parent.postMessage({ hq: 'review', ...m }, HQ); } catch { /* not served by the coordinator */ } };
  if (!framed) start();
  else {
    addEventListener('message', e => {
      if (e.source !== parent || e.origin !== HQ || e.data?.hq !== 'hq') return;
      if (!started) start();
      if (e.data.pin) ui.toggle(); // the pin button in HQ's viewer bar
      if (e.data.notes) ui.refresh(); // notes sent or discarded in HQ's Reviews
      if (e.data.ask) toHq({ hello: 1 }); // HQ asks every page its frame loads
    });
    addEventListener('pagehide', () => toHq({ bye: 1 })); // HQ hides its pin button until the next page says hello (when it arrives: Chromium drops it.)
    addEventListener('pageshow', e => e.persisted && toHq({ hello: 1 }));
    toHq({ hello: 1 });
  }
  function start() {
    started = true;
    const doc = document, TRAIL_KEY = '__hq_review_trail', ACCENT = '#ff5a5f';

    // ---------------------------------------------------------------- trail: clicks, scrolls and route changes
    // Kept in sessionStorage so it survives page loads within the tab; the last 50 go with each note.
    let host; // our own element: nothing inside it is logged or photographed
    const here = () => location.pathname + location.search + location.hash;
    const trail = (() => { try { return JSON.parse(sessionStorage.getItem(TRAIL_KEY)) || []; } catch { return []; } })();
    const log = (type, extra) => {
      trail.push({ t: Date.now(), type, url: here(), ...extra }); trail.splice(0, trail.length - 50);
      try { sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail)); } catch { /* private mode: memory only */ }
    };
    log('load');
    addEventListener('click', e => {
      if (host && e.composedPath().includes(host)) return;
      log('click', { target: e.target instanceof Element ? selector(e.target) : '', x: Math.round(e.clientX), y: Math.round(e.clientY) });
    }, true);
    let scrolled; addEventListener('scroll', () => { clearTimeout(scrolled); scrolled = setTimeout(() => log('scroll', { y: Math.round(scrollY) }), 500); }, { passive: true });
    const push = history.pushState;
    history.pushState = function (...a) { const r = push.apply(this, a); log('route'); return r; };
    addEventListener('popstate', () => log('route')); addEventListener('hashchange', () => log('route'));

    // A CSS-ish path an agent can find the element by: up to five steps, stopping at an id. One in an open shadow root
    // (a chat's panel) starts with its host's path, then a space
    function selector(el) {
      const root = el.getRootNode?.(), parts = [];
      for (let e = el; e && e.nodeType === 1 && e !== doc.documentElement && parts.length < 5; e = e.parentElement) {
        if (e.id) { parts.unshift(`${e.localName}#${CSS.escape(e.id)}`); break; }
        let s = e.localName + [...e.classList].slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
        const same = e.parentElement ? [...e.parentElement.children].filter(x => x.localName === e.localName) : [];
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
        parts.unshift(s);
      }
      const path = parts.join(' > ');
      return root instanceof ShadowRoot ? `${selector(root.host)} ${path}` : path;
    }

    // ---------------------------------------------------------------- the UI
    const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 2.5l7 7-2.2.6-3.6 3.6.4 4.6-1.6 1.6-4.2-4.2L5 21l-.9-.9 5.3-5.3-4.2-4.2 1.6-1.6 4.6.4 3.6-3.6z" fill="currentColor"/></svg>';
    const MENU = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const UNDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';
    const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
    const CSS_TEXT = `
      :host { all: initial; }
      ${LOOK.startsWith('{{') ? NEUTRAL : LOOK}   /* the menus' colours */
      * { box-sizing: border-box; }
      .ui { position: fixed; inset: 0; pointer-events: none; font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #2b2230; -webkit-tap-highlight-color: transparent; }
      button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
      /* the dock holds the pin and its hints: bottom right above the home bar, lifted clear of the page's own buttons (--up), or where the board dragged it */
      .dock { position: absolute; width: 60px; height: 60px; right: max(18px, calc(env(safe-area-inset-right) + 8px)); bottom: max(18px, calc(env(safe-area-inset-bottom) + 10px));
        transform: translateY(calc(-1 * var(--up, 0px))); transition: transform .35s cubic-bezier(.3,1.4,.5,1); }
      .dock.left { right: auto; left: max(18px, calc(env(safe-area-inset-left) + 8px)); }
      .dock.drag { left: var(--dx); top: var(--dy); right: auto; bottom: auto; transform: none; transition: none; }
      .dock[hidden] { display: none; }
      .fab { pointer-events: auto; position: absolute; inset: 0; touch-action: none;
        width: 60px; height: 60px; border-radius: 50%; background: ${ACCENT}; color: #fff; display: grid; place-items: center;
        box-shadow: 0 6px 0 #c23c44, 0 12px 24px rgba(43,34,48,.3); transition: transform .25s cubic-bezier(.3,1.6,.5,1), box-shadow .15s; animation: bob 3.2s ease-in-out infinite; }
      .dock.drag .fab { animation: none; transform: scale(1.12); box-shadow: 0 14px 0 #c23c44, 0 22px 34px rgba(43,34,48,.3); }
      .fab svg { width: 28px; height: 28px; transition: transform .3s cubic-bezier(.3,1.6,.5,1); }
      .fab:active { transform: translateY(5px); box-shadow: 0 1px 0 #c23c44, 0 4px 10px rgba(43,34,48,.3); }
      .fab.on { animation: none; background: #2b2230; box-shadow: 0 6px 0 #000, 0 12px 24px rgba(43,34,48,.3); }
      .fab.on svg { transform: rotate(45deg) scale(.9); }
      .fab[hidden] { display: none; }
      .fab.boing { animation: boing .6s cubic-bezier(.3,1.6,.5,1); }
      /* hints go over the pin: beside it sits the menu's button */
      .tip { position: absolute; right: 0; bottom: 72px; background: #2b2230; color: #fff; padding: 6px 12px; border-radius: 10px;
        font-size: 14px; white-space: nowrap; opacity: 0; transform: translateY(6px); transition: .25s; pointer-events: none; }
      .dock.left .tip { right: auto; left: 0; }
      .tip.show { opacity: 1; transform: none; }
      /* the menu, a quiet round button beside the pin with the count of notes not sent yet */
      .more { pointer-events: auto; position: absolute; right: 70px; bottom: 12px; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; touch-action: none;   /* (it drags the pin too) */
        background: rgba(255,255,255,.92); color: #2b2230; border: 1px solid rgba(43,34,48,.3); box-shadow: 0 2px 8px rgba(43,34,48,.15); }
      .more svg { width: 16px; height: 16px; }
      .more[aria-expanded="true"] { background: #2b2230; color: #fff; }
      .more .count { position: absolute; top: -8px; left: -8px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: #ffe66d; color: #2b2230;
        font-size: 12px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 2px 0 #d9b92c; }
      .more .count:empty { display: none; }
      .more.boing { animation: boing .6s cubic-bezier(.3,1.6,.5,1); }
      .dock.left .more { right: auto; left: 70px; }
      .more[hidden], .menu[hidden], .menu [hidden] { display: none; }
      /* the menu and My notes look like the guest pages: plain cards in their colours */
      .menu { pointer-events: auto; position: absolute; right: 0; bottom: 72px; width: min(290px, calc(100vw - 24px)); padding: 6px; background: var(--card); color: var(--ink);
        border-radius: 18px; box-shadow: 0 0 0 1px var(--line), var(--shadow), 0 14px 34px rgb(20 28 45 / .16); animation: pop-in .3s cubic-bezier(.3,1.5,.5,1) both; }
      .menu.below { bottom: auto; top: 72px; }
      .dock.left .menu { right: auto; left: 0; }
      .screen { max-height: min(62vh, 440px); overflow: auto; padding: 4px 0 0; }
      .cap { margin: 4px 12px 6px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
      .screen button { display: block; width: 100%; padding: 10px 12px; border-radius: 12px; text-align: left; font-size: 15px; font-weight: 600; transition: background .15s, filter .15s; }
      .screen button:hover, .screen button:focus-visible { background: var(--soft); outline: 0; }
      .screen button:disabled { opacity: .6; }
      .screen small { display: block; margin-top: 1px; font-size: 13px; font-weight: 400; color: var(--muted); }
      .screen .go, .screen .go:hover, .screen .go:focus-visible { margin-top: 6px; border-radius: min(var(--btn-r), 16px); background: var(--accent); color: var(--on); }   /* Send my notes, Add more notes: the menu's way on */
      .screen .go:hover, .screen .go:focus-visible { filter: brightness(1.07); }
      .screen .go small { color: inherit; opacity: .85; }
      .screen .go.sure { background: ${ACCENT}; color: #fff; }
      /* Listen as I draw: a switch */
      .screen [role=menuitemcheckbox] { position: relative; padding-right: 64px; }
      .screen [role=menuitemcheckbox]::after { content: ""; position: absolute; right: 12px; top: 50%; width: 40px; height: 24px; margin-top: -12px; border-radius: 12px; background: var(--line); transition: background .2s; }
      .screen [role=menuitemcheckbox]::before { content: ""; position: absolute; z-index: 1; right: 30px; top: 50%; width: 20px; height: 20px; margin-top: -10px; border-radius: 50%; background: #fff;
        box-shadow: 0 1px 2px rgb(0 0 0 / .25); transition: transform .2s cubic-bezier(.3,1.5,.5,1); }
      .screen [aria-checked="true"]::after { background: var(--accent); }
      .screen [aria-checked="true"]::before { transform: translateX(16px); }
      /* My notes: a sidebar sliding in from the side (the whole width on a phone), every note a card in one scrolling list.
         Sized to what's visible (fitSide, below), it stays on screen on a zoomed or wide page. */
      .side { pointer-events: auto; position: absolute; top: 0; right: 0; bottom: 0; width: min(440px, 100%); display: flex; background: var(--bg); color: var(--ink); transform-origin: 0 0;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) 0;
        box-shadow: -1px 0 0 var(--line), -14px 0 34px rgb(20 28 45 / .18); animation: slide-in .3s cubic-bezier(.3,1.2,.5,1) both; }
      .side.whole { box-shadow: none; padding-left: env(safe-area-inset-left); }
      .dim { pointer-events: auto; position: absolute; inset: 0; background: rgb(20 28 45 / .3); }   /* beside it on a wider screen: a tap closes it */
      @keyframes slide-in { from { transform: translateX(100%) } }
      .side[hidden], .dim[hidden], .zoom[hidden], .side [hidden] { display: none; }
      .side .screen { flex: 1; min-width: 0; display: flex; flex-direction: column; max-height: none; overflow: hidden; padding: 0; }
      .side header { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 16px; background: var(--card); border-bottom: 1px solid var(--line); }
      .side header .cap { flex: 1; margin: 0; }
      .side .x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; text-align: center; font-size: 24px; font-weight: 400; line-height: 1; color: var(--muted); }
      .side ol { flex: 1; overflow: auto; overscroll-behavior: contain; list-style: none; margin: 0; padding: 2px 14px 14px; }
      .side li { margin: 12px 0 0; padding: 14px; border-radius: 16px; background: var(--card); box-shadow: var(--shadow); }
      .side .shot { position: relative; aspect-ratio: 4 / 3; padding: 0; overflow: hidden; border-radius: 10px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); cursor: zoom-in; }
      .side .shot img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; display: block; }   /* (the whole screen, where frame.js won't frame it) */
      .side .shot img.framed { max-width: none; object-fit: fill; }
      .side .words { margin: 12px 0 4px; font-size: 15px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .side .pics { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 6px; padding: 0; list-style: none; }   /* */
      .side .pics button { width: 56px; height: 56px; padding: 0; overflow: hidden; border-radius: 8px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); cursor: zoom-in; }
      .side .pics img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .side .where { overflow-wrap: anywhere; }
      .side .acts { display: flex; gap: 8px; margin-top: 12px; }
      .side .acts button { width: auto; padding: 8px 16px; border-radius: var(--btn-r); font-size: 14px; background: var(--soft); }
      .side .acts .sure, .side .acts .sure:hover { background: ${ACCENT}; color: #fff; }
      .side .oops { margin: 8px 0 0; font-size: 13px; color: #c23c44; }
      .side .oops:empty { display: none; }
      .side footer { display: flex; gap: 8px; padding: 10px 14px 12px; background: var(--card); border-top: 1px solid var(--line); }
      .side footer button { width: auto; margin: 0; }
      .side footer [data-close] { flex: none; padding: 10px 20px; border-radius: var(--btn-r); text-align: center; background: var(--soft); }   /* where a thumb reaches */
      .side footer .go { flex: 1; min-width: 0; margin: 0; }
      .side .empty { margin: 16px 4px; color: var(--muted); }
      /* a screenshot, bigger: the whole screen as it was, a tap or Escape puts it away */
      .zoom { pointer-events: auto; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
        background: rgb(10 12 18 / .9); cursor: zoom-out; animation: pop-in .25s cubic-bezier(.3,1.5,.5,1) both; }
      .zoom img { min-width: 0; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; box-shadow: 0 14px 40px rgba(0,0,0,.6); background: #fff; }
      /* the first few pages a reviewer opens: a bubble that says what the pin is for, and a ring around the pin */
      .coach { pointer-events: auto; position: absolute; right: -6px; bottom: 80px; width: max-content; max-width: min(260px, calc(100vw - 32px)); background: #fff; color: #2b2230;
        border: 2px solid #2b2230; border-radius: 16px; padding: 12px 14px 8px; box-shadow: 0 4px 0 #2b2230, 0 14px 34px rgba(43,34,48,.3); font-size: 14px; line-height: 1.35;
        animation: pop-in .45s cubic-bezier(.3,1.5,.5,1) both; }
      .coach::after { content: ""; position: absolute; right: 26px; bottom: -9px; width: 14px; height: 14px; background: #fff; border: solid #2b2230; border-width: 0 2px 2px 0; transform: rotate(45deg); }
      .dock.left .coach { right: auto; left: -6px; } .dock.left .coach::after { right: auto; left: 26px; }
      .coach[hidden] { display: none; }
      .coach b { display: block; font-size: 16px; margin-bottom: 3px; }
      .coach button { display: block; margin: 4px 0 0 auto; padding: 6px 2px; font-weight: 700; color: #c23c44; }
      .dock.coaching .fab::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 3px solid ${ACCENT}; animation: ring 1.5s ease-out infinite; pointer-events: none; }
      @keyframes pop-in { from { transform: translateY(12px) scale(.85); opacity: 0 } }
      @keyframes ring { from { transform: scale(.85); opacity: 1 } to { transform: scale(1.45); opacity: 0 } }
      @keyframes bob { 0%, 100% { transform: translateY(0) rotate(0) } 50% { transform: translateY(-3px) rotate(-4deg) } }
      @keyframes boing { 0% { transform: scale(1) } 30% { transform: scale(1.3) rotate(12deg) } 60% { transform: scale(.9) rotate(-6deg) } 100% { transform: none } }

      .veil { pointer-events: auto; position: absolute; inset: 0; touch-action: none; cursor: crosshair;
        box-shadow: inset 0 0 0 4px ${ACCENT}, inset 0 0 60px rgba(255,90,95,.25); background: rgba(255,246,216,.08); }
      .veil[hidden], .sheet[hidden] { display: none; }
      /* over the page while the board marks it: what to do, and the inks */
      .bar { position: absolute; left: 50%; top: max(14px, env(safe-area-inset-top)); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .hint { background: #fff; border-radius: 999px; padding: 10px 18px;
        box-shadow: 0 4px 0 #2b2230, 0 10px 30px rgba(43,34,48,.25); border: 2px solid #2b2230; white-space: nowrap; font-weight: 600; font-size: 15px; display: flex; gap: 10px; align-items: center; }
      .veil.marked .hint { display: none; }
      /* the inks: little pots of paint on a strip of card, the one in hand lifted out of its well */
      .strip { display: flex; align-items: center; padding: 3px 4px; border-radius: 999px; cursor: default; touch-action: manipulation;
        background: linear-gradient(#fffdf6, #f1ead8); border: 2px solid #2b2230; box-shadow: 0 4px 0 #2b2230, 0 10px 30px rgba(43,34,48,.25), inset 0 1px 0 #fff; }
      .strip button { position: relative; width: 40px; height: 40px; display: grid; place-items: center; }
      .strip .pot i { width: 24px; height: 24px; border-radius: 50%; background: var(--c); transition: transform .2s cubic-bezier(.3,1.6,.5,1), box-shadow .2s;
        box-shadow: inset 0 2px 3px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.35), 0 1px 0 #fff; }
      .strip .pot i::after { content: ""; position: absolute; width: 7px; height: 4px; margin: 5px 0 0 6px; border-radius: 50%; background: rgba(255,255,255,.55); opacity: 0; transition: opacity .2s; }
      .strip .pot.wide i { width: 26px; height: 15px; border-radius: 4px; opacity: .75; transform: rotate(-20deg); }   /* (the highlighter's chisel tip) */
      .strip .pot[aria-pressed="true"] i { transform: translateY(-3px) scale(1.12); box-shadow: 0 0 0 2px #fffdf6, 0 0 0 4px #2b2230, 0 5px 6px rgba(43,34,48,.35); }
      .strip .pot.wide[aria-pressed="true"] i { transform: translateY(-3px) rotate(-20deg) scale(1.12); }
      .strip .pot[aria-pressed="true"] i::after { opacity: 1; }
      .strip .sep { width: 2px; height: 24px; margin: 0 4px; border-radius: 1px; background: rgba(43,34,48,.18); }
      .strip .undo { color: #2b2230; } .strip .undo svg { width: 22px; height: 22px; } .strip .undo:disabled { opacity: .3; cursor: default; }
      .strip .undo:not(:disabled):active svg { transform: rotate(-40deg); transition: transform .1s; }
      .hint i { width: 20px; height: 20px; color: ${ACCENT}; animation: peck 1.2s ease-in-out infinite; } .hint i svg { width: 100%; height: 100%; }
      .hint small { font-weight: 400; color: #6d6275; }
      @keyframes peck { 0%, 100% { transform: translateY(0) } 40% { transform: translateY(4px) rotate(8deg) } }
      .hl { position: absolute; border: 2px dashed ${ACCENT}; border-radius: 6px; background: rgba(255,90,95,.08); transition: all .08s; pointer-events: none; }
      .hl[hidden] { display: none; }
      .ink, .wet { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }   /* the strokes, and the one being drawn (ink.js) */
      .drop { position: absolute; width: 34px; height: 34px; margin: -30px 0 0 -6px; color: ${ACCENT}; filter: drop-shadow(0 2px 0 #fff); animation: land .4s cubic-bezier(.3,1.6,.5,1); pointer-events: none; }
      @keyframes land { from { transform: translateY(-40px) scale(1.4); opacity: 0 } }

      .sheet { pointer-events: auto; position: absolute; left: 50%; bottom: calc(max(12px, env(safe-area-inset-bottom)) + var(--kb, 0px)); width: min(540px, calc(100vw - 20px));
        transform: translateX(-50%) rotate(-.6deg); background: #fff6c9; border-radius: 4px 4px 14px 14px; padding: 22px 18px 14px;
        box-shadow: 0 2px 0 #e7d98f, 0 18px 50px rgba(43,34,48,.35); animation: pop .35s cubic-bezier(.3,1.5,.5,1); max-height: calc(100dvh - 24px - var(--kb, 0px)); overflow: auto; }
      .sheet::before { content: ""; position: absolute; top: -12px; left: 50%; width: 110px; height: 26px; transform: translateX(-50%) rotate(2deg); background: rgba(255,255,255,.55);
        border-left: 2px dotted rgba(0,0,0,.06); border-right: 2px dotted rgba(0,0,0,.06); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
      .sheet.away { animation: away .5s cubic-bezier(.6,-.3,.7,.5) forwards; }
      @keyframes pop { from { transform: translateX(-50%) translateY(40px) rotate(3deg) scale(.9); opacity: 0 } }
      @keyframes away { to { transform: translate(35vw, 20vh) rotate(25deg) scale(.1); opacity: 0 } }
      .top { display: flex; gap: 14px; align-items: flex-start; }
      .polaroid { flex: none; width: 112px; background: #fff; padding: 6px 6px 18px; box-shadow: 0 3px 10px rgba(43,34,48,.25); transform: rotate(3deg); position: relative; }
      .polaroid .img { width: 100%; aspect-ratio: 3 / 4; background: #3a3345; display: grid; place-items: center; overflow: hidden; position: relative; } /* (relative: a framed img sits on the mark) */
      .polaroid img, .polaroid canvas { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; animation: develop 1.2s ease-out; }
      .polaroid .framed { position: absolute; max-width: none; object-fit: fill; }
      .polaroid .img span { color: #cfc6da; font-size: 11px; text-align: center; padding: 6px; }
      .polaroid.busy .img { background: linear-gradient(110deg, #3a3345 30%, #5a4f6b 50%, #3a3345 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
      @keyframes shimmer { to { background-position: -150% 0 } }
      @keyframes develop { from { filter: brightness(2.2) sepia(.6) blur(2px); opacity: .4 } }
      .who { min-width: 0; flex: 1; }
      .who h2 { margin: 0 0 6px; font: 700 22px/1.15 "Marker Felt", "Chalkboard SE", "Segoe Print", "Comic Sans MS", cursive; }
      .chip { display: inline-block; max-width: 100%; background: #fff; border: 1.5px solid #2b2230; border-radius: 8px; padding: 2px 8px; font: 13px/1.4 ui-monospace, Menlo, monospace;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .page { display: block; margin-top: 4px; color: #6d6275; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .redraw { margin-top: 6px; padding: 4px 0; font-size: 14px; font-weight: 700; color: #c23c44; text-decoration: underline; text-underline-offset: 3px; }   /* changing a note: its mark drawn again */
      .redraw[hidden] { display: none; }
      /* the board's: the circled bit to a sketch in HQ's Sketchbook */
      .tosk { display: block; margin-top: 6px; font-size: 14px; color: #6d6275; }
      .tosk[hidden], .tosk [hidden] { display: none; }
      .tosk button { padding: 4px 0; font-size: 14px; font-weight: 700; color: #2b2230; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
      .tosk .tosk-go::before { content: ""; display: inline-block; width: 11px; height: 13px; margin-right: 6px; vertical-align: -2px; border: 1.5px solid currentColor; border-radius: 1px 3px 3px 1px; box-shadow: inset 2px 0 0 currentColor; }
      .tosk.done button { color: #1d7a4a; text-decoration: none; } .tosk.done .tosk-go::before { display: none; }
      .polaroid.hop { animation: hop .5s cubic-bezier(.3,1.6,.5,1); }
      @keyframes hop { 40% { transform: translateY(-10px) rotate(-4deg) scale(1.05) } }
      .sheet.bare .polaroid, .sheet.bare .chip { display: none; } /* a general note: no photo */
      textarea { display: block; width: 100%; margin: 14px 0 10px; min-height: 104px; resize: vertical; border: 0; outline: 0; padding: 4px 2px; color: #2b2230; font: 18px/28px system-ui, sans-serif;
        background: repeating-linear-gradient(transparent 0 27px, rgba(91,141,239,.35) 27px 28px); background-attachment: local; }
      textarea::placeholder { color: #a39a8a; }
      /* the pictures pasted or dropped on the note, taped under its words; the sheet lights up while one is dragged over */
      .pics { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; padding: 4px 2px 0; list-style: none; }
      .pics:empty { display: none; }
      .pics li { position: relative; width: 64px; height: 64px; padding: 3px; background: #fff; box-shadow: 0 2px 6px rgba(43,34,48,.25); transform: rotate(var(--tilt, 0deg)); animation: pop-in .3s cubic-bezier(.3,1.5,.5,1) both; }
      .pics img { width: 100%; height: 100%; object-fit: cover; display: block; background: #3a3345; }
      .pics li.busy img { background: linear-gradient(110deg, #3a3345 30%, #5a4f6b 50%, #3a3345 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
      .pics .x { position: absolute; top: -9px; right: -9px; width: 24px; height: 24px; border-radius: 50%; background: #2b2230; color: #fff; font-size: 17px; line-height: 1; display: grid; place-items: center; box-shadow: 0 0 0 2px #fff6c9; }
      .pics .x::before { content: ""; position: absolute; inset: -10px; }   /* (a finger's reach) */
      .sheet.taking { outline: 3px dashed ${ACCENT}; outline-offset: 5px; }
      .row { display: flex; gap: 10px; align-items: center; }
      .mic { position: relative; width: 52px; height: 52px; border-radius: 50%; background: #2b2230; color: #fff; display: grid; place-items: center; flex: none; }
      .mic svg { width: 24px; height: 24px; position: relative; }
      .mic::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: ${ACCENT}; transform: scale(var(--lvl, 0)); opacity: .45; transition: transform .08s; }
      .mic.on { background: ${ACCENT}; } .mic.on::before { transform: scale(calc(1 + var(--lvl, 0))); }
      .mic.busy { animation: spin 1s linear infinite; background: conic-gradient(${ACCENT}, #2b2230); }
      @keyframes spin { to { transform: rotate(1turn) } }
      .mic[disabled] { opacity: .35; cursor: default; }
      .grow { flex: 1; }
      .ghost { padding: 12px 14px; border-radius: 12px; color: #6d6275; }
      .send { padding: 12px 20px; border-radius: 12px; background: ${ACCENT}; color: #fff; font-weight: 700; box-shadow: 0 4px 0 #c23c44; }
      .send:active { transform: translateY(3px); box-shadow: 0 1px 0 #c23c44; } .send[disabled] { opacity: .5; }
      .msg { min-height: 20px; margin: 8px 2px 0; font-size: 14px; color: #6d6275; }
      /* (no message over the page after a pin) */
      @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }`;

    host = doc.createElement('review-mode');
    host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block');
    const root = host.attachShadow({ mode: 'closed' });
    // (the ink and the outline sit outside the veil, so a mark shows while its note is changed; Redraw in the sheet)
    root.innerHTML = `<div class="ui">
      <div class="veil" hidden><div class="bar"><div class="hint"><i>${PIN}</i><span>Tap anything <small>or draw on it</small></span></div>
        <div class="strip" role="toolbar" aria-label="Inks"><span class="sep"></span><button class="undo" aria-label="Undo the last line" title="Undo" disabled>${UNDO}</button></div></div></div>
      <canvas class="ink" data-watchalong-hide></canvas><canvas class="wet" data-watchalong-hide></canvas><div class="hl" hidden></div>
      <div class="sheet" hidden role="dialog" aria-label="A note for the team">
        <div class="top"><div class="polaroid busy"><div class="img"></div></div>
          <div class="who"><h2>Note to self… er, to the team</h2><span class="chip"></span><span class="page"></span><button class="redraw" hidden>Redraw</button>
           <span class="tosk" hidden><button class="tosk-go">To the Sketchbook</button><span class="tosk-to" hidden>Into <button data-to="new">a new sketch</button> or <button data-to="last">the last one</button>?</span></span></div></div>
        <textarea placeholder="What should change? Type it, or tap the mic and say it." maxlength="4000"></textarea>
        <div class="row"><button class="mic" aria-label="Dictate the note">${MIC}</button><span class="grow"></span>
          <button class="ghost" data-cancel>Never mind</button><button class="send">Pin it</button></div>
        <p class="msg" aria-live="polite"></p>
      </div>
      <div class="dock"><div class="tip"></div>
        <div class="coach" hidden role="note"><b>Tap the red pin to leave a note</b>Then tap the bit you mean, and say or type what should change. In the way? Drag the pin.<button>Got it</button></div>
        <div class="menu" hidden role="menu" aria-label="Review mode"><div class="screen"><p class="cap"></p>
          <div class="items"><button role="menuitem" data-general>General note<small>About it all, not one spot</small></button>
            <button role="menuitem" data-list>My notes<small></small></button>
            <button role="menuitemcheckbox" aria-checked="false" data-listen hidden>Listen as I draw<small>Off</small></button>
            <button role="menuitem" class="go" data-mine hidden>Send my notes<small></small></button>
            <button role="menuitem" class="go" data-again hidden>Add more notes<small>Pin away, then send them again</small></button>
            <button role="menuitem" data-away hidden>Put the pin away<small>Bring it back anytime</small></button></div></div></div>
        <button class="more" aria-label="Review mode’s menu: a general note, my notes" aria-haspopup="menu" aria-expanded="false">${MENU}<span class="count"></span></button>
        <button class="fab" aria-label="Review mode: pin a note">${PIN}</button></div>
      <div class="dim" hidden></div><div class="side" hidden role="dialog" aria-label="My notes"><div class="screen">
        <header><p class="cap"></p><button class="x" aria-label="Close my notes">×</button></header>
        <ol></ol>
        <footer><button data-close>Close</button><button class="go" data-send hidden>Send my notes<small></small></button></footer></div></div>
      <div class="zoom" hidden role="dialog" aria-label="The screenshot, bigger"><img alt="The screen as it was, with the spot marked"></div></div>`;
    const $ = s => root.querySelector(s);
    const dock = $('.dock'), fab = $('.fab'), coach = $('.coach'), veil = $('.veil'), hl = $('.hl'), sheet = $('.sheet'), text = $('textarea'), msg = $('.msg'), mic = $('.mic');
    const more = $('.more'), menu = $('.menu'), ASK = text.placeholder, redrawButton = $('.redraw');
    // (a stylesheet of its own rather than a <style>, so a page whose CSP admits no inline style, like HQ's, still draws it)
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
    } catch { root.prepend(Object.assign(doc.createElement('style'), { textContent: CSS_TEXT })); }
    doc.documentElement.append(host);
    // Above the page's popups: a modal dialog (showModal) or a popover sits in the browser's top layer, over any z-index,
    // and a modal one makes everything outside it inert. While one is open the host goes inside the topmost one a tap
    // reaches (alive as part of it, and a tap on it is the popup's own, so a light dismiss leaves it be) and joins the top
    // layer after it as a manual popover, placed by the viewport whatever the popup's transform. It goes back to the page's
    // end once they're closed. A browser without popovers (Safari before 17) leaves it at the page's end, under them.
    const popupsWork = 'showPopover' in host && CSS.supports('selector(:modal)');
    const isModal = el => el.matches(':modal'), inTopLayer = el => isModal(el) || el.matches(':popover-open');
    // popups: the page's dialogs and popovers in the order they opened, which is the top layer's: a dialog as its open
    // attribute changes, a popover at its beforetoggle (both as they happen: the dialogs' records are taken first). Those
    // open before review mode started go in the page's order, the modal dialog a tap reaches over the rest: the browser
    // tells no more.
    let popups = [];
    const openPopups = () => popups.filter(e => e.isConnected && inTopLayer(e));
    // the modal dialog a tap reaches: the one opened last, as the others are inert and a hit test passes them by
    const reachable = el => {
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      return doc.elementsFromPoint(x, y).some(e => e !== host && e.closest(':modal') === el);
    };
    const activeModal = () => openPopups().find(e => isModal(e) && reachable(e));
    const opening = el => { popups = popups.filter(e => e !== el && e.isConnected); popups.push(el); };
    // reshow: a popup opened or closed, so the host joins the top layer again, after it
    function liftHost(reshow) {
      popups = popups.filter(e => e.isConnected);
      const modal = activeModal(), topmost = openPopups().findLast(e => !modal || modal.contains(e));
      if (!topmost) {
        if (host.parentNode !== doc.documentElement) doc.documentElement.append(host);
        host.removeAttribute('popover');
        return;
      }
      let showAgain = reshow;
      if (host.parentNode !== topmost) { topmost.append(host); showAgain = true; } // (out of the document, a popover is hidden)
      host.popover = 'manual';
      if (showAgain && host.matches(':popover-open')) host.hidePopover();
      if (!host.matches(':popover-open')) host.showPopover();
    }
    // the dialogs whose open attribute changed, in order; true when there was one
    const dialogsChanged = records => {
      const dialogs = records.filter(r => r.type === 'attributes' && r.target.localName === 'dialog').map(r => r.target);
      for (const dialog of dialogs) if (dialog.open) opening(dialog);
      return dialogs.length > 0;
    };
    if (popupsWork) {
      popups = [...doc.querySelectorAll('dialog[open], [popover]')].filter(inTopLayer);
      const modal = activeModal();
      if (modal) popups = [...popups.filter(e => !modal.contains(e)), ...popups.filter(e => modal.contains(e))];
      const watch = new MutationObserver(records => {
        const changed = dialogsChanged(records);
        if (changed || !host.isConnected || popups.some(e => !e.isConnected)) liftHost(changed); // (or a popup, or the host in it, taken out)
      });
      watch.observe(doc, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });
      addEventListener('beforetoggle', e => {
        if (e.target === host || !e.target.hasAttribute?.('popover') || e.newState !== 'open') return;
        const changed = dialogsChanged(watch.takeRecords());
        opening(e.target);
        if (changed) liftHost(true);
      }, true);
      addEventListener('toggle', e => { if (e.target !== host && e.target.hasAttribute?.('popover')) liftHost(true); }, true);
      liftHost(false);
    }
    // editing: the note from My notes being changed, with the mark shown on the page
    let mode = 'idle', mark = null, shot = null, editing = null;
    // frame.js's frameMark (next to this script), loaded with the first note or the sidebar: a photo framed on its mark
    let framing = null;
    const framer = () => framing ??= import(new URL('frame.js', ROUTE).href).then(module => module.frameMark, () => () => null);
    const tip = $('.tip'), keep = (store, k, v) => { try { store.setItem(k, v); } catch { /* private mode */ } }, kept = (store, k) => { try { return store.getItem(k); } catch { return null; } };
    // an outsider's hello names the crew
    if (outside) coach.querySelector('b').textContent = `Tap the red pin to leave a note for the ${OUTSIDE} crew`;
    const say = (t, ms = 4000) => { tip.textContent = t; tip.classList.add('show'); if (ms) setTimeout(() => tip.classList.remove('show'), ms); };
    // The first few pages a reviewer opens explain the pin, until it's used or waved off: counted by the coordinator for
    // the person (/__review/coach), so the shop and each of its apps, each on a host of its own, don't ask again
    // TOLD: an outsider was told what goes with a note
    const TOLD = '__hq_review_told';
    const coaching = body => fetch(new URL('coach', ROUTE), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    setTimeout(() => coaching({}).then(r => r.ok && r.json()).then(r => {
      if (r?.show && mode === 'idle' && menu.hidden && !dock.classList.contains('drag')) { coach.hidden = false; dock.classList.add('coaching'); }
    }).catch(() => { /* no bubble */ }), 700);
    // "Got it" or using the pin puts it away for good; a tap on the page itself, until next time
    const uncoach = (done = true) => { if (coach.hidden) return; coach.hidden = true; dock.classList.remove('coaching'); if (done) coaching({ done: true }).catch(() => { /* asks again next page */ }); };
    coach.querySelector('button').onclick = () => uncoach();
    addEventListener('pointerdown', e => { if (!e.composedPath().includes(host)) uncoach(false); }, true);
    // (no toast)

    // ---------------------------------------------------------------- the menu
    // A small button beside the pin, with the count of the reviewer's notes not sent yet: General note, My notes (the
    // sidebar: below), Send my notes, and once an outsider sent theirs, Add more notes. The pin stays just the pin.
    // The notes are the coordinator's (/__review/mine), read on every page and again when the browser brings one back or
    // its tab is shown again: an outsider's wherever they pinned them on the link (the shop's pages and its apps'), the
    // board's waiting on this product.
    let state = { notes: 0, list: [], sent: SENT, more: SENT };
    const notesItem = $('[data-list]'), sendButton = $('[data-mine]'), again = $('[data-again]');
    const side = $('.side'), dim = $('.dim'), sideList = side.querySelector('ol'), sideSend = side.querySelector('[data-send]'), zoom = $('.zoom');
    const sendLine = outside ? `To the ${OUTSIDE} crew` : 'Tick and send in HQ';
    const label = (b, main, sub) => { b.firstChild.textContent = main; if (sub !== undefined) b.querySelector('small').textContent = sub; };
    const post = (path, body) => fetch(new URL(path, ROUTE), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    async function refresh() {
      try {
        const res = await fetch(new URL('mine', ROUTE), { credentials: 'same-origin', cache: 'no-store' });
        if (res.ok) { state = await res.json(); paint(); dropGone(); }
      } catch { /* this page's own count */ }
      // inside HQ's frame the viewer bar's Send counts the board's notes waiting on this product, as listed here: a cue for
      // HQ only, whose Reviews shows the real ones
      if (!outside) toHq({ waiting: state.list.map(n => n.id) });
    }
    function paint() {
      const n = state.notes, done = outside && state.sent, of = `${n} ${n === 1 ? 'note' : 'notes'}`;
      // sent, and nothing more to add (the share has ended for good): the tool is done on this page
      if (done && !state.more) { reset(); fab.remove(); more.remove(); menu.remove(); return; }
      more.querySelector('.count').textContent = done ? '' : n || '';
      fab.hidden = done; $('[data-general]').hidden = done;
      // every line one line in the menu's width, a phone's too: the count only in the caption, a sub-line only what its title
      // doesn't say
      $('.cap').textContent = done ? 'Sent · thank you!' : n ? `Review · ${of} to send` : 'Review mode';
      side.querySelector('.cap').textContent = `My notes${n ? ` · ${n} to send` : ''}`;
      notesItem.hidden = done || !n; label(notesItem, 'My notes', 'Read, change or delete');
      for (const b of [sendButton, sideSend]) {
        b.hidden = done || !n;
        if (!b.dataset.sure) label(b, 'Send my notes', sendLine);
      }
      again.hidden = !done;
      // (Listen as I draw, where the browser records: no notes to draw once they're sent.)
      const listen = $('[data-listen]');
      listen.hidden = done || !listen.dataset.can;
    }
    paint(); refresh();
    addEventListener('pageshow', e => e.persisted && refresh());
    doc.addEventListener('visibilitychange', () => doc.visibilityState === 'visible' && refresh());

    // it opens over the pin (under it when the pin sits high) and shuts on a choice, a tap anywhere else or Escape; shut,
    // a Send my notes that asked again starts over
    const unsure = b => { if (!b.disabled) { delete b.dataset.sure; b.classList.remove('sure'); paint(); } };
    const shut = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); unsure(sendButton); };
    more.onclick = () => {
      if (dragged) { dragged = false; return; }   // (it drags the pin too: below)
      if (!menu.hidden) return shut();
      uncoach(); tip.classList.remove('show'); refresh();
      menu.hidden = false; more.setAttribute('aria-expanded', 'true');
      menu.classList.toggle('below', dock.getBoundingClientRect().top < menu.offsetHeight + 24);
    };
    addEventListener('pointerdown', e => { if (!e.composedPath().includes(host)) shut(); }, true);
    $('.ui').addEventListener('pointerdown', e => { if (!menu.contains(e.target) && !more.contains(e.target)) shut(); });
    $('[data-general]').onclick = () => { shut(); if (mode === 'idle') general(); };
    notesItem.onclick = () => openSide();
    // Listen as I draw: the first mark starts the mic, on a computer and a tablet alike (off until the reviewer turns it
    // on, on this device).
    const LISTEN = '__hq_review_listen', listenItem = $('[data-listen]');
    const listening = () => kept(localStorage, LISTEN) === '1';
    const showListen = () => { listenItem.setAttribute('aria-checked', String(listening())); label(listenItem, 'Listen as I draw', listening() ? 'On: a mark starts the mic' : 'Off'); };
    listenItem.onclick = () => { keep(localStorage, LISTEN, listening() ? '' : '1'); showListen(); };
    showListen();
    const away = $('[data-away]');
    let putAway = false, covered = false;
    const showPin = () => { host.style.display = putAway || covered ? 'none' : 'block'; };
    away.hidden = !summoned;
    away.onclick = () => { shut(); closeSide(); reset(); putAway = true; showPin(); };
    addEventListener('review:summon', () => { putAway = false; showPin(); refresh(); });
    addEventListener('review:cover', e => { covered = !!e.detail; if (covered) { shut(); stopMic(); } showPin(); });
    addEventListener('review:notes', () => refresh());
    // Send my notes, in the menu and at the sidebar's foot. An outsider's (two taps): their notes go to the crew, and they
    // add no more (until its date they can take them up again: Add more notes). Once everyone invited has sent theirs, the crew
    // gathers them
    // The board's is a hand-over to HQ, where only its own ticks choose what goes (the page's code could post a send
    // itself): inside HQ's frame it asks HQ for its send step (Reviews over the preview, at these notes), in a tab of its
    // own it opens HQ's Reviews at them.
    for (const b of [sendButton, sideSend]) b.onclick = () => outside ? submit(b) : handOver();
    function handOver() {
      shut(); closeSide();
      if (framed) return toHq({ send: 1 });
      if (summoned) return dispatchEvent(new CustomEvent('review:send', { detail: state.list.slice(0, 50).map(n => n.id) }));
      window.open(`${HQ}/?open=notes&notes=${state.list.slice(0, 50).map(n => n.id).join(',')}`, '_blank', 'noopener');
    }
    async function submit(b) {
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.classList.add('sure'); label(b, 'Tap again to send', sendLine); return; }
      b.disabled = true;
      let failureLabel = { title: 'Couldn’t send', subtitle: 'Tap to try again' };
      try {
        const res = await fetch(new URL('submit', ROUTE), { method: 'POST', credentials: 'same-origin' });
        if (res.status === 403) failureLabel = { title: 'The link has ended', subtitle: 'Thank you for your notes!' };
        if (!res.ok) throw new Error(failureLabel.title);
        b.disabled = false; shut(); closeSide(); uncoach(false);
        state = { ...state, sent: true, more: false }; await refresh(); paint();
        say(`Sent to the ${OUTSIDE} crew. Thank you!`, state.more ? 4000 : 0);
      } catch (err) {
        b.disabled = false; delete b.dataset.sure; b.classList.remove('sure');
        label(b, failureLabel.title, failureLabel.subtitle);
      }
    }

    // ---------------------------------------------------------------- My notes: the sidebar
    // Every note not sent yet as one scrolling list, each with its screenshot as it went with the note (the spot marked on
    // it, framed on the mark as the polaroid was; a tap shows the whole screen), its words in full and its page, and
    // Change and Delete (two taps: the board's is discarded as in HQ, an outsider's is gone). The screenshots come from
    // HQ's host (mine?shots), for the session this browser holds there, each loaded as it scrolls into view.
    // The words are the reviewer's: text only, never HTML.
    const EMPTY = 'No notes waiting. Tap the red pin to leave one.';
    let showing = null;   // loads each screenshot as it comes near the list's view
    async function openSide() {
      shut(); uncoach(); tip.classList.remove('show');
      if (mode !== 'idle') return;
      side.hidden = dim.hidden = false; dock.hidden = true; zoom.hidden = true; fitSide();
      sideList.replaceChildren(line('empty', 'Loading your notes…'));
      side.querySelector('.x').focus();
      try {
        const res = await fetch(new URL('mine?shots', ROUTE), { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error();
        state = await res.json(); paint();
      } catch { if (!side.hidden) sideList.replaceChildren(line('empty', 'Couldn’t load your notes. Close this and try again.')); return; }
      if (side.hidden) return;
      const frameMark = await framer();
      showing?.disconnect();
      showing = window.IntersectionObserver && new IntersectionObserver(seen => seen.forEach(e => {
        if (e.isIntersecting) { showing.unobserve(e.target); e.target.firstChild.src = e.target.dataset.src; }
      }), { root: sideList, rootMargin: '600px 0px' });
      sideList.replaceChildren(...state.list.map(n => entry(n, frameMark)));
      if (!state.list.length) sideList.append(line('empty', EMPTY));
    }
    function closeSide() {
      if (side.hidden) return;
      side.hidden = dim.hidden = zoom.hidden = true; showing?.disconnect(); showing = null; unsure(sideSend);
      if (mode === 'idle') { dock.hidden = false; more.focus(); }
    }
    side.querySelector('.x').onclick = side.querySelector('[data-close]').onclick = dim.onclick = closeSide;
    // The fixed .ui follows the layout viewport, which a page laid out wider than the phone, or pinch-zoomed (iOS zooms
    // into a box being typed in), makes bigger than the screen. So the sidebar is sized in screen pixels to the visual
    // viewport and scaled back by the zoom, which keeps it, its × and its foot at the phone's own scale and on screen.
    const viewport = window.visualViewport;
    function fitSide() {
      if (side.hidden || !viewport) return;
      const pageScale = viewport.scale, screenWidth = viewport.width * pageScale, wide = screenWidth > 560, sideWidth = wide ? 440 : screenWidth;
      side.classList.toggle('whole', !wide);
      Object.assign(side.style, { top: `${viewport.offsetTop}px`, left: `${viewport.offsetLeft + viewport.width - sideWidth / pageScale}px`, right: 'auto', bottom: 'auto',
        width: `${sideWidth}px`, height: `${viewport.height * pageScale}px`, transform: pageScale === 1 ? '' : `scale(${1 / pageScale})` });
    }
    viewport?.addEventListener('resize', fitSide); viewport?.addEventListener('scroll', fitSide);
    zoom.onclick = () => { zoom.hidden = true; };
    // (a picture added to a note, or its screenshot)
    const enlarge = (url, what) => { const img = zoom.querySelector('img'); img.src = url; img.alt = what; zoom.setAttribute('aria-label', `${what}, bigger`); zoom.hidden = false; };
    // notes sent or discarded elsewhere (HQ's Reviews) leave an open sidebar too
    function dropGone() {
      if (side.hidden) return;
      for (const li of sideList.querySelectorAll(':scope > li')) if (!state.list.some(n => n.id === Number(li.dataset.id))) li.remove();
      if (!sideList.querySelector('li, .empty')) sideList.append(line('empty', EMPTY));
    }
    const line = (cls, words, tag = 'p') => { const e = doc.createElement(tag); e.className = cls; e.textContent = words; return e; };
    const button = (words, cls = '') => { const b = line(cls, words, 'button'); b.type = 'button'; return b; };
    function entry(n, frameMark) {
      const li = doc.createElement('li');
      li.dataset.id = n.id;
      if (n.shot) {
        const b = button('', 'shot'), img = new Image();
        b.setAttribute('aria-label', 'Show the screenshot bigger'); img.alt = ''; b.append(img); b.dataset.src = n.shot.url;
        const placement = frameMark(n.shot.element, n.shot.viewport, 4 / 3);
        if (placement) { img.className = 'framed'; Object.assign(img.style, placement); }
        img.onerror = () => b.remove();   // (a device without the reader's session on HQ's host: the note alone)
        if (showing) showing.observe(b); else img.src = n.shot.url;
        b.onclick = () => enlarge(n.shot.url, 'The screenshot');
        li.append(b);
      }
      const words = line('words', n.note);
      // the pictures added to it, loaded as they come into view like the screenshot
      const added = doc.createElement('ul');
      added.className = 'pics';
      for (const p of n.pictures ?? []) {
        const li = doc.createElement('li'), b = button('', 'pic'), img = new Image();
        b.setAttribute('aria-label', 'Show the picture bigger'); img.alt = ''; b.append(img); b.dataset.src = p.url;
        img.onerror = () => li.remove();
        if (showing) showing.observe(b); else img.src = p.url;
        b.onclick = () => enlarge(p.url, 'A picture added to the note');
        li.append(b); added.append(li);
      }
      const where = line('where', `${n.kind === 'general' ? 'General note · written on ' : n.text ? `On “${n.text.slice(0, 60)}${n.text.length > 60 ? '…' : ''}” · ` : ''}${n.page}`, 'small');
      const acts = doc.createElement('div'), change = button('Change'), del = button('Delete'), oops = line('oops', '');
      acts.className = 'acts'; acts.append(change, del); oops.setAttribute('aria-live', 'polite');
      li.append(words, ...(added.childElementCount ? [added] : []), where, acts, oops);
      // Change: the note's own sheet, its mark on the page again
      change.onclick = () => changeNote(n);
      del.onclick = async () => {
        if (!del.dataset.sure) { del.dataset.sure = '1'; del.classList.add('sure'); del.textContent = 'Tap again to delete'; return; }
        del.disabled = true;
        try {
          const res = await post('delete', { id: n.id });
          if (!res.ok && res.status !== 404) throw new Error();   // (404: gone already)
          li.remove(); state.list = state.list.filter(x => x.id !== n.id); state.notes = state.list.length; paint(); refresh();
          if (!state.list.length) sideList.append(line('empty', EMPTY));
        } catch { del.disabled = false; oops.textContent = 'Couldn’t delete it. Try again?'; }
      };
      return li;
    }
    // Add more notes: the same as on their door, right here
    again.onclick = async () => {
      again.disabled = true;
      try {
        const res = await fetch(new URL('more', ROUTE), { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error();
        shut(); await refresh(); say('Pin away! Send them again when done');
      } catch { label(again, 'Add more notes', 'Couldn’t: try again, or use your link'); } finally { again.disabled = false; }
    };

    // ---------------------------------------------------------------- changing a note: its mark on the page again
    // Change in My notes opens the note's own sheet, its words in it and its mark back on the page: on its element where
    // that's still there (found by its selector, inside open shadow roots too, and moving and scaling with it), else where
    // it was on the screen. Redraw marks it again, as a new note would. A note pinned on another page of this product
    // opens that page first; one on another product's page (an outsider's link opens several) changes its words only.
    const EDIT = '__hq_review_edit', base = new URL('..', ROUTE).pathname.slice(0, -1);   // (a shelf's base, or '')
    const local = () => location.pathname.startsWith(base) ? location.pathname.slice(base.length) + location.search : null;
    const clean = page => page.replace(/#.*….*$/, '');   // (a fragment's values are left out of a note's page)
    function changeNote(n, arrived = false) {
      const page = clean(n.page), [path, hash] = [page.replace(/#.*$/, ''), page.match(/#.*$/)?.[0] ?? ''];
      if (n.mark && n.here && !arrived && path !== local()) {
        keep(sessionStorage, EDIT, String(n.id)); location.assign(`${location.origin}${base}${page}`); return;
      }
      if (n.mark && n.here && hash && hash !== location.hash) location.hash = hash;
      shut(); closeSide(); uncoach(); tip.classList.remove('show');
      mode = 'note'; mark = null; shot = null;
      editing = { n, mark: n.mark && n.here ? n.mark : null, redrawn: false };
      dock.hidden = true; sheet.classList.toggle('bare', !n.mark); redrawButton.hidden = !editing.mark;
      const pol = $('.polaroid'), img = $('.polaroid .img');
      pol.classList.remove('busy'); img.textContent = '';
      if (n.shot) framer().then(frameMark => {
        if (editing?.n !== n || editing.redrawn) return;
        const i = new Image(); i.src = n.shot.url; i.alt = 'The screen, as it was';
        const placement = frameMark(n.shot.element, n.shot.viewport, 3 / 4);
        if (placement) { i.className = 'framed'; Object.assign(i.style, placement); }
        i.onerror = () => { img.innerHTML = '<span>No photo here: the note still has it.</span>'; };
        img.append(i);
      });
      else img.innerHTML = '<span>No photo with this note.</span>';
      $('.who h2').textContent = !n.mark ? 'A general note' : n.kind === 'circle' ? 'About this bit…' : 'About this…';
      $('.chip').textContent = n.mark ? `<${n.mark.tag}>${n.text ? ` “${n.text.slice(0, 40)}${n.text.length > 40 ? '…' : ''}”` : ''}` : '';
      $('.page').textContent = n.mark ? n.page : `About it all · written on ${n.page}`;
      $('.send').textContent = 'Save'; text.value = n.note;
      showPictures(n.pictures ?? []);
      framePic = pictures.find(p => p.file && p.file === n.video?.frame) ?? null;
      // (after the page's own layout settles, the mark in view above the sheet)
      showSheet(); setTimeout(() => showMark(true), arrived ? 600 : 0);
    }
    // a change asked for on another page: once this one has loaded
    const asked = kept(sessionStorage, EDIT);
    if (asked) {
      try { sessionStorage.removeItem(EDIT); } catch { /* private mode */ }
      fetch(new URL('mine?shots', ROUTE), { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(mine => {
        const n = mine?.list.find(x => x.id === Number(asked));
        if (n && mode === 'idle') changeNote(n, true);
      }).catch(() => { /* My notes still has it */ });
    }
    // where its element is now: one in an open shadow root has its host's path first, then a space (selector()). The space
    // that ends a hex escape (CSS.escape of an id like 123 gives \31 23) is part of its step, not that boundary.
    const found = sel => {
      let el = null;
      try { for (const part of sel.match(/(?:\\[0-9a-fA-F]{1,6} ?|\\.|[^\\ ]| > )+/g) ?? []) if (!(el = (el ? el.shadowRoot : doc)?.querySelector(part))) return null; } catch { return null; }
      return el;
    };
    // The shown mark, drawn where it is now: its lines (an older circle's closed line, or the oval in its area when it
    // has none), and a pin's element outlined. scroll: brings it into view above the sheet.
    function showMark(scroll = false) {
      const m = editing?.mark;
      paintInk([]); hl.hidden = true;
      if (!m || (mode !== 'note' && mode !== 'sending')) return;
      const el = m.el?.isConnected ? m.el : m.selector ? found(m.selector) : null, now = el?.getBoundingClientRect(), was = m.rect;
      const at = now && was && (now.width || now.height)
        ? ([x, y]) => [now.left + (x - was.x) * (was.w ? now.width / was.w : 1), now.top + (y - was.y) * (was.h ? now.height / was.h : 1)]
        : ([x, y]) => [x + m.view.x - scrollX, y + m.view.y - scrollY];
      const a = m.area ?? was;
      if (!a) return;
      const [left, top] = at([a.x, a.y]), [right, bottom] = at([a.x + a.w, a.y + a.h]);
      if (scroll) {
        const room = sheet.hidden ? innerHeight : sheet.getBoundingClientRect().top, middle = (top + bottom) / 2;
        if (top < 8 || bottom > room - 8) { scrollBy({ left: 0, top: middle - Math.max(room, 120) / 2, behavior: 'instant' }); return showMark(); }
      }
      if (m.kind !== 'circle') { Object.assign(hl.style, { left: `${left - 3}px`, top: `${top - 3}px`, width: `${right - left + 6}px`, height: `${bottom - top + 6}px` }); hl.hidden = false; }
      const lines = m.ink?.length ? m.ink : m.kind !== 'circle' ? [] : [{ color: ACCENT, size: 5, points: (m.path?.length ? [...m.path, m.path[0]] : oval(a)).map(([x, y]) => [x, y, 0.5, 0]) }];
      paintInk(lines.map(l => ({ ...l, points: l.points.map(([x, y, ...rest]) => [...at([x, y]), ...rest]) })));
    }
    // (an older circle saved with only its area)
    const oval = a => Array.from({ length: 49 }, (_, i) => [a.x + a.w / 2 * (1 + Math.cos(i * Math.PI / 24)), a.y + a.h / 2 * (1 + Math.sin(i * Math.PI / 24))]);
    addEventListener('scroll', () => editing && showMark(), { passive: true, capture: true }); addEventListener('resize', () => editing && showMark());
    // Redraw: the sheet steps aside for the pin's tap or circle; the pin, Escape or Never mind… puts the sheet back as it was
    redrawButton.onclick = async () => {
      if (mode !== 'note') return;
      await stopMic();   // (words being said are this note's)
      if (mode !== 'note') return;
      sheet.hidden = true; paintInk([]); hl.hidden = true; dock.hidden = false; pick();
    };
    function unpick() { penOn?.cancel(); veil.hidden = true; fab.classList.remove('on'); dock.hidden = true; mode = 'note'; showSheet(); showMark(); }
    // Never mind, or Escape: a change goes back to My notes
    function cancel() { const was = editing; reset(); if (was) openSide(); }

    let dragged = false;
    const toggle = () => { uncoach(); shut(); closeSide(); if (mode === 'idle') pick(); else if (mode === 'pick') (editing ? unpick : reset)(); };
    fab.onclick = () => { if (dragged) dragged = false; else toggle(); };
    ui = { toggle, refresh };
    // Escape puts away the big screenshot, else the sidebar, else the menu and the note
    addEventListener('keydown', e => {
      if (e.key !== 'Escape' || covered) return;
      // what it puts away is review mode's own: the page's popup under it stays open
      if (!zoom.hidden || !side.hidden || !menu.hidden || mode !== 'idle') e.preventDefault();
      if (!zoom.hidden) zoom.hidden = true;
      else if (!side.hidden) closeSide();
      else { shut(); if (mode === 'pick' && editing) unpick(); else if (mode !== 'idle' && mode !== 'sending') cancel(); }
    }, true);
    // Cmd or Ctrl+Z takes back the last line (in the note's words, it's the words' own undo)
    addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || mode !== 'note' || veil.hidden || covered || root.activeElement === text) return;
      e.preventDefault(); e.stopPropagation(); undo();
    }, true);
    // Keys typed into the note are the note's: the page's own shortcuts never hear them (a deck's space and arrows turned
    // its slides and ate the spaces). Escape still reaches the listener above, which hears it first.
    for (const type of ['keydown', 'keypress', 'keyup']) host.addEventListener(type, e => e.stopPropagation());
    // Taps on it are its own too: inside a popup, one that shuts on a tap outside what it shows stays open
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click']) host.addEventListener(type, e => e.stopPropagation());
    function reset() {
      mode = 'idle'; mark = null; shot = null; editing = null; stopMic(true);
      text.value = ''; msg.textContent = ''; $('.send').disabled = false; // the next note starts blank, and can be pinned
      veil.hidden = true; sheet.hidden = true; sheet.classList.remove('away', 'bare'); text.placeholder = ASK;
      fab.classList.remove('on'); more.hidden = false; dock.hidden = !side.hidden; settle();
      root.querySelectorAll('.drop').forEach(d => d.remove());
      hl.hidden = true; redrawButton.hidden = true; $('.send').textContent = 'Pin it';
      showPictures([]);
      penOn?.cancel(); strokes = []; penSeen = false; undoTo = null; exposure = null; veil.classList.remove('marked'); undoButton.disabled = true; paintInk([]);
    }

    // ---------------------------------------------------------------- where the pin sits
    // Out of the product's way: when one of its buttons or links sits under the pin or its menu's button, the pin steps up
    // above it (as long as it stays in the lower 60% of the screen), and back down once the page moves on. Dragged, it
    // stays put on this product.
    const PLACE = '__hq_review_pin', TAPPABLE = 'a[href], button, input, select, textarea, label, summary, [role=button], [role=link], [onclick]';
    let placed = (() => { try { return JSON.parse(kept(localStorage, PLACE)); } catch { return null; } })();
    const lift = up => dock.style.setProperty('--up', `${Math.round(up)}px`);
    // a dragged spot, as far as this screen allows: turned sideways or in a shorter frame it stops at the top, and the
    // stored lift stays as it was, so a taller screen puts the pin back where the board left it
    const liftPlaced = () => lift(Math.max(0, Math.min(placed.up, dock.offsetTop - 16)));
    if (placed) { dock.classList.toggle('left', !!placed.left); liftPlaced(); }
    function settle() {
      if (mode !== 'idle' || dock.classList.contains('drag')) return;
      if (placed) return liftPlaced();
      const x = dock.offsetLeft, home = dock.offsetTop; // offsets ignore the lift (a transform): this is where the pin sits unlifted
      let top = home;
      for (let round = 0; round < 4; round++) { // clear of one button, the pin may land on the next one up
        let hit = null;
        // the pin, and the menu's button beside it (offsets in the dock)
        const spots = [8, 30, 52].flatMap(dx => [8, 30, 52].map(dy => [dx, dy]));
        if (more.isConnected) for (const dx of [10, 26]) for (const dy of [10, 26]) spots.push([more.offsetLeft + dx, more.offsetTop + dy]);
        for (const [dx, dy] of spots) {
          const el = doc.elementsFromPoint(x + dx, top + dy).find(e => e !== host && e !== doc.documentElement && e !== doc.body)?.closest(TAPPABLE);
          const r = el?.getBoundingClientRect(); // a big one (a whole card that's a button) stays easy to tap around the pin
          if (r && r.width * r.height < innerWidth * innerHeight / 4 && (!hit || r.top < hit.top)) hit = r;
        }
        if (!hit) break;
        top = hit.top - 70;
      }
      lift(top < innerHeight * 0.4 ? 0 : home - top); // too far up: stay home, the board can scroll or drag
    }
    let settling; const soon = ms => { clearTimeout(settling); settling = setTimeout(settle, ms); };
    addEventListener('scroll', () => soon(250), { passive: true }); addEventListener('resize', () => soon(250));
    addEventListener('click', e => { if (!e.composedPath().includes(host)) soon(450); }, true); // a sheet or step the tap opened
    addEventListener('popstate', () => soon(300)); addEventListener('load', () => soon(100)); soon(400);
    // drag: press and move the pin, or the menu's button beside it (it looks like a handle), and let go on either side.
    // The pin follows the finger from where it was held; a plain tap on either still does what it does.
    let drag = null;
    for (const b of [fab, more]) {
      b.addEventListener('pointerdown', e => {
        if (mode !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const r = dock.getBoundingClientRect();
        drag = { b, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, dx: e.clientX - r.left, dy: e.clientY - r.top };
        b.setPointerCapture(e.pointerId);   // (a quick drag leaves a small button before it has moved far enough to count)
      });
      b.addEventListener('pointermove', e => {
        if (!drag || drag.b !== b || e.pointerId !== drag.id || (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 10)) return;
        if (!drag.moved) { drag.moved = true; dock.classList.add('drag'); uncoach(); shut(); tip.classList.remove('show'); }
        dock.style.setProperty('--dx', `${Math.min(innerWidth - 60, Math.max(0, e.clientX - drag.dx))}px`); dock.style.setProperty('--dy', `${Math.min(innerHeight - 60, Math.max(0, e.clientY - drag.dy))}px`);
      });
      const drop = e => {
        const d = drag;
        if (!d || d.b !== b) return;
        drag = null;
        if (!d.moved) return;
        dragged = e.type === 'pointerup'; setTimeout(() => { dragged = false; }, 400); // no click after a drag
        const top = Math.min(innerHeight - 60, Math.max(0, e.clientY - d.dy)), left = Math.min(innerWidth - 60, Math.max(0, e.clientX - d.dx)) + 30 < innerWidth / 2;
        dock.classList.remove('drag'); dock.classList.toggle('left', left);
        const up = Math.max(0, Math.min(dock.offsetTop - 16, dock.offsetTop - top));
        placed = { left, up }; lift(up); keep(localStorage, PLACE, JSON.stringify(placed));
      };
      b.addEventListener('pointerup', drop); b.addEventListener('pointercancel', drop);
    }

    // ---------------------------------------------------------------- pick: tap an element, or draw on the page
    // The pen (ink.js, next to this script): every line drawn stays until the note goes, open as drawn (circled, crossed
    // out, underlined, scribbled), in the ink chosen on the strip, and the first mark opens the note. As the first mark a
    // tap pins what's under it; Shift held as a mouse starts a line draws a rectangle. A pen drawn across the page starts
    // all this by itself (a pen's tap stays the page's), and once a pen has drawn on a note only the pen draws: a palm
    // resting on the screen doesn't, and a finger still scrolls and taps everything else.
    let inkjs = null, penOn = null, strokes = [], penSeen = false, undoTo = null;
    const MAX_LINES = 64;   // a note's, as the coordinator keeps them (feedback.ts inkOf)
    const inkCanvas = $('.ink'), wet = $('.wet'), strip = $('.strip'), undoButton = $('.undo'), INK_KEY = '__hq_review_ink';
    let inkNow = Number(kept(localStorage, INK_KEY)) || 0;
    import(new URL('ink.js', ROUTE).href).then(m => {
      inkjs = m; inkNow = Math.min(inkNow, m.INKS.length - 1);
      strip.prepend(...m.INKS.map((k, i) => {
        const b = button('', `pot${k.alpha < 1 ? ' wide' : ''}`);
        b.setAttribute('aria-label', k.name); b.title = k.name; b.style.setProperty('--c', k.color); b.setAttribute('aria-pressed', String(i === inkNow));
        b.append(doc.createElement('i')); b.onclick = () => chooseInk(i);
        return b;
      }));
      penOn = m.pen(veil, wet, { halo: true, use: drawable, ink: () => m.INKS[inkNow], shape: e => e.shiftKey && e.pointerType === 'mouse' ? 'rect' : '', end: stroked });
      if (editing) showMark();
    }, () => { /* no pen: the pin says so when tapped */ });
    const chooseInk = i => { inkNow = i; keep(localStorage, INK_KEY, String(i)); strip.querySelectorAll('.pot').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i))); };
    const drawable = e => (mode === 'pick' || (mode === 'note' && !veil.hidden)) && !e.composedPath().includes(strip)
      && (e.pointerType === 'pen' || !penSeen) && !(e.pointerType === 'mouse' && e.button !== 0);
    const paintInk = lines => { if (inkjs) { inkjs.draw(inkjs.fit(inkCanvas), lines, { halo: true }); inkjs.shown(inkCanvas, lines, { halo: true }); } };   // (shown: a walk-through's recording follows it)
    const redrawInk = () => editing ? showMark() : paintInk(strokes);
    function pick() {
      if (!penOn) return say('The pen didn’t load: reload the page?');
      undoTo = { mark, shot, exposure, editing };
      mode = 'pick'; strokes = []; veil.hidden = false; veil.classList.remove('marked'); undoButton.disabled = true;
      fab.classList.add('on'); more.hidden = true; paintInk([]); hl.hidden = true;
    }
    // A pen on the page while review mode rests: its first move draws (the line from where it touched), and the page
    // never scrolls under it. Its tap stays the page's own.
    let penDown = null;
    addEventListener('pointerdown', e => {
      penDown = e.pointerType === 'pen' && e.isPrimary && mode === 'idle' && penOn && !putAway && !covered && !fab.hidden && fab.isConnected
        && side.hidden && !e.composedPath().includes(host) ? e : null;
    }, true);
    addEventListener('pointermove', e => {
      if (!penDown || e.pointerId !== penDown.pointerId || Math.hypot(e.clientX - penDown.clientX, e.clientY - penDown.clientY) < 4) return;
      const down = penDown; penDown = null;
      if (mode !== 'idle') return;
      uncoach(); shut(); pick();
      if (penOn.start(down)) { e.stopPropagation(); penOn.move(e); }
    }, true);
    addEventListener('pointerup', e => { if (penDown?.pointerId === e.pointerId) penDown = null; }, true);
    // (Safari scrolls under a pen until its first touchmove says no)
    addEventListener('touchmove', e => { if ((penDown || mode === 'pick' || mode === 'note') && [...e.changedTouches].some(t => t.touchType === 'stylus')) e.preventDefault(); }, { capture: true, passive: false });
    // what's under the finger, inside open shadow roots too: a tap in a chat's panel is the bubble or button there, not
    // the chat's empty host element at the page's end
    const under = (x, y) => {
      let el = doc.elementsFromPoint(x, y).find(e => e !== host && e !== doc.documentElement && e !== doc.body) || doc.body;
      for (let root; (root = el.shadowRoot);) { // the topmost of its own (ours is on top of everything)
        const inner = root.elementsFromPoint(x, y).find(e => e.getRootNode() === root);
        if (!inner) break;
        el = inner;
      }
      return el;
    };
    const box = r => ({ x: Math.round(r.left ?? r.x), y: Math.round(r.top ?? r.y), w: Math.round(r.width ?? r.w), h: Math.round(r.height ?? r.h) });
    // where lines are: the box around all their points
    const boxOf = lines => {
      const pts = lines.flatMap(l => l.points), xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    // a hover outline for a mouse, until the first mark
    veil.onpointermove = e => {
      if (e.pointerType !== 'mouse' || mode !== 'pick' || penOn?.drawing) return;
      const r = under(e.clientX, e.clientY).getBoundingClientRect();
      Object.assign(hl.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` }); hl.hidden = false;
    };
    veil.addEventListener('pointerdown', () => { hl.hidden = true; });
    // With lines on it, the page stays as it is under them (its screenshot was taken at the first mark)
    veil.addEventListener('wheel', e => { if (mode !== 'pick') e.preventDefault(); }, { passive: false });
    function stroked(stroke, e) {
      if (e.pointerType === 'pen') penSeen = true;
      const area = boxOf([stroke]);
      penOn.clear();
      if (area.w < 24 && area.h < 24) {   // a tap: as the first mark, it pins the element under it; beside the note, nothing
        if (mode !== 'pick') return;
        mark = { kind: 'pin', x: e.clientX, y: e.clientY, el: under(e.clientX, e.clientY), area: null };
        const d = doc.createElement('i'); d.className = 'drop'; d.innerHTML = PIN; Object.assign(d.style, { left: `${e.clientX}px`, top: `${e.clientY}px` }); $('.ui').append(d);
      } else if (strokes.length >= MAX_LINES) {   // (beyond it, a change couldn't draw them all again)
        msg.textContent = `A note keeps ${MAX_LINES} lines at most: undo one to draw another.`;
        return;
      } else {
        strokes.push(stroke);
        if (mode === 'pick') mark = { kind: 'circle' };
        aim();
      }
      undoButton.disabled = false;
      if (mode === 'pick') compose(); else { redrawInk(); develop(); }
    }
    // A drawn mark's area, around all its lines, and the smallest element that holds most of it
    function aim() {
      if (mark.kind !== 'circle') return;
      const area = boxOf(strokes);
      let el = under(area.x + area.w / 2, area.y + area.h / 2);
      for (let r; el.parentElement && el !== doc.body && (r = el.getBoundingClientRect()) && (r.width < area.w * 0.8 || r.height < area.h * 0.8);) el = el.parentElement;
      Object.assign(mark, { el, area });
      if (!mark.element) return;   // (compose describes it)
      mark.element = { ...mark.element, ...describe(el), area: box(area) };
      if (editing) editing.mark = { ...editing.mark, ...mark.element, el };
    }
    // Undo: the last line goes; the last mark gone, it's back to tapping or drawing, the words kept
    function undo() {
      if (mode !== 'note' || veil.hidden) return;
      if (strokes.length) {
        strokes.pop();
        if (strokes.length || mark.kind === 'pin') { aim(); redrawInk(); develop(); return; }
      }
      if (framePic) unpicture(framePic);
      ({ mark, shot, exposure, editing } = undoTo); framePic = null;
      root.querySelectorAll('.drop').forEach(d => d.remove());
      mode = 'pick'; sheet.hidden = true; dock.hidden = false; veil.classList.remove('marked'); undoButton.disabled = true; redrawInk(); if (editing) paintInk([]);
    }
    undoButton.onclick = undo;
    // ---------------------------------------------------------------- the note
    // The element's HTML goes without form values, like the screenshot: hidden and password fields are dropped, other
    // fields lose their value (a button's value is its label, so it stays) and textareas their text.
    const describe = el => {
      const r = el.getBoundingClientRect(), t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      const c = el.cloneNode(true);
      for (const f of [c, ...c.querySelectorAll('input, textarea')]) {
        if (f.localName === 'textarea') f.textContent = '';
        else if (f.localName !== 'input' || /^(button|submit|reset|image)$/.test(f.type)) continue;
        else if ((f.type === 'hidden' || f.type === 'password') && f !== c) f.remove();
        else f.removeAttribute('value');
      }
      return { selector: selector(el), tag: el.localName, text: t.slice(0, 200), html: c.outerHTML.slice(0, 2000), rect: box(r) };
    };
    // the screen too, as a big screen with a half-width window reads as a small laptop; touch points tell an iPad from a Mac
    const viewNow = () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1, x: Math.round(scrollX), y: Math.round(scrollY), ua: navigator.userAgent,
      sw: screen.width, sh: screen.height, touch: navigator.maxTouchPoints || 0 });
    // A note's lines as they go with it (at most MAX_LINES of them), each thinned to at most 1,000 points (its last kept)
    // and all of them to 12,000, the coordinator's caps (feedback.ts inkOf), so every line is drawn again on a change
    const thin = (l, most) => l.points.length <= most ? l
      : { ...l, points: l.points.filter((_, i, all) => i % Math.ceil(all.length / (most - 1)) === 0 || i === all.length - 1) };
    const inkOut = () => strokes.map(l => thin(l, Math.min(1000, Math.floor(12_000 / strokes.length))));
    // A note on a video keeps its moment: the video under the pin (or the circle's middle) stops there, its time goes with
    // the note ("at 0:07"), the screenshot shows that frame, and the frame itself goes with it as a picture.
    // (a video with no frame yet has no moment to keep)
    const videoAt = m => [m.el.closest('video'), ...doc.elementsFromPoint(...(m.area ? [m.area.x + m.area.w / 2, m.area.y + m.area.h / 2] : [m.x, m.y]))]
      .find(e => e?.localName === 'video' && e.readyState >= 2);
    const clock = t => { const s = Math.floor(t), mm = `${Math.floor(s / 60) % 60}`; return `${s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}` : mm}:${`${s % 60}`.padStart(2, '0')}`; };
    function compose() {
      mode = 'note';
      // (a re-pin's frame replaces the last one's; frameless: what to say when no frame went with the note.)
      const video = videoAt(mark);
      if (framePic) unpicture(framePic);
      framePic = null;
      if (video) { video.pause(); mark.frameless = addFrame(video); }
      mark.element = { ...describe(mark.el), kind: mark.kind, area: mark.area && box(mark.area),
        ...(video ? { video: { time: Math.round(video.currentTime * 10) / 10, src: new URL(video.currentSrc, location.href).pathname } } : {}) };
      mark.view = viewNow(); mark.page = location.href;
      // changing a note: this mark replaces the one shown, and stays on the page with its element as the sheet comes back
      if (editing) editing = { ...editing, redrawn: true, mark: { ...mark.element, ink: strokes, el: mark.el, view: mark.view } };
      const pol = $('.polaroid'), img = $('.polaroid .img');
      pol.classList.add('busy'); img.textContent = ''; exposure = null;
      // the page as it was at the first mark; every line since is drawn on it (develop), and on what goes with the note
      const m = mark;
      shot = Promise.all([snapshot(m), framer()]).then(([taken, frameMark]) => {
        if (mark !== m) return null;
        pol.classList.remove('busy'); frameIt = frameMark;
        if (taken) { exposure = taken; develop(); } else img.innerHTML = '<span>No photo this time: the note still goes.</span>';
        return taken;
      }, () => null);
      // (the mic, if the board asked for it to listen as it draws: the first mark starts it)
      if (listening() && !rec && !stopping) startMic();
      setTimeout(() => { // let the pin land, then the note
        if (mark !== m) return;
        veil.classList.add('marked'); dock.hidden = true;
        if (editing) root.querySelectorAll('.drop').forEach(d => d.remove());
        redrawInk();
        const t = mark.element;
        $('.chip').textContent = `<${t.tag}>${t.video ? ` at ${clock(t.video.time)}` : ''}${t.text ? ` “${t.text.slice(0, 40)}${t.text.length > 40 ? '…' : ''}”` : ''}`;   // (the moment before the words the chip may cut)
        $('.page').textContent = here();
        $('.who h2').textContent = mark.kind === 'circle' ? 'About this bit…' : 'About this…';
        showSheet();
        if (mark.frameless) msg.textContent = `${msg.textContent} ${mark.frameless}`.trim();
      }, 380);
    }
    // The polaroid, framed on the mark: the page as it was with every line drawn so far
    let exposure = null, frameIt = null;
    function develop() {
      if (!exposure) return;
      const img = $('.polaroid .img'), c = img.querySelector('canvas') ?? img.appendChild(doc.createElement('canvas'));
      expose(exposure, mark, c);
      const placement = frameIt?.(mark.element, mark.view, 3 / 4);
      c.className = placement ? 'framed' : ''; c.removeAttribute('style'); if (placement) Object.assign(c.style, placement);
      offerSketch();
    }
    // To the Sketchbook (the board's only: a share's reviewer has none): the circled part of the screenshot, the note's lines
    // on it, becomes a picture on a sketch in HQ's Sketchbook, a new one or the one opened last. It waits there until the
    // sketch opens, and lands on its page (the coordinator's sketches.ts fromReview).
    const tosk = $('.tosk');
    function offerSketch() {
      tosk.hidden = outside || !exposure || !mark || mark.kind === 'general';
      tosk.classList.remove('done'); tosk.querySelector('.tosk-go').hidden = false; tosk.querySelector('.tosk-to').hidden = true;
      tosk.querySelector('.tosk-go').textContent = 'To the Sketchbook'; tosk.querySelector('.tosk-go').disabled = false;
    }
    tosk.querySelector('.tosk-go').onclick = () => { tosk.querySelector('.tosk-go').hidden = true; tosk.querySelector('.tosk-to').hidden = false; };
    for (const b of tosk.querySelectorAll('[data-to]')) b.onclick = () => toSketchbook(b.dataset.to);
    async function toSketchbook(to) {
      const picture = exposure && scrapOf(exposure, mark);
      if (!picture) { msg.textContent = 'That bit couldn’t be cut out of the photo.'; return; }
      tosk.querySelector('.tosk-to').hidden = true; tosk.classList.add('done');
      tosk.querySelector('.tosk-go').hidden = false; tosk.querySelector('.tosk-go').textContent = 'Putting it in…'; tosk.querySelector('.tosk-go').disabled = true;
      try {
        const res = await post('sketch', { picture, to });
        await refusal(res);
        if (!res.ok) throw new RefusedError(res.status === 403 ? 'The Sketchbook is for the board.' : `The coordinator said no (${res.status}).`);
        const { fresh } = await res.json();
        tosk.querySelector('.tosk-go').textContent = fresh ? '✓ In a new sketch' : '✓ On the last sketch';
        const pol = $('.polaroid'); pol.classList.remove('hop'); void pol.offsetWidth; pol.classList.add('hop');
      } catch (err) { offerSketch(); msg.textContent = err instanceof RefusedError ? err.message : 'Could not reach HQ. Try again?'; }
    }
    // The bit the mark is about, cut from the screenshot with its lines drawn on: the box around the circle's lines (a
    // pin's element and its head), with a margin, at least SCRAP_MIN px a side, kept on the screen
    const SCRAP_MIN = 160, SCRAP_PAD = 24;
    function scrapOf(taken, m) {
      try {
        const full = expose(taken, m), k = taken.k, W = m.view.w, H = m.view.h;
        const parts = strokes.length ? [boxOf(strokes)] : [];
        if (m.kind === 'pin') parts.push(m.element.rect, { x: m.x, y: m.y - 32, w: 22, h: 32 });
        if (!parts.length) return null;
        const x0 = Math.min(...parts.map(r => r.x)), y0 = Math.min(...parts.map(r => r.y));
        const x1 = Math.max(...parts.map(r => r.x + r.w)), y1 = Math.max(...parts.map(r => r.y + r.h));
        const grow = (a, b, most) => {
          const need = Math.max(0, SCRAP_MIN - (b - a)) / 2;
          a = Math.max(0, a - SCRAP_PAD - need); b = Math.min(most, b + SCRAP_PAD + need);
          return [a, Math.max(b, Math.min(most, a + SCRAP_MIN))];
        };
        const [l, r] = grow(x0, x1, W), [t, b] = grow(y0, y1, H);
        const c = doc.createElement('canvas'), f = Math.min(1, 2000 / (Math.max(r - l, b - t) * k));
        c.width = Math.max(1, Math.round((r - l) * k * f)); c.height = Math.max(1, Math.round((b - t) * k * f));
        c.getContext('2d').drawImage(full, l * k, t * k, (r - l) * k, (b - t) * k, 0, 0, c.width, c.height);
        for (const q of [0.9, 0.8, 0.65, 0.5]) { const url = c.toDataURL('image/jpeg', q); if (url.length < 2_000_000) return url; }
        return null;
      } catch { return null; }
    }
    // A general note: the same sheet, pinned to nothing and without a photo,
    // saved with the page it's written on
    function general() {
      mode = 'note'; shot = null;
      mark = { kind: 'general', element: { kind: 'general' }, view: viewNow(), page: location.href };
      dock.hidden = true; sheet.classList.add('bare');
      $('.who h2').textContent = 'A general note';
      $('.page').textContent = `About it all · written on ${here()}`;
      text.placeholder = 'Something across the pages, or that differs between them? Type it, or tap the mic and say it.';
      showSheet();
    }
    function showSheet() {
      msg.textContent = ''; sheet.hidden = false; sheet.classList.remove('away'); offerSketch();
      // an outsider hears once what goes with a note (a general note has no picture, so its line doesn't count as that)
      // (a note being changed has no mark until it's redrawn, and a redraw's new picture is told too)
      if (outside && mark && !kept(localStorage, TOLD)) {
        if (mark.kind === 'general') msg.textContent = 'Your notes go to the crew. Please don’t type personal details.';
        else { msg.textContent = 'Your notes and a picture of the screen go to the crew. Please don’t type personal details.'; keep(localStorage, TOLD, '1'); }
      }
      if (matchMedia('(pointer: fine)').matches) text.focus();
    }
    $('[data-cancel]').onclick = cancel;
    // its message is shown to the reviewer as it is
    class RefusedError extends Error {}
    // the hourly rate (429) and a disk too full for a screenshot (507) say why in their own words
    async function refusal(res) {
      if (res.status === 429 || res.status === 507) throw new RefusedError((await res.json()).error);
    }
    $('.send').onclick = async () => {
      if (mode !== 'note') return;
      // words still being spoken or transcribed belong in this note: wait for them before reading it
      if (rec || stopping) { $('.send').disabled = true; await stopMic(); $('.send').disabled = false; if (mode !== 'note') return; }
      const note = text.value.trim();
      if (!note) { text.focus(); msg.textContent = 'A word or two first?'; return; }
      mode = 'sending'; $('.send').disabled = true; msg.textContent = shot ? 'Developing the photo…' : 'Sending…';
      const waiting = pictures, url = photo(await Promise.race([shot, new Promise(r => setTimeout(() => r(null), 9000))]), mark);
      const added = await picturesNow(waiting);
      if (!added) { mode = 'note'; $('.send').disabled = false; return; }
      msg.textContent = 'Sending…';
      if (editing) return save(note, url, added);
      try {   // next to the script
        const res = await post('notes', { note, page: mark.page, element: marked(), viewport: mark.view, trail, shot: url || null, pictures: added });
        await refusal(res);
        // an outsider's 403 is their link's end
        if (!res.ok) throw new RefusedError(res.status !== 403 ? `The coordinator said no (${res.status}).` : outside ? 'The link has ended. Thank you for your notes!' : 'The review key has expired: open this page from HQ again.');
        text.value = ''; state.notes += 1;
        sheet.classList.add('away');
        // Pinned: the menu's button boings and counts it, and HQ's viewer bar shows Send N (refresh). Nothing over the page
        // being reviewed.
        setTimeout(() => {
          $('.send').disabled = false; reset(); paint(); refresh();
          more.classList.add('boing'); setTimeout(() => more.classList.remove('boing'), 700);
        }, 450);
      } catch (err) { mode = 'note'; $('.send').disabled = false; msg.textContent = err instanceof RefusedError ? err.message : 'Could not reach HQ. Try again?'; }
    };
    // A change: the words and pictures, and a mark drawn again with its screenshot; then back to My notes (pictures)
    async function save(note, url, added) {
      try {
        const res = await post('edit', { id: editing.n.id, note, pictures: added, ...(editing.redrawn ? { page: mark.page, element: marked(), viewport: mark.view, shot: url || null } : {}) });
        await refusal(res);
        if (!res.ok) throw new RefusedError(res.status === 404 ? 'That note has gone already: sent, or deleted.' : `The coordinator said no (${res.status}).`);
        $('.send').disabled = false; cancel();
      } catch (err) { mode = 'note'; $('.send').disabled = false; msg.textContent = err instanceof RefusedError ? err.message : 'Couldn’t save it. Try again?'; }
    }
    // With the on-screen keyboard up (Chrome on Android resizes only the visual viewport), lift the note above it.
    const vv = window.visualViewport;
    if (vv) { const fit = () => sheet.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`); vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }

    // ---------------------------------------------------------------- pictures: pasted or dropped on the note
    // The reviewer's own pictures go with the note, as small thumbnails under its words: pasted (Ctrl or Cmd+V) or dropped
    // on the open note, each with a × to take it off. Each is drawn again here at most 2,000 px a side and stepped down to
    // what the coordinator keeps, as the screenshot is, so a phone's photo goes too, without what its file says besides
    // the pixels (where it was taken). A PNG stays one while it fits (a screenshot's text stays sharp). A change shows the
    // note's own again, kept by their names.
    const MAX_PICTURES = 12, MAX_SIDE = 2000, MAX_DATA_URL = 2_000_000;
    const picList = doc.createElement('ul');
    picList.className = 'pics'; picList.setAttribute('aria-label', 'Pictures with this note'); text.after(picList);
    let pictures = [];   // each { file } kept on a change or { data } new (once ready), with its thumbnail
    let framePic = null;   // the one that is a video's frame (the coordinator names its file: withFrame).
    function addPictures(files) {
      const images = files.filter(f => f.type.startsWith('image/'));
      if (images.length < files.length) msg.textContent = 'Only pictures go with a note.';
      for (const file of images) {
        if (pictures.length >= MAX_PICTURES) { msg.textContent = 'A note takes a dozen pictures at most.'; return; }
        const p = {};
        p.li = thumbnail(p, null);
        p.ready = scaled(file).then(data => {
          if (data) { p.data = data; p.li.querySelector('img').src = data; p.li.classList.remove('busy'); return; }
          p.failed = true; unpicture(p); msg.textContent = 'That picture couldn’t be read here. Another kind of file?';
        });
        pictures.push(p);
      }
    }
    function thumbnail(p, src) {
      const li = doc.createElement('li'), img = new Image(), x = button('×', 'x');
      img.alt = ''; x.setAttribute('aria-label', 'Remove this picture');
      if (src) img.src = src; else li.classList.add('busy');
      x.onclick = () => { unpicture(p); msg.textContent = ''; if (matchMedia('(pointer: fine)').matches) text.focus(); };
      li.style.setProperty('--tilt', `${(Math.random() * 6 - 3).toFixed(1)}deg`);   // (taped on by hand)
      li.append(img, x); picList.append(li);
      return li;
    }
    const unpicture = p => { pictures = pictures.filter(q => q !== p); p.li.remove(); };
    // what goes with the note, once every picture is drawn: the names of the ones kept, the new ones as data URLs
    // (null if one of them couldn't be read while the note was waiting: it goes nowhere without it, and the message says why)
    async function picturesNow(waiting) {
      await Promise.all(waiting.map(p => p.ready));
      return waiting.some(p => p.failed) ? null : pictures.flatMap(p => p.file ? [p.file] : p.data ? [p.data] : []);
    }
    function showPictures(list) {
      pictures = []; picList.replaceChildren(); framePic = null;
      for (const { file, url } of list) { const p = { file }; p.li = thumbnail(p, url); pictures.push(p); }
    }
    async function scaled(file) {
      const src = URL.createObjectURL(file), img = new Image();
      try {
        img.src = src; await img.decode();
        return drawn(img, img.naturalWidth, img.naturalHeight, file.type === 'image/png');
      } catch { return null; } finally { URL.revokeObjectURL(src); }
    }
    // a picture, or a video's frame, as a data URL the coordinator keeps (null if it can't be read: a video from another
    // site without CORS taints the canvas)
    function drawn(img, w, h, png) {
      try {
        const c = doc.createElement('canvas'), g = c.getContext('2d');
        for (let k = Math.min(1, MAX_SIDE / Math.max(w, h)); k > 0.05; k *= 0.7) {
          c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          g.clearRect(0, 0, c.width, c.height);
          if (png) { g.drawImage(img, 0, 0, c.width, c.height); const url = c.toDataURL('image/png'); if (url.length < MAX_DATA_URL) return url; }
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);   // (a JPEG has no see-through)
          for (const q of [0.85, 0.7, 0.55]) { const url = c.toDataURL('image/jpeg', q); if (url.length < MAX_DATA_URL) return url; }
        }
        return null;
      } catch { return null; }
    }
    // the paused video's frame, as the note's first picture (its × takes it off like any other)
    // (what to tell the board when no frame went: a film from another site without CORS taints the canvas, and a note
    // with a dozen pictures has no room; '' when it did)
    function addFrame(video) {
      const data = drawn(video, video.videoWidth, video.videoHeight, false);
      if (!data) return FRAMELESS;
      if (pictures.length >= MAX_PICTURES) return NO_ROOM_FOR_FRAME;
      const p = { data, ready: Promise.resolve() };
      p.li = thumbnail(p, data); picList.prepend(p.li); pictures.unshift(p); framePic = p;
      return '';
    }
    // the element as it goes, with its lines (ink.js's strokes), and saying whether its first picture is the video's frame
    const marked = () => ({ ...mark.element, ...(strokes.length ? { ink: inkOut() } : {}),
      ...(mark.element.video ? { video: { ...mark.element.video, frame: !!framePic && pictures[0] === framePic } } : {}) });
    const FRAMELESS = 'The film’s frame couldn’t be copied here (it comes from another site): the note keeps its moment, without a picture of it.';
    const NO_ROOM_FOR_FRAME = 'A note takes a dozen pictures at most, so the film’s frame stays off: the note keeps its moment, without a picture of it.';
    // A paste into the note, or with nothing on the page to take it. Text copied with a picture of itself (an office app's
    // cells) pastes as text; a file copied in a file manager brings its name as text, and goes as the picture.
    const imagesIn = list => [...(list ?? [])].filter(f => f.type.startsWith('image/'));
    function pasted(e) {
      if (mode !== 'note' || covered) return;
      const images = imagesIn(e.clipboardData?.files), words = e.clipboardData?.getData('text/plain').trim() ?? '';
      if (!images.length || (words && !words.split(/\r?\n/).every(w => images.some(f => f.name === w.trim())))) return;
      e.preventDefault(); addPictures(images);
    }
    host.addEventListener('paste', e => { e.stopPropagation(); pasted(e); });   // (the page never hears what goes in the note)
    addEventListener('paste', e => { if (e.target === doc.body || e.target === doc.documentElement) pasted(e); });
    // A file dragged over the open note lights it up, and dropped there goes with it. One that misses it lands on the note
    // too, unless the page takes it, rather than the browser opening the file in place of the page and the note. While
    // the note is covered (HQ's viewer), a miss still doesn't open the file, but nothing goes in the hidden note.
    let takingTimer;
    const carriesFiles = e => mode === 'note' && [...(e.dataTransfer?.types ?? [])].includes('Files');
    for (const [target, ours] of [[host, true], [window, false]]) {
      target.addEventListener('dragover', e => {
        if (!carriesFiles(e) || (!ours && e.defaultPrevented)) return;
        if (ours) e.stopPropagation();
        e.preventDefault(); e.dataTransfer.dropEffect = covered ? 'none' : 'copy';
        if (covered) return;
        sheet.classList.add('taking'); clearTimeout(takingTimer); takingTimer = setTimeout(() => sheet.classList.remove('taking'), 200);
      });
      target.addEventListener('drop', e => {
        if (!carriesFiles(e) || (!ours && e.defaultPrevented)) return;
        if (ours) e.stopPropagation();
        e.preventDefault(); if (covered) return;
        sheet.classList.remove('taking'); addPictures([...e.dataTransfer.files]);
      });
    }

    // ---------------------------------------------------------------- voice: tap to talk, tap to stop
    // The words come as they're said, as on a call: the microphone's audio goes as it's heard, 16 kHz PCM, over a
    // WebSocket next to the script (/__review/dictate, which the coordinator hands to the voice line's recogniser), and each
    // phrase's words come back while the board talks, into the note. The clip is recorded too: where that line can't be
    // reached (or drops), the whole clip is transcribed by the coordinator's speech-to-text (POST /__review/voice).
    const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    const canRecord = !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    // (heard in the board's language, which the coordinator reads)
    let rec = null, stopping = null;
    if (!canRecord) { mic.disabled = true; mic.title = 'This browser can’t record here'; }
    listenItem.dataset.can = canRecord ? '1' : ''; listenItem.hidden = !canRecord || (outside && !!state.sent);
    mic.onclick = () => rec ? stopMic() : startMic();
    async function startMic() {
      // (the audio context made at the tap, so Safari lets it run)
      const AC = window.AudioContext || window.webkitAudioContext;
      const r = rec = { chunks: [], said: text.value.trim(), shown: [], taken: [], ctx: AC ? new AC() : null };
      // What the reviewer types meanwhile stays: the words in the note then are theirs, and only words heard after go in
      r.typed = () => { r.said = text.value; r.taken = r.shown; r.edited = true; };
      text.addEventListener('input', r.typed);
      mic.classList.add('on'); msg.textContent = 'Listening… tap the mic to stop';
      try {
        r.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
        if (rec !== r) { r.stream.getTracks().forEach(t => t.stop()); r.ctx?.close?.(); return; }
        const type = TYPES.find(t => MediaRecorder.isTypeSupported?.(t));
        r.mr = new MediaRecorder(r.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
        r.mr.ondataavailable = e => { if (e.data.size) r.chunks.push(e.data); };
        r.mr.start(1000); r.t0 = performance.now();
        r.limit = setTimeout(() => rec === r && stopMic(), 300_000);   // (the voice line's five minutes)
        if (!r.ctx) return;
        r.ctx.resume?.();
        // the mic button breathes with the voice
        const source = r.ctx.createMediaStreamSource(r.stream), an = r.ctx.createAnalyser(), buf = new Uint8Array(256);
        source.connect(an); an.fftSize = 256;
        const tick = () => { if (rec !== r) return mic.style.setProperty('--lvl', 0); an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += (v - 128) ** 2;
          mic.style.setProperty('--lvl', Math.min(0.6, Math.sqrt(s / buf.length) / 30).toFixed(2)); requestAnimationFrame(tick); };
        tick();
        live(r, source);
      } catch (err) {
        if (rec === r) { rec = null; mic.classList.remove('on'); r.ctx?.close?.(); text.removeEventListener('input', r.typed); }
        msg.textContent = err?.name === 'NotAllowedError' ? 'The microphone is blocked for this page. Type the note instead?' : 'Could not start the microphone.';
      }
    }
    // The live line: its words replace what it said before in the note, after the words that were there already.
    // r.live: open while it carries the words, 'failed' once it can't (the clip then does)
    function live(r, source) {
      const url = new URL('dictate', ROUTE); url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      let ws;
      try { ws = new WebSocket(url); } catch { r.live = 'failed'; return; }
      ws.binaryType = 'arraybuffer';
      r.live = ws;
      r.done = new Promise(resolve => { r.finished = resolve; });
      r.closed = new Promise(resolve => ws.addEventListener('close', resolve));
      const tap = r.ctx.createScriptProcessor(4096, 1, 1), mute = r.ctx.createGain(), rate = r.ctx.sampleRate;
      mute.gain.value = 0; source.connect(tap).connect(mute).connect(r.ctx.destination);
      let at = 0;   // where the next 16 kHz sample falls in the incoming audio
      tap.onaudioprocess = e => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const x = e.inputBuffer.getChannelData(0), step = rate / 16000, out = new Int16Array(Math.ceil((x.length - at) / step));
        let n = 0;
        for (; at < x.length - 1 && n < out.length; at += step, n++) {
          const i = Math.floor(at), v = x[i] + (x[i + 1] - x[i]) * (at - i);
          out[n] = Math.max(-1, Math.min(1, v)) * 0x7fff;
        }
        at -= x.length;
        ws.send(out.subarray(0, n));
      };
      r.untap = () => { tap.onaudioprocess = null; try { source.disconnect(tap); } catch { /* gone */ } };
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'heard' && typeof m.text === 'string' && (rec === r || r.ending)) words(r, m.text);
        // (done unasked: the line's five minutes are up, so the mic stops there)
        if (m.type === 'done') { r.liveDone = true; r.finished(true); ws.close(); if (rec === r) stopMic(); }
      };
      // (closed before its words were all in: the clip has them)
      ws.onclose = () => { r.untap(); if (r.live === ws && !r.liveDone) r.live = 'failed'; r.finished(false); };
      ws.onerror = () => { r.live = 'failed'; };
    }
    // The heard words past the ones the note held when the reviewer last typed (a look's words revised since: past the
    // ones both share, a word the recogniser only recased or repunctuated still the same one), after the reviewer's own,
    // where their caret stays
    const plain = w => w.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const words = (r, heard) => {
      const said = heard.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      while (i < r.taken.length && plain(said[i] ?? '') === plain(r.taken[i])) i++;
      const fresh = said.slice(i).join(' ');
      r.shown = said; r.heard = true;
      if (r.edited && !fresh) return;
      const { selectionStart: from, selectionEnd: to } = text, typing = root.activeElement === text;
      text.value = [r.said.trimEnd(), fresh].filter(Boolean).join(' ');
      if (typing) text.setSelectionRange(from, to); else text.scrollTop = text.scrollHeight;
    };
    // One stop at a time: `stopping` is the running one, so Pin it can wait for its words.
    function stopMic(cancel) {
      if (!rec) return stopping ?? Promise.resolve();
      const r = rec, p = stopping = endMic(r, cancel).finally(() => text.removeEventListener('input', r.typed));
      return p.finally(() => { if (stopping === p) stopping = null; });
    }
    async function endMic(r, cancel) {
      const m = mark;
      rec = null; clearTimeout(r.limit); mic.classList.remove('on');
      const clip = await new Promise(res => { if (!r.mr || r.mr.state === 'inactive' || cancel) { try { r.mr?.stop(); } catch { /* stopped */ } return res(null); }
        r.mr.onstop = () => res(new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' })); r.mr.stop(); });
      r.stream?.getTracks().forEach(t => t.stop());
      // the live line's last phrase: it says done once the words are in (or a few seconds pass)
      let liveOk = !!r.liveDone && !cancel;
      if (!liveOk && r.live && r.live !== 'failed' && !cancel) {
        r.ending = true;   // (its last words still come in)
        if (r.live.readyState === WebSocket.OPEN) r.live.send(JSON.stringify({ type: 'end' }));
        liveOk = await Promise.race([r.done, new Promise(res => setTimeout(() => res(false), 6000))]);
      }
      // (closed before the clip goes: the coordinator takes one at a time)
      if (r.live && r.live !== 'failed') r.live.close();
      if (r.closed && !liveOk && !cancel) await Promise.race([r.closed, new Promise(res => setTimeout(res, 2000))]);
      r.ending = false; r.untap?.(); r.ctx?.close?.();
      if (liveOk) { msg.textContent = r.heard ? 'Check the words, then pin it.' : 'No words came through. Try again, a little closer?'; return; }
      if (!clip || cancel) return;
      if (performance.now() - r.t0 < 600 || clip.size < 200) { msg.textContent = 'That was very short. Tap, talk, then tap again.'; return; }
      mic.classList.add('busy'); mic.disabled = true; $('.send').disabled = true; msg.textContent = 'Turning your words into text…';
      try {   // next to the script
        const res = await fetch(new URL('voice', ROUTE), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': clip.type || 'audio/webm' }, body: clip });
        if (!res.ok) throw res.status;
        const said = ((await res.json()).text || '').trim();
        if (mark !== m) return;   // that note was cancelled meanwhile (finally still frees the mic)
        if (said) { words(r, said); msg.textContent = 'Check the words, then pin it.'; }
        else msg.textContent = 'No words came through. Try again, a little closer?';
      } catch (code) {
        msg.textContent = code === 413 ? 'That was too long for one go: try it in two.'
          : code === 429 ? 'The transcriber is busy with this page. Type this one instead?' : 'The transcriber isn’t available right now. Type it instead?';
      } finally {
        mic.classList.remove('busy'); mic.disabled = false; if (mode === 'note') $('.send').disabled = false;
      }
    }

    // ---------------------------------------------------------------- the screenshot
    // The viewport as it is, drawn by the browser itself through an SVG <foreignObject>: every visible element is
    // copied with its computed style inlined, images, backgrounds and web fonts become data URLs (same-origin or
    // CORS-enabled ones; the rest are left out), fixed and sticky elements are pinned where they are on screen. Returns
    // that picture ({ c: a canvas, k: its pixels per CSS px}), or null if the browser won't play along; the pin and the
    // lines go on a copy (expose), each time they change, and the note takes that copy as a JPEG (photo).
    async function snapshot(m) {
      try {
        const W = innerWidth, H = innerHeight, sx = scrollX, sy = scrollY, de = doc.documentElement, waits = [];
        // what copy() keeps track of for fixed and sticky boxes, and for faces that
        // turn in 3D: the 3D context a box sits in, whether its parent keeps it 3D, and whether what it's painted on is
        // turned away
        const pins = { top: null, cb: { x: 0, y: 0 }, clear: true, cut: false, cuts: false, scroller: false,
          context3d: null, preserved: false, turnedAway: false };
        const clone = copy(de, waits, { sx, sy, W, H, ...pins });
        // the page's open popups over it all, in the order they opened, in a box the screen's size (the one they're sized
        // and placed in); each with its backdrop in a stacking context of its own, the popup over its backdrop (the top
        // layer ignores a popup's own z-index, which its copy keeps)
        const overPage = doc.createElement('div');
        overPage.setAttribute('style', `position:absolute;left:${sx}px;top:${sy}px;width:${W}px;height:${H}px;z-index:2147483647`);
        for (const popup of openPopups()) {
          const b = getComputedStyle(popup, '::backdrop'), layer = doc.createElement('div'), backdrop = doc.createElement('div'), above = doc.createElement('div');
          layer.setAttribute('style', 'position:absolute;inset:0;isolation:isolate');
          backdrop.setAttribute('style', `position:absolute;inset:0;background-color:${b.backgroundColor};background-image:${b.backgroundImage};`
            + `opacity:${b.opacity};backdrop-filter:${b.backdropFilter || 'none'}`);
          above.setAttribute('style', 'position:absolute;inset:0;z-index:1');
          const copied = copy(popup, waits, { sx, sy, W, H, ...pins, cb: { x: sx, y: sy }, popup });
          if (copied) above.append(copied);
          layer.append(backdrop, above);
          overPage.append(layer);
        }
        clone.append(overPage);
        // (WebKit paints no box placed against the image's own initial containing block: the root holds them instead)
        if (getComputedStyle(de).position === 'static') clone.style.position = 'relative';
        const fonts = await Promise.race([fontFaces(), new Promise(r => setTimeout(() => r(''), 3000))]);
        await Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, 4000))]);
        const style = doc.createElement('style'); style.textContent = fonts; clone.prepend(style);
        const dw = Math.max(de.scrollWidth, W), dh = Math.max(de.scrollHeight, H);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="${-sx}" y="${-sy}" width="${dw}" height="${dh}">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
        const img = new Image(); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await img.decode();
        const k = Math.min(devicePixelRatio || 1, 2, 2000 / Math.max(W, H)), c = doc.createElement('canvas');
        c.width = Math.round(W * k); c.height = Math.round(H * k);
        const g = c.getContext('2d'); g.scale(k, k);
        g.fillStyle = bg(); g.fillRect(0, 0, W, H);
        g.drawImage(img, 0, 0, W, H);
        await new Promise(r => setTimeout(r, 60)); g.drawImage(img, 0, 0, W, H); // Safari paints images late: a second pass
        c.toDataURL('image/jpeg', 0.1);   // (a page that tainted it says so here, not at the send)
        return { c, k };
      } catch (err) { console.info('[review] no screenshot:', err?.message || err); return null; }
    }
    // the screenshot with the mark on it, into `into` (a new canvas by default)
    function expose({ c, k }, m, into = doc.createElement('canvas')) {
      into.width = c.width; into.height = c.height;
      const g = into.getContext('2d'); g.drawImage(c, 0, 0); g.scale(k, k);
      annotate(g, m);
      return into;
    }
    // ...as it goes: the coordinator keeps a screenshot up to 1.5 MB (about 2 MB as a data URL)
    function photo(taken, m) {
      if (!taken) return null;
      try {
        const c = expose(taken, m);
        let url;
        for (const q of [0.85, 0.7, 0.55, 0.4]) if ((url = c.toDataURL('image/jpeg', q)).length < 2_000_000) break;
        return url.startsWith('data:image/jpeg') ? url : null;
      } catch { return null; }
    }
    const bg = () => { for (const e of [doc.body, doc.documentElement]) { const c = e && getComputedStyle(e).backgroundColor; if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c; } return '#fff'; };
    // the pin, and the lines drawn as they are on screen (ink.js)
    function annotate(g, m) {
      g.lineCap = g.lineJoin = 'round';
      const r = m.element.rect;
      if (m.kind === 'circle') { /* its lines, below */ } else {
        g.setLineDash([7, 5]); g.strokeStyle = ACCENT; g.lineWidth = 2.5; g.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6); g.setLineDash([]);
        const { x, y } = m; // a pin: a round head on a short needle
        g.strokeStyle = '#2b2230'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 8, y - 16); g.stroke();
        g.fillStyle = ACCENT; g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(x + 11, y - 21, 9, 0, 7); g.fill(); g.stroke();
      }
      inkjs?.draw(g, strokes, { halo: true });
    }
    // (a dialog or popover in the top layer is copied over it all, after the rest: its v.popup.)
    const SKIP = /^(script|noscript|template|style|link|meta|title|base|head|iframe|object|embed|audio|source|track)$/;
    function copy(node, waits, v) {
      if (node.nodeType !== 1 || node === host || SKIP.test(node.localName) || (node !== v.popup && popups.includes(node) && inTopLayer(node))) return null;
      const cs = getComputedStyle(node);
      if (cs.display === 'none') return null;
      const tag = node.localName, r = node.getBoundingClientRect();
      // a fixed box (a chat's 0×0 custom element at the page's end) says nothing about where its fixed contents are
      const off = cs.position !== 'fixed' && (r.bottom < -50 || r.top > v.H + 50 || r.right < -50 || r.left > v.W + 50);
      if (node instanceof SVGElement && tag !== 'svg') return node.cloneNode(true);
      let out;
      if (tag === 'canvas') { out = doc.createElement('img'); try { out.src = node.toDataURL(); } catch { /* tainted */ } }
      else if (tag === 'video') {   // its frame as it is (paused under a note), else its poster.
        out = doc.createElement('img');
        // (a frame that can't be copied leaves the box empty: the poster would pass for the moment)
        if (node.readyState >= 2) { const frame = drawnFrame(node); if (frame) out.src = frame; }
        else if (node.poster) waits.push(inline(node.poster).then(u => { if (u) out.src = u; }));
      }
      else if (tag === 'svg') out = paintedSvg(node, off);
      else out = node.cloneNode(false);
      out.removeAttribute?.('id'); out.removeAttribute?.('srcset'); out.removeAttribute?.('loading');
      for (const a of [...(out.attributes || [])]) if (/^on/i.test(a.name)) out.removeAttribute(a.name);
      // An auto margin (a column centred in the page) can read as a stale 0px in Chrome's computed style, so the copy would
      // sit at the left while the mark stays where it was drawn: the typed computed value keeps it auto
      const typed = node.computedStyleMap?.();
      let s = '';
      for (let i = 0; i < cs.length; i++) {
        const p = cs[i];
        s += `${p}:${p.startsWith('margin') && String(typed?.get(p)) === 'auto' ? 'auto' : cs.getPropertyValue(p)};`;
      }
      const html = tag === 'html' || tag === 'body';
      const background = pageBackground(tag, cs);
      s += background.style;
      // Margins through a block's ends, as on screen: a block sized by what's in it lets its last child's bottom margin
      // through, which a height in px would keep inside (not around a box the copy leaves out, whose height it would
      // lose), and an off-screen box's copy is empty, so it takes on the margins that its first and last child let
      // through it
      const lastBlock = !html && !off && passes(node, cs, 'bottom') && edgeChild(node, 'bottom');
      if (lastBlock && !node.querySelector('iframe, object, embed, audio, dialog')) s += 'height:auto;';
      if (!html && off) s += `margin-top:${through(node, cs, 'top')}px;margin-bottom:${through(node, cs, 'bottom')}px;`;
      s += 'animation:none;transition:none;';
      // Fixed and sticky: where it is on screen right now, in place, from the box it's positioned in, so it paints in
      // tree order like the browser's. Lifted out only when an ancestor's overflow would cut it there and nothing in
      // between changes how it paints (no ancestor it's positioned or stacked in): then it goes right after the
      // outermost ancestor that would cut it, so later positioned siblings still paint over it. A sticky one leaves an
      // empty box of its size behind, so what's under it stays there; one in a scroll container (overflow:clip cuts
      // but doesn't scroll) stays as it is, like that container's scroll
      const overflows = [cs.overflowX, cs.overflowY];
      const clips = !html && overflows.some(o => o !== 'visible');
      const scrolls = !html && overflows.some(o => o === 'hidden' || o === 'scroll' || o === 'auto');
      const pinned = cs.position === 'fixed' || (cs.position === 'sticky' && !v.scroller), lift = pinned && v.clear && v.cut;
      const room = pinned && cs.position === 'sticky' && doc.createElement('div');
      if (room) room.setAttribute('style', `${s}visibility:hidden;`);
      const x = r.left + v.sx, y = r.top + v.sy;
      const inner = { x: x + parseFloat(cs.borderLeftWidth), y: y + parseFloat(cs.borderTopWidth) };
      if (pinned) {
        const at = lift ? v.top : v.cb;
        s += `position:absolute;left:${x - at.x}px;top:${y - at.y}px;right:auto;bottom:auto;margin:0;transform:none;`;
        if (lift) v.top.kids.push(out);
      }
      // holds: a fixed box inside is positioned and painted in it; paints: its own stacking or compositing
      const willChange = cs.willChange || 'auto', contentVisibility = cs.contentVisibility || 'visible';
      const holds = cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none'
        || (cs.backdropFilter || 'none') !== 'none' || /layout|paint|strict|content/.test(cs.contain)
        || /transform|perspective|filter/.test(willChange) || contentVisibility !== 'visible';
      const composites = parseFloat(cs.opacity) < 1 || cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal'
        || cs.clipPath !== 'none' || (cs.maskImage || cs.webkitMaskImage || 'none') !== 'none';
      const paints = composites || cs.zIndex !== 'auto' || /opacity/.test(willChange);
      const face = faceOf(node, cs, v, clips, composites);
      if (face.away) s += 'visibility:hidden;';
      // An absolute copy is cut by the overflow of the box it's positioned in and of every ancestor of that box. The
      // first box that cuts what's inside it, itself uncut, takes what's lifted out of it right after it.
      const positions = pinned || holds || cs.position !== 'static';
      const uncut = pinned ? lift || !v.cut : !v.cut && !v.cuts, first = clips && uncut;
      const lifted = first && !lift && { x: v.cb.x, y: v.cb.y, kids: [] };
      // A box scrolled on screen holds what's inside in one box, moved by the scroll (the copy doesn't scroll)
      const scroll = scrolls && tag !== 'textarea' && /block|flow-root|flex|grid|list-item/.test(cs.display) && { x: node.scrollLeft, y: node.scrollTop };
      const held = (scroll.x || scroll.y) && scrollHolder(node, cs, scroll, positions);
      if (held) s += held.boxStyle;
      const at = held ? { x: inner.x - scroll.x, y: inner.y - scroll.y } : inner;
      v = { ...v, top: lifted || v.top, cb: positions ? at : v.cb, clear: (first || v.clear) && !paints && !holds,
        cut: pinned ? clips || (!lift && v.cut) : v.cut || (positions && (v.cuts || clips)),
        cuts: !positions && (v.cuts || clips), scroller: v.scroller || scrolls,
        context3d: face.context3d, preserved: face.preserves, turnedAway: face.away };
      out.setAttribute('style', s);
      if (tag === 'img') { out.removeAttribute('src'); const src = node.currentSrc || node.src; if (src) waits.push(inline(src).then(u => { if (u) out.setAttribute('src', u); })); }
      if (tag === 'input') { if (node.type === 'checkbox' || node.type === 'radio') node.checked ? out.setAttribute('checked', '') : out.removeAttribute('checked'); else if (node.type !== 'password') out.setAttribute('value', node.value); }
      if (tag === 'option' && node.selected) out.setAttribute('selected', '');
      if (background.image.includes('url(')) waits.push(inlineUrls(background.image, location.href).then(b => { out.style.backgroundImage = b; }));
      // off screen: keep the box (it holds the layout) but skip what's inside
      if (tag === 'textarea') out.textContent = node.value;
      else if (tag !== 'svg' && tag !== 'canvas' && tag !== 'video' && (!off || tag === 'html' || tag === 'body')) {
        const box = !v.scroller && contentBox(r, cs);
        const before = pseudo(node, '::before', waits, box, v), after = pseudo(node, '::after', waits, box, v);
        // a face turned away hides what it paints too
        if (face.away) {
          for (const p of [before, after]) {
            if (p) p.style.visibility = 'hidden';
          }
        }
        const into = held ? held.holder : out, wraps = cs.whiteSpace === 'normal';
        if (before) into.append(before);
        for (const c of (node.shadowRoot || node).childNodes) {
          const k = c.nodeType === 3 ? copyText(c, wraps) : copy(c, waits, v);
          if (k) into.append(k);
        }
        if (after) into.append(after);
        if (held) out.append(held.holder);
      }
      const parts = [room, !lift && out, ...(lifted ? lifted.kids : [])].filter(Boolean);
      if (parts.length < 2) return parts[0] || null;
      const all = doc.createDocumentFragment(); all.append(...parts); return all;
    }
    // An inline SVG copied whole, its shapes painted as the page's style sheets paint them on screen
    const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
      'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'paint-order', 'opacity', 'display', 'visibility',
      'transform', 'transform-origin', 'transform-box', 'color', 'stop-color', 'stop-opacity', 'font-family', 'font-size',
      'font-weight', 'text-anchor', 'mix-blend-mode'];
    function paintedSvg(node, off) {
      const svg = node.cloneNode(true);
      if (off) return svg;
      const shapes = svg.querySelectorAll('*');
      node.querySelectorAll('*').forEach((shape, i) => {
        const cs = getComputedStyle(shape);
        const paint = PAINT.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';');
        shapes[i].setAttribute('style', `${shapes[i].getAttribute('style') || ''};${paint};animation:none;transition:none`);
      });
      return svg;
    }
    // The page's background as the browser paints it: under everything, boxes with a negative z-index included, the
    // body's on the root when the root has none. Its style text and the picture it paints
    function pageBackground(tag, cs) {
      if (tag === 'html') {
        const from = doc.body && bare(cs) ? getComputedStyle(doc.body) : cs;
        const moved = from === cs ? '' : BACKGROUND.map(p => `${p}:${from.getPropertyValue(p)};`).join('');
        return { style: `isolation:isolate;${moved}`, image: from.backgroundImage };
      }
      if (tag === 'body' && bare(getComputedStyle(doc.documentElement))) return { style: 'background:none;', image: 'none' };
      return { style: '', image: cs.backgroundImage };
    }
    const BACKGROUND = ['background-color', 'background-image', 'background-position', 'background-size',
      'background-repeat', 'background-attachment', 'background-origin', 'background-clip'];
    const bare = cs => cs.backgroundImage === 'none' && /^(transparent|rgba\(.*,\s*0\))$/.test(cs.backgroundColor);
    // Whether a box lets the margin of its first (top) or last (bottom) child through that end
    const passes = (node, cs, end) => /^(block|list-item)$/.test(cs.display) && !flexOrGridItem(node) && /^(static|relative)$/.test(cs.position)
      && cs.float === 'none' && cs.overflowX === 'visible' && cs.overflowY === 'visible'
      && !pixels(cs, `padding-${end}`) && !pixels(cs, `border-${end}-width`)
      && (end === 'top' || (String(node.computedStyleMap?.().get('height')) === 'auto' && !pixels(cs, 'min-height')));
    // A flex or grid item is blockified, but its children's margins stay inside it
    function flexOrGridItem(node) {
      const parent = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement;
      return !!parent && /flex|grid/.test(getComputedStyle(parent).display);
    }
    // A box's margin at one end, together with the margins its children let through it there: the largest one, less the
    // most negative one, as margins collapse
    function through(node, cs, end) {
      const margins = [];
      let box = node, style = cs;
      while (box) {
        margins.push(parseFloat(style.getPropertyValue(`margin-${end}`)) || 0);
        box = passes(box, style, end) ? edgeChild(box, end) : null;
        style = box && getComputedStyle(box);
      }
      return collapse(...margins);
    }
    const collapse = (...margins) => Math.max(0, ...margins) + Math.min(0, ...margins);
    // A box's first or last child in the flow, if it's a block: text or an inline box there ends the margins' way
    function edgeChild(node, end) {
      const kids = [...(node.shadowRoot || node).childNodes];
      if (end === 'bottom') kids.reverse();
      for (const kid of kids) {
        if (kid.nodeType === 3 && kid.data.trim()) return null;
        if (kid.nodeType !== 1) continue;
        const style = getComputedStyle(kid);
        if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed' || style.float !== 'none') continue;
        return /^(block|list-item|flow-root|flex|grid|table)$/.test(style.display) ? kid : null;
      }
      return null;
    }
    // A scrolled box's contents go in one box in the copy, moved by the scroll and laid out as the scrolled box lays
    // them out, its padding included. The scrolled box keeps its size on screen. The holder moves by top and left when the
    // scrolled box positions what's inside, so that moves with it, else by its margins, so it positions nothing itself.
    // A sticky box in it sticks to the scrolled box's copy, which doesn't scroll, so the holder spans all it scrolls
    // down, as the browser's sticky box sees it, rather than its size on screen, and across too only when a sticky box
    // sticks to a side, since that widens the boxes in the flow
    const LAYOUT = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'flex-direction', 'flex-wrap',
      'align-items', 'align-content', 'justify-content', 'justify-items', 'row-gap', 'column-gap', 'grid-template-columns',
      'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows'];
    function scrollHolder(node, cs, scroll, positions) {
      const around = (a, b) => cs.boxSizing === 'border-box' ? 0
        : pixels(cs, `padding-${a}`) + pixels(cs, `padding-${b}`) + pixels(cs, `border-${a}-width`) + pixels(cs, `border-${b}-width`);
      const boxStyle = `display:${cs.display.startsWith('inline') ? 'inline-block' : 'flow-root'};box-sizing:border-box;padding:0;flex:none;`
        + `width:${pixels(cs, 'width') + around('left', 'right')}px;height:${pixels(cs, 'height') + around('top', 'bottom')}px;`
        + 'min-width:0;min-height:0;max-width:none;max-height:none;';
      const sticky = [...(node.shadowRoot || node).children].map(kid => getComputedStyle(kid))
        .concat([getComputedStyle(node, '::before'), getComputedStyle(node, '::after')]).filter(style => style.position === 'sticky');
      const sideways = sticky.some(style => style.left !== 'auto' || style.right !== 'auto');
      const size = `width:${sideways ? `${node.scrollWidth}px` : '100%'};height:${sticky.length ? `${node.scrollHeight}px` : '100%'};`;
      let s = `display:${/flex|grid/.exec(cs.display)?.[0] || 'flow-root'};box-sizing:border-box;${size}`;
      for (const p of LAYOUT) s += `${p}:${cs.getPropertyValue(p)};`;
      s += positions ? `position:relative;left:${-scroll.x}px;top:${-scroll.y}px;` : `margin:${-scroll.y}px 0 0 ${-scroll.x}px;`;
      const holder = doc.createElement('div'); holder.setAttribute('style', s);
      return { boxStyle, holder };
    }
    // A length in a computed style, in px
    const pixels = (style, property) => parseFloat(style.getPropertyValue(property)) || 0;
    // Where a box's content box is on screen
    const contentBox = (r, cs) => ({
      top: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
      right: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
      bottom: r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
      left: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    });
    // The browser transforms only the boxes it can transform. The computed style of an inline box of text, a table
    // column, a ruby box or a box without one still has its transform and backface-visibility, but the browser ignores
    // them. An inline picture or form field is a box of its own and turns.
    const UNTRANSFORMED = /^(inline|contents|table-column|table-column-group|ruby|ruby-base|ruby-text)$/;
    const REPLACED = /^(img|video|canvas|svg|input|select|textarea|button|meter|progress)$/;
    // Whether a face is turned away, and the 3D context the face gives the boxes inside it. The copy is flat, so it
    // would draw a face turned away mirrored. It keeps an empty box instead, which holds the layout
    function faceOf(node, cs, v, clips, composites) {
      const transformable = !UNTRANSFORMED.test(cs.display) || REPLACED.test(node.localName);
      const willChange = cs.willChange || 'auto';
      // The 3D matrix of the face decides which side of the face the viewer sees.
      const faceTransform = faceTransformOf(node, cs, v.context3d);
      // The browser draws nothing of a face when backface-visibility hides it and its back faces the viewer.
      const hidesBack = transformable && cs.backfaceVisibility === 'hidden';
      // A face paints the boxes inside it on itself, so a box inside a face turned away goes with that face. A box is
      // a 3D plane of its own when its parent keeps it 3D (preserve-3d) and the box has one of these:
      // - a transform (the translate, rotate and scale properties don't count)
      // - will-change: transform
      // - transform-style: preserve-3d
      const plane = cs.transform !== 'none' || /transform/.test(willChange) || cs.transformStyle === 'preserve-3d';
      const ownPlane = transformable && v.preserved && plane;
      const away = (hidesBack && faceTransform.inverse().m33 < 0) || (v.turnedAway && !ownPlane);
      // A box that flattens paints the boxes inside it on itself, so they turn with it. A box flattens when it has one
      // of these:
      // - an overflow that clips
      // - compositing, or will-change: opacity
      // - a filter, a backdrop-filter or will-change: filter
      // - a reflection
      const flattens = clips || composites || /opacity|filter/.test(willChange) || cs.filter !== 'none'
        || (cs.backdropFilter || 'none') !== 'none' || (cs.webkitBoxReflect || 'none') !== 'none';
      const preserves = transformable && cs.transformStyle === 'preserve-3d' && !flattens;
      // A box that keeps the boxes inside it 3D passes its face's matrix on to them. A box with a perspective passes
      // that perspective on too.
      const kept = preserves ? faceTransform : new DOMMatrix();
      const context = transformable ? kept.multiply(perspectiveOf(cs)) : kept;
      return { away, preserves, context3d: context.isIdentity ? null : { matrix: context, holder: node } };
    }
    // The 3D matrix that decides which side of an element faces the viewer: its own transform, after the matrix of the
    // 3D context it sits in. Under perspective, where the box sits changes the angle it's seen from, so its offset from
    // the box that holds that context goes in between
    function faceTransformOf(node, cs, context3d) {
      const own = transformOf(node, cs);
      if (!context3d) return own;
      const [x, y] = layoutAt(node), [hx, hy] = layoutAt(context3d.holder);
      return context3d.matrix.translate(x - hx, y - hy).multiply(own);
    }
    // An element's own transform, about its transform-origin: the translate, rotate and scale properties, then
    // transform
    function transformOf(node, cs) {
      const m = new DOMMatrix(), rotate = cs.rotate || 'none', scale = (cs.scale || 'none').split(' ');
      if ((cs.translate || 'none') !== 'none') {
        const size = [node.offsetWidth, node.offsetHeight, 0];
        const parts = cs.translate.match(/(?:[^\s(]|\((?:[^()]|\([^()]*\))*\))+/g);
        const lengths = parts.map((part, i) => lengthOf(part, size[i]));
        m.translateSelf(...lengths);
      }
      if (rotate !== 'none') {
        const rotation = rotationOf(rotate);
        m.multiplySelf(new DOMMatrix(rotation));
      }
      if (scale[0] !== 'none') {
        const [sx, sy = sx, sz = 1] = scale;
        m.multiplySelf(new DOMMatrix(`scale3d(${sx},${sy},${sz})`));
      }
      m.multiplySelf(new DOMMatrix(cs.transform));
      if (m.isIdentity) return m;
      const [ox, oy, oz = 0] = cs.transformOrigin.split(' ').map(parseFloat);
      return new DOMMatrix().translate(ox, oy, oz).multiply(m).translate(-ox, -oy, -oz);
    }
    // The rotate property as a transform function: an angle alone, an axis and an angle, or a vector and an angle
    function rotationOf(rotate) {
      const axis = rotate.split(' '), angle = axis.pop();
      if (!axis.length) return `rotate(${angle})`;
      if (axis.length === 1) return `rotate${axis[0].toUpperCase()}(${angle})`;
      return `rotate3d(${axis},${angle})`;
    }
    // A computed length-percentage in px, a percentage of size. A calc() mixing the two stays one in the computed style:
    // a margin of a box that wide in our own root resolves it
    function lengthOf(value, size) {
      if (/^[-+\d.e]+(px)?$/.test(value)) return parseFloat(value);
      const box = doc.createElement('div'), probe = doc.createElement('div');
      box.setAttribute('style', `position:absolute;visibility:hidden;width:${size}px;padding:0;border:0`);
      probe.style.marginLeft = value; box.append(probe); root.append(box);
      const px = parseFloat(getComputedStyle(probe).marginLeft); box.remove();
      return Number.isFinite(px) ? px : 0;
    }
    // Where an element's border box sits in the page's layout, before transforms and after scrolling
    function layoutAt(el) {
      let x = 0, y = 0;
      for (let e = el; e; e = e.offsetParent) {
        const p = e.offsetParent;
        x += e.offsetLeft + (p ? p.clientLeft - p.scrollLeft : 0);
        y += e.offsetTop + (p ? p.clientTop - p.scrollTop : 0);
      }
      return [x, y];
    }
    // The perspective an element gives its children, from its perspective-origin
    function perspectiveOf(cs) {
      const m = new DOMMatrix();
      if (cs.perspective === 'none') return m;
      const [x, y] = cs.perspectiveOrigin.split(' ').map(parseFloat);
      m.m34 = -1 / Math.max(1, parseFloat(cs.perspective));
      return new DOMMatrix().translate(x, y).multiply(m).translate(-x, -y);
    }
    function pseudo(node, which, waits, box, v) {
      const ps = getComputedStyle(node, which), c = ps.content;
      if (!c || c === 'none' || c === 'normal') return null;
      const span = doc.createElement('span'); let s = '';
      for (let i = 0; i < ps.length; i++) s += `${ps[i]}:${ps.getPropertyValue(ps[i])};`;
      // A sticky one can't be measured, and sticky means nothing in the copy: it keeps its place in the flow, moved to
      // where it sticks on screen
      if (ps.position === 'sticky' && box) s += stuck(node, ps, which === '::before', box, v);
      span.setAttribute('style', s + 'animation:none;transition:none;');
      // its picture inlined too, like an element's
      if (ps.backgroundImage.includes('url(')) waits.push(inlineUrls(ps.backgroundImage, location.href).then(b => { span.style.backgroundImage = b; }));
      const m = c.match(/^"(.*)"$/s); if (m) span.textContent = m[1].replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, e) => /^[0-9a-f]/i.test(e) && e.length > 1 ? String.fromCodePoint(parseInt(e, 16)) : e);
      return span;
    }
    // How far a sticky ::before or ::after sits from where it would be unstuck: a ::before at the start of its parent's
    // content box, an ::after under what's in that box, at its left. As in the browser, it sticks to the viewport by its
    // insets and its margin box stays in that content box
    function stuck(node, ps, first, box, v) {
      const along = (start, end, size, view, flow) => {
        const from = box[start] + pixels(ps, `margin-${start}`), to = box[end] - pixels(ps, `margin-${end}`) - size;
        const at = flow ?? from;
        const [near, far] = [ps.getPropertyValue(start), ps.getPropertyValue(end)];
        let moved = at;
        if (near !== 'auto') moved = Math.max(moved, Math.min(parseFloat(near), to));
        if (far !== 'auto') moved = Math.min(moved, Math.max(view - parseFloat(far) - size, from));
        return moved - at;
      };
      const top = along('top', 'bottom', pixels(ps, 'height'), v.H, first ? null : afterTop(node, ps, box));
      const left = along('left', 'right', pixels(ps, 'width'), v.W);
      return `position:relative;top:${top}px;left:${left}px;bottom:auto;right:auto;`;
    }
    // Where a block ::after's border box starts in the flow: under its parent's last child in the flow, past the margins
    // between them as they collapse, else at the top of the content box. A last child's rectangle is where it's painted:
    // its relative offset comes off, and text or an inline box ends at the bottom of its line, past the leading under
    // the font's box
    function afterTop(node, ps, box) {
      const own = pixels(ps, 'margin-top');
      const lineEnd = (rect, style) => rect.bottom + Math.max(0, (pixels(style, 'line-height') - rect.height) / 2);
      for (const kid of [...(node.shadowRoot || node).childNodes].reverse()) {
        if (kid.nodeType === 3 && kid.data.trim()) {
          const range = doc.createRange(); range.selectNodeContents(kid);
          const lines = range.getClientRects();
          if (lines.length) return lineEnd(lines[lines.length - 1], getComputedStyle(node)) + own;
        }
        if (kid.nodeType !== 1) continue;
        const style = getComputedStyle(kid);
        if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed' || style.float !== 'none') continue;
        const rect = kid.getBoundingClientRect(), relativeTop = style.position === 'relative' ? pixels(style, 'top') : 0;
        if (style.display === 'inline') return lineEnd(rect, style) - relativeTop + own;
        return rect.bottom - relativeTop + collapse(through(kid, style, 'bottom'), own);
      }
      return box.top + own;
    }
    // Text on one line on screen stays on one line: the copy keeps each box's width, and a browser can draw the copy's
    // text a hair wider (Firefox does), which would wrap a button's label out of its button. The spaces around it stay
    // outside, so the line can still break there as it does on screen
    function copyText(node, wraps) {
      const [, before, words, after] = /^(\s*)(.*?)(\s*)$/s.exec(node.data);
      if (!wraps || !words) return doc.createTextNode(node.data);
      const range = doc.createRange(); range.setStart(node, before.length); range.setEnd(node, before.length + words.length);
      const lines = new Set([...range.getClientRects()].map(line => Math.round(line.top)));
      if (lines.size !== 1) return doc.createTextNode(node.data);
      const line = doc.createElement('span'); line.setAttribute('style', 'white-space:nowrap'); line.textContent = words;
      const all = doc.createDocumentFragment(); all.append(before, line, after);
      return all;
    }
    // a video's frame as it shows now, about the size it's shown at
    const drawnFrame = v => {
      const r = v.getBoundingClientRect(), k = Math.min(1, Math.max(r.width, r.height) * Math.min(devicePixelRatio || 1, 2) / Math.max(v.videoWidth, v.videoHeight));
      return drawn(v, v.videoWidth * k, v.videoHeight * k, false);
    };
    const cache = new Map();
    const inline = url => {
      if (url.startsWith('data:')) return Promise.resolve(url);
      if (!cache.has(url)) cache.set(url, fetch(url, { credentials: 'same-origin' }).then(r => r.ok ? r.blob() : null).then(b => b && new Promise(res => {
        const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => res(null); f.readAsDataURL(b);
      })).catch(() => null));
      return cache.get(url);
    };
    async function inlineUrls(css, base) {
      const urls = [...css.matchAll(/url\((['"]?)(.*?)\1\)/g)];
      for (const [all, , u] of urls) {
        if (u.startsWith('data:')) continue;
        let abs; try { abs = new URL(u, base).href; } catch { continue; }
        const data = await inline(abs);
        css = css.replace(all, data ? `url("${data}")` : 'none');
      }
      return css;
    }
    async function fontFaces() {
      const out = [];
      for (const sheet of doc.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheets can't be read
        for (const rule of rules) if (rule.constructor.name === 'CSSFontFaceRule') out.push(await inlineUrls(rule.cssText, sheet.href || location.href));
      }
      return out.join('\n');
    }
  }
})();
