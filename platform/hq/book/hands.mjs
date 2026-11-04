// Pen and finger gestures for Notebook browser stories, the same in either engine: Chromium's own (its CDP, trusted
// events), WebKit's as Safari hands them over (Playwright's WebKit has no touch or pen of its own to play).

// The Pencil and fingers on a page (frame: one of its frames, whose own page takes them in WebKit; points are the
// page's either way). pen: down(at), move(at), up(at), stroke(points), tap(at); touch, any number of fingers at once:
// down(ats), move(tos, steps), up(), stroke(froms, tos); trackpadPinch(at, deltaY): a trackpad's pinch, a wheel with
// Ctrl and no Ctrl key down.
export async function hands(page, { frame } = {}) {
  if (page.context().browser().browserType().name() === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    return {
      pen: chromiumPen(cdp),
      touch: touchOf(cdp),
      trackpadPinch: ([x, y], deltaY) =>
        cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 2 }),
    };
  }
  const on = frame ?? page,
    box = frame ? await frame.frameElement().then(e => e.boundingBox()) : { x: 0, y: 0 },
    inside = points => points.map(([x, y]) => [x - box.x, y - box.y]),
    step = (kind, phase, points = []) => on.evaluate(safari, { kind, phase, points: inside(points) });
  // (their pointer capture, on this page and every one the context loads after)
  await page.context().addInitScript(capturable);
  await on.evaluate(capturable);
  const pen = {
    down: at => step('pen', 'down', [at]),
    move: at => step('pen', 'move', [at]),
    up: () => step('pen', 'up'),
    stroke: async points => {
      await pen.down(points[0]);
      for (const p of points.slice(1)) await pen.move(p);
      await pen.up();
    },
    tap: at => pen.stroke([at]),
  };
  return {
    pen,
    touch: fingers((phase, points) => step('touch', phase, points)),
    trackpadPinch: (at, deltaY) => on.evaluate(trackpadWheel, { at: inside([at])[0], deltaY }),
  };
}

// Chromium's own Pencil (cdp: the page's CDP session), whose events are trusted: their clicks and pointer capture are
// the browser's. Chromium only.
function chromiumPen(cdp) {
  const send = (type, [x, y], down) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: down || type === 'mouseReleased' ? 'left' : 'none',
      buttons: down ? 1 : 0,
      clickCount: 1,
      pointerType: 'pen',
      force: down ? 0.5 : 0,
    });
  const pen = {
    down: at => send('mousePressed', at, true),
    move: at => send('mouseMoved', at, true),
    up: at => send('mouseReleased', at, false),
    // down at the first point, along the rest, and up at the last
    stroke: async points => {
      await pen.down(points[0]);
      for (const p of points.slice(1)) await pen.move(p);
      await pen.up(points.at(-1));
    },
    tap: at => pen.stroke([at]),
  };
  return pen;
}
// Fingers (cdp: the page's CDP session, Chromium's trusted touch events)
const touchOf = cdp =>
  fingers((phase, at) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[phase],
      touchPoints: at.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
    }),
  );
// Fingers by send(phase, points): down at points, moved to others in steps, lifted
function fingers(send) {
  let last = [];
  const t = {
    down: async at => {
      last = at;
      await send('down', at);
    },
    move: async (to, steps = 12) => {
      const from = last;
      for (let i = 1; i <= steps; i++)
        await send(
          'move',
          from.map(([x, y], k) => [x + ((to[k][0] - x) * i) / steps, y + ((to[k][1] - y) * i) / steps]),
        );
      last = to;
    },
    up: () => send('up', []),
    stroke: async (from, to) => {
      await t.down(from);
      await t.move(to);
      await t.up();
    },
  };
  return t;
}

// (in the page) One step of Safari's Pencil (kind 'pen') or fingers ('touch'): down at points, moved to them, or up.
// Each pointer's events go to what captured it (capturable), else to what was under its press, inside review mode's
// shadow root too; then the step's touch event, as Safari sends one for the Pencil too (a 'stylus' touch). Let go, a
// pointer's capture is lost. One pointer let go where it came down is a tap: it clicks what it pressed, unless the page
// took its touch (its start, end or a move prevented).
function safari({ kind, phase, points }) {
  const TAP_PX = 10;
  const deepest = ([x, y]) => {
    let under = document.elementFromPoint(x, y) ?? document.body;
    for (let inner; (inner = under.shadowRoot?.elementFromPoint(x, y)) && inner !== under;) under = inner;
    return under;
  };
  const all = (window.__safari ??= {}),
    held = phase === 'down' ? (all[kind] = []) : (all[kind] ?? []);
  if (phase === 'down')
    for (const at of points)
      held.push({ id: (kind === 'pen' ? 7 : 11) + held.length, kind, under: deepest(at), from: at, at, taken: false });
  else if (phase === 'move') held.forEach((p, i) => (p.at = points[i]));
  const [type, touchType] = {
    down: ['pointerdown', 'touchstart'],
    move: ['pointermove', 'touchmove'],
    up: ['pointerup', 'touchend'],
  }[phase];
  for (const p of held)
    (p.captured ?? p.under).dispatchEvent(
      new PointerEvent(type, {
        ...{ pointerId: p.id, pointerType: kind, isPrimary: p === held[0], clientX: p.at[0], clientY: p.at[1] },
        ...{ pressure: phase === 'up' ? 0 : 0.5, button: phase === 'move' ? -1 : 0, buttons: phase === 'up' ? 0 : 1 },
        ...{ bubbles: true, composed: true, cancelable: true },
      }),
    );
  const touches = held.map(p => ({
    ...{ identifier: p.id, target: p.under, clientX: p.at[0], clientY: p.at[1] },
    ...{ pageX: p.at[0] + scrollX, pageY: p.at[1] + scrollY, touchType: kind === 'pen' ? 'stylus' : 'direct' },
  }));
  const event = Object.defineProperties(new Event(touchType, { bubbles: true, composed: true, cancelable: true }), {
    ...{ touches: { value: phase === 'up' ? [] : touches }, targetTouches: { value: phase === 'up' ? [] : touches } },
    changedTouches: { value: touches },
  });
  held[0]?.under.dispatchEvent(event);
  if (event.defaultPrevented) held.forEach(p => (p.taken = true));
  if (phase !== 'up') return;
  for (const p of held) p.captured?.releasePointerCapture(p.id);
  all[kind] = [];
  const [p] = held;
  if (held.length === 1 && !p.taken && Math.hypot(p.at[0] - p.from[0], p.at[1] - p.from[1]) <= TAP_PX)
    p.under.dispatchEvent(
      new MouseEvent('click', { clientX: p.at[0], clientY: p.at[1], bubbles: true, composed: true, cancelable: true }),
    );
}
// (in the page) Pointer capture for safari's pointers, as Safari gives a real one's: the browser's own throws for a
// made-up pointer, so a press that captures would end there. Others' as the browser has it.
function capturable() {
  if (window.__capturable) return;
  window.__capturable = true;
  const own = id =>
    Object.values(window.__safari ?? {})
      .flatMap(held => held)
      .find(p => p.id === id);
  const { setPointerCapture, releasePointerCapture, hasPointerCapture } = Element.prototype;
  const tell = (p, type) =>
    p.captured?.dispatchEvent(new PointerEvent(type, { pointerId: p.id, pointerType: p.kind, bubbles: true }));
  Object.assign(Element.prototype, {
    setPointerCapture(id) {
      const p = own(id);
      if (!p) return setPointerCapture.call(this, id);
      if (p.captured === this) return;
      tell(p, 'lostpointercapture');
      p.captured = this;
      tell(p, 'gotpointercapture');
    },
    releasePointerCapture(id) {
      const p = own(id);
      if (!p) return releasePointerCapture.call(this, id);
      if (p.captured !== this) return;
      tell(p, 'lostpointercapture');
      p.captured = null;
    },
    hasPointerCapture(id) {
      const p = own(id);
      return p ? p.captured === this : hasPointerCapture.call(this, id);
    },
  });
}
// (in the page) A trackpad's pinch at a point, as Safari hands it over: a wheel with Ctrl on what's there
function trackpadWheel({ at: [x, y], deltaY }) {
  (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
    new WheelEvent('wheel', {
      ...{ clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode: 0, ctrlKey: true },
      ...{ bubbles: true, composed: true, cancelable: true },
    }),
  );
}

// A pen or a finger's line and hold, and a two fingers' pan, for a story in either engine, played by hands(): hold(type,
// from) a held pointer's moves and lift, stroke(type, points) one pressed along points, pan(points): fingers at points
// moved up 70 px together.
export async function inputs(page) {
  const { pen, touch } = await hands(page);
  const finger = {
    down: point => touch.down([point]),
    move: point => touch.move([point]),
    up: () => touch.up(),
  };
  const hold = async (type, from) => {
    const pointer = type === 'pen' ? pen : finger;
    await pointer.down(from);
    return pointer;
  };
  return {
    hold,
    stroke: async (type, points) => {
      const pointer = await hold(type, points[0]);
      for (const point of points.slice(1)) await pointer.move(point);
      await pointer.up(points.at(-1));
    },
    pan: points =>
      touch.stroke(
        points,
        points.map(([x, y]) => [x, y - 70]),
      ),
  };
}

// Two fingers tapped together on the page, as Safari hands them over: Linux's headless WebKit has no Touch to make, so
// a touch event's lists filled as Safari fills them
export async function twoFingerTap(page) {
  await page.evaluate(() => {
    const t = (id, x) => ({ identifier: id, target: document.body, clientX: x, clientY: 600 });
    const fire = (type, touches, changed) =>
      document.body.dispatchEvent(
        Object.defineProperties(new Event(type, { bubbles: true, composed: true }), {
          touches: { value: touches },
          changedTouches: { value: changed },
        }),
      );
    const two = [t(1, 300), t(2, 400)];
    fire('touchstart', two, two);
    fire('touchend', [], two);
  });
}
