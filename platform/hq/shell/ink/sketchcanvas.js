// The one canvas: a scrap opened on its own (bookscrapopen.js: its own page record, focus its unit), every notebook
// page being a grid of scraps. Pure, read by HQ's page (bookarrive.js, bookpages.js, bookunitfor.js, bookview.js).
/** @param {{ focus?: unknown }} page */
export const isCanvas = page => !!page.focus;
