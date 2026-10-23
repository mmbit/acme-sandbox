---
title: "Sound: satisfying effects in apps, ads and films"
kind: note
tags: [craft, sound, foley, music, ads, apps, loudness, harshness]
verified: 2026-10-11
---

# Sound

Learned while giving apps their own sounds, scoring ads with them, and mastering films, all without recordings and
without ears: every sound is made in code, and checked by measuring.

## The direction

- **The tools help, they never limit**. Everything below is advice from what
  worked. Only two things are rules: a sound never grates (`harsh.mjs`), and it plays at a pleasant volume.
- **Crafted effects usually lead.** "Oddly satisfying" foley (a stamp, a card dealt onto felt, a page turning,
  something clicking into place) carries an app and its ad well, so music mostly sits under the effects. A score good
  enough to carry the film, melody and all, leads it.
- **Everything is made, never sampled, copied or imitated:** no real songs, no living artist's style.
- **A film uses whatever sounds serve it,** not only its app's. The app then follows its film where it can, so tapping
  in it sounds like what the film promised.

## The tools

All in `shared/demo/`, documented in `SYNTH.md`:

- `foley.js`: physical sounds made in code, for the browser (a player with a remembered mute toggle) and for Node;
- `mix.mjs`: a film's soundtrack, cues on a timeline (kit sounds or any WAV of our own) over an optional music bed,
  mastered for social platforms;
- `synth.mjs`: music and beds with a beat grid.

A sound the kit doesn't have is yours to make, in code or any tool, and it cues and plays like the kit's own.

The soundboard `shared/demo/examples/foley.html` and `examples/audition.mp4` play the whole palette.

## What makes a sound satisfying

- **Anticipation, then a clean stop.** A short lead-in (a slide, a pull) into a crisp hit, then silence. Sync the
  picture to the hit, not to the start.
- **The material on screen,** physical, in a small close room. No beeps.
- **Never the same twice:** another take, a little pitch and level each time (the player does it).
- **Rising runs:** repeated actions (words landing, cards dealt) climb in pitch.
- **One hero sound** for the moment the product is about, richer than the rest.
- **Your own palette.** Start from how the product's moments should feel, then pick the kit's sounds, tune them or
  make your own, so two products don't sound alike (`SYNTH.md`).

## Never harsh

Learned when a board found the kit's swipe and slide sounds grating. A sound
should catch the ear, especially in a short-video ad, and it must never grate.

- **What grates isn't brightness.** Measured on real recordings, paper slid gently across a table (fine) is brighter
  than a cardboard box dragged over concrete (grating). The box has **weight** under 500 Hz, **judder** (its level
  shaking 15 to 150 times a second: stick-slip) and **crackle** (clicks standing out of the rub). A narrow resonance in
  noise **squeals**. Past the brightest real paper, sharpness does grate.
- **A movement (a slide, a swipe, a transition) stays light and smooth:** cut its noise under about 500 Hz, keep its
  texture fluctuating slowly (under about 20 Hz), and land it on a light stop, not a thud.
- **Darkening a scrape doesn't soften it**, it makes it heavier: box-like. A 2 to 5 kHz cut does little to a sound that
  is normalised to its peak afterwards.
- **A run that climbs brightens:** a slide pitched up for every step of a sequence gets sharper each time. Check the
  bright end, not only the default.
- **Measure it:** `node shared/demo/harsh.mjs` measures every kit sound against the bars of its kind, or any WAV;
  `foley-check.mjs` fails a sound that misses them; mix.mjs names the sharpest moment of a track.

## In the app

- **Nothing before the first tap,** soft (no louder than a quiet click), and a mute toggle that's remembered.
- **Time the picture to the sound:** `play()` returns the seconds until the hit, so land the visual then.
- **Warm long sounds up, off the main thread.** The first play of each take is rendered on the main thread and can
  stall a tap by 50 to 250 ms; rendered in idle time instead, one render still outlasts the gap between two frames, so
  an animated page stutters for its first seconds. Pin the take with a seed, render it in a worker as the page opens
  (`renderTake(name, params)` there, `sfx.keep(name, params, take)` on the page) and play it once there is a gesture
- **Schedule sequences a moment ahead** in the animation loop instead of rendering a whole sequence on the tap, and
  gate sounds for a view on that view still being on screen (the player can't cancel).
- **One table of the app's moments** (sound and parameters) makes it easy to give the film the same sounds where
  you want them.
- **Check on a real phone:** the iPhone's silent switch mutes web audio, and that can't be tested here.

## In the ad

- **Cue every visible action** at its time in the recording's `events.json` plus where the scene starts the clip.
  The sound is whatever serves the film: the app's own where it fits, something bigger where the film needs it.
- **Showing the app's own sound?** Know what the app really played. Either the app logs its plays and the cue list maps over the log, or the cue
  list replays the recording's taps through the app's own sound code. A replay easily misses sounds (one that lands
  just after the first tap, moments after the ad cuts away). Prove it: re-record the same flow with a spy on
  `AudioBufferSourceNode.prototype.start` and match cues to logged hits within 50 ms (a frame is 33 ms).
- **Log the moment, not only its values.** A log of params replays the old sound once the app re-tunes a call (a
  bigger tick, a drier squish): log each play's moment name and the take, and let the cue list look the params up
  in the app's palette today.
- **Balance changes, not levels:** the master is normalised, so equal volume changes do nothing. Bring sharp hits
  (knock, snap, stamp, lock) to about 0.6 of the textures' level.

## Loudness

- **Social platforms:** about -14 LUFS integrated, true peak about -1 dBTP. Films for a board or a deck: around -16.
- **Measure the finished MP4, not the WAV:** `ffmpeg -i ad.mp4 -af ebur128=peak=true -f null -`. The AAC encoder
  overshoots sharp transients and noisy textures by 0.3 to 3 dB. Mix to a lower ceiling (`master.ceiling` around -3
  for sparse clicks), or cut the top (`master.lp: 13000` fixed a cloth texture), and measure again after every render.
- **Sparse clicks are hard to make loud.** Silence between hits reads quiet, so the limiter takes a lot off each hit.
  `mix.mjs` reports how much; past about 12 dB, turn the loudest cues down or put texture between them. Trimming one
  cue only moves the problem to the next.
- **Small speakers:** a tablet plays almost nothing under 150 Hz, so a thump needs body at 200 to 400 Hz.

## Checking without ears

- **A spectrogram per sound** (log frequency, dB) and an energy envelope show what's wrong: a low thump ringing too
  long, a tonal plink where a crack should be noise, hiss where water should resonate. Write the STFT in Node if there's
  no numpy; ffmpeg's `showspectrumpic` is too coarse for sounds under a second.
- **Onsets:** a 5 ms energy envelope (a rise of 10 dB over the 35 ms before) finds each hit. `silencedetect` finds
  moments.
- **Compare levels by the loudest 100 ms,** not by peak.
- **Stems:** `mix.mjs --stems --levels` writes the effects and the bed apart, so loudness on each gives the gap in LU.
- **Harshness:** weight, judder, crackle, squeal and sharpness (`harsh.mjs`), calibrated on real recordings of the
  sound you want and the sound you don't.
- **Test what the docs promise for every sound:** a hash of each sound with a parameter changed catches parameters that
  do nothing.
- **Nobody has heard it yet** until someone listens on a phone speaker. Say so in the report.
