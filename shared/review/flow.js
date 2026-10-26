// How the copy keeps the page's flow (copy.js): margins that collapse through a box's ends, ::before and ::after with
// their sticky places, and text that stays on one line.
import { inlineUrls } from './snapshot.js';

// A length in a computed style, in px
export const pixels = (style, property) => parseFloat(style.getPropertyValue(property)) || 0;
// Whether a box lets the margin of its first (top) or last (bottom) child through that end
export const passes = (node, cs, end) =>
  /^(block|list-item)$/.test(cs.display) &&
  !flexOrGridItem(node) &&
  /^(static|relative)$/.test(cs.position) &&
  cs.float === 'none' &&
  cs.overflowX === 'visible' &&
  cs.overflowY === 'visible' &&
  !pixels(cs, `padding-${end}`) &&
  !pixels(cs, `border-${end}-width`) &&
  (end === 'top' || (String(node.computedStyleMap?.().get('height')) === 'auto' && !pixels(cs, 'min-height')));
// A flex or grid item is blockified, but its children's margins stay inside it
function flexOrGridItem(node) {
  const parent = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement;
  return !!parent && /flex|grid/.test(getComputedStyle(parent).display);
}
// A box's margin at one end, together with the margins its children let through it there: the largest one, less the
// most negative one, as margins collapse
export function through(node, cs, end) {
  const margins = [];
  let box = node,
    style = cs;
  while (box) {
    margins.push(parseFloat(style.getPropertyValue(`margin-${end}`)) || 0);
    box = passes(box, style, end) ? edgeChild(box, end) : null;
    style = box && getComputedStyle(box);
  }
  return collapse(...margins);
}
const collapse = (...margins) => Math.max(0, ...margins) + Math.min(0, ...margins);
// A box's first or last child in the flow, if it's a block: text or an inline box there ends the margins' way
export function edgeChild(node, end) {
  const kids = [...(node.shadowRoot || node).childNodes];
  if (end === 'bottom') kids.reverse();
  for (const kid of kids) {
    if (kid.nodeType === 3 && kid.data.trim()) return null;
    if (kid.nodeType !== 1) continue;
    const style = getComputedStyle(kid);
    if (
      style.display === 'none' ||
      style.position === 'absolute' ||
      style.position === 'fixed' ||
      style.float !== 'none'
    )
      continue;
    return /^(block|list-item|flow-root|flex|grid|table)$/.test(style.display) ? kid : null;
  }
  return null;
}
export function pseudo(node, which, waits, box, v) {
  const ps = getComputedStyle(node, which),
    c = ps.content;
  if (!c || c === 'none' || c === 'normal') return null;
  const span = document.createElement('span');
  let s = '';
  for (let i = 0; i < ps.length; i++) s += `${ps[i]}:${ps.getPropertyValue(ps[i])};`;
  // A sticky one can't be measured, and sticky means nothing in the copy: it keeps its place in the flow, moved to
  // where it sticks on screen
  if (ps.position === 'sticky' && box) s += stuck(node, ps, which === '::before', box, v);
  span.setAttribute('style', s + 'animation:none;transition:none;');
  // its picture inlined too, like an element's
  if (ps.backgroundImage.includes('url('))
    waits.push(
      inlineUrls(ps.backgroundImage, location.href).then(b => {
        span.style.backgroundImage = b;
      }),
    );
  const m = c.match(/^"(.*)"$/s);
  if (m)
    span.textContent = m[1].replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, e) =>
      /^[0-9a-f]/i.test(e) && e.length > 1 ? String.fromCodePoint(parseInt(e, 16)) : e,
    );
  return span;
}
// How far a sticky ::before or ::after sits from where it would be unstuck: a ::before at the start of its parent's
// content box, an ::after under what's in that box, at its left. As in the browser, it sticks to the viewport by its
// insets and its margin box stays in that content box
function stuck(node, ps, first, box, v) {
  const along = (start, end, size, view, flow) => {
    const from = box[start] + pixels(ps, `margin-${start}`),
      to = box[end] - pixels(ps, `margin-${end}`) - size;
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
      const range = document.createRange();
      range.selectNodeContents(kid);
      const lines = range.getClientRects();
      if (lines.length) return lineEnd(lines[lines.length - 1], getComputedStyle(node)) + own;
    }
    if (kid.nodeType !== 1) continue;
    const style = getComputedStyle(kid);
    if (
      style.display === 'none' ||
      style.position === 'absolute' ||
      style.position === 'fixed' ||
      style.float !== 'none'
    )
      continue;
    const rect = kid.getBoundingClientRect(),
      relativeTop = style.position === 'relative' ? pixels(style, 'top') : 0;
    if (style.display === 'inline') return lineEnd(rect, style) - relativeTop + own;
    return rect.bottom - relativeTop + collapse(through(kid, style, 'bottom'), own);
  }
  return box.top + own;
}
// Text on one line on screen stays on one line: the copy keeps each box's width, and a browser can draw the copy's
// text a hair wider (Firefox does), which would wrap a button's label out of its button. The spaces around it stay
// outside, so the line can still break there as it does on screen
export function copyText(node, wraps) {
  const [, before, words, after] = /^(\s*)(.*?)(\s*)$/s.exec(node.data);
  if (!wraps || !words) return document.createTextNode(node.data);
  const range = document.createRange();
  range.setStart(node, before.length);
  range.setEnd(node, before.length + words.length);
  const lines = new Set([...range.getClientRects()].map(line => Math.round(line.top)));
  if (lines.size !== 1) return document.createTextNode(node.data);
  const line = document.createElement('span');
  line.setAttribute('style', 'white-space:nowrap');
  line.textContent = words;
  const all = document.createDocumentFragment();
  all.append(before, line, after);
  return all;
}
