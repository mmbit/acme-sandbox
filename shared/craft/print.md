---
title: "Print files: posters, cards, books and other printed things"
kind: note
tags: [craft, print, posters, artwork, test-print, print-on-demand]
verified: 2026-10-02
---

# Print files

Learned while making print files for a print-on-demand partner (posters on paper and cotton, calendars, books,
cards) and preparing the first physical test print.

## The file

- **Read the exact size and bleed from the partner's product spec when you build the file.** Don't copy them into
  code by hand: they differ per product and can change. Check the units (sizes usually include the bleed on every
  side) and confirm anything the documentation leaves out.
- **Fill the bleed.** It's trimmed off or wrapped round an edge. Check that no edge of the file has white pixels.
- **Keep text and key art in a safe zone** well inside the trim. Hardware covers more than the trim: rails, a spiral
  binding, a hanger, a fold or a book's hinge. Measure how far it reaches and keep the art out of it. A book's cover
  grows with its page count, so compute the spine from the partner's table.
- **sRGB**, unless the partner says otherwise. Don't assume it converts CMYK the way you expect.
- **Resolution:** partners often check only a file's dimensions, never its resolution. Keep at least 150 DPI at the
  final size, and 250 or more for things held close (cards, books, puzzles, bookmarks). Check a customer's own photo
  against that in the preview, and warn them before they pay.
- **Formats:** JPEG or PNG at exactly the product's aspect ratio; PDF for books, often with cover and pages as separate
  files, pages exported one by one. Flatten layers.
- **One drawing for the screen and the print.** The preview and the print file come from the same code (the same SVG
  or canvas), so what the customer approved is what gets printed.
- **Fonts:** the customer's browser fonts differ per device. Draw lettering from your own glyphs or render it on the
  server, wait until the fonts have loaded before drawing a label, and key any cache of drawn text on what was loaded.
- **A proof that shrinks print pages to fit a screen** scales them with a transform, never CSS `zoom`: Safari keeps
  zoomed text at 9 px at least, so small type grows on a laptop and runs into what's below it, while Chromium (and
  the print file) look right. Look at a proof in Safari before saying it's what will be printed.
- **Deterministic files:** the same order makes the same bytes. Record a test file's hash; a new browser or font
  version can change it, so remake files only on purpose.
- **A PDF printed from a browser** gets a page rounded up to whole CSS pixels (202 mm comes out 202.18), with the extra
  left blank at the right and the bottom. Set the page box to the exact size afterwards and paint past the edge, then
  check every edge pixel of a rasterised page. The PDF's creation date changes its bytes too: fix it.
- **Pixel art in a vector file: one path per colour.** Squares drawn side by side show hairline seams when a viewer
  or a printer's RIP smooths their edges. Look at the PDF rasterised, not at the browser's screenshot.
- **A code someone scans (barcode, Data Matrix, QR) is checked by scanning it**, from the PDF rasterised, with a
  decoder (zxing-cpp). Keep at least two modules of white round it: a frame or a stamp drawn within one module can make
  it unreadable while it still looks fine.
- **Upload the file to the partner** rather than giving it a link: a preview behind a login can't be fetched.

## The first real print

- **Order a test print before launch.** A mockup can't show what the material does to the art.
- **Print the extremes, not a typical design:** the palest colours, the darkest colours, the longest text, and the
  design that comes closest to the edge or the hardware. Two sheets that cover the extremes teach more than three
  typical ones.
- **Write down what you expect before it arrives**, so the result shows what surprised you:
  - how far the hardware reaches onto the sheet;
  - whether pale fills vanish into the material (cotton soaks up a near-white wash);
  - whether dark colours go muddy and fine veins drown;
  - whether lines of one or two pixels at 200 DPI break up on a woven surface;
  - whether the smallest lettering reads at arm's length;
  - how the paper tone shifts, and how colours compare with a phone screen (greens and lavenders shift most, reds
    dull).
- **Send an arrival checklist** whose questions are answered "yes means pass", with numbered photos to take.
- **Until a property is tested in print, claim only what's known.** "Colour it in with coloured pencils" can be
  promised before "felt tips won't bleed through" has been tried.

## Talking to the partner

- **A test environment accepts files and produces nothing.** It proves the file is the right shape, not that the
  colours are right.
- **Read the partner's own answer** for each file (accepted or rejected) and for the order's state. Never infer it
  from a neighbouring status, and never tell a customer something happened because a call was sent.
- **Use your own order id as the partner's order id**, so a retry can't place the order twice.
