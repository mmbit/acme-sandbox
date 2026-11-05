// An error or a done on a tool's own line (the intercom's, a card's, a call's) as the design system's alert part: its
// sign, then what happened. Each look draws it its own way (style.css, controls.css, a look's kit). A line's plain words
// (Sending…) replace it, and an empty line has none.
import { esc } from '../util.js';
import { icon } from './icons.js';

export const SIGNS = { problem: icon('alert'), done: icon('tick') };
export const alertHtml = (html, kind = 'problem') =>
  `<span class="alert ${kind}" role="${kind === 'problem' ? 'alert' : 'status'}"><span class="sign">${SIGNS[kind]}</span><span class="words">${html}</span></span>`;
export function tell(line, words, kind = 'problem') {
  if (line) line.innerHTML = words ? alertHtml(esc(words), kind) : '';
}
