---
title: "Decks: slides people read on a phone"
kind: note
tags: [craft, decks, presentations, board]
verified: 2026-10-02
---

# Decks

Learned while making presentation decks for the board: product reviews, pitches and proposals, read on a phone, an
upright tablet, a laptop and a large monitor.

## Build it with the deck kit

- **`node shared/deck/build.mjs deck.json`** makes one self-contained page from a JSON spec: swipe, tap or arrow
  keys, a poster for every video, transition sounds, and HQ's look inside HQ. The fields are in
  `shared/deck/README.md`. Edit the spec and rebuild; never edit the built page.
- **Portrait first.** People hold phones and tablets upright. Landscape only as a choice with a reason, and then say
  the reason where the viewer sees it ("turn your tablet: the two pages side by side").
- **Visuals and key points, not paragraphs.** A slide is a title, one line under it, two or three short points and
  one visual. Keep hero titles to two lines.
- **Four cards on an upright tablet stack in one column**, so each card's text has to fit on one line (about 48
  characters), with no room for a note.
- **Order by what matters most.** For a review of several products, the ads first, then a few slides per product
  (the product and its signature moment, the opportunity, the economics as one simple chart, the main risk, a button
  to try it), then the recommendation.
- **The deck is the presentation.** No separate film of the same slides.

## Media

- **Every video needs a poster**, or it shows as an empty box on a phone that won't autoplay. The build takes the
  first frame when you name none; name one that tells the story.
- **Re-encode recordings for the deck,** through the kit so it's noted as a render (`shared/demo/README.md`, Renders):
  `node shared/demo/renders.mjs make out.mp4 -- ffmpeg -i rec.mp4 -an -vf scale=720:-2 -crf 25 -pix_fmt yuv420p -movflags +faststart out.mp4`. `yuv420p` matters:
  screen recordings are often 4:4:4, which Chromium plays and Apple's players may not. Posters about 540 pixels wide,
  mockups about 1400.
- **Only files the deck's server serves will play.** Copy media into the deck's folder.
- **Send crops, not whole phone screens** (`pictures.md`).
- **A phone clip beside a picture** covers the picture's lower left on a phone. If the point of the picture is there,
  make two slides.

## Numbers and claims

- **Every number comes from a source** (the pitch, the build, the ledger, the research). The kit's stacked chart
  refuses parts that don't add up to the total.
- **Check a figure against what was built, not only its source.** A pitch's forecast can count a feature the build
  later cut (an add-on in the margin per order): the slide matches the pitch and is still wrong. Read the build's
  known gaps next to its numbers.
- **Label mockups** ("Mockup, not a photo").
- **A caption must match its clip.** When someone verifies a clip's sounds or steps against a log, ask them "what does
  the old text misstate?": it finds overclaims (a sound that comes on picking, not on typing).
- **Posters hide stale words.** When an ad is re-rendered, its poster (often also on a title slide) is a frame of the
  old ad. Find that frame in the old ad by the smallest pixel difference and take the same moment from the new one.
- **When a product's recording is redone, every deck that uses it goes stale.** Rebuild them.

## Check it

- **`node shared/deck/check.mjs index.html --shots <dir>`** opens every slide on the board's screens
  (`company/screens.json`, or a generic phone, tablet, laptop and monitor). It fails on controls over text, text cut
  off or under 12 pixels on a phone, a visual too small on a phone, a video without a poster or one that won't play,
  lines too long, and slides that are islands on a big screen. Use `--only 1,5` while you work, and get a clean run
  (exit 0) on the whole deck before you stop.
- **Then look at the shots,** the phone's scrolling slides first.
- **Don't run the check while media are still being written:** it reads half-written files.
- **Safari's engine where it's installed:** `--webkit` runs the check in Playwright's WebKit. iOS behaviour (Low Power
  Mode, the real safe areas) still needs a look on a real phone.
- **A blank white page in Safari is an empty response first,** before it's the page: a 404 or 502 with no body shows
  as nothing in Safari, where Chrome shows its own error page. Check what the address serves before you debug the deck.
- **Layout traps:** `container-type: size` on an `auto` grid column collapses it to nothing (use `fr` columns), and a
  swipe that ends on a video also fires a click, so ignore the click after a drag.
