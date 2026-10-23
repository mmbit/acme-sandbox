# HQ refactor, step 1: shell, world model, brownstone renderer

**What this is:** the Overseer's working plan for HQ's refactor, kept up to date by its maintainer as its steps land.
It retires when the last step has landed: what was built is then described in `platform/hq/`, and this file goes.

The plan for step 1 of PLAN.md ("Freeze-free extraction"), against acme-corp's `platform/hq` on 2026-09-30. Binding:
PLAN.md and CODE_STYLE.md. Rule for every step: **no visible change** (pixel-check tiers A/B/C exact), except M2.

## Decisions
- **Camera is the renderer's** (iso maths, integer zoom, layout bounds) → `renderers/brownstone/camera.js`. The shell
  hands over what the HUD and panel cover as `shell.chrome()` (raw facts, so the maths stays byte-identical).
- **Gestures are the shell's**: tap, double tap, hover, drag, pinch, fling, wheel, keys, driving `scene.camera`.
- **Renderer people inherit from world agents**: `P = Object.create(worldAgent)` + x, y, lvl, plan, pose, hit, seat,
  room, look. Reads of `state`/`data`/`id` are live; writes land on P. (render.js already does this in `whoIsWhere`.)
- **A fresh `<canvas>` per scene** (a 2d canvas can't become WebGL; hot swap needs both).
- **world/ has no DOM and no `location` at import**; `?hour=/?date=/?weather=` come via `clock.init()`, so `node:test`
  can import it. Renderers import only pure helpers from `world/clock.js`, `world/weather.js`; they read state through
  the `world` parameter and write only through world commands, in answer to taps.

## Target tree
```
platform/hq/
  index.html        script → shell/main.js; brand text via data-name placeholders (C1)
  style.css         unchanged; :root variables overwritten from the brand at boot
  util.js           pure helpers from js/util.js (hash rng pick rand clamp lerp mix canvas trim esc titleCase store);
                    inset → shell/stage.js (it adds a resize listener at import)
  pixel-check.mjs   step 0          mock/brand.json   C1
  shell/  main stage input tour events hud overlay dev panel news brand desk data audio voice push agekey mic-worklet
  world/  world clock weather mascots  + world.test.js clock.test.js
  renderers/brownstone/  scene build hit react sign camera sim mascots layout render iso sprites rooms env facade billboard town
  classic/          untouched
```

### js/main.js
| What | To |
|---|---|
| boot, refreshOrg, checkHealth, busy, moveIn, showRequests, *_POLL_MS | shell/main.js |
| loop, step (shell half: world.tick → scene.update → overlay.step → tour.step), viewHeight, resize (dpr, --app-h, then scene.resize), inset, chrome(), mount/swap | shell/stage.js |
| bindInput, tap, dispatch half of act, TAP_SLOP/TAP_MS/DOUBLE_TAP_MS, konami (→ world.startParty) | shell/input.js |
| bindHud (flyTo/petCat → scene.focus + scene.act), updateStatus, clock label | shell/hud.js |
| startTour/nextTour/stopTour, card DOM (stops from scene.showcase) | shell/tour.js |
| fx.bubbles, dropBubble, card, dropCard | shell/overlay.js |
| onEvent shell half (unknown → refreshOrg; "Asked the board" → refreshRequests; post toast + Gazette reload; dev Gazette), onDirective | shell/events.js |
| devHooks (old names kept as aliases) | shell/dev.js |
| hour, fixedHour, fx.lapse, calendarCheck (→ checkDay, emits 'day') | world/clock.js |
| STATUS_LOG, world half of onEvent (state, task, logs, asleep), world half of build (keep state/task/logs across refreshes), lightState (→ rooms[].asleep), party countdown, busy/engine/dock load | world/world.js |
| INTRO_STEP, WALL_DUR, walls, stepIntro, introStops, introOffset, wallOpen, setShut, setWalls, onScreen, draw, renderer half of step, fx.planes | brownstone/scene.js |
| renderer half of build (layout, looks, room art + trim, island, sim, carryLift, people, seats, roof bits, façade, walkCheck warning) | brownstone/build.js |
| hit; renderer-only taps (bell, sign×5 → world.startParty, orb → world.lapse(20), elevator, jacuzzi, weather → world.pickWeather, telescope, duck, van, chest, walls, mascot); petCat (→ petMascot), ringBell, WEATHER_PICKED, fx.bells, fx.signTaps | brownstone/hit.js |
| renderer half of onEvent (decide for the agent and waiting roommates, onChat, planes + whoosh/blip, onPost, the '...' particle, newsBurst, burst, CONFETTI); visual half of setParty (look.party, clearSpriteCache) | brownstone/react.js |

Renderer half of `step`, in this order: busy/engineBusy/dockBusy from the world, `update(S)`, confetti, planes, tick
sound, weather ambience, chirp, boom, `camStep`.

### The rest of js/
| Current | To | Change |
|---|---|---|
| world.js (sim) | brownstone/sim.js | S.world.agents → S.people; S.onVan/onFlap → shell.sound; updateCats → brownstone/mascots.js; onPost setTimeout → shell.later |
| layout.js | brownstone/layout.js | collectRooms split: normalisation (board as agents, commons, departments, mascots) → world.setOrg; len, engines, filler rooms, packing stay; buildLayout(world, sw, sh) reads world.rooms |
| render.js | brownstone/render.js | buildRoofBits + signGlow → sign.js; S.world.agents → S.people in whoIsWhere, drawScreens, roomGlows |
| camera.js | brownstone/camera.js | ui.panelOpen, innerWidth, inset, HUD_H, PANEL_W, SHEET, WIDE → shell.chrome() |
| env.js | brownstone/env.js | today, season, HOLIDAYS, holidays, darkness → world/clock.js; PICKS, pickWeather, weatherAt → world/weather.js; env.js re-exports |
| iso.js | brownstone/iso.js | WORDMARK → brand logo pixels: wordmark(g, x, y, ink, one, shadow, rows) |
| sprites.js, town.js | brownstone/ | unchanged |
| rooms.js | brownstone/ | bowl letter = the mascot's initial; basket and bowl only for mascots that sleep there |
| facade.js, billboard.js | brownstone/ | from brand settings |
| ui.js: initUI, show, closePanel, panelOpen, openAgent, refreshAgent, openRoom, openPet | shell/panel.js | |
| ui.js: portrait, catPortrait | scene.portrait | |
| ui.js: coverFor … openDoc, sanitize | shell/news.js | |
| ui.js: toast, countBadge, DIGITS | shell/hud.js | |
| ui.js: place, drawBubbles, drawCard | shell/overlay.js | |
| desk, data (+loadBrand), audio, voice, push, agekey, mic-worklet | shell/ | desk: addModule('shell/mic-worklet.js'), names from brand, CEO from world.company.ceo, directory reads world.rooms |

Outside HQ in step 1: `shared/covers/kit.js` imports; `platform/coordinator/src/security.test.ts:237-238` paths;
`shared/review/README.md:61`. Unchanged: review.ts HIGH_RISK still matches `platform/hq/`; hqFingerprint walks subfolders.

## Mascots
Today Skittles is an org.yaml board member with `cat: true`, spread over sim (S.cats, updateCats, boardStroll), render
(drawCat, catFrame), rooms.js (basket, bowl 'S'), billboard (skittles(), "+ A CAT"), main.js (petCat, card, tour),
ui.js (catPortrait, openPet blurb), desk.js (directory).

Config, any number (zero is fine), in brand.yaml:
```yaml
mascots:
  - id: skittles
    name: Skittles
    kind: cat                 # renderers map a kind to their own art
    role: Honorary Board Member
    about: Naps in the sun, sleeps in the basket at night, and is never assigned work.
    home: board               # world room (panels, directory, tour)
    favours: [board]          # brownstone reads board as "the roof by the penthouse"
    rules: { night: sleep, day: [sit, loaf, sit], nap: 0.45, wander: [6, 14], visitedBy: board, visitChance: 0.4 }
```
During migration world.js also reads org.yaml `cat: true` members (brand.yaml wins); C1 removes the org.yaml entry.

World (`world/mascots.js`): `{ id, name, kind, role, about, home, favours, rules, activity: awake|nap|asleep, love,
want }`; owns sleep at night, nap/sit choices, the love timer, the wanted room. Commands `world.pet(id)` (love 3, emits
`feel { mascot, emote: 'love' }`) and `world.visit(id)`. Positions, routes, spots and beds stay in the renderer.

Renderer: a kind table, e.g. `const ART = { cat: { frame: catFrame, bed: 'basket', bowl: true } }`. Unknown kind: not
drawn or tappable in the canvas (one dev note), still in directory, panels and tour list; tour skips it when `focus`
returns false; `portrait` returns null → initial. Two mascots: the first sleeper gets the basket, the next the next free
spot; one tour stop each. No mascot: no basket or bowl, no billboard slide, no tour stop.

Billboard: `skittles()` → a generic `mascot` slide (`{ slide: mascot, mascot: skittles, lines: [...] }`), dropped when
the mascot is missing or its kind has no billboard art. "+ A CAT" is brand text; foundation default `+ A {KIND}`.

## World model
`import * as world from '../world/world.js'` (module state; the namespace is the `world` parameter).
```js
company     { name, legal, ceo }          // org.company; new org.yaml field company.ceo, default 'juno'
dev         boolean
agents      Map id → { id, name, role, engine, board, temp, pronouns, look, data, roomId,
                       state: 'idle'|'working'|'waiting'|'sleeping', task, logs: [{ ts, type, text }] /* ≤ 80 */,
                       emote: { kind, s, left } | null }
rooms       [{ id, name, kind, size, features, agentIds, board, commons, deptId, asleep }]   // board, commons, depts
departments [{ id, name, charter, customerData, roomId }]
mascots, alumni, requests (number), party (seconds left)
load()      → { busy: 0..1, engines: { claude: n, … }, deliveries: boolean }
hour() today() season() holidays() darkness(h) weather()
emote(id, kind, s = EMOTE_S) → boolean   // world/emotes.js: EMOTES { kind: { means, glyph, color } }, fade(emote) → 0..1
on(type, fn) → off
```
Signals (synchronous, after the change, in registration order): `org {added, removed}`, `status {agent, was}`,
`say {agent, to, text}`, `feel {agent|mascot, emote}`, `post {agent, title, board}`, `log {agent, text}`,
`requests {n, was}`, `party {on}`, `weather {kind, picked}`, `day {holidays}`, `lapse {on}`.

Only the shell calls `setOrg`, `apply(ev)` (→ `{ unknown }`), `setRequests`, `tick(dt)`, `clock.init(q)`, `setHour`
(dev). User commands (`startParty`, `pickWeather`, `lapse`, `pet`) may come from the shell or a renderer's `act`.
`update`/`draw` never write to the world. Agent records stay the same objects per id.

Speech bubbles: the shell draws DOM bubbles for `say` in every renderer, at `scene.anchor`. Emotes: each agent's `emote`
counts down in `tick`; it's set by `world.emote` (dev: `hq.emote(id, kind)`), by a coordinator event
`{ type: 'feel', agent, emote }`, and by two events of its own (working → idle: `happy`; a post: `celebrate` for its
author). Unknown kinds are ignored. Every renderer draws `agent.emote` over the person in its own style, with `fade`;
its art per kind is optional (it falls back to the kind's `glyph` and `color`), so a new emote is one line in `EMOTES`.

## Renderer contract
```js
// renderers/<name>/scene.js
export const info = { id, name, context: '2d' | 'webgl2', label };
export async function createScene({ canvas, world, brand, settings, shell }) → scene
// settings: theme/hq.yaml's [name] section + { intro }
// shell: { sound: { play(name, ...a), weather(rain, dark, snow), ready() }, toast(html, onTap), card(target, title, sub, s),
//          chrome() → { top, bottom, panel: { open, wide, right, share } } (CSS px), store: { get, set }, later(fn, ms) }
scene = {
  update(dt), draw(t),                 // dt ≤ 0.1 s; t = shell time in s; draw sizes/places its own canvas
  hit(x, y) → { kind: 'agent'|'mascot'|'room'|'object', id, room? } | null,        // CSS px, no side effects
  focus(target, { instant, close }) → boolean,   // target { kind: 'home'|'agent'|'mascot'|'room'|'object', id }
  resize(w, h, dpr), dispose(),
  camera: { grab(), drag(dx, dy, vx, vy), pinch(x, y, scale, phase), release(fling), zoom(step, x, y), nudge(dx, dy) },
  anchor(target) → { x, y } | null, highlight(target | null),
  // optional
  act(hit, { double }), portrait(target) → { img, accent } | null, near(a, b) → boolean, where(target),
  controls: [{ id, title, pressed(), toggle() }], showcase(on) → { lead, stops: [{ target, title, sub, hold }] } | null,
  dev: { S, L, R, cam, fx, walkCheck, errand, rebuild, walls, tick },
};
```
Taps: the shell handles object ids `news`, `library`, `phone`, `intercom`, `computer`; the rest (and mascots) go to
`scene.act`. Double tap on a non-agent focuses `hit.room`; on nothing, home. Room taps use world room features
(library, newsstand) else `openRoom`. Renderer sounds: whoosh blip pop thump whirr flap tick chirp boom meow quack honk
ding blub twinkle jingle rewind + `sound.weather`; the shell keeps ring, open/close, fanfare, mic and UI blips.

Hot swap (`stage.mount(name)`): `import()`; a new canvas `#world`; `await createScene` (on failure keep the old one, toast);
then `old.dispose()`, swap the node, re-attach input, `resize`, `focus(home, instant)`, re-apply `highlight`, re-anchor
bubbles, stop the tour, re-bind the HUD's scene buttons (`controls`). `dispose` removes world listeners, cancels
`shell.later` work, clears inline canvas styles; module caches may survive but hold no scene state. The look picker
(computer › Settings › Look) swaps with `stage.pick(name)`, which also stores it per viewer (`null`: none picked); boot
takes `?renderer=` (this load only), else the stored look, else `theme.renderer`, falling back to it, then brownstone.

Skins: style.css is the brownstone's pixel-art UI, written in variables (`--line --bw --r* --shadow* --press --ease
--on-accent --deep --scr* --tint-*`, the brand's colours under them). A look in `stage.js` DRESSED ships
`renderers/<name>/skin.css`: `mount` loads it beside the one worn, and drops the old one as the scene swaps. A skin
sets the variables on `body`, so its surfaces, lines and font win over the brand's `:root` while the brand's accents
(red, gold, …) stay; a few targeted rules do what variables can't (a frosted backdrop, eased motion, smooth HUD icons,
the count as text). HQ ships two looks, brownstone and holo; soft, glass, paper and ring are archived at the branch
`archive/looks-six`.

Sound packs: `shell/audio.js` is the engine (`tone`, `noise`, `strike`, `note`, all WebAudio synthesis, no files) and the
brownstone's chiptune, the default pack. A look in DRESSED also ships `renderers/<name>/sounds.js`:
`export const sfx = { name: (...a) => … }` (its version of a sound, made with the engine) and `export const music =
{ bass, arp, lead, hat, snare }` (each part's `tone`/`noise` settings over the chiptune's, `gain` on its level); a sound
or part it leaves out is the chiptune's. `mount` imports it with the scene and `audio.wear(pack)` puts it on as the scene
swaps in (brownstone: `{}`); `sfx.<name>` and `shell.sound.play` always play the pack worn. A pack's sounds go through a
bus of its own that the next swap fades and drops, so nothing of the last look rings on; the music changes voice at its
next note. The rain and its drops on the glass stay the same in every look: they are the weather, not the UI.

## brand.yaml
`GET /api/brand` → `{ brand: company/brand.yaml, theme: theme/hq.yaml }` (`{}` for a missing file); dev: `mock/brand.json`.
`shell/brand.js` holds the only foundation defaults; renderer-specific defaults live in the renderer.
```yaml
name: Onlyonery
names: { hq: HQ, os: HQ-OS, newsletter: The Gazette, newsletterShort: Gazette, library: The Library,
         libraryShort: Library, phone: Desk phone, phoneShort: Phone, intercom: Intercom, computer: Computer }
colours: { ink: '#1d1a2f', cream: '#fdf3e1', paper: '#fffaf0', muted: '#6b6580', red: '#e8505b', gold: '#ffd966',
           blue: '#5b8def', green: '#5cc26a', purple: '#9b72cf', orange: '#ff9b4a' }
font: { family: "'Pixelify Sans', ui-monospace, 'Cascadia Mono', monospace", href: https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;600&display=swap }
logo: { svg: wordmark.svg, svgDark: wordmark-dark.svg, alt: Onlyonery, pixels: [ …15 rows of 80… ],
        lines: [[0, 34], [35, 63], [65, 80]], colours: { ink: '#fffaf0', accent: '#ffd966', shadow: '#4f4670' } }
sign: { text: null, panel: '#2b2350', frame: '#b8862e', inner: '#3b3355', bulbOn: '#fff3b0', bulbOff: '#8a6a2a', plaque: '#2a2352' }
billboard:   # slide kinds are brownstone's; lines replace the words
  - { slide: logo, seconds: 3.6 }
  - { slide: tee, seconds: 3.4, lines: [ONE OF, A, KIND, LIKE YOU] }
  - { slide: mug, seconds: 4.0, lines: [MADE FOR], names: [ADA, NOOR, SAM, YUKI, LEO, MAYA, OMAR, ZOE] }
  - { slide: printer, seconds: 3.8, lines: [PRINTED, TO ORDER] }
  - { slide: heater, seconds: 3.2, lines: [SLIGHTLY, WARMER] }
  - { slide: balloons, seconds: 3.2, lines: [SLIGHTLY, MORE, WHIMSICAL] }
  - { slide: mascot, seconds: 4.4, mascot: skittles, lines: [SKITTLES, BOARD, MEMBER] }
  - { slide: typewriter, seconds: 3.6, lines: [RUN BY, AI, + A CAT] }
mascots: [ see Mascots ]
calendar: { founded: '09-25', holidays: [halloween, sinterklaas, pakjesavond, christmas, newYear] }
app: { title: Onlyonery HQ, description: 'The Onlyonery office building, live: see what every agent is up to.', themeColour: '#1d1a2f' }
mail: { domain: onlyonery.com }
```
Replaces: `name` index.html:11,12,27, main.js:50 + tour titles :552/:558, manifest, desk.js:275; `names.hq` index.html:10,27,
main.js:297, desk.js:806, sw.js:10; `names.os` desk.js:644,757,772; `names.newsletter` index.html:30, main.js:326,555,
ui.js:131,132,161, desk.js:922; `names.library` ui.js:142,155,156, desk.js:254,922; `names.phone` index.html:29, ui.js:58,
desk.js:142; `names.intercom` index.html:31, ui.js:59, desk.js:510,641; `names.computer` index.html:32, ui.js:60;
`company.ceo` desk.js:510–520,575,641–664,816,821, ui.js:59, index.html:31, main.js:356; `colours` style.css:2–3,
index.html:6, manifest; `font` style.css:4, index.html:19; `logo.pixels` iso.js:135–157 (facade.js:182, render.js:928,
billboard.js:72–74); `logo.lines` billboard.js:72; `logo.colours` facade.js:182, render.js:928; `sign` render.js:925–927
(width = logo width + 16 = 96), facade.js:181–182 (logo width + 6 = 86); `billboard` billboard.js:1,80–239,242;
`calendar` env.js:23–30; `mail.domain` desk.js:824,828. Tour copy (mascot name, dock room name) comes from the world.
Flagged, not moved: desk.js:68,99–104 postMessage key `onlyonery` (shared with shared/review); desk.js:104 preview host
(→ infra.env); data.js mock event script (→ mock/events.json).

## Steps
**The check: `platform/hq/pixel-check.mjs --ref origin/main [--only …] [--brand file]`.** Serves the ref's tree (via
`git show ref:path`) and the working tree from two `node:http` servers, both in dev mode with mock data; renders both in
Playwright per scenario; compares in the page (canvas getImageData); writes base/new/diff PNGs to $TMPDIR only on a
difference; any differing pixel exits 1. Setup: seeded mulberry32 `Math.random` via addInitScript; `page.clock.install()`
+ `pauseAt`; Google Fonts aborted; `waitForFunction` with `polling: 100`. Stable dev hooks only: `world.paused`, `frame`,
`cam`, `hit`, `S`, `L` (kept as aliases by shell/dev.js).
- **Tier A, stills** (paused, `hq.frame(10)`; canvas and full page): desktop 1280×800 at hours 3, 7 (fog,
  ?date=2026-10-30), 12 clear, 16 rain, 19.5, 23; 12-24 17:00 snow; 12-31 23:30; 09-25 bunting; walls on; zoomed on
  lobby, penthouse, basement; billboard at t = 1.8, 5.3, 9, 13, 16.5, 19.8, 23.6, 27.6. iPhone 390×844 dpr 2; tablet
  1024×768 at night.
- **Tier B, runs**: the loop with the dev event script, `clock.runFor` 10, 20, 30 s.
- **Tier C, interactions** (real input): tap an agent (via `hq.hit`), double-tap a room, wheel, arrow keys, zoom
  buttons, tour + 8 s, walls, konami + 3 s, orb, water tower, pet the mascot, directory → fly to, HQ-OS apps, Gazette,
  Library, phone and intercom panels.
If B differs, find the reordered `Math.random` call; don't re-baseline.

| Step | Files | After | Checks and tests |
|---|---|---|---|
| 0 Harness | pixel-check.mjs | – | two runs against main: zero differences |
| 1 Move files | git mv; imports; index.html; worklet path; kit.js; security.test.ts; review README | 0 | security.test.ts; covers render byte-identical |
| 2a Renderer carve | brownstone scene/build/hit/react/sign; createScene takes brand; portrait → scene | 1 | A/B/C |
| 2b Shell carve | shell main/stage/input/tour/events/hud/overlay/dev; ui.js → panel + news; world/world.js; world/clock.js | 2a | A/B/C |
| 2c Names | shell/brand.js with today's values; desk/panel/news/hud read `names` | 2b | C, byte-identical DOM |
| A1 Clock, weather | world/clock.js, weather.js, brownstone/env.js | 2c | clock.test: New Year's Eve evening → next morning; ?date= previews a holiday |
| A2 Company model | world/world.js, brownstone layout/sim/render(3 lines)/react/build, shell events/panel/desk | 2c | world.test: refresh keeps state, task, log; a room goes dark only when all sleep (never the board's); unknown id asks for a refresh |
| B1 Contract | brownstone scene/hit/camera; shell input/tour/overlay/stage | 2c | tier C |
| C1 Brand loading | coordinator company.ts + server.ts (/api/brand), company/brand.yaml, theme/hq.yaml, mock/brand.json, shell brand/data/main, index.html | 2c | coordinator test: missing brand.yaml → {} and HQ boots on defaults; values come through |
| D1 Brand in renderer | brownstone iso/facade/sign/billboard/rooms | 2c | A zoomed on sign, plaque, billboard |
| B2 Hot swap | shell stage/dev (`hq.swap`), brownstone scene (dispose), swap-check.mjs | A2 + B1 | 10 swaps: frames after 1 and 10 identical; listeners, canvases, timers stable; no console errors |
| D2 Calendar | world/clock.js | A1 | clock.test: founded → birthday |
| M1 Mascots as config | brand.yaml, world/mascots.js, world.js, brownstone mascots/sim/rooms/billboard, shell/panel | A2 + D1 | A/B/C; --brand with 0 and 2 mascots: no errors, a screenshot to look at |
| M2 Mascot state in world | world/mascots.js, brownstone/mascots.js | M1 | A exact; B re-baselined after a reviewed contact sheet |
| C2 Manifest, icons | server.ts, sw.js, index.html | C1 | – |
| E Gate | pixel-check --brand | all | with a foreign brand, every panel and app: no Onlyonery, Gazette, HQ-OS, Juno or Skittles in the page; grep onlyonery in shell/world/renderers finds only the flagged key |

0 → 1 → 2a → 2b → 2c are serial. After 2c, A1, A2, B1, C1, D1 share no files and run in parallel. Then B2 (A2 + B1),
D2 (A1), M1 (A2 + D1) → M2, C2 (C1), E last.

## Risks
1. Shared agent objects: prototypes break on `{...A}` spreads or renderer writes to state/task; grep in A2.
2. `Math.random` order: moving code across `update(S)` changes tier B; no tier-B scenario ends a party.
3. Time: `hq.frame(t)` runs step(0), sets now = t, draws; the scene sets now in draw and adds dt in update.
4. Camera and panel: focusPoint assumes a panel is opening, clampCam reads panelOpen(); chrome() gives raw facts.
5. Bubbles: anchor()/near() must reproduce place() (hit.sx, hit.y0 − 2, ÷ dpr) and the tile-distance rule.
6. Taps: rooms.js hot-spot types map to shell object ids; the walls hit carries its room.
7. Brand sizes: sign 96, plaque 86 and lockup cuts from formulas that also fit other logos.
8. Dispose: stray setTimeouts (errands, petting 700 ms, bell toast 1400 ms, dev ack) and inline canvas styles.
9. The covers kit imports brownstone sprites and font: "brand book, not renderer" holds only once it has its own copy.
10. index.html, manifest and sw.js load before JS: until C2 their text flashes; fill placeholders before #loading hides.
11. mock/brand.json and mock/org.json can drift from the YAML.
12. Companies without a mascot lose the roof basket and bowl (shifts their roof props); never for Onlyonery.
