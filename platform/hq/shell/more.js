// The HUD's More key, for a look that folds some of its keys away (its CSS says which, under
// .tools:not(.more-open)): a press shows them, another folds them again. press: the look's sound for it. Returns the
// key's removal, for the look's dispose.
import { icon } from './icons.js';

export function moreKey(press) {
  const tools = document.querySelector('#hud .tools'),
    more = Object.assign(document.createElement('button'), { id: 'btn-more', title: 'More' });
  more.setAttribute('aria-expanded', 'false');
  more.innerHTML = `${icon('more')}<span class="sr">More</span>`;
  more.onclick = () => {
    more.setAttribute('aria-expanded', String(tools.classList.toggle('more-open')));
    press();
  };
  tools?.append(more);
  return () => {
    more.remove();
    tools?.classList.remove('more-open');
  };
}
