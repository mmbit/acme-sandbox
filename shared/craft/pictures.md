---
title: "Pictures: product mockups, app screenshots and diagrams"
kind: note
tags: [craft, pictures, images, mockups, screenshots, diagrams]
verified: 2026-10-02
---

# Pictures

Learned while making product pictures, app screenshots and diagrams for ads, decks, sites and the board. Pixel art
has its own note (`pixel-art.md`).

## Product pictures

- **Show the product as it will arrive.** `node shared/demo/mockup.mjs <product> art.png --out x.jpg` turns flat
  artwork into a photo-like picture of the printed object, drawn in code: no stock photos. `shared/demo/MOCKUP.md`
  lists the products, their scenes and the art ratio each needs. Export the art at that ratio, or it's cropped.
- **Mock up only what's sold.** No frame, stand, packaging or option the maker doesn't supply.
- **Label every picture that isn't a photo:** "Mockup, not a photo", or "Mockup · sample data" on a screen with
  invented data. A plain diagram needs no tag.
- **Give each product its own scene:** its own wall, surface and accent colours (`--wall`, `--surface`, `--accent`),
  or a scene drawn for it around the object alone (`--transparent`), so a range of products doesn't look
  like one product five times. The mockup's own scenes and props are a starting point, never the house picture
 .
- **Sizes:** 1600 x 1200 for pages and documents, 1080 x 1920 for a 9:16 ad, 1080 x 1080 square; `--scale 2` for
  sharp screens. JPEG for ads and documents (a tenth of the size), PNG only for transparency.
- **Invented people only:** names, photos and text in every picture are made up, never a customer's.

## Screenshots of a real app

- **Skin the real app rather than drawing a fake one.** Run it locally in its stub mode (without partner or payment
  keys), set the state you need with Playwright's `page.route` (an order's status, say), and inject only what the
  picture needs. The picture then stays true to the app.
- **"As it would look live":** hide test-only labels and notes, but keep the mockup tag on the picture. Don't show a
  state the product doesn't have, or say plainly that it's invented.
- **A sticky header that's a little transparent looks like a glitch in a still.** Make it opaque for the shot.
- **Element screenshots include sticky headers, and full-page shots repeat fixed elements** at the top. Hide them or
  crop.
- **A phone frame holds one idea.** Cut the copy to fit, not the font size. A 9:16 frame at 396 x 704 CSS pixels holds
  about 570 pixels of scrolling content under a device's chrome.
- **A chat anchored to the bottom leaves empty space above a short conversation.** Fill it with real context (a date
  divider, the greeting), not decoration.
- **A whole phone screen shrunk onto a slide is unreadable on a phone** (about 230 pixels wide). Send a crop of the
  moment instead, for example 4:5.
- **Phone video:** Playwright's `recordVideo` films at CSS size. Record at device pixels with the DevTools screencast
  (`Page.startScreencast`) and join the frames with ffmpeg, each with its own duration.

## Diagrams and pictures for decks

- **A deck shows a picture at 350 to 600 pixels wide.** In a 1200-pixel source, keep main labels at 50 pixels or more
  and details at 29 or more. Check the picture scaled down to 380 pixels.
- **Shapes for a phone-first deck:** diagrams portrait (1120 x 1400) or square, with text at 28 pixels or more; a
  title picture landscape (1400 x 1000) with its subject in the middle.
- **Check a picture where it will be seen:** screenshot the slide at phone width, not the bare PNG.
- **Keep each picture small.** `convert in.png -dither None -colors 256 PNG8:out.png` makes a Playwright PNG several
  times smaller, and most pictures land well under 200 KB.
- **A chart says where its numbers came from**, in one line under it: the tool or table and the time it covers. For a
  chart answering a note in a notebook, `node shared/scrapchart/draw.mjs` draws a line or bar chart in the line look and
  refuses one with no source (`shared/scrapchart/README.md`).

## Colour and contrast

- **Text needs 4.5:1 against its background** (WCAG), large text 3:1.
- **Text on generated colours** (a tint per product, a colour per catalogue entry) has to pass for every entry, not
  the first five. Compute the contrast over the whole set. Light letters on a generated accent once fell to 1.7:1:
  deepen the background toward the ink until it passes.
- **Compare colours in OKLab.** A difference under about 0.02 can't be seen, which is how to prove a refactor kept
  every colour.

## Tool traps

- ImageMagick renders many SVGs wrongly. Screenshot an SVG in Chromium instead.
- ImageMagick refuses very tall images (a full-page phone shot can be 17,000 pixels): crop and scale with ffmpeg.
- `montage` can crash on a machine without fonts. Tile with `convert +append` and `-append`, or ffmpeg's `hstack` and
  `vstack`.
- Playwright's `setContent` can't load `file://` images: `page.goto` a file instead. Module imports need a local HTTP
  server, not `file://`.
