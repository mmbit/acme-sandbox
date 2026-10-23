// A screen drawn in parts: each part, and each row of a list, is drawn again only when its own HTML changes, so a field
// being typed in, a picture that has loaded and a choice made in a select stay as they are across redraws.

const drawn = new WeakMap(); // an element → the HTML it was last drawn with

// The element [data-part=<name>] under root, drawn with html (and wire(it) run) if that changed
export function part(root, name, html, wire) {
  const box = root.querySelector(`[data-part="${name}"]`);
  if (drawn.get(box) === html) return box;
  drawn.set(box, html);
  box.innerHTML = html;
  wire?.(box);
  return box;
}

// The list [data-rows=<name>] under root, one element per item ({ key, html }) in their order: a row whose HTML is the
// same stays, a changed one is drawn again (wire(row) runs for it), and a key that wasn't there before arrives (the
// class "arrived", for its first look). → the list
export function rows(root, name, items, wire) {
  const list = root.querySelector(`[data-rows="${name}"]`);
  const old = new Map([...list.children].map(n => [n.dataset.key, n]));
  items.forEach(({ key, html }, at) => {
    let node = old.get(key);
    old.delete(key);
    if (!node || drawn.get(node) !== html) {
      const template = document.createElement('template');
      template.innerHTML = html.trim();
      const row = template.content.firstElementChild;
      row.dataset.key = key;
      if (!node) row.classList.add('arrived');
      drawn.set(row, html);
      node?.replaceWith(row);
      node = row;
      wire?.(row);
    }
    if (list.children[at] !== node) list.insertBefore(node, list.children[at] ?? null);
  });
  for (const n of old.values()) n.remove();
  return list;
}
