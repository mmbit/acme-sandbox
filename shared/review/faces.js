// Faces turned in 3D, for the copy (copy.js): the copy is flat, so a face whose back is turned keeps an empty box.

// The browser transforms only the boxes it can transform. The computed style of an inline box of text, a table
// column, a ruby box or a box without one still has its transform and backface-visibility, but the browser ignores
// them. An inline picture or form field is a box of its own and turns.
const UNTRANSFORMED = /^(inline|contents|table-column|table-column-group|ruby|ruby-base|ruby-text)$/;
const REPLACED = /^(img|video|canvas|svg|input|select|textarea|button|meter|progress)$/;
// Whether a face is turned away, and the 3D context the face gives the boxes inside it. The copy is flat, so it
// would draw a face turned away mirrored. It keeps an empty box instead, which holds the layout
export function faceOf(r, node, cs, v, clips, composites) {
  const transformable = !UNTRANSFORMED.test(cs.display) || REPLACED.test(node.localName);
  const willChange = cs.willChange || 'auto';
  // The 3D matrix of the face decides which side of the face the viewer sees.
  const faceTransform = faceTransformOf(r, node, cs, v.context3d);
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
  const flattens =
    clips ||
    composites ||
    /opacity|filter/.test(willChange) ||
    cs.filter !== 'none' ||
    (cs.backdropFilter || 'none') !== 'none' ||
    (cs.webkitBoxReflect || 'none') !== 'none';
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
function faceTransformOf(r, node, cs, context3d) {
  const own = transformOf(r, node, cs);
  if (!context3d) return own;
  const [x, y] = layoutAt(node),
    [hx, hy] = layoutAt(context3d.holder);
  return context3d.matrix.translate(x - hx, y - hy).multiply(own);
}
// An element's own transform, about its transform-origin: the translate, rotate and scale properties, then
// transform
function transformOf(r, node, cs) {
  const m = new DOMMatrix(),
    rotate = cs.rotate || 'none',
    scale = (cs.scale || 'none').split(' ');
  if ((cs.translate || 'none') !== 'none') {
    const size = [node.offsetWidth, node.offsetHeight, 0];
    const parts = cs.translate.match(/(?:[^\s(]|\((?:[^()]|\([^()]*\))*\))+/g);
    const lengths = parts.map((part, i) => lengthOf(r, part, size[i]));
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
  const axis = rotate.split(' '),
    angle = axis.pop();
  if (!axis.length) return `rotate(${angle})`;
  if (axis.length === 1) return `rotate${axis[0].toUpperCase()}(${angle})`;
  return `rotate3d(${axis},${angle})`;
}
// A computed length-percentage in px, a percentage of size. A calc() mixing the two stays one in the computed style:
// a margin of a box that wide in our own root resolves it
function lengthOf(r, value, size) {
  if (/^[-+\d.e]+(px)?$/.test(value)) return parseFloat(value);
  const box = document.createElement('div'),
    probe = document.createElement('div');
  box.setAttribute('style', `position:absolute;visibility:hidden;width:${size}px;padding:0;border:0`);
  probe.style.marginLeft = value;
  box.append(probe);
  r.root.append(box);
  const px = parseFloat(getComputedStyle(probe).marginLeft);
  box.remove();
  return Number.isFinite(px) ? px : 0;
}
// Where an element's border box sits in the page's layout, before transforms and after scrolling
function layoutAt(el) {
  let x = 0,
    y = 0;
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
