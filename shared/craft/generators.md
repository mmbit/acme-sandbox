---
title: "What an app makes: names, flags, words and pictures from a seed or a customer's text"
kind: note
tags: [craft, generators, wordcheck, names, culture]
verified: 2026-10-02
---

# What an app makes

When several apps were checked for anything that could embarrass a customer or the company, every real problem came
from something an app *generated* or *showed on its own*: a made-up name with a slur inside it, a flag that looked
like a far-right one, a celebration on a cancelled order. None came from art or copy that people had drawn or
written. So this is where the checking effort pays off.

## Render everything once

- **A small space gets enumerated.** A generator with a few dozen designs (flags, crests, colour sets): render every
  one into a contact sheet and look at it.
- **A large space gets swept.** Thousands of name pairs through a joiner, hundreds of names from many backgrounds
  (Dutch, German, French, Turkish, Moroccan, Persian, English…) through a name generator. Use a decent random number
  generator for samples: a quick home-made one can skew letter counts and hide the hits.
- **Sweep the whole range a form accepts**, not typical inputs: the longest name, accents, two words, an ampersand.
- **Keep the sweep as a check script** in the product's own `demo/` folder, so it runs again after every change.

## Words at the seams

- **Joining text makes words nobody typed.** A name ending plus a suffix gives a slur or a rude word ("…naz" + "ia"
  contains "nazi"; two short names joined can spell something crude). Check the joined string, not the inputs.
- **`shared/wordcheck/`** finds a rude word, slur, disease curse or extremist code in several languages:
  `blocked(text, ...typed)` returns the first blocked word in `text` that the customer didn't type themselves. Copy
  `wordcheck.js` into the app.
- **In a generator, a hit means "take the next variant".** A false alarm costs one variant, a miss costs a
  screenshot.
- **In customer text you print, a hit means a person looks before it prints.** Never refuse automatically: people
  really are called Dick, Con or Kutlu. Also run `blocked(typed)` on the raw typed text without the exception, or
  "Hitler" typed into a field that adds "land" passes.

## Look-alikes

- **A generated flag or symbol can resemble a real one with a meaning:** an extremist flag, a national flag in a
  context that reads as a statement. Know the ones that matter in your markets and compare.
- **Real flags with maps on them exist,** so a map on a flag isn't by itself a sign of a mistake.

## Names in any alphabet

The moment someone sees their child's or partner's name come out right is the moment they decide. So:

- **Never match names with `\w` or `\b`:** in JavaScript they only know ASCII. Use `/[\p{L}\p{M}]+/gu` (letters in
  any script, plus combining marks: some keyboards send "ö" as "o" plus a separate mark).
- **Keep the name as it was typed.** Mixed case ("van Dijk", "McKenzie", "Işıl") can't be rebuilt from capitals.
  Re-case only a name typed all in capitals or all in lower case, and clean up the stray dot that lower-casing a
  Turkish "İ" leaves.
- **Printed capitals are fine** where the design wants them.
- **Scripts without case** (Arabic, Hebrew, Chinese) pass through unchanged: check they aren't dropped.
- **Store what was typed**, not only the display form, or a reload loses it.

## Sad states

A generator or an animation that celebrates must know when not to. A cancelled or refunded order gets no "make
another" and no replay of the happy moment: someone may have cancelled because of a loss. A product for births,
weddings or deaths makes no remarks about bodies, ages or looks.
