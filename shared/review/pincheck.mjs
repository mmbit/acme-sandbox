// The pin carried and let go (dock.js), as HQ's book-check (bookpin.mjs) and review mode's check on a preview
// (check.mjs) see it. Let go, it stays exactly where it was dropped, frame after frame until any transition would have
// ended: nothing sliding in from the bottom or the side. Held, it's the same button lifted: its size and its darker
// base as at rest, a grab hand over it and a closed one while it's carried.

// Where the dock sits each frame from now, through letGo() and for ms after: { ok, why }
export async function dropped(frame, letGo, ms = 700) {
  await frame.evaluate(async ms => {
    // (a touch's last move lands at the next frame: it's held where it settles)
    await new Promise(next => requestAnimationFrame(() => requestAnimationFrame(next)));
    const dock = document.querySelector('review-mode').shadowRoot.querySelector('.dock'),
      seen = (window.__pinSeen = []),
      start = performance.now();
    (function look() {
      const b = dock.getBoundingClientRect();
      seen.push([Math.round(b.left), Math.round(b.top)]);
      if (performance.now() - start < ms) requestAnimationFrame(look);
    })();
  }, ms);
  await letGo();
  await frame.waitForTimeout(ms + 100);
  const seen = await frame.evaluate(() => window.__pinSeen),
    [held] = seen,
    off = seen.find(([x, y]) => Math.abs(x - held[0]) > 1 || Math.abs(y - held[1]) > 1);
  return off
    ? { ok: false, why: `let go at ${held}, it went by ${off} (${seen.length} frames: ${seen.join(' ')})` }
    : { ok: true, why: `let go at ${held}, it stayed there for ${seen.length} frames` };
}

// The pin pressed with a mouse, carried by (dx, dy) and let go: what's wrong, or nothing
export async function carried(page, [dx, dy]) {
  const look = () =>
    page.evaluate(() => {
      const dock = document.querySelector('review-mode').shadowRoot.querySelector('.dock'),
        fab = dock.querySelector('.fab'),
        b = fab.getBoundingClientRect(),
        css = getComputedStyle(fab);
      return {
        x: b.x + b.width / 2,
        y: b.y + b.height / 2,
        size: [Math.round(b.width), Math.round(b.height)],
        laid: [fab.offsetWidth, fab.offsetHeight], // (its size before any transform: at rest it bobs and tilts)
        base: css.boxShadow.split(/,(?![^(]*\))/)[0].trim(), // the hard shadow under its face: the button's depth
        cursor: css.cursor,
        carried: dock.classList.contains('drag'),
      };
    });
  const wrong = [],
    rest = await look();
  if (rest.cursor !== 'grab') wrong.push(`over the pin the cursor is ${rest.cursor}, not a grab hand`);
  await page.mouse.move(rest.x, rest.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(rest.x + (dx * i) / 8, rest.y + (dy * i) / 8);
  await page.waitForTimeout(400); // (past the press's own .25 s)
  const held = await look();
  if (!held.carried) wrong.push('the pin didn’t follow the mouse');
  if (held.size.join() !== held.laid.join()) wrong.push(`carried it's ${held.size} px, grown from ${held.laid}`);
  if (held.base !== rest.base) wrong.push(`carried, its base is ${held.base}, at rest ${rest.base}`);
  if (held.cursor !== 'grabbing') wrong.push(`carried, the cursor is ${held.cursor}, not a closed hand`);
  const landed = await dropped(page.mainFrame(), () => page.mouse.up());
  if (!landed.ok) wrong.push(landed.why);
  return wrong;
}
