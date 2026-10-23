# Deck: interactive slide decks for the board

One JSON spec in, one self-contained HTML page out: swipe, tap or arrow keys, on a tablet, a desktop or a phone
(portrait and landscape; checked on the board's own screens, `company/screens.json`), in the house look (HQ's cream cards, ink outlines, hard shadows).
The house look helps, it never limits: a deck restyles it with its own `css`
and a slide's `class`, and its pictures and films can be anything. The check holds a deck to readable and usable on
the board's screens, never to the look.
The CSS and script are inlined; the page loads nothing from other sites (a Content-Security-Policy
enforces it), and media is linked relatively. The policy lets in a script from the deck's own site, so the cycles site's
review mode (`/__review/review.js`) can pin the board's notes on a slide as on a demo.
Used for venture cycle presentations
(`products/_cycles/<date>/presentation/`, playbook step 5), served at
`https://cycles.preview.<zone>/<date>/presentation/` behind the preview login.

```sh
node shared/deck/build.mjs products/_cycles/<date>/presentation/deck.json   # writes index.html next to it
```

The build fails (exit 2) on a missing file, an outside URL for media, or a stacked chart whose parts
don't add up to its total. It prints the media size, split into files in the deck's folder and files
linked from outside it (e.g. `../ads/`). Edit the spec and rebuild; never edit `index.html` by hand.

## Using it

- **The page is two bands:** the slides, up to the top of the screen, and the controls at the bottom (the deck's
  title on a wide screen, progress, 🔈, ☰, ◀ n / N ▶). The controls never lie over a slide, and they keep clear of the
  notch and the home bar (safe areas). Nothing sits above a slide: the top safe area is the slide's own padding, so a
  slide that doesn't fit scrolls up to the screen's edge, and its foot fades out while there's more below. Inside a
  frame (HQ's viewer) the deck takes no safe areas at all: the viewer keeps clear of them itself.
- **Navigate:** swipe left/right; tap the right side of a slide for next, the left third for back;
  arrow keys, space, Page Up/Down, Home/End; the ◀ ▶ buttons; the progress bar (one segment per chapter);
  or ☰ / the slide count (`C`), which lists every slide by its title, under its chapter. `#12` in the URL opens slide 12.
- **On a phone held upright** a slide shows its heading, then its picture or video filling what's left of the screen
  (at least two thirds of it), then the points, cards and note below. Sideways, the text sits beside the visual.
- **Tap a picture or video** to see it as large as the screen allows (a video plays there with its controls); tap
  anywhere, ✕ or Esc to go back. Every visual has a small ⤢ mark in its corner for this.
- **Video** plays only while its slide is on screen and restarts when you come back. `"sound": true`
  plays with sound where the browser allows it (after the first tap, swipe or key press); otherwise it
  plays muted with a "Tap for sound" chip. Where the browser won't start it at all (iOS in Low Power Mode),
  its poster stays with a ▶ to play it in place. The 🔈 button (`M`) mutes all.
- **Every video has a poster**, drawn as a picture under the video and kept until the video really plays, so a
  video never shows as an empty box. Name one with `poster`; without it, the build takes the video's first frame
  into `posters/` next to the page (named by the video's contents: a re-recorded clip gets a new one, and the ones
  it made that no video uses any more are removed; a poster you name may live in `posters/` too). Commit `posters/`
  with the page.
- The next slide's video is fetched while you look at the current one, so it starts at once.
- **Transition sounds, not music** (the board's direction for cycle 1): each slide lands with a card slid into
  place, a step higher on every slide of a chapter (up to an octave); a new chapter turns a card over, a jump (menu, progress bar)
  deals one, going back slides lower, and either end answers with a dull knock. It's the demo kit's foley player
  (`shared/demo/foley.js`, inlined), so it's silent until the first tap or key, soft, and a new take each time.
  Inlined means a deck keeps the kit it was built with: after a change to `foley.js` (or `deck.js`, `deck.css`), rebuild
  every built deck. `shared/demo/foley-check.mjs` lists any deck still on an old kit, and `check.mjs` refuses one built
  on an old kit, deck.js or deck.css.
  The 🔈 button mutes the sounds and the videos together, and the choice is remembered on the device.
  `"sfx": false` in the spec turns the sounds off. No background music.
- **In HQ's viewer it wears HQ's look:** the deck says hello to HQ, and a look with a stylesheet for decks
  (`platform/hq/renderers/<look>/slides.css`, the holo deck's) sends it over, laid over `deck.css`. The brownstone has
  none: its decks are this house look. A deck built before this keeps its own look until it's rebuilt.
- **It talks to HQ only.** The cycles site names HQ's origin at `/__hq-origin` (`infra/products.py`), and only HQ and
  the cycles pages may frame a deck there (`frame-ancestors`). The deck says hello to that origin alone and takes a
  stylesheet only from it; a button to a preview tells HQ the deck's path and slide, never its query. Served anywhere
  without `/__hq-origin` (a local check, another server) or framed by another page, it sends nothing and takes
  nothing. `node shared/deck/hq-check.mjs` checks this in Chromium on three loopback origins.

## The spec

```jsonc
{
  "title": "Venture cycle 1 · Five, made overnight",   // tab title, and the chip in the controls on a wide screen
  "hint": "Swipe, tap or use the arrow keys",          // shown on the first slide for 5 s
  "css": "extra.css",                                   // optional, relative to the spec, inlined after deck.css
  "unit": "€",                                          // for chart values
  "sfx": true,                                          // transition sounds (the default); false turns them off
  "chapters": [
    { "name": "Hello", "accent": "green",               // accent: gold red blue green purple orange, or any CSS colour
      "slides": [ { ... }, { ... } ] }
  ]
}
```

Every slide takes any of these; the layout follows from what's there.

| Field | What it does |
|---|---|
| `kicker` | the small label chip above the title |
| `title`, `sub` | headline and one line under it. Keep both short: the board reads on a tablet |
| `points` | 2–3 short bullets |
| `cards` | `[{ label, big, text, source }]`: 2–4 tiles side by side (stacked in portrait), e.g. customer / trend / gap, with `big` for one number |
| `media` | one item or a list: `{ video, poster, sound, loop, label, alt, frame }` (`poster` optional: the first frame otherwise) or `{ image, label, alt, frame }`. `frame`: `phone` (9:16 in a phone; the default for video) or `photo` (a framed picture; the default for images). Two items (a phone and a photo) overlap: the photo large, the phone in front of its corner. Two photos sit side by side (one above the other held upright): a now and a proposed, each with a short `label` ("Now", "Proposed") |
| `chart` | `{ type: "stack", label, total, parts: [{ label, value, key }] }`: one whole split into parts, the `key` part in the accent colour (a price into VAT, costs and margin). Or `{ type: "bars", rows: [{ label, sub, value, display, tag }], color, max }`: one measure across a few items |
| `button` | `{ label, href, small }`: a big link, opens in a new tab. In HQ's viewer, a link to a product preview opens there instead, with ‹ back to the slide |
| `note` | a small line at the bottom: sources, "mockup", a caveat |
| `hero` | `true`: a title slide, big headline, media in a row below |
| `wide` | give the visual more room than the text (automatic for charts) |
| `accent`, `class` | override the chapter's accent; add a class for your own CSS |

Text with `media` or `chart` sits beside the visual in landscape; in portrait the heading (kicker, title, sub) is
above the visual and the rest (points, button, note) below it. With `cards`, the cards run under the title. Don't
cap a visual's size in your own `css` with `vh`: the kit fits it to its band, and a `vh` size doesn't know about the
controls.

## House rules for decks

- **Numbers come from the sources** (pitches, READMEs, the build). The stacked chart's sum check helps.
- **Mockups say so:** label every product picture that isn't a photo "Mockup, not a photo".
- **Keep it light:** re-encode recordings for the deck (`node shared/demo/renders.mjs make out.mp4 -- ffmpeg -i rec.mp4
  -an -vf scale=720:-2 -crf 25 -pix_fmt yuv420p -movflags +faststart out.mp4`: renders aren't committed, their recipe
  is, `shared/demo/README.md`), posters at 540 px, mockups at 1400 px. Cycle 1's deck is 5.5 MB plus the
  ads. `yuv420p` matters: a screen recording is often 4:4:4, which Chromium (and so the check) plays but Apple's
  players may not.
- **Check it:** `node shared/deck/check.mjs <index.html> [--shots dir] [--only 1,5] [--screens file]` opens every slide
  in Chromium on the screens in `company/screens.json` (the board's own: its phone in Safari and in HQ's viewer, either way
  up, its tablet, laptop and monitor; without the file, a generic phone, tablet, laptop and 2560 px monitor). Each screen is the page's viewport where the board sees it:
  `{ name, width, height, inset, touch }`, `inset` being a phone's safe areas. A screen under 500 px either way is a phone.
  It lists controls over the slides or under 40 px, text cut off at the side or in its box, text under 12 px on a phone,
  a visual under half the stage on a phone (a fifth on a title slide), a video without a poster, and a film that won't
  play. Off a phone it also lists a slide that doesn't fit the screen (a phone may scroll; the others have the room),
  lines over 90 characters,
  running text under a 60th of the screen's height, and an island: a slide whose content covers under 60% of the
  stage both ways. Then that a tap shows a picture and a video large and wholly on the phone's screen, either way up,
  and the menu lists every slide; then the sounds: silent before a gesture, a sound after one, mute silencing sounds and
  videos and remembered after a reload. It plays the films as they are, so it checks the files the board sees (a
  Chromium without H.264, as older Playwright builds were, gets VP9 WebM copies).
  35 slides on eight screens take about 4 minutes; use `--only` while iterating, and look at the shots, the phone's
  scrolling slides first (it lists how many). `--webkit` runs it all in Playwright's WebKit, Safari's engine, where that's
  installed. Real iOS quirks still need a real phone.
- **On a big screen** the root size follows the screen up to a QHD monitor's (32 px), so a slide there looks like it
  does on a laptop, only larger; points stop at about 75 characters a line. **On a tablet held upright** the visual
  takes what the text leaves (at least two fifths of the slide) so the points stay on screen, and four cards sit two by
  two.

Files: `build.mjs` (spec → page), `inlined.mjs` (what a page inlines, and the built decks on an old copy), `deck.css`
(the look), `deck.js` (navigation, video and sounds), `check.mjs`,
`build.test.mjs` (the build's posters: `node shared/deck/build.test.mjs`), `hq-check.mjs` (talks to HQ only), `logo.svg`
(HQ's pixel building).
