// A snip's box round a mark's ink: the ink's area with MARGIN round it, at least SNIP_MIN, within a W × H screen and
// centred on the ink where it fits. marks.js snipOf cuts the snip by it, HQ's book aims a lifted mark's flight at the
// ink on its scrap by it (platform/hq/shell/ink/booklanding.js), and the book's lift story finds the ink on the page's
// photo by it (platform/hq/book/lift.mjs).

// the margin round the ink (the book shows the snip at its width), and the least the snip is
const MARGIN = 24;
const SNIP_MIN = { w: 240, h: 150 };

// area: the ink's { x, y, w, h } on the screen. → { x, y, w, h }
export function snipBox(area, W, H) {
  const w = Math.min(W, Math.max(SNIP_MIN.w, area.w + 2 * MARGIN)),
    h = Math.min(H, Math.max(SNIP_MIN.h, area.h + 2 * MARGIN));
  return {
    x: Math.min(W - w, Math.max(0, area.x + area.w / 2 - w / 2)),
    y: Math.min(H - h, Math.max(0, area.y + area.h / 2 - h / 2)),
    w,
    h,
  };
}
