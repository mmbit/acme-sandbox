// HQ's page: <body>, in the room the book beside it leaves (style.css). Its width is the one HQ lays itself out in.

// Kept by one observer rather than read from the layout, as the overlay asks for it every frame. (The observer's first
// call, as it starts, changes nothing.)
let width = document.body.getBoundingClientRect().width;
const watchers = new Set();
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === width) return;
  width = entry.contentRect.width;
  watchers.forEach(watcher => watcher());
}).observe(document.body);

export const pageWidth = () => width;

// Calls `watcher` when the page changes size: as the window does, or as the book slides open or folded (every frame of
// its slide). The window's own resize stays a call too: the page's height follows --app-h, which a resize sets.
// Returns the function that stops it.
export function onPageResize(watcher) {
  watchers.add(watcher);
  addEventListener('resize', watcher);
  return () => {
    watchers.delete(watcher);
    removeEventListener('resize', watcher);
  };
}
