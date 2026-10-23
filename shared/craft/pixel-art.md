---
title: "Pixel art, pixel type and small marks"
kind: note
tags: [craft, pixel-art, typography, icons, covers]
verified: 2026-10-11
---

# Pixel art, pixel type and small marks

Learned while drawing newsletter covers, logos, icons, signs and diagrams in pixels.

## Keep every pixel square

- **Whole-number scales only** (2x, 3x, 4x), with smoothing off (`image-rendering: pixelated`). At 2.8x some pixels
  are wider than others, and the art looks smudged.
- **Mail apps smooth images.** Ship pixel art for email already scaled up (2x).
- **No anti-aliasing and no gradients:** stepped bands of a fixed palette.

## Light, outline and composition

- **Light from one side, always the same** (top left is usual): a highlight on the lit edges, a shade on the others,
  one of each per colour in the palette.
- **Two layers:** a backdrop without outlines, and the things in front with one ink outline around their silhouette.
- **One scene, one idea.** The subject large and readable in a glance at card size, wherever the composition puts it.
  Few colours per object.
- **Words only where they'd be in the world** (a sign, a label, a screen), and short. A title belongs next to the
  picture, not on it.
- **Isometric on a 2:1 grid:** X = ox + 2(u - v), Y = oy + (u + v) - z. Things along one wall barely rise on screen, so
  show growth with the height of bars, not with how high their tops reach.

## Pixel type

- **Pixels for signs, a readable sans for sentences.** Never set a paragraph in a pixel font.
- **Pixel fonts have glyphs that are easy to misread at label size:** B reads as G or 8, C as O, G as 8, 5 as S, 2 as
  Z, € as 8, and the "fi" and "ff" ligatures as other letters. The @ and j can be ambiguous too.
- **The fix:** keep the pixel font and take only the ambiguous characters from a second pixel font, under the same
  family name, with `unicode-range`. Declare that second face again for every weight you use: a face only competes on
  `unicode-range` with faces of the same weight, so one face for all weights never loads. Match the cap heights with
  `size-adjust`, and turn ligatures off (`font-variant-ligatures: none`; in SVG, in each `<text>`'s `style`).
- **A letter that carries the whole meaning** (the A and B of an A/B test, say) is drawn as a small bitmap glyph inside
  the sprite.

## Icons and marks

- **Draw a mark at 16 pixels first.** If it doesn't read there, it doesn't work as an icon.
- **Look at a small mark the way a stranger would:**
  - a head drawn as a plus reads as a cross at 7 pixels: draw square heads;
  - a plus inside a ring reads as a Celtic cross, a far-right symbol;
  - a coloured box with a centred cross can read as a flag: put the knot on top so it reads as a present;
  - an upright tag reads as a house: tilt it.
- **Never show a name twice in two styles on one screen** (a pixel label next to a drawn wordmark).
- **Anything drawn per item stops scaling.** Draw the company, and let data draw the products (a card per catalogue
  entry, not a hand-drawn shop window each).

## Drawing pixels in code

- **A grid rasteriser** (rectangles, circles, polygons and lines on a grid, an automatic outline, written out as
  run-length `<rect>`s at a whole-number scale) gives chunky pixel art from code, isometric rooms included.
- **Sketch small sprites as rows of characters** with a colour map (`'.rr.rr.'`). They stay readable in the source.
- **Without a browser:** write a binary PPM (P6) and scale it with `convert -filter point -resize 1200%`.
- **Look at every state before anyone else does** <!-- -->: a scene that changes
  with the time, the weather or who's in it gets rendered in each state, in the day and in the dark, side by side on one
  sheet, and every sheet opened. A hand-picked crop hides what's wrong: a sign hanging over a window, a room left in
  shadow, a chair merged into the wall. HQ's rooms have `platform/hq/room-preview.mjs` for it.

## Newsletter covers

The platform's cover kit is `shared/covers/` (its README has the format, the palette and the look): 128 x 72 pixels,
still, drawn in code next to the post, rendered with `node shared/covers/render.mjs <cover.js>`. The feed is a wall of
covers: keep the style uniform (size, palette, light, outline) and vary the set-up (the place, the shot, the scale), or
a wall of the same shot gets dull within a couple of weeks. Start from the story's own picture, not the kit's parts:
its places and things are what covers drew before, and a wall built from them looks alike. Look at a new cover scaled
up next to the last few (`--recent`) before you publish: it should read at card size and look unlike them.
