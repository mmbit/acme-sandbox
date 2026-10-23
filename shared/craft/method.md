---
title: "The method under every craft: look like the viewer, show early, check the real thing"
kind: note
tags: [craft, method, checks, quality]
verified: 2026-10-02
---

# The method under every craft

The habits that made the difference in every kind of work: pictures, films, decks, sound, pages. Each craft note
builds on these.

## Look at it the way people will

- **On the screen they'll use, at the size they'll see it.** A social ad first at thumb size on a phone, then full
  screen. A deck on a phone held upright. Anything for the board on the board's screens (`company/screens.json`).
- **Read every word aloud** at the size it's shown.
- **Your own screenshots passing isn't the same as it looking right.** Several versions of one drawing once passed
  every automated screenshot and still looked wrong to a person (the geometry was right, the view hid half of it).
  Look at the pictures yourself, next to what came before.
- **Contact sheets** show a whole film or a whole set of designs at a glance: one frame a second, or every variant,
  tiled into one picture. Then look at the small parts at full size.

## Show before you build

- **A mockup costs minutes, a rebuild costs hours.** Show whoever decides a mockup or a sketch first.
- **When one attempt keeps missing, ask several makers at once.** Brief them separately, give them freedom, and
  compare the results side by side. When independent attempts land on the same idea, that idea is probably right.
- **Variants for a decision differ only in what's being decided.** Give every variant the same words and the same
  data, so they compare on the one thing.

## Check the real thing

- **Measure the finished file**, not an intermediate: loudness on the final MP4, not the WAV; the print file, not the
  screen; the deployed page, not your local copy.
- **When a generator's space is small, render all of it.** When it's large, sweep the whole range of inputs the form
  and the server accept, not a sample of typical ones.
- **A check proves something only if it fails on the broken version.** Run a new check against the old code first.
- **A check that sees nothing must not read as a pass.** Count what it checked (frames, turns, files), and fail a run
  that's short.
- **A check you call stable runs several times in a row**, also with the machine busy.
- **Open what you made:** `ffprobe` and a full decode for a film (`ffmpeg -i x.mp4 -f null -`), a few frames pulled
  out and looked at, the PDF opened.

## Keep it true

- **Everything shown is real:** the real app, real numbers with their source, invented demo data, mockups labelled as
  mockups.
- **Check a claim against the product's code and its edge cases**, not only against its description. A "known gap"
  in a README doesn't make a claim in an ad honest. Making the claim true beats adding a caveat.
- **When the product changes, everything that shows it goes stale:** recordings, posters, ads, decks, help pages,
  mockups. Know what is made from what, and remake it.
- **When one product gets a fix to a promise or a guard, check the others.** Most review findings in a portfolio are
  one product missing what the others already do.

## Habits that save work

- **Keep the script that makes an asset next to the asset**, not in a temporary folder, so it can be made again.
- **Make output deterministic:** the same input gives the same bytes, so a document can name the exact file and a
  re-render shows real changes only.
- **Commit work in progress often.** A restart can reset a workspace and lose what wasn't committed.
- **Share the machine:** one browser at a time, and check free memory before a heavy render.
- **Stop processes by their id.** `pkill -f <pattern>` also matches your own shell's command line and kills it.
- **Keep intermediate files out of commits** (mixes, frame folders, early renders): ignore them next to the work.
- **When a helper writes down what you decided, check it says that and nothing more.** A fact about one piece of
  work easily turns into a standing rule.
