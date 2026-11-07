// What doesn't fit on a page, measured in its geometry rather than judged from a picture: text whose ink runs past its
// box into another element, text a clipping box cuts with no ellipsis, a line of text under another element, text or a
// control past the screen's side or put under its safe areas (inset: [top, right, bottom, left] px, a status bar and a
// home indicator, as env(safe-area-inset-*) gives them), and every text's drawn size, keyed by where it is so the same
// text compares across screens. It runs in the page:
//   const { findings, sizes } = await page.evaluate(fit, inset);
// finding: { kind: 'overflow' | 'cut' | 'covered' | 'off', of, line, box }, of naming the element; size: { key, px,
// text, box }. A box is { x, y, w, h } in the viewport's CSS px. Text hidden by design (display or visibility, opacity
// 0, inert, wholly outside a box that clips it, or under something else) is neither measured nor judged.
// eslint-disable-next-line max-lines-per-function -- page.evaluate sends one function's source: its helpers live in it
export function fit(inset = [0, 0, 0, 0]) {
  const SLACK = 1; // px a box may be off by in rounding
  const LEAST = 4; // a clipping box narrower or lower than this hides what's in it by design (a screen reader's words)
  const CONTROLS = 'button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem]';
  const styles = new Map(),
    style = el => styles.get(el) ?? styles.set(el, getComputedStyle(el)).get(el);
  const findings = [],
    sizes = [],
    pageWide = document.scrollingElement.scrollWidth > innerWidth + SLACK;

  // (everything drawn, the body's and what a page puts beside it on <html>)
  const shown = [...document.documentElement.querySelectorAll('*')].filter(
    el => el !== document.body && !document.head.contains(el) && isShown(el),
  );
  const painted = shown.filter(paints).map(el => ({ el, box: inkOrBox(el) }));
  for (const el of shown) {
    const lines = ownLines(el);
    if (lines.length) judgeText(el, lines);
    else if (el.matches(CONTROLS)) {
      const face = faceOf(el);
      if (onTop(el, face)) {
        judgeOff(el, face, describe(el));
        judgeInset(el, face, describe(el));
      }
    }
  }
  return { findings, sizes };

  // ---- the judgements
  function judgeText(el, lines) {
    const chain = clipsOf(el),
      clip = chain.reduce((c, a) => c && meet(c, a.box), { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity }),
      seen = clip ? lines.map(line => meet(line, clip)).filter(Boolean) : [];
    if (!seen.length) return; // (wholly clipped away: hidden by design)
    const what = describe(el);
    if (onTop(el, seen)) {
      judgeOverflow(el, lines, clip, what);
      judgeCut(el, lines, chain, what);
      judgeOff(el, seen, what);
      judgeInset(el, seen, what);
      judgeCovered(el, seen, what);
    }
    sizes.push({ key: keyOf(el), px: round(drawnSize(el)), text: snippet(el), box: toBox(union(seen)) });
  }

  // Ink past the element's own box (its block's, for an inline element), where nothing clips it, over another painted
  // element that is neither its ancestor nor its descendant
  function judgeOverflow(el, lines, clip, what) {
    const host = blockOf(el),
      hb = box(host.getBoundingClientRect());
    const spills = lines.flatMap(line => spillsOf(line, hb)).flatMap(s => meet(s, clip) ?? []);
    if (!spills.length) return;
    for (const other of painted) {
      if (other.el === el || other.el.contains(el) || el.contains(other.el) || host.contains(other.el)) continue;
      const hit = spills.find(s => overlap(s, other.box));
      if (!hit) continue;
      const past = Math.round(Math.max(...spills.map(s => Math.max(s.r - s.l, s.b - s.t))));
      findings.push({
        kind: 'overflow',
        of: what,
        line: `${what} runs ${past} px past its box into ${describe(other.el)}`,
        box: toBox(union([hb, ...lines, other.box])),
      });
      return;
    }
  }

  // A line partly inside and partly outside a box that clips it (not a scroller or a window onto a panned world, which
  // show the rest by scrolling or panning), where no ellipsis marks the cut: across, by any box; at its foot, only by
  // its own block with no line clamp (a panel's foot cutting its last lines is the rest of a list scrolled on)
  function judgeCut(el, lines, chain, what) {
    const host = blockOf(el);
    let left = lines; // (what the nearer boxes leave of its lines)
    for (const { el: by, box: cb, x, y, pans } of chain) {
      const across = x && !(by === host && style(host).textOverflow === 'ellipsis'),
        down = y && by === host && style(host).webkitLineClamp === 'none',
        judged = cb.r - cb.l >= LEAST && cb.b - cb.t >= LEAST && !scrolls(style(by)) && !pans;
      const cut = left.find(
        line => (across && crosses(line.l, line.r, cb.l, cb.r)) || (down && crosses(line.t, line.b, cb.t, cb.b)),
      );
      if (judged && cut) {
        const line = `${what} is cut off by ${describe(by)}`;
        findings.push({ kind: 'cut', of: what, line, box: toBox(union([cb, ...lines].map(b => clamp(b)))) });
        return;
      }
      left = left.map(line => meet(line, cb)).filter(Boolean);
    }
  }

  // A line of its words under another part of the box it's drawn on (a tile's bars laid over its last line), where the
  // rest of it shows. Under a layer from elsewhere (a sheet, the book) it's covered by design.
  function judgeCovered(el, seen, what) {
    let card = el.parentElement;
    while (card && card !== document.documentElement && !paints(card)) card = card.parentElement;
    for (const line of seen) {
      const x = (line.l + line.r) / 2,
        y = (line.t + line.b) / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || el.contains(top) || top.contains(el) || !card?.contains(top)) continue;
      let over = top.closest('svg') ?? top;
      while (!over.id && !over.classList.length && over.parentElement !== card) over = over.parentElement;
      const both = union([line, box(over.getBoundingClientRect())]);
      findings.push({
        kind: 'covered',
        of: what,
        line: `${what} runs under ${describe(over)}`,
        box: toBox(clamp(both)),
      });
      return;
    }
  }

  // Past the screen's left or right edge: anywhere the page scrolls sideways to it, or else cut by the screen's edge
  // with its middle on the screen (one past it with its middle too is tucked away by design: a tab folded at the edge,
  // a finger's target round a small handle)
  function judgeOff(el, parts, what) {
    const all = union(parts),
      left = -all.l,
      right = all.r - innerWidth,
      middle = (all.l + all.r) / 2;
    if (left <= SLACK && right <= SLACK) return;
    if (!pageWide && (middle < 0 || middle > innerWidth)) return;
    const side =
      right > left
        ? `${Math.round(right)} px past the screen's right edge`
        : `${Math.round(left)} px past its left edge`;
    findings.push({ kind: 'off', of: what, line: `${what} runs ${side}`, box: toBox(all) });
  }

  // Under one of the screen's safe areas where the page put it, not scrolled or panned there: no scroller round it (the
  // page's own either) has more of it beyond that side, and it isn't in a world the page pans.
  function judgeInset(el, parts, what) {
    if (clipsOf(el).some(clip => clip.pans)) return;
    const all = union(parts),
      [top, right, bottom, left] = inset,
      [w, h] = [innerWidth, innerHeight];
    // (each side: its band of the screen, and how far a scroller has more beyond it)
    const sides = [
      ['top', { l: 0, t: 0, r: w, b: top }, s => s.scrollTop],
      ['bottom', { l: 0, t: h - bottom, r: w, b: h }, s => s.scrollHeight - s.scrollTop - s.clientHeight],
      ['left', { l: 0, t: 0, r: left, b: h }, s => s.scrollLeft],
      ['right', { l: w - right, t: 0, r: w, b: h }, s => s.scrollWidth - s.scrollLeft - s.clientWidth],
    ];
    for (const [side, band, beyond] of sides) {
      const under = meet(all, band);
      if (!under || scrollersOf(el).some(s => beyond(s) > SLACK)) continue;
      const px = Math.round(side === 'top' || side === 'bottom' ? under.b - under.t : under.r - under.l);
      if (px <= SLACK) continue;
      findings.push({
        kind: 'off',
        of: what,
        line: `${what} runs ${px} px under the screen's ${side} safe area`,
        box: toBox(clamp(all)),
      });
      return;
    }
  }
  // The boxes that scroll round el, the page's own first
  function scrollersOf(el) {
    const scrollers = [document.scrollingElement];
    for (let up = el.parentElement; up && up !== document.documentElement; up = up.parentElement)
      if (scrolls(style(up))) scrollers.push(up);
    return scrollers;
  }

  // ---- what's on the page
  function isShown(el) {
    if (el instanceof SVGElement && el.ownerSVGElement && !(el instanceof SVGTextContentElement)) return false;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest('[inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1; // (a pixel's box: words kept for a screen reader)
  }
  // Whether el is what shows at the middle of its parts on the screen, not under something else (a book over the
  // page, a sheet over a panel)
  function onTop(el, parts) {
    const on = meet(union(parts), { l: 0, t: 0, r: innerWidth, b: innerHeight });
    if (!on) return true; // (off the screen: judged by its side alone)
    const top = document.elementFromPoint((on.l + on.r) / 2, (on.t + on.b) / 2);
    return !top || el.contains(top) || top.contains(el);
  }
  // What draws something of its own: words, a picture, a control, or a background or border
  function paints(el) {
    if (ownText(el).length || el.matches('img, svg, canvas, video, iframe, input, select, textarea, button'))
      return true;
    const s = style(el);
    return (
      s.backgroundImage !== 'none' ||
      !/rgba\(.*, 0\)|transparent/.test(s.backgroundColor) ||
      ['Top', 'Right', 'Bottom', 'Left'].some(
        side => parseFloat(s[`border${side}Width`]) > 0 && !/rgba\(.*, 0\)/.test(s[`border${side}Color`]),
      )
    );
  }
  // What a control shows: its words and pictures, or its box where it has neither (its padding and a finger's target
  // round it may lie past the screen's edge)
  function faceOf(el) {
    // (what's drawn of it: a screen reader's words, a pixel's box, aren't)
    const words = [...el.querySelectorAll('*')].filter(isShown).flatMap(ownLines),
      pictures = [...el.querySelectorAll('svg, img, canvas')].filter(isShown).map(p => box(p.getBoundingClientRect()));
    const face = [...words, ...pictures].filter(b => b.r > b.l && b.b > b.t);
    return face.length ? face : [box(el.getBoundingClientRect())];
  }
  function ownText(el) {
    return [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  }
  // Its own words' lines on screen, each as thick as its line box (a line's ink box stands taller than a tight
  // line-height, which isn't a spill; sideways in vertical writing)
  function ownLines(el) {
    const s = style(el),
      lineHeight = (parseFloat(s.lineHeight) * drawnSize(el)) / parseFloat(s.fontSize);
    return ownText(el).flatMap(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()]
        .filter(r => r.width > 0)
        .map(r => {
          if (s.writingMode.startsWith('vertical')) {
            const middle = r.left + r.width / 2,
              half = Math.min(r.width, lineHeight || r.width) / 2;
            return { l: middle - half, r: middle + half, t: r.top, b: r.bottom };
          }
          const middle = r.top + r.height / 2,
            half = Math.min(r.height, lineHeight || r.height) / 2;
          return { l: r.left, r: r.right, t: middle - half, b: middle + half };
        });
    });
  }
  function inkOrBox(el) {
    const lines = ownLines(el);
    return lines.length ? union(lines) : box(el.getBoundingClientRect());
  }
  // The box an inline element's words fit in: its nearest block's
  function blockOf(el) {
    let at = el;
    while (at.parentElement && style(at).display.startsWith('inline') && !at.matches('svg, svg *'))
      at = at.parentElement;
    return at;
  }

  // The boxes that clip el's words, nearest first: its own (a block's), then its ancestors'. A positioned element
  // escapes the clipping of the ancestors between it and its containing block.
  function clipsOf(el) {
    const own = style(el).display.startsWith('inline') ? null : clipOf(el),
      chain = own ? [own] : [];
    let position = flow(style(el).position),
      panned = false; // (a transformed layer on the way: what clips it is a window onto a world it pans and zooms)
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = style(a),
        contains = s.transform !== 'none' || s.filter !== 'none' || /paint|strict|content/.test(s.contain);
      if (position === 'fixed' && !contains) continue;
      if (position === 'absolute' && s.position === 'static' && !contains) continue;
      const clip = clipOf(a);
      if (clip) chain.push({ ...clip, pans: panned });
      panned ||= s.transform !== 'none';
      position = flow(s.position);
    }
    return chain;
  }
  // The box a clips its content to, { el, box, x, y } (x, y: whether it clips that way), or null where it doesn't: its
  // client box in screen px, scaled as its box is by a transform on the way
  function clipOf(a) {
    const s = style(a),
      x = clipsX(s),
      y = clipsY(s);
    if (!x && !y) return null;
    const r = a.getBoundingClientRect(),
      k = a.offsetWidth ? r.width / a.offsetWidth : 1,
      left = r.left + a.clientLeft * k,
      top = r.top + a.clientTop * k;
    const box = {
      l: x ? left : -Infinity,
      r: x ? left + a.clientWidth * k : Infinity,
      t: y ? top : -Infinity,
      b: y ? top + a.clientHeight * k : Infinity,
    };
    return { el: a, box, x, y };
  }
  function flow(position) {
    return position === 'absolute' || position === 'fixed' ? position : 'static';
  }
  function clipsX(s) {
    return s.overflowX !== 'visible' || /paint|strict|content/.test(s.contain);
  }
  function clipsY(s) {
    return s.overflowY !== 'visible' || /paint|strict|content/.test(s.contain);
  }
  function scrolls(s) {
    return /auto|scroll/.test(s.overflowX) || /auto|scroll/.test(s.overflowY);
  }

  // The size its words are drawn at: the font's size times every transform's scale on the way to the screen
  function drawnSize(el) {
    const px = parseFloat(style(el).fontSize);
    if (el instanceof SVGElement) {
      const m = el.getScreenCTM();
      return m ? px * Math.hypot(m.a, m.b) : px;
    }
    return el.offsetWidth ? (px * el.getBoundingClientRect().width) / el.offsetWidth : px;
  }
  // Where it is on the page, the same on every screen: tags and classes from the nearest id down, no indexes
  function keyOf(el) {
    const steps = [];
    for (let at = el; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
      if (at.id) return [`#${at.id}`, ...steps].join(' > ');
      const classes = [...at.classList].sort().map(c => `.${c}`);
      steps.unshift(`${at.tagName.toLowerCase()}${classes.join('')}`);
    }
    return steps.join(' > ');
  }
  function describe(el) {
    const tag = el.tagName.toLowerCase(),
      name = el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : '',
      words = snippet(el);
    return words ? `${tag}${name} "${words}"` : `${tag}${name}`;
  }
  function snippet(el) {
    const words = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return words.length > 40 ? `${words.slice(0, 39)}…` : words;
  }

  // ---- boxes { l, t, r, b }
  function box(r) {
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  }
  function meet(a, b) {
    const m = { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
    return m.r - m.l > 0 && m.b - m.t > 0 ? m : null;
  }
  function union(boxes) {
    return {
      l: Math.min(...boxes.map(b => b.l)),
      t: Math.min(...boxes.map(b => b.t)),
      r: Math.max(...boxes.map(b => b.r)),
      b: Math.max(...boxes.map(b => b.b)),
    };
  }
  function overlap(a, b) {
    const m = meet(a, b);
    return !!m && m.r - m.l >= SLACK && m.b - m.t >= SLACK;
  }
  // The parts of a line outside a box, each side's by more than SLACK
  function spillsOf(line, hb) {
    return [
      line.r > hb.r + SLACK && { ...line, l: Math.max(line.l, hb.r) },
      line.l < hb.l - SLACK && { ...line, r: Math.min(line.r, hb.l) },
      line.b > hb.b + SLACK && { ...line, t: Math.max(line.t, hb.b) },
      line.t < hb.t - SLACK && { ...line, b: Math.min(line.b, hb.t) },
    ].filter(Boolean);
  }
  // Whether from..to is partly inside and partly outside lo..hi
  function crosses(from, to, lo, hi) {
    const inside = to > lo && from < hi;
    return inside && (from < lo - SLACK || to > hi + SLACK);
  }
  function clamp(b) {
    return { l: Math.max(b.l, 0), t: Math.max(b.t, 0), r: Math.min(b.r, innerWidth), b: Math.min(b.b, innerHeight) };
  }
  function toBox(b) {
    return { x: Math.round(b.l), y: Math.round(b.t), w: Math.round(b.r - b.l), h: Math.round(b.b - b.t) };
  }
  function round(px) {
    return Math.round(px * 10) / 10;
  }
}
