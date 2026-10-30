// The Shelf's and a notebook's page grid as plain numbers (bookshelf.js draws them): how many columns fit the paper and
// how wide each is, the cell under a dragged tile, a page moved in its notebook's order, and the Shelf's order. No DOM,
// so node --test reads it (bookshelfgrid.test.js).

// Columns across a width (px): as many as fit at least `least` px wide with `gap` between, at most `most`, never
// none; each as wide as shares the width out. { cols, w }
export function gridOf(width, { least, gap, most = Infinity }) {
  const cols = Math.max(1, Math.min(most, Math.floor((width + gap) / (least + gap))));
  return { cols, w: (width - gap * (cols - 1)) / cols };
}

// The cell a point (px from the grid's top-left) falls in, of n: its column and row, each cell w × h with gap between
// columns and rowGap between rows, a gap's halves going to the cells either side; a point past the last cell is the
// last.
export function slotAt(x, y, { cols, w, h, gap, rowGap = gap }, n) {
  if (n < 1) return -1;
  const col = Math.max(0, Math.min(cols - 1, Math.floor((x + gap / 2) / (w + gap)))),
    row = Math.max(0, Math.floor((y + rowGap / 2) / (h + rowGap)));
  return Math.min(n - 1, row * cols + col);
}

// A list with the item at `from` moved to `to` (both indexes in the list as it is), a new list
export function moved(list, from, to) {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

// The Shelf in its order: My journal first, then the newest first (by its last change), the name breaking a tie
export const shelfOrder = notebooks =>
  [...notebooks].sort(
    (a, b) =>
      (b.kind === 'mine') - (a.kind === 'mine') ||
      String(b.updated ?? '').localeCompare(String(a.updated ?? '')) ||
      String(a.name).localeCompare(String(b.name)),
  );
