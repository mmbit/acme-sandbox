---
title: "Films and ads: making the video"
kind: note
tags: [craft, films, ads, video, captions, demo-kit]
verified: 2026-10-11
---

# Films and ads

Learned while making 9:16 product ads, demo films and longer films that walk a decision-maker through several
options. Recording an app is in `recordings.md`, the soundtrack in `sound.md`, the campaign around an ad in `ads.md`.
A film is a render: commit its scene or recipe and the `.render.json` the kit writes beside it, never the MP4
(`shared/demo/README.md`, Renders).

## The format

- **A social ad is 9:16 (1080 x 1920) and 15 to 30 seconds.** The hook lands in the first two seconds: the moment
  that makes someone think "I want to try that".
- **Sound leads.** Every visible action gets its own sound, synced to the frame, from whatever serves the film. Music
  usually sits under the effects; a score good enough to carry the film leads it (`sound.md`).
- **The words on screen carry the story**, in the film's language: one film per language, never subtitles over
  another language.
- **The AI label.** AI-made content carries "Made with AI" (in the film's language) from start to end. The kit burns
  it in; move it clear of the platform's own top bar (`--label-inset 280,72` clears Instagram Reels).
- **Safe zones.** Every word, label and price sits where the platform's buttons and captions won't cover it. For
  Reels, read in late 2026: 14% of the height at the top, 35% at the bottom, 6% at each side (x 65 to 1015 and
  y 269 to 1248 in a 1080 x 1920 frame), with small print above y 1152. Check the platform's current guide.
- **Every ad also comes out square** (1080 x 1080, `<ad>-square.mp4`, for the product page): the kit renders it from the same scene, so build for 9:16 only. Mark what only works on social (a
  "link in bio", a pointer at the platform's buttons) `data-social`, and the square film leaves it out.
- **A film for a decision** (a brand walkthrough, options side by side) has captions throughout and needs no voice.
  It may be landscape when the comparison needs the width; say why on the card that sends it.

## Making it with the demo kit

The kit in `shared/demo/` (its README) renders frame by frame in headless Chromium, so a film is smooth and the same
on every run:

- `record.mjs flow.json`: the real app, driven by a script, to an MP4 and its `events.json` (`recordings.md`);
- `ad.mjs scene.html`: an HTML scene to a 9:16 MP4 with its soundtrack and the AI label;
- `present.mjs deck.json`: a manifest of sections to a 16:9 film with captions and a music bed;
- `mockup.mjs`: the printed product from its artwork (`pictures.md`).

The kit and its examples (`shared/demo/examples/`) help, they never limit:
read an example for how the plumbing works, then make the film the idea needs. Draw the scene any way you like
(canvas, SVG, WebGL, hand-drawn frames, glow and gradients); only a frame that shows what we print uses the
product's own print renderer, so the print it shows is true. Then:

- **Draw each frame only from its time `t`.** Frames are rendered out of order by several workers: no state carried
  from frame to frame, no real timers, and seeded randomness only.
- **Show recordings with `<img data-clip="rec.mp4">`, not `<video>`.** Playwright's Chromium can't decode H.264.
- **Keep one timeline module** that the scene and the sound's cue list both import. Moving a time then moves the
  picture and its sound together.
- **The music's tempo is the grid.** At 96 beats a minute a bar is 2.5 seconds, so 10 and 40 second sections start on
  bar lines. Tell designers the grid before they time their sections.
- **Scene traps:** a `const` named like an element id shadows the element's global, and `name` is `window.name` (a
  string). Look elements up with `getElementById`.
- **Bring your own look.** The kit is plumbing. Two products' ads shouldn't look alike.

## Captions

- **Read every caption aloud at the size it's shown.** Keep to about four words a second, and at least two seconds
  per caption on a tablet. When a caption is too long, ask for shorter text, not new timings: the timings sit on the
  animation.
- **One caption style for the whole film**, in a clear band (keep the bottom 170 pixels and the platform's corners free).
- **No helper or agent names on screen:** a rename then means a re-render.

## Honest

- **Only what the product does,** with invented demo data and mockups labelled. Honesty is about the claims and the
  printed result shown, not about how the film was made: its sounds, music and drawing are free, as long as none of
  them promises a feature (a ticking sound over a printed clock, shown as if it keeps time).
- **Dates, times and prices in the viewer's format:** record with the right locale (`recordings.md`).
- **Check every caption against the product's promise and its edge cases** before you render: a claim like "unique"
  needs to be true of every output.

## Check it

- **A contact sheet first:** `ffmpeg -i ad.mp4 -vf fps=1,scale=270:-1,tile=6x4 sheet.png`. Then full-size crops of
  the zones that hold words (the top 200, the bottom 350 and the right 150 pixels).
- **Judge it at thumb size on a phone first,** full screen second.
- **Open the file:** `ffprobe`, a full decode (`ffmpeg -i ad.mp4 -f null -`), and the loudness on the MP4
  (`sound.md`).
- **Before calling a render final,** check that none of the shots or media it used changed while it ran.
- **The poster is a frame of the film** at its own aspect ratio, chosen to tell what the film is.
- **Remake the chain after any change:** re-record, re-mix, re-render, copy the result to wherever it's shown.
