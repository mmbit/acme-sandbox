# The demo kit

Turns a product into a recording, an ad and a presentation, all rendered frame by frame in headless
Chromium and encoded with ffmpeg: smooth, identical on every run, with our own sound and music. It's plumbing
only, so bring your own look and your own track: the kit helps, it never limits what a film looks or sounds like
.

| tool | does | output |
|---|---|---|
| `record.mjs flow.json` | drives the real app through scripted steps (below) | 9:16 1080x1920 (phone) or 16:9 1920x1080 (desktop) MP4, no audio |
| `ad.mjs scene.html` | renders an HTML scene (below) with a music track | 9:16 1080x1920 MP4 with the AI label, and a 1080x1080 square one beside it |
| `present.mjs deck.json` | renders a manifest of sections (below) with `slides.html` | 16:9 1920x1080 MP4 with the AI label |
| `foley.js` | satisfying foley sounds in code, for the apps (browser player with a mute toggle) and the ads | see `SYNTH.md` |
| `mix.mjs sound.mjs out.wav` | a film's soundtrack: cues on a timeline (kit sounds or any WAV of our own) over an optional music bed, mastered, plus `out.beats.json` | see `SYNTH.md` |
| `synth.mjs song.mjs out.wav` | composes music (and generic SFX) in code, plus `out.beats.json` | see `SYNTH.md` |
| `harsh.mjs [a.wav]` | measures how harsh every kit sound is, or a recording or a track | see `SYNTH.md` |
| `mockup.mjs <product> art.png` | artwork turned into a picture of the printed product | see `MOCKUP.md` |

`core.mjs` is the shared engine (file server, `/__clip`, encoder, `render()`), and `runtime.js`
is injected into every ad and slide page as `window.demo`. Working examples are in `examples/`:
`hello-ad.html` (a sound-led ad scene), `hello-deck.json` (a deck), `audition.mjs`/`.html`/`.mp4` (the foley
palette), `foley.html` (the soundboard) and songs for `synth.mjs`. `foley-check.mjs` checks foley.js in Chromium, and that no sound is harsh.
A deck inlines `foley.js` when it's built (`shared/deck/build.mjs`), so a kit change means rebuilding every built deck:
foley-check lists the ones still on an old kit. The product apps keep no copy:
every product host serves this one (infra/products.md).

## Preview authentication

`preview.mjs` exports `authenticatePreview(context, target)` for Playwright checks. Call it before navigation.
`hq preview <product> -- <command>` supplies `HQ_PREVIEW_URL` (the approved preview URL) and
`HQ_PREVIEW_COOKIE` (one `name=value` view-only cookie). The module reads both from the environment once on import.
With neither input it leaves local checks unauthenticated. With either input it requires both and rejects a target
whose origin differs from the preview URL. It installs a host-only cookie for that origin with `HttpOnly`, `Secure`
and `SameSite=Lax`. Keep the cookie in the environment and out of command arguments and logs.

## Renders

Rendered video and audio isn't committed: its recipe is, with the `<file>.render.json` the kit writes beside every file
it renders (the command that made it, from the repo root, and the file's sha256 and size). Git ignores the file
itself. The worker keeps each render a push names, and the server puts it back where its `.render.json` is, so HQ, the
previews, the sites and the company's tools find it where they always did. The kit renders the same file on every run,
so a render can always be made again from its recipe.

```sh
node shared/demo/renders.mjs make out.mp4 -- ffmpeg -i rec.mp4 -vf scale=720:-2 out.mp4   # anything else that makes one
node shared/demo/renders.mjs fetch products/<slug>/ads/x.mp4    # one this clone doesn't have, from HQ (in a job)
node shared/demo/renders.mjs render products/<slug>/ads/x.mp4   # rendered again from its recipe
node shared/demo/renders.mjs check products/<slug>/ads/x.mp4    # rendered again: still the same file?
node shared/demo/renders.mjs status                              # every render here: present, missing or changed
node shared/demo/renders.mjs keep knowledge/qa/<check>/trace.json  # a run's raw output: kept, never committed
```

- **Commit the `.render.json`, never the file:** the gates refuse a video or audio file over 512 KB. The platform's own
  small UI sounds (HQ's chime) are the only media in git.
- **A job's clone has only the `.render.json`** of the renders already made: fetch the ones you need to look at, or
  edit (a deck's check names the command for a missing one). `fetch` also finds a render a branch HQ hasn't merged
  pushed, so a fix round takes the last round's files instead of rendering them all again.
- **Render inside the repo**, where its `.render.json` can go beside it; a file made in a temp folder and copied in has
  none. A file made by anything but the kit goes through `make`, so it has a recipe too, and so does a script of your
  own that runs a kit tool (a recording after a test purchase): run it through `make`, or the tool's own record names
  the script's temporary files, and the kit warns that a clone can't render it again.
- **`check` says DIFFERENT for a film that differs by a hair** (50 dB PSNR and up: `ffmpeg -i a.mp4 -i b.mp4 -lavfi psnr
  -f null -`) when Chromium draws something a shade apart from run to run. A layer with rounded, clipped corners that
  moves or scales (`overflow: hidden` and `border-radius`) needs `will-change: transform` so it's always drawn the same
  way. Sound an app plays through Web Audio rendered in Chromium (a `ConvolverNode`'s reverb) can leave a few samples
  one step apart; `mix.mjs` and `synth.mjs` render in Node and come out the same.
- **One render at a time on a shared machine:** each uses up to four Chromium pages, so concurrent renders can exhaust
  memory. Use the same lock for every render: `flock /tmp/demo-render.lock node shared/demo/ad.mjs <scene.html>`
  (replace the command with the kit tool or wrapper you need).
- One rendered before renders were kept names its blob in git's history instead of a command (`adopt`): the server
  takes it from there, and it can't be rendered again until it has a recipe.
- **A run's raw output is kept the same way, without a recipe:** `keep` a trace, observations, a frame dump or a log,
  and commit the `.render.json` it writes with a short summary of the numbers. `keep` and `adopt` put a file git
  wouldn't ignore in its folder's `.gitignore`, so it stays here and out of git. The gates refuse a data file (JSON,
  logs, CSV, text) over 2,000 lines or 512 KB under `knowledge/` or `products/`; a fixture a test reads gets the
  `fixture` attribute in `.gitattributes` instead.

## On a lent machine

In a job, every film `render()` draws (`ad.mjs`, `present.mjs`, a script of your own on `core.mjs`, `renders.mjs render`
and `check`) is drawn on a machine the board lends, not beside the agents on the server: `away.mjs` sends it as a run of
the company's `render` kind (`hq run`, platform/helper/README.md) and brings the film back, noted as if made here. There's
nothing to type: the film lands where its tool puts it, with its `.render.json`.

- **What goes:** the demo kit, the page and its folder, the film's music, and what the page needed before in this clone.
  A run that lacks a file the page asks for (a font, a script, a clip) stops and names it, and the next takes it, with the
  files beside it but renders, so a new scene takes a few short runs first. A page can ask for any file in the repo.
- **With no machine to take it** (no `render` kind, the machine off or asleep, or one lost the run), it's drawn in the
  job (`hq run --fallback here`). `HQ_RUN_HERE=1` draws it here on purpose.
- **The kind:** an image with Chromium through Playwright (its browsers in `/ms-playwright`), ffmpeg and the fonts films
  use, and `lentOnly: true`, since a film the machine can't take is drawn in the job anyway. Without the kind every film
  is drawn in the job.
- **Pages are answered with no server:** the browser's requests to `http://localhost` (no port) are answered from the
  repo, as a run may open no socket. A page names its files by repo path (`/theme/...`), never a host of its own.
- **Recordings stay here:** `record.mjs` drives a real app on its own server, which a run can't start.
- **Another machine, a hair apart:** a film drawn there differs from one drawn here by about as much as two runs here
  (about 50 dB PSNR on average), so `check` can say DIFFERENT for it.

## Prices

A film, deck or recording never types a price. It names the ones it shows by key in its settings, and the kit asks the
company's price source for each at render time, in the film's language (`--lang`, else its `data.lang`):

```html
<script type="application/json" id="demo">{ "out": "ad.mp4", "data": { "lang": "nl" }, "prices": ["notebook"] }</script>
```

- **In a scene:** `demo.price('notebook')` gives it as the language writes it (`€ 26,95`), and `demo.withPrices(words)`
  puts each `{price:notebook}` in a line of words. One the settings don't name is an error.
- **In a deck:** `"prices"` and `"lang"` in the manifest, and `{price:notebook}` anywhere in its words (an `html`
  section has `demo.price`). **In a flow:** `"prices"` names the ones the app shows; the app shows its own.
- **Each render records them** in its `.render.json` (`prices`: key, language, cents, text). A render made from others
  (a `cp`, a re-encode, a wrapper: every word of its command that's a render here) records theirs too, as their notes
  have them when it's made, so a copy left behind after its source is rendered again still shows up in the check.
- **The check** lists every render whose prices aren't today's, each with the command that renders it again, those it's
  made from first. `--ads` adds every ad running with one (in a job). It exits 1 if there's any, so a company runs it
  as a test where its price list lives, and the nightly run takes it too.

```sh
node shared/demo/prices.mjs check [path...] [--ads]          # renders whose prices aren't today's, and what redoes each
node shared/demo/prices.mjs note products/<slug>/ads/x.mp4  # a render made before its scene named its prices: records
                                                             # its scene's, today's (look at it first; --from <scene>
                                                             # or --prices a,b for one a script of its own made,
                                                             # --lang for its language); one made from others (a cp)
                                                             # gets theirs, as their notes record them
```

The company's setting is `company/prices.json`: `source`, a module whose `price(key, lang)` gives today's price as
`{ cents, text }` (its first language with none) and throws for a key it doesn't know; `ads` (optional), a module whose
`running()` gives the ads showing now as `[{ ad, films }]`, the films by their repo paths.

## record.mjs: flow.json

```sh
node shared/demo/record.mjs products/<slug>/demo/flow.json [--out x.mp4] [--viewport phone|desktop] [--fps 30]
```

```json
{
  "serve": "../app/src/server.ts",  "url": "/",  "viewport": "phone",  "fps": 30,
  "out": "../ads/<slug>-phone.mp4",  "time": "2026-09-27T10:00:00",  "crf": 18,
  "steps": [{ "wait": 0.6 }, { "type": "Mila", "into": "#name" }, { "tap": "button" }, { "scroll": 260 }]
}
```

- `serve` is the app's server script, started with `PORT` set to a free port. Leave it out and `url`
  is used as it is. `url` is the start page.
- `viewport` is `phone` (360x640 at 3x, touch, finger dot), `desktop` (1280x720 at 1.5x, cursor),
  a list of both (one file each, `-phone`/`-desktop` suffix), or `{ "width", "height", "scale", "touch" }`.
- `time` is where the fake clock starts (Date, timers and rAF run on it, and CSS and Web Animations are seeked
  to it; one that ends is finished on the frame the clock passes its end, so `await animation.finished` and
  `onfinish` work, which `record-check.mjs` checks). `crf` sets quality, lower is better (18 by default).
  Paths are relative to the flow file.
- `locale` is the browser's language for dates, times and numbers: `en-GB` by default (14/03/2026, 14:30), `nl-NL`
  for 14-03-2026. It sets the process's `LANG` too, because date and time fields ignore the page locale (recordings
  before job #757 show US formats, 03/14/2026 02:30 PM).
- `camera` is a Y4M film (relative to the flow file) the page's camera shows instead of a real one, with the camera
  already allowed: for an app that films its user, with a face drawn for it, never a real person's.

| step | does |
|---|---|
| `{ "wait": s }` | records s seconds |
| `{ "waitFor": "sel" }` | waits until the selector exists, recording nothing meanwhile. The page clock is paused, so use it for network waits, and `wait` for anything on a timer |
| `{ "go": "/path" }` | navigates, relative to `url` |
| `{ "tap": "sel" or [x, y], "s": 0.5 }` | finger comes down and taps, or the cursor moves there (`s` = move time) and clicks |
| `{ "type": "text", "into": "sel", "cps": 11 }` | taps `into` first (optional), then types at a human, slightly uneven pace |
| `{ "press": "Enter" }` | one key |
| `{ "scroll": px, "s": 1, "in": "sel" }` | eased scroll of the page (or of the element `in`) by px |
| `{ "drag": "sel", "to": "sel" or [x, y], "s": 0.8 }` | press, move along a slight arc, release |
| `{ "eval": "js" }` | runs JS in the page (set demo state, open a dialog); with `"mark": "name"` its result goes into `events.json` as `{ t, type: name, value }` (for example the app's own log of the sounds it played) |

The app is served on `localhost` (where a payment engine run locally sends a buyer back), and the recording follows
it to another address and back, a checkout's payment page included. The app's own CSP stays on: the finger and the
cursor are drawn in a way `style-src 'self'` allows. It warns when the page is wider than the viewport, because the
right edge gets cut off. Use demo
data only, never customer data (house rule 7). Next to the MP4 it writes `<name>.events.json`: the time
each tap, key, scroll and drag shows in the video, so an ad's sound cues can land on them (`SYNTH.md`).

## ad.mjs: the scene contract

```sh
node shared/demo/ad.mjs scene.html [--out ad.mp4] [--duration s] [--audio sound.wav] [--audio-start s]
  [--bpm 120 --offset 0] [--fps 30] [--label "Made with AI"] [--label-pos top-left]
  [--label-inset 280,72] [--workers 3] [--square <css background> | --no-square] [--only vertical|square] [--no-social]
```

**Every ad comes out twice**: the 9:16 film for social, then a 1080x1080
square one beside it, `<out>-square.mp4`, for a product page. The scene needs nothing for it. The square one is the
same scene, seeked frame by frame again and set full height in the middle of the square. Its sides follow the film:
its outermost columns stretched to the square's edges and softened, so a dark end card gets dark sides, and the film's
side edges fade into them. The AI label is redrawn in the square's corner at full size. A scene that draws its own
label (with `"label": ""`) marks it `data-ai-label`: the square hides it and draws the kit's in its words instead.

- **Social-only bits:** mark them `data-social` (`<div data-social>Link in bio</div>`) and the square film hides them. `--no-social`
  hides them in the vertical film too: the film for a paid ad, where the platform puts its own button under it
  Something drawn in script asks `demo.format` (`'vertical'` or `'square'`).
- **The sides:** `"square": "#f6efdf"` in the scene's settings (or `--square`) takes any CSS background instead of
  the film's edges, a pattern included (`"repeating-linear-gradient(45deg, #f6efdf 0 14px, #efe4d2 14px 28px)"`;
  a `url()` is relative to the scene). `"square": false` (`--no-square`) makes the vertical one only.
- **Each file's `.render.json` renders only itself** (`--only vertical` or `--only square`), so a square cut of an
  older ad is one command: `node shared/demo/ad.mjs scene.html --only square`.

- The scene is a 1080x1920 page that defines `window.frame(t)`, which draws time t in seconds and may
  be async. Frames are rendered out of order by up to four pages, each drawing the same share every run, so the drawing must depend only
  on t, with no state carried from the previous frame and no real timers or `Math.random()` without a seed.
- Settings can live in the scene: `<script type="application/json" id="demo">{"out": "../ads/x.mp4",
  "duration": 15, "audio": "music.wav", "audioStart": 0, "bpm": 120, "data": {...}}</script>`. Paths
  are relative to the scene, and flags win. Without `duration` it's the track's length (at most 30 s), or 15 s with no track.
- `window.demo` (from `runtime.js`) is there before your scripts run:
  - `demo.t`, `demo.duration`, `demo.fps`, `demo.width`, `demo.height`, `demo.data`
  - the beat grid from `<track>.beats.json` (written by synth.mjs) or `--bpm/--offset`: `demo.beat(n)`,
    `demo.bar(n)` (time of beat or bar n), `demo.beatAt(t)` (a fractional beat, and `% 1` gives
    the phase), `demo.marker('logo')`, `demo.sections`, and for a mix.mjs track every sound as
    `demo.cues` (`{ t, start, sound, name }`, t = the moment it lands)
  - animation: `demo.p(t, a, b, ease)` (0..1 progress), `demo.lerp`, `demo.clamp`,
    `demo.ease.{linear,out,in,inOut,back,spring}`
  - video: `<img data-clip="rec.mp4" data-at="2" data-speed="1">` plays a recording from scene time
    `data-at`. You can also call `await demo.clip(img, src, t)` yourself. Use `<img>`, not `<video>`:
    Playwright's Chromium can't decode H.264, so the server hands out single frames (`/__clip`).
  - `window.ready = promise` makes rendering wait for your own loading (fonts, fetches, iframes).
- **The AI label** (house rule 5) is burned into every frame: "Made with AI", top-left, clear of the
  platforms' top bar. `--label-pos` moves it. `--label-inset edge,side` (or `"labelInset": [280, 72]`
  in the scene's settings) sets how far it sits from its two edges, in 1080-wide px, up to 1878 and 540 in portrait.
  The label is always drawn whole: one that would run past the frame (a long label wraps) moves in until it fits.
  The default (150, 44) clears TikTok's top bar but not Instagram Reels', which can cover the top 270 px and 65 px
  at each side: for Reels use 280,72. `--label ""` removes it, only for footage that isn't AI-generated content.

## present.mjs: the deck manifest

```sh
node shared/demo/present.mjs deck.json [--out presentation.mp4] [--fps 30] [--workers 3] [--label ...]
```

```json
{
  "title": "Venture cycle 1", "out": "presentation.mp4",
  "audio": "bed.wav", "audioStart": 0, "loop": true, "bpm": 120,
  "css": "deck.css", "theme": { "bg": "#10141f", "accent": "#7ad", "serif": "Georgia" },
  "sections": [
    { "type": "title", "kicker": "Five concepts", "title": "Tonight's work", "sub": "…", "dur": 5, "caption": "…" },
    { "type": "ad", "src": "../x/ads/ad.mp4", "kicker": "01", "title": "Name", "sub": "…", "num": "1" },
    { "type": "recording", "src": "rec-phone.mp4", "title": "…", "points": ["…"], "lead": 0.5 },
    { "type": "recording", "src": "rec-desktop.mp4", "wide": true, "title": "…" },
    { "type": "image", "image": "mockup.jpg", "title": "…", "points": ["…"], "dur": 5 },
    { "type": "table", "title": "Unit economics", "table": [["Price", "€ 29"], ["Margin", "€ 11"]], "dur": 6 },
    { "type": "text", "title": "…", "sub": "…", "points": ["…"], "dur": 6 },
    { "type": "html", "html": "my-slide.html", "dur": 8 }
  ]
}
```

- Sections play in order, each for `dur` seconds. `ad` and `recording` default to the clip's length
  plus `lead` (a hold before it starts) and `tail` (0.6 s). Everything else defaults to 5 s. The total is the video's length.
- Every section can take `caption` (shown at the bottom; the playbook wants captions throughout),
  `class` and `style`. The table's last row is styled as the total.
- `captions` (`[{ start, end, text, who }]`, in seconds of the film) are timed captions over the whole film, for one
  with a voice: while one is on, it takes the section's caption's place, `who` in front of it.
- `steps` (on a section with `points`, in seconds from its start): when each point comes on, the newest bright and
  the ones before it stepped back; without it they all come in with the section.
- `hosts` (`[{ id, name, look, sprite }]`, as org.yaml's crew) are drawn as HQ's characters (the brownstone sprites)
  from the waist up at the foot of every slide, the first half left, the rest right. The one whose caption is on (`who`
  is their `name`) is lit, their mouth moving with the `audio`'s loudness and their caption a bubble on their side; the
  others dimmed. When two captions overlap, the later one shows. <!-- --> The
  bubble sits between the two groups, past the innermost host on each side, so it never covers a face.
- The two lights behind every deck drift slowly over the film (CSS `--glow1`, `--glow2`), so a slide held long still
  breathes. It is on for every deck, with or without `hosts`.
- `audio` repeats when the deck is longer than the track if `loop` is set, or when the track's
  beats.json says `"loop": true` (synth.mjs beds do). The music fades out over the last 0.5 s.
- Restyle with `theme` (the CSS variables in `slides.html`: `bg`, `bg2`, `ink`, `muted`, `accent`,
  `accent2`, `serif`, `sans`) and `css` (your own stylesheet, or a list of them, each over the last; a host's `--lit`,
  1 when lit, dims it your own way). `script` names a module of your own the page imports once the slides are built,
  before the first frame, to draw on them. You can also replace the whole page
  with `"page": "my-deck.html"`, which gets the manifest as `demo.data` (with `start` added to every section).
- `html` sections are iframes: the page gets `window.demo` too, and is sought with `demo.seek(t)`
  (section-local t), so it follows the same scene contract as an ad. Its `steps`, if it has any, come in its address,
  `#steps=1.2,3.4`, for it to draw its own points.
- Paths are relative to the manifest. The AI label sits top-right by default (`labelPos`, `label`).
