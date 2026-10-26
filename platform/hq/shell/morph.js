// A part of the page brought up to date in place: el's children made to match html's, node by node, so what's the same
// stays put (a running animation, a picture, a hover, focus, a scroll) and only what changed is touched. A node that
// can't match (another tag, another icon) is replaced. keep(node): an element whose children something else fills in
// after it's drawn (an icon, a log that loads), left as it is.
const icon = node => node.matches('svg[data-icon]');

export function morph(el, html, keep = () => false) {
  const next = document.createElement('template');
  next.innerHTML = html;
  patch(el, next.content, keep);
}

function patch(el, next, keep) {
  const want = [...next.childNodes];
  want.forEach((node, i) => {
    const have = el.childNodes[i];
    if (!have) el.append(node);
    else if (!alike(have, node)) have.replaceWith(node);
    else if (node.nodeType !== Node.ELEMENT_NODE) {
      if (have.nodeValue !== node.nodeValue) have.nodeValue = node.nodeValue;
    } else if (!icon(have)) {
      attributes(have, node);
      if (!keep(have)) patch(have, node, keep);
    }
  });
  while (el.childNodes.length > want.length) el.lastChild.remove();
}
// the same kind of node, and for an icon the same one
const alike = (a, b) =>
  a.nodeType === b.nodeType &&
  a.nodeName === b.nodeName &&
  (a.nodeType !== Node.ELEMENT_NODE || a.getAttribute('data-icon') === b.getAttribute('data-icon'));

function attributes(have, want) {
  for (const { name } of [...have.attributes]) if (!want.hasAttribute(name)) have.removeAttribute(name);
  for (const { name, value } of want.attributes) if (have.getAttribute(name) !== value) have.setAttribute(name, value);
}
