// Notebook portraits come from the host's renderer when it has one, or the answer uses initials.
import { esc } from '../../util.js';

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
// The agent's face as HQ's look draws them, or their initial in their ink (an answer still coming under its note:
// bookgroups.js; a try's versions: bookversions.js; the seen mark: bookassignlist.js)
export function faceHtml({ by, name }) {
  const picture = portrait(by);
  return picture
    ? `<i class="bk-answer-face" style="background-image:url(${picture})" aria-hidden="true"></i>`
    : `<i class="bk-answer-face" aria-hidden="true">${esc([...(name ?? by)][0] ?? '')}</i>`;
}
