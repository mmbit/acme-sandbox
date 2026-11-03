// Pen and finger gestures for Notebook browser stories, including a pointer held across awaits.
import { chromiumPen, touchOf, pressAlong } from './kit.mjs';

export async function inputs(browser, page) {
  const chromium = browser.browserType().name() === 'chromium';
  const cdp = chromium ? await page.context().newCDPSession(page) : null;
  const pen = cdp && chromiumPen(cdp),
    touch = cdp && touchOf(cdp);
  const finger = touch && {
    down: point => touch.down([point]),
    move: point => touch.move([point]),
    up: () => touch.up(),
  };
  const hold = async (type, from) => {
    if (!cdp) {
      const held = await pressAlong(page, [from], { type, lift: false });
      return { move: point => held.along([point]), up: () => held.up() };
    }
    const pointer = type === 'pen' ? pen : finger;
    await pointer.down(from);
    return pointer;
  };
  return {
    hold,
    stroke: async (type, points) => {
      if (!cdp) return pressAlong(page, points, { type });
      const pointer = await hold(type, points[0]);
      for (const point of points.slice(1)) await pointer.move(point);
      await pointer.up(points.at(-1));
    },
    pan: points =>
      cdp
        ? touch.stroke(
            points,
            points.map(([x, y]) => [x, y - 70]),
          )
        : panOnPage(page, points),
  };
}

function panOnPage(page, points) {
  return page.evaluate(points => {
    const target = document.elementFromPoint(...points[0]);
    for (const kind of ['pointerdown', 'pointermove', 'pointerup'])
      points.forEach(([x, y], i) =>
        target.dispatchEvent(
          new PointerEvent(kind, {
            pointerType: 'touch',
            pointerId: 30 + i,
            isPrimary: i === 0,
            bubbles: true,
            clientX: x,
            clientY: y - (kind === 'pointerdown' ? 0 : 70),
            buttons: kind === 'pointerup' ? 0 : 1,
          }),
        ),
      );
  }, points);
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
