// The book's undo keys: ⌘Z (Ctrl+Z) takes back the book's last step while it's open and nothing being typed into has
// the keys; with Shift (or Ctrl+Y) it makes the last undone again. book: { shut(), pages() } (book.js)
export function undoKeys(book) {
  addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !(key === 'z' || (key === 'y' && e.ctrlKey && !e.shiftKey))) return;
    if (book.shut() || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    if (e.shiftKey || key === 'y') book.pages().redo();
    else book.pages().undo();
  });
}
