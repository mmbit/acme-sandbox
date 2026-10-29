// Notebook portraits come from the host's renderer when it has one, or the answer uses initials.
let renderer = null;
const portraits = new Map();
export const useFaces = source => {
  renderer = source;
};
export function portrait(id) {
  if (!renderer) return '';
  const key = `${renderer.look()}:${id}`;
  if (!portraits.has(key)) {
    const drawn = renderer.draw(id);
    if (!drawn) return '';
    portraits.set(key, drawn.img.toDataURL());
  }
  return portraits.get(key);
}
export const faced = id => (portrait(id) ? renderer.look() : '');
