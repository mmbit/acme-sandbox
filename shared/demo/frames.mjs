// What a frame-by-frame recording of a real page draws and keeps on its clock, shared by record.mjs and the recorders
// built on it (platform/hq/tip-films.mjs): the frames on the page's fake clock, the finger dot or cursor with its tap
// ripples, CSS animations seeked to that clock, a tap, typing at a person's pace and the easing every move takes.
// overlay and syncAnimations go to the page as source (`${fn}`), so they use nothing from outside themselves.

// A recording's frames: each tick runs the page's clock a frame on, ages the finger's ripples, seeks the page's CSS
// animations and draws the finger, then capture({ x, y }) shoots the frame where the page has scrolled to. during(s, fn)
// ticks for s seconds, calling fn(k) before each frame with k going to 1. inPage(script, arg) runs a script in the page
// (record.mjs's tries again on the page a tap moved to). finger: what overlay draws.
export function frameClock({ page, fps, finger, capture, inPage = (script, arg) => page.evaluate(script, arg) }) {
  const source = { sync: syncAnimations.toString(), draw: overlay.toString() };
  let now = 0;
  const clock = {
    frame: 0,
    async tick() {
      const ms = Math.round(((clock.frame + 1) * 1000) / fps) - Math.round((clock.frame * 1000) / fps);
      clock.frame++;
      now += ms;
      await page.clock.runFor(ms);
      finger.ripples = finger.ripples.map(r => ({ ...r, k: r.k + 1 / (0.5 * fps) })).filter(r => r.k < 1);
      await capture(await inPage(drawFrame, [now, source, finger]));
    },
    async during(s, fn = () => {}) {
      const n = Math.max(1, Math.round(s * fps));
      for (let i = 1; i <= n; i++) {
        await fn(i / n);
        await clock.tick();
      }
    },
  };
  return clock;
}

// In the page: its animations at now and the finger drawn, by the kit's own functions sent as source (Playwright can't
// pass a function inside an argument). Where the page has scrolled to comes back.
function drawFrame([now, source, finger]) {
  for (const [fn, arg] of [
    [source.sync, now],
    [source.draw, finger],
  ])
    (0, eval)(`(${fn})`)(arg); // eslint-disable-line no-eval -- the kit's own functions, as source
  return { x: globalThis.visualViewport.pageLeft, y: globalThis.visualViewport.pageTop };
}

// A tap at p, frame by frame: a finger comes down beside the point and presses, press() taps the page, and the finger
// lifts as its ripple spreads. A cursor (finger.touch false) goes there by moveTo(p) instead, and stays.
export async function tapAt(clock, finger, p, { press, moveTo }) {
  if (finger.touch)
    await clock.during(0.22, k => {
      const e = ease(k);
      Object.assign(finger, { show: e, x: p.x + 26 * (1 - e), y: p.y + 34 * (1 - e) });
    });
  else await moveTo(p);
  await clock.during(0.1, k => (finger.press = k));
  await press();
  finger.ripples.push({ x: p.x, y: p.y, k: 0 });
  await clock.during(0.14, k => (finger.press = 1 - k));
  if (finger.touch) await clock.during(0.2, k => Object.assign(finger, { show: 1 - k, y: p.y + 10 * k }));
}

// Typing at a person's pace: each key with the pause after it in seconds, about cps keys a second, the same every run
export function* keystrokes(text, cps) {
  let seed = 7;
  for (const key of text) {
    seed = (seed * 16807) % 2147483647;
    yield [key, (1 / cps) * (0.6 + (seed % 1000) / 1250)];
  }
}

// In-page overlay: finger dot / cursor and tap ripples, drawn from state we pass each frame. Its look is a constructed
// stylesheet and its positions are set through the element's style, both of which a page's CSP allows: a <style> or a
// style="" in markup would be dropped under `style-src 'self'`, and the cursor drawn as a huge unstyled blob
export function overlay(s) {
  let host = document.getElementById('__demo_cursor');
  if (!host) {
    host = document.createElement('div');
    host.id = '__demo_cursor';
    Object.assign(host.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    const root = host.attachShadow({ mode: 'open' }),
      sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .f{position:absolute;width:40px;height:40px;margin:-20px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff,#e8e8ee);
        opacity:.8;box-shadow:0 3px 10px rgba(0,0,0,.35),inset 0 0 0 1.5px rgba(0,0,0,.12)}
      .c{position:absolute;width:24px;height:24px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
      .r{position:absolute;border-radius:50%;border:3px solid rgba(255,255,255,.95);box-shadow:0 0 0 2px rgba(0,0,0,.18)}`);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML =
      '<div class="f"></div><svg class="c" viewBox="0 0 24 24"><path d="M3 2l17 10.5-7.3 1.3 4.3 7.7-3.2 1.7-4.2-7.7L3 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div class="rs"></div>';
    document.documentElement.append(host);
  }
  const r = host.shadowRoot,
    f = r.querySelector('.f'),
    c = r.querySelector('.c');
  f.style.display = s.touch ? '' : 'none';
  c.style.display = s.touch ? 'none' : '';
  f.style.transform = `translate(${s.x}px,${s.y}px) scale(${1 - 0.18 * s.press})`;
  f.style.opacity = 0.82 * s.show;
  c.style.transform = `translate(${s.x - 3}px,${s.y - 2}px) scale(${1 - 0.1 * s.press})`;
  c.style.opacity = s.show;
  r.querySelector('.rs').replaceChildren(
    ...s.ripples.map(({ x, y, k }) => {
      const d = (s.touch ? 30 : 16) + k * (s.touch ? 60 : 40);
      const ring = document.createElement('div');
      ring.className = 'r';
      Object.assign(ring.style, {
        left: `${x - d / 2}px`,
        top: `${y - d / 2}px`,
        width: `${d}px`,
        height: `${d}px`,
        opacity: (1 - k) ** 1.5,
      });
      return ring;
    }),
  );
}
// Seek every CSS animation/transition to our virtual clock. A paused one never finishes, so once the clock passes the
// end of one that plays forward and ends, finish() it: its `finished` promise and finish/animationend events fire on
// that frame. finish() throws for a zero playback rate, so a stopped or reversed one is only seeked. One the page plays
// again (no longer finished) is picked up afresh.
export function syncAnimations(now) {
  for (const an of document.getAnimations()) {
    if (an.__demoDone && an.playState === 'finished') continue;
    if (an.__demoStart === undefined || an.__demoDone) {
      an.__demoStart = now - (an.currentTime ?? 0);
      an.__demoDone = false;
      an.pause();
    }
    const elapsed = now - an.__demoStart,
      endTime = an.effect?.getComputedTiming().endTime;
    if (an.playbackRate > 0 && Number.isFinite(endTime) && elapsed >= endTime) {
      an.finish();
      an.__demoDone = true;
    } else {
      an.currentTime = elapsed;
    }
  }
}

export const ease = k => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);
