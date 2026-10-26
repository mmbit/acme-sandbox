// The screenshot's copy of the page (snapshot.js): every visible element with its computed style inlined, fixed and
// sticky boxes pinned where they are on screen, scrolled boxes held at their scroll.
import { inTopLayer } from './layer.js';
import { drawnFrame, inline, inlineUrls } from './snapshot.js';
import { edgeChild, passes, pixels, through, pseudo, copyText } from './flow.js';
import { faceOf } from './faces.js';

// (a dialog or popover in the top layer is copied over it all, after the rest: its v.popup.)
const SKIP = /^(script|noscript|template|style|link|meta|title|base|head|iframe|object|embed|audio|source|track)$/;
export function copy(r, node, waits, v) {
  if (
    node.nodeType !== 1 ||
    node === r.host ||
    SKIP.test(node.localName) ||
    (node !== v.popup && r.popups.includes(node) && inTopLayer(node))
  )
    return null;
  const cs = getComputedStyle(node);
  if (cs.display === 'none') return null;
  const tag = node.localName,
    b = node.getBoundingClientRect();
  // a fixed box (a chat's 0×0 custom element at the page's end) says nothing about where its fixed contents are
  const off = cs.position !== 'fixed' && (b.bottom < -50 || b.top > v.H + 50 || b.right < -50 || b.left > v.W + 50);
  if (node instanceof SVGElement && tag !== 'svg') return node.cloneNode(true);
  let out;
  if (tag === 'canvas') {
    out = document.createElement('img');
    try {
      out.src = node.toDataURL();
    } catch {
      /* tainted */
    }
  } else if (tag === 'video') {
    // its frame as it is (paused under a note), else its poster.
    out = document.createElement('img');
    // (a frame that can't be copied leaves the box empty: the poster would pass for the moment)
    if (node.readyState >= 2) {
      const frame = drawnFrame(node);
      if (frame) out.src = frame;
    } else if (node.poster)
      waits.push(
        inline(node.poster).then(u => {
          if (u) out.src = u;
        }),
      );
  } else if (tag === 'svg') out = paintedSvg(node, off);
  else out = node.cloneNode(false);
  out.removeAttribute?.('id');
  out.removeAttribute?.('srcset');
  out.removeAttribute?.('loading');
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
  const pinned = cs.position === 'fixed' || (cs.position === 'sticky' && !v.scroller),
    lift = pinned && v.clear && v.cut;
  const room = pinned && cs.position === 'sticky' && document.createElement('div');
  if (room) room.setAttribute('style', `${s}visibility:hidden;`);
  const x = b.left + v.sx,
    y = b.top + v.sy;
  const inner = { x: x + parseFloat(cs.borderLeftWidth), y: y + parseFloat(cs.borderTopWidth) };
  if (pinned) {
    const at = lift ? v.top : v.cb;
    s += `position:absolute;left:${x - at.x}px;top:${y - at.y}px;right:auto;bottom:auto;margin:0;transform:none;`;
    // (fixed and sticky boxes always stack what's in them on their own, an absolute one only with a z-index: so a
    // child's z-index stays inside it, as on screen, and doesn't climb over a later box.)
    if (cs.zIndex === 'auto') s += 'isolation:isolate;';
    if (lift) v.top.kids.push(out);
  }
  // holds: a fixed box inside is positioned and painted in it; paints: its own stacking or compositing
  const willChange = cs.willChange || 'auto',
    contentVisibility = cs.contentVisibility || 'visible';
  const holds =
    cs.transform !== 'none' ||
    cs.filter !== 'none' ||
    cs.perspective !== 'none' ||
    (cs.backdropFilter || 'none') !== 'none' ||
    /layout|paint|strict|content/.test(cs.contain) ||
    /transform|perspective|filter/.test(willChange) ||
    contentVisibility !== 'visible';
  const composites =
    parseFloat(cs.opacity) < 1 ||
    cs.isolation === 'isolate' ||
    cs.mixBlendMode !== 'normal' ||
    cs.clipPath !== 'none' ||
    (cs.maskImage || cs.webkitMaskImage || 'none') !== 'none';
  const paints = composites || cs.zIndex !== 'auto' || /opacity/.test(willChange);
  const face = faceOf(r, node, cs, v, clips, composites);
  if (face.away) s += 'visibility:hidden;';
  // An absolute copy is cut by the overflow of the box it's positioned in and of every ancestor of that box. The
  // first box that cuts what's inside it, itself uncut, takes what's lifted out of it right after it.
  const positions = pinned || holds || cs.position !== 'static';
  const uncut = pinned ? lift || !v.cut : !v.cut && !v.cuts,
    first = clips && uncut;
  const lifted = first && !lift && { x: v.cb.x, y: v.cb.y, kids: [] };
  // A box scrolled on screen holds what's inside in one box, moved by the scroll (the copy doesn't scroll)
  const scroll = scrolls &&
    tag !== 'textarea' &&
    /block|flow-root|flex|grid|list-item/.test(cs.display) && { x: node.scrollLeft, y: node.scrollTop };
  const held = (scroll.x || scroll.y) && scrollHolder(node, cs, scroll, positions);
  if (held) s += held.boxStyle;
  const at = held ? { x: inner.x - scroll.x, y: inner.y - scroll.y } : inner;
  v = {
    ...v,
    top: lifted || v.top,
    cb: positions ? at : v.cb,
    clear: (first || v.clear) && !paints && !holds,
    cut: pinned ? clips || (!lift && v.cut) : v.cut || (positions && (v.cuts || clips)),
    cuts: !positions && (v.cuts || clips),
    scroller: v.scroller || scrolls,
    context3d: face.context3d,
    preserved: face.preserves,
    turnedAway: face.away,
  };
  out.setAttribute('style', s);
  if (tag === 'img') {
    out.removeAttribute('src');
    const src = node.currentSrc || node.src;
    if (src)
      waits.push(
        inline(src).then(u => {
          if (u) out.setAttribute('src', u);
        }),
      );
  }
  if (tag === 'input') {
    if (node.type === 'checkbox' || node.type === 'radio') out.toggleAttribute('checked', node.checked);
    else if (node.type !== 'password') out.setAttribute('value', node.value);
  }
  if (tag === 'option' && node.selected) out.setAttribute('selected', '');
  if (background.image.includes('url('))
    waits.push(
      inlineUrls(background.image, location.href).then(b => {
        out.style.backgroundImage = b;
      }),
    );
  // off screen: keep the box (it holds the layout) but skip what's inside
  if (tag === 'textarea') out.textContent = node.value;
  else if (tag !== 'svg' && tag !== 'canvas' && tag !== 'video' && (!off || tag === 'html' || tag === 'body')) {
    const box = !v.scroller && contentBox(b, cs);
    const before = pseudo(node, '::before', waits, box, v),
      after = pseudo(node, '::after', waits, box, v);
    // a face turned away hides what it paints too
    if (face.away) {
      for (const p of [before, after]) {
        if (p) p.style.visibility = 'hidden';
      }
    }
    const into = held ? held.holder : out,
      wraps = cs.whiteSpace === 'normal';
    if (before) into.append(before);
    for (const c of (node.shadowRoot || node).childNodes) {
      const k = c.nodeType === 3 ? copyText(c, wraps) : copy(r, c, waits, v);
      if (k) into.append(k);
    }
    if (after) into.append(after);
    if (held) out.append(held.holder);
  }
  const parts = [room, !lift && out, ...(lifted ? lifted.kids : [])].filter(Boolean);
  if (parts.length < 2) return parts[0] || null;
  const all = document.createDocumentFragment();
  all.append(...parts);
  return all;
}
// An inline SVG copied whole, its shapes painted as the page's style sheets paint them on screen
const PAINT = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'paint-order',
  'opacity',
  'display',
  'visibility',
  'transform',
  'transform-origin',
  'transform-box',
  'color',
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'mix-blend-mode',
];
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
    const from = document.body && bare(cs) ? getComputedStyle(document.body) : cs;
    const moved = from === cs ? '' : BACKGROUND.map(p => `${p}:${from.getPropertyValue(p)};`).join('');
    return { style: `isolation:isolate;${moved}`, image: from.backgroundImage };
  }
  if (tag === 'body' && bare(getComputedStyle(document.documentElement)))
    return { style: 'background:none;', image: 'none' };
  return { style: '', image: cs.backgroundImage };
}
const BACKGROUND = [
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  'background-attachment',
  'background-origin',
  'background-clip',
];
const bare = cs => cs.backgroundImage === 'none' && /^(transparent|rgba\(.*,\s*0\))$/.test(cs.backgroundColor);
// A scrolled box's contents go in one box in the copy, moved by the scroll and laid out as the scrolled box lays
// them out, its padding included. The scrolled box keeps its size on screen. The holder moves by top and left when the
// scrolled box positions what's inside, so that moves with it, else by its margins, so it positions nothing itself.
// A sticky box in it sticks to the scrolled box's copy, which doesn't scroll, so the holder spans all it scrolls
// down, as the browser's sticky box sees it, rather than its size on screen, and across too only when a sticky box
// sticks to a side, since that widens the boxes in the flow
const LAYOUT = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'align-content',
  'justify-content',
  'justify-items',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
];
function scrollHolder(node, cs, scroll, positions) {
  const around = (a, b) =>
    cs.boxSizing === 'border-box'
      ? 0
      : pixels(cs, `padding-${a}`) +
        pixels(cs, `padding-${b}`) +
        pixels(cs, `border-${a}-width`) +
        pixels(cs, `border-${b}-width`);
  const boxStyle =
    `display:${cs.display.startsWith('inline') ? 'inline-block' : 'flow-root'};box-sizing:border-box;padding:0;flex:none;` +
    `width:${pixels(cs, 'width') + around('left', 'right')}px;height:${pixels(cs, 'height') + around('top', 'bottom')}px;` +
    'min-width:0;min-height:0;max-width:none;max-height:none;';
  const sticky = [...(node.shadowRoot || node).children]
    .map(kid => getComputedStyle(kid))
    .concat([getComputedStyle(node, '::before'), getComputedStyle(node, '::after')])
    .filter(style => style.position === 'sticky');
  const sideways = sticky.some(style => style.left !== 'auto' || style.right !== 'auto');
  const size = `width:${sideways ? `${node.scrollWidth}px` : '100%'};height:${sticky.length ? `${node.scrollHeight}px` : '100%'};`;
  let s = `display:${/flex|grid/.exec(cs.display)?.[0] || 'flow-root'};box-sizing:border-box;${size}`;
  for (const p of LAYOUT) s += `${p}:${cs.getPropertyValue(p)};`;
  s += positions
    ? `position:relative;left:${-scroll.x}px;top:${-scroll.y}px;`
    : `margin:${-scroll.y}px 0 0 ${-scroll.x}px;`;
  const holder = document.createElement('div');
  holder.setAttribute('style', s);
  return { boxStyle, holder };
}
// Where a box's content box is on screen
const contentBox = (b, cs) => ({
  top: b.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
  right: b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
  bottom: b.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
  left: b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
});
