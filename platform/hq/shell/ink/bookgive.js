// A copy of the board's page given to a guest, in their own notebook to carry on with (notebookgive.ts): Give a copy…
// in the dots menu opens a card beside them with everyone invited somewhere, and Someone new, by name and address as
// Share takes them. Given, the card says whose notebook has it and shares their one link (the iPad's share sheet, else
// copied). A tap away or Escape closes it. Its look: bookgive.css.
import { esc, stylesheet } from '../../util.js';
import { icon } from '../icons.js';
import { share } from '../share.js';
import { toast } from '../toast.js';
import { beside, button, island, moreKey } from './bookui.js';
import { word } from './bookscope.js';
import { givePage, loadPeople } from './notebookdata.js';

// book: bookpages.js's. Returns follow(far, page): the row shows on a page, not over the overview
export function giveKey(book) {
  stylesheet('shell/ink/bookgive.css');
  const key = button({ icon: icon('person'), label: word('givePage'), onClick: () => opened(book) });
  island('menu').append(key);
  return (far, page) => {
    key.hidden = far || !page;
  };
}

let shown = null;
async function opened(book) {
  shown?.close();
  const page = book.views[book.cur]?.page;
  if (!page) return;
  let people;
  try {
    people = (await loadPeople(book.dev)).everyone;
  } catch (e) {
    return toast(esc(e.message));
  }
  const card = Object.assign(document.createElement('div'), { className: 'bk-card bk-menu bk-give' });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', word('giveTitle'));
  card.innerHTML = choiceHtml(people);
  const away = e => {
    if (e.type === 'keydown' ? e.key === 'Escape' : !card.contains(e.target)) close();
  };
  const close = () => {
    card.remove();
    shown = null;
    removeEventListener('pointerdown', away, true);
    removeEventListener('keydown', away, true);
  };
  shown = { close };
  card.addEventListener('click', e => {
    const row = e.target.closest('[data-to]');
    if (row) give(book, card, page, { to: row.dataset.to });
    else if (e.target.closest('[data-done]')) close();
  });
  card.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const { name, email } = e.target.elements;
    give(book, card, page, { person: { name: name.value.trim(), email: email.value.trim() } });
  });
  beside(card, moreKey());
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', away, true);
}

// Everyone invited, then Someone new: their name and address
const choiceHtml = people =>
  `<p class="bk-give-head">${word('giveTitle')}</p><p class="bk-give-note">${word('giveNote')}</p>${people
    .map(p => `<button type="button" data-to="${esc(p.to)}">${icon('person')}<span>${esc(p.name)}</span></button>`)
    .join('')}<hr><form novalidate><p class="bk-give-head">${word('giveNew')}</p><input name="name" autocomplete="off"
    placeholder="${esc(word('giveName'))}" aria-label="${esc(word('giveName'))}"><input name="email" type="email"
    inputmode="email" autocomplete="off" placeholder="${esc(word('giveEmail'))}" aria-label="${esc(
      word('giveEmail'),
    )}"><button type="submit">${word('give')}</button></form><p class="bk-give-said" role="status"></p>`;

// The copy given (to: someone invited, or person: someone new); a refusal said under the form
async function give(book, card, page, whom) {
  if (card.inert) return;
  card.inert = true;
  try {
    const given = await givePage(book.dev, page.id, whom);
    card.innerHTML = `<p class="bk-give-note">${esc(word('givenCopy', { name: given.name }))}</p><button type="button"
      data-link>${icon('share')}<span>${word('giveLink')}</span></button><button type="button" data-done><span>${word(
        'done',
      )}</span></button><p class="bk-give-said" role="status"></p>`;
    const said = card.querySelector('.bk-give-said');
    card.querySelector('[data-link]').addEventListener('click', () => share({ url: given.link }, said));
  } catch (e) {
    card.querySelector('.bk-give-said').textContent = e.message;
  }
  card.inert = false;
}
