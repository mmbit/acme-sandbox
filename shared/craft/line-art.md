---
title: 'Isometric line art: one weight, empty ground, one accent'
kind: note
tags: [craft, line-art, isometric, illustration, covers]
verified: 2026-10-22
---


# Isometric line art

Learned while building the line-art drawing kit. The kit is `shared/lineart/` (its README
has the calls); pixel art has its own note (`pixel-art.md`).

## What makes the style

- **One line weight for everything**, ink on every edge, joins and ends rounded. Two weights at most: the second at half,
  for what's drawn on a surface (a window's cross, a lattice). A heavier outline round the silhouette reads as a
  sticker, not a drawing.
- **Empty ground is the style.** Leave faces bare (the paper) and let the outlines carry the form. A picture that fills
  every face looks like stock vector art.
- **Shade one way, always the same side.** The faces turned from the light (the kit: the right-hand ones) and the
  shadows take the shade: dots, hatching or a darker flat tone. Pick one per picture and never mix them.
- **One accent shape, where the story is:** the screen someone works at, the door of the building, the person in focus.
  Two accent shapes and neither is the story. In a live scene the accent follows the focus, and with none there's none.
- **Isometric, not perspective:** x and y at 30 degrees, z straight up, parallel lines stay parallel. Things don't
  shrink with distance, so order and gaps do the work of depth.

## Composition

- **Cut away to show inside:** a room keeps its floor and two far walls, a roof its far slope. The near walls go, never
  the far ones, or the inside hides behind them.
- **Draw back to front.** Further back is smaller x + y; within a room, what's against the far walls first, then the
  furniture by rows, each person after their desk, then what stands in front (a tree). A shape added out of order
  covers what it should stand behind.
- **Give each thing room.** Things placed closer than their own height overlap on screen, as the walls of a room in
  front rise into the room behind. Gaps between buildings or rooms at least the walls' height, or each on its own
  plate.
- **People are simple:** a body and a head, standing or seated, an arm when it does something. A face or clothes
  details at this scale turn into noise. Their pose says what they're doing (seated and reaching: at work).
- **Labels beside the drawing, or over it on a halo** of the ground colour, in a plain sans: never on a slanted face.
- **A tall screen wants an upright drawing.** An isometric grid of rooms is twice as wide as it's tall; on a phone,
  stack them down the diagonal (one, then two side by side) instead of shrinking a wide one.

## Colour

- **One ink for every line and dot.** A blueprint is all ink on white, with tints of the same ink for the accent.
- **Flat looks: three tones per material** (top lightest, the lit side, the shaded side), soft and few: two or three
  hues and white over a pale ground. No gradients.
- **Colours as data, as CSS variables in an SVG,** so one drawing repaints in every colour scheme a site offers. Check
  every scheme, dark ones included: an accent that pops on a light ground can vanish on a dark one.

## Checks

- **Look at every palette side by side** on one sheet (`node shared/lineart/render.mjs`, then screenshot the SVGs in
  Chromium: ImageMagick draws many SVGs wrongly).
- **At the size it's shown, then zoomed in.** Dots and hatching that read at full size become a grey smear when a cover
  is small. The kit sizes them from the line weight: thin the line, and the shade thins with it.
- **Count the accents:** exactly one shape in the accent colour (the kit's test counts them in its examples).
- **Deterministic output:** the same scene gives the same bytes, so a re-render shows only real changes.
- **A live scene in every state:** asleep, at work, waiting, the person in focus, on a phone and a laptop, in each
  palette.
