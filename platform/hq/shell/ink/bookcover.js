// HQ's page under the book's spread: book.js covers it as the book lays out as the spread, and uncovers it otherwise
// (bookguest.js's shelf too). Split out of book.js.

// The spread covers HQ's page, not its top layer opened before or after it (a small call, its cards, a modal: one
// left under the cover would leave nothing to tap).
let covering = null;
export function coverPage(covered) {
  if (covering === null) addEventListener('beforetoggle', uncover, true);
  covering = covered;
  for (const el of document.body.children) el.inert = covered && !el.matches(':popover-open, :modal');
}
function uncover(e) {
  if (covering && e.target.parentNode === document.body) e.target.inert = e.newState !== 'open';
}
