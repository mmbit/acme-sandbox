---
title: "Screen recordings of an app"
kind: note
tags: [craft, recordings, video, demo-kit, playwright]
verified: 2026-10-02
---

# Screen recordings of an app

Learned while recording apps for ads, decks and demos with `shared/demo/record.mjs` (its flow format is in
`shared/demo/README.md`).

## The clock

- **The page runs on a fake clock** (dates, timers, animation frames and CSS animations), which only moves while the
  recorder records. That's what makes recordings smooth and identical on every run.
- **`waitFor` doesn't move the clock.** Use it for the network, and `wait` for anything on a timer. A debounced input
  needs a `wait` before a `waitFor`.
- **Smooth scrolling isn't on the page clock.** Patch `Element.prototype.scrollTo` in the flow if the app uses it.
- **Seed anything random** (a fake server's jitter, a shuffled board) from the flow, so a re-run matches.

## Taps, scrolls and drags

- **Tap by selector.** Coordinate taps break when the layout moves: a header 6 pixels taller moved a tap from the sea
  onto land, the recorder waited 30 seconds for a chip that never came, and a cut-off MP4 was left behind. After any
  layout change, measure again (`locator.boundingBox()`).
- **A tap scrolls the document to reach its target.** Scroll an inner list first with `{ "scroll": px, "in": "sel" }`.
- **Drags need selectors.** Inject a 2-pixel marker element with an `eval` step to drag to a precise spot.
- **Sliders:** the recorder moves the pointer once per frame with an easing curve. An app that throttles its sound
  per move plays fewer sounds on a fast scrub.
- **Keep the app inside the viewport** (360 pixels wide on the phone). The recorder warns when the page is wider; fix
  the app's layout, not the recording.

## Locale and data

- **Set the flow's `locale`.** Chromium's date and time fields follow the process's language, not the page's: without
  it a European recording shows 03/14/2026 and 02:30 PM.
- **Demo data only:** invented names and test orders, never anything a real customer typed, even on a preview.

## Knowing when things happened

- **`events.json`** lands next to the MP4: the time each tap, key, scroll and drag shows in the video. A soundtrack
  cues on it.
- **Sounds that don't come from a tap** (an animation's ticks): have the app keep a log of what it plays with
  `performance.now()`, and end the flow with an `eval` step that has `"mark": "heard"`. A sound logged at `t` shows at
  `mark.t - (now - t)` in the clip.
- **Nothing plays before the first gesture.** A synthetic `pointerdown` wakes an audio player in a flow that starts
  without one.
- **A sped-up clip keeps its events at normal speed.** Place each sound at (start + hit) / speed, by its hit, or
  sounds with a lead-in land late.

## When you record again

- **The picture can change while the timing stays the same:** a shuffled board puts cards elsewhere. Read positions
  off the new frames.
- **Compare old and new timing** with frame-difference onsets (small grey frames, the sum of absolute differences):
  the same onsets mean the same timing.
- **Everything made from the old recording is stale now:** the ad, the deck's clip, its poster.
