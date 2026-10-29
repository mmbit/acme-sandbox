# The watch-along

A page of ours records itself so an agent can see along, live, and anyone can watch it back: a walk-through call
(the caller chooses to show the screen and goes on using HQ or a demo), later the support chat with a customer who
agreed.
It records the page's DOM as it changes ([rrweb](https://github.com/rrweb-io/rrweb), MIT, `@rrweb/record` and
`@rrweb/replay` in the coordinator's dependencies), never pixels from the device: a server renders any moment from it.

## In the page

```js
import { watch } from '/shared/watchalong/watchalong.js';
const watching = watch({ url: session.events, typed: 'shown', onEnd: why => {} });
watching.mark(tag, payload); // a moment of the page's own (the pen's ink it hears by itself)
watching.pause(); // nothing recorded until resume(); the agent sees "paused"
watching.resume();
await watching.stop(); // what's recorded so far sent, then stopped
```

- `url`: where the batches go, the store's session route with its key (the coordinator's `POST /api/watchalong/start`
  hands it out for a live call). A batch goes once a second, sooner when 200 events wait; with nothing to send (a quiet
  page, or paused) an empty one goes, which the store keeps nothing of, so the page still hears whether the agent sees
  it (`onSeen`) and that the session is over.
- `typed`: `'shown'` keeps what's typed, except passwords (the board's own calls); `'hidden'` keeps only that something
  was typed, and how much (guests, customers). Frames follow the page that asks them.
- `canvasFps`: canvas pictures a second (HQ's building is a canvas), 0 for none. `canvas.js` takes them, loaded only
  then: each canvas on show, never a hidden or private one, at most one pixel for each on screen, encoded in a worker
  (WebP, JPEG where the browser makes no WebP: Safari), and only when it changed. They are rrweb canvas mutations, which
  its replayer draws with `UNSAFE_replayCanvas: true`. rrweb's own `recordCanvas` stays off: it encodes each canvas
  twice on the main thread at every start and resume, which takes 0.7 s on Brownstone and 1.7 s on Holo at an iPad's
  size and a quarter of the speed (a start takes 0.15 s with `canvas.js`). The worker is `encoder.js`, served beside
  it from the page's own origin, which a policy without `worker-src` (HQ's) allows; a blob's worker it refused, and no
  canvas reached a call (job #19916).
- `onEnd(why)`: `'stopped'`, `'over'` (the call ended), `'full'` (the session's room, 507), `'too big'` (one event
  past what a post holds, 413) or `'unreachable'` (8 MB held while the server couldn't be reached). A post holds at
  most the store's `BATCH_BYTES`, so a big backlog goes in several.

Beside rrweb's own events it records custom ones: `tap` (`x`, `y`, `pointer`, the target's `role` and `label`: its
`aria-label`, field label, `alt`, `title` or text, never a field's value, nor the text of a control holding a hidden,
private or typed-in part) and `page` (`address`, never the title, which a page may fill with a person's words: the
recording masks the title too) at the start and whenever it changes; `paused` and `resumed`; and whatever the page
marks.

**The pen's ink** (`shared/review/ink.js`, review mode's pen and HQ's Sketchbook) goes in as data, never as pixels: the
recorder hears each stroke's `ink:stroke` events and marks `ink` moments (a stroke's start and end whole, its moves as
the points since the last, at most one every 100 ms; the end with where it is on screen and what's under it, named as
a tap's target is), in a frame too, on the document it was drawn on. A canvas of dry ink drawn again (a note's lines,
fewer after an undo, none once sent) says what it shows now (ink.js `shown`). The ink's canvases are
`data-watchalong-hide`; the Sketchbook's page keeps its own canvas pictures, so its finished strokes stay drawn until
its next picture. `strokes.js` reads the events back: the strokes on screen at any time (`Inks`, `inkAt`), and draws
them over a replay in each document's place (`paint`, `placer`), as the mirror and the player do.
**Kept out:** passwords and hidden fields' values always; anything inside `[data-watchalong-hide]` (an empty box in
the replay: key fields). Inside `[data-private]`, for the board too (a person's address,
email or phone, a customer's case: mark them where a page shows them): the text, what's typed, every attribute but
those the replay draws by (`class`, `style`, `id`, sizes and rrweb's own: `DRAWN` in watchalong.js), and pictures
(`img`, `picture`, `video`, `canvas`, `svg`, a frame, and a marked part of a drawing, like lettering drawn as paths, go
as empty boxes, and a `style` loses any declaration with an address: a background, a mask, a cursor). Mark the field
itself where only what's typed is someone's (a checkout's address fields): its label stays. In HQ that's Care, Mail, an
email card, an address card, a call out's number and people's emails on a share, the support chat's panel (inside its
shadow root: a mark doesn't reach through one). Everywhere: a page's
title (masked, as a private part's text), its query string and fragment, and any path part that looks like a token
(`/join/<token>`), in the page's address and in its links' and frames' addresses (a picture keeps its whole address:
the replay loads it by it); a link of another kind keeps only its kind (`mailto:`, `tel:`); other sites' frames.

In HQ, the call screen's Show my screen starts one, never minimising (`platform/hq/shell/callscreen.js`:
`typed: 'shown'`, `canvasFps: 0.5`); its Stop showing and the bubble's Pause
pause it, and the call's end stops it. The call's own window, its bubble and its cards are recorded as the board
sees them: the agent's picture is the board's screen (job #19916).

## In a frame

A page of ours in another origin's frame (a preview in HQ's viewer) records itself only when the framing page asks.
It runs `answerFrames(framer)` with the framing page's origin; `framed.js` does on HQ's first ask, from HQ's origin
(its viewer, or a guest's join page), loading this file from beside itself then and handing on what HQ said meanwhile
(`answerFrames` returns what it does with a message). The coordinator
serves `framed.js` after review mode's script, HQ's origin filled in, whether that page's viewer may take notes or not
(a guest who sent theirs is still seen); it says `{hq: 'watchalong', hello}` to HQ as the page loads and `bye` as it
goes, which is how the join page knows the frame answers. `watch()` asks every frame as it
starts and as each frame's page loads, and tells them to stop on pause and at the end. rrweb's cross-origin frame
mode sends the frame's events up to the framing page's recorder, which keeps them in its own stream. On preview hosts
the coordinator serves both files at `/__review/watchalong.js` and `/__review/vendor/rrweb-record.js`; on HQ's host at
`/shared/watchalong/`.

## On the server

`store.ts` keeps sessions on any `node:sqlite` database and folder (the coordinator's for calls; care can open its
own): `open`, `start(purpose, ref, typed)` (an id and the page's key, kept as its sha256), `add` (a batch: the HTTP
status to answer), `end(purpose, ref)`, `read` (the events in order, and `clockMs`, how far the page's clock ran behind
the server's, to line the events up with a transcript), `sessionsOf`, `forget`, and `sweep` (sessions past `KEEP_DAYS`,
90). Each batch is one gzip member appended to `<folder>/<id>.ndjson.gz` (0600) with the time it came in.

## What an agent sees

Agents can't watch video, so a session reaches one as lines and pictures.

- `moments.ts` folds the stream into moments as it comes (`add`, `settle(now)` on the page's clock): a page change, a
  tap (its label and role), a scroll and typing once they settle (`SCROLL_MS`, `TYPING_MS`; typing says how much and
  in which field, never what), a pen stroke (`ink`, its `end`: its shape and what's under it, `circled "Add to basket"
  (button)`), a dwell (`DWELL_MS` still on a screen that changed),
  paused and resumed, the screen resized. Each is its own moment, numbered from 1; `lines()` writes them with their
  times, the same words in a row as one line, counted (`#4–6 … (×3)`).
- `mirror.ts` keeps a live session replayed in headless Chromium (`shared/chromium`, the one driver over the DevTools
  pipe): one browser, a tab per live session running rrweb's replayer in live mode, fed each batch
  (`open`, `feed`); `now` takes the screen in about 0.15 s, `at` replays a past moment in a tab of its own (about 0.5
  s). JPEG (PNG when asked) at the long side asked for, a tap ringed, a region zoomed, the pen's ink drawn as the
  caller saw it (SVG over the replay, sharp at any size; a stroke still being drawn as far as it has gone). Nothing reaches outside: the replay's own files
  come from the app's `@rrweb/replay`, what the recorded page asks for goes to the app's answer, told the origins of the
  recording's pages, its frames' included, that the app lets the session show (`open` and `at` take its word: the
  recording is only the page's), and the rest is refused. The coordinator answers HQ's own pictures and
  stylesheets from disk, found as HQ serves them. It answers a preview's pictures, fonts and stylesheets only when the
  recording was on that preview host and the session may show it: the board's call any preview (its key opens each), a
  guest's walk-through only the hosts its call out's share reached when it started (`store.ts` keeps them with it). It fetches them through Caddy on a pass of HQ's own (`previewfiles.ts` `mirrored`:
  held in memory, one host's files, GETs only, never a page or a script), within `LOADING_MS` and 16 MB each, typed by
  their names. Nothing goes to any other host, and a proxy that isn't there stops anything else.
  Nothing of the recorded page runs either (an onerror, a javascript: address): the replay's page allows only its own
  script files, and rrweb's frame takes that policy on (the frame runs scripts, as rrweb draws canvas frames only so).
  A mirror closes with its session or after `IDLE_MS` with nothing recorded or asked; Chromium with the last one.
  Each tab is a window of its own (a hidden tab never paints), a picture waits only on the pictures on screen (a lazy
  one below it never loads, so never decodes), and every step has `STEP_MS`: one that fails or runs past it closes
  its mirror, which opens again from the recording when next asked for (`seen` says false until then). Without that a
  step left hanging held every later picture of its session behind it, silently. 15 s is how long the voice line waits
  for the coordinator. A step past its time closes only its own tab while Chromium still replies (`REPLY_MS`), so a
  slow page leaves the other mirrors alone. A Chromium that doesn't reply closes, every mirror with it, and the next
  opens in a fresh one. A mirror opens with only what the screen still shows (`shown`): the events since the last full
  snapshot, each canvas's latest picture alone (canvas.js's wipe the whole canvas). From the whole recording a share of
  HQ's building took 2.8 s to its first picture after 10 minutes and past 15 s after 30; now 0.9 s after 60 (measured
  with Chromium 1243, a 744 × 1133 canvas at 0.5 frames a second, 58 KB each).
- Memory (measured with Playwright's Chromium 1243, proportional set size of the whole process tree): about 440 MB
  with one mirror open, growing about 2.5 MB a minute at HQ's canvas rate (90 frames a minute; 520 MB after 30
  minutes), and about 60 MB more for each further mirror.
- The coordinator (`watchalong.ts`) mirrors and folds every live session from its first batch, and answers the voice
  line: `POST /api/voice/screen-turn` (with a caller's turn: the moments since the agent's last, at most 20, and a
  picture at 1024 px when the screen changed, the last tap ringed; while paused, lines only; the briefing's paragraph
  for a session that hasn't had it; a picture not there within 1 s, the lines without it and a line saying so, as the
  voice line waits 1.5 s for the whole answer) and `POST /api/voice/screen` (the agent's screen tool: now or a past moment at 1568
  px, a region, or the moments since a time). Both by the session's purpose and the thing it belongs to, and only for a
  purpose with its own briefing (`BRIEFS`: the board's call, a guest's walk-through), so no other is ever told it sees
  the board's screen.
  Its answer to each of a watched session's batches carries `seen` (the page's `onSeen`), the batch that opens the
  mirror's once it has opened or failed to: HQ's call shows the eye only while the agent's side has the screen, and
  says when it doesn't.

**For agents, after the call.** A job steps back through an ended walk-through call with `hq call <id> moments` (the
call's moments and its transcript's lines in one timeline by the server's clock, each with its time on the company's
clock: `17:03:12  #14 tapped "Add to basket" (button)`, `17:03:10  [12] Board: and then this one here`) and `hq call
<id> screen <time>` (a PNG of the screen then, 1568 px on its long side, the ink drawn and a moment's tap ringed, saved
to a file: `17:03:12`, `#14`, or `+2m10s` from the call's start). Both on exactly the access `hq call <id>` has (the
coordinator's `GET /api/agent/call` with `view`, `watchalong.ts timeline` and `screenAt`). The lines line up because
the voice line keeps when each was said (`calls.line_times`: a turn's start, the board's words from their first sound,
the agent's reply from when it was first heard); a call from before they were kept has none, and lists only its moments.
## Checking it

- `node --test shared/watchalong/store.test.ts shared/watchalong/moments.test.ts shared/watchalong/shown.test.ts
  shared/watchalong/mirror.test.ts` (the mirror's needs `CHROMIUM_PATH`), and the coordinator's
  `src/watchalong.test.ts`, `src/watchtimes.test.ts` and `src/callviews.test.ts` (hq call's views; their pictures need
  `CHROMIUM_PATH`). `walk.test.json.gz` is a walk-through recorded with
  watchalong.js in Chromium (moments.test.ts says what's in it).
- `node shared/watchalong/check.mjs [--shots dir]`: a page and a page of another origin in its frame are recorded in
  Chromium, as a guest and as the board, while someone taps, types and moves on in the frame. It checks what the
  recording holds and keeps out, and has rrweb's replayer draw the moment after a tap in the frame (PNGs in the temp
  folder). It needs the coordinator's `node_modules` (`npm ci` there).
- `node platform/hq/private-check.mjs`: HQ as the board's call records it (Care, Mail, the desk phone's email, address,
  key and guest cards, typed into), with none of the mock customers' details or that typing in the stream.
## Watching it back

`player.js` replays a recording in any page of ours, with nothing of the page
around it in it: rrweb's replayer in a frame of its own (`replay.html`, whose policy draws the recorded page's
stylesheets and runs only its own two scripts, so nothing the recording carries runs, in it or in the replayer's frames
under it), the pen's ink drawn over it as it was drawn (`strokes.js`, on a canvas in device pixels), a scrubber
(`scrubber.js`) with ticks for taps, pages and ink, and the moments beside it, the one it's at marked and kept in view.

```js
import { Player } from '/shared/watchalong/player.js';
const player = new Player(box, { replay: '/shared/watchalong/replay.html', ink, moments, start, end, side, icons, sound });
player.add(events); // as they load, in order: it shows the screen once a snapshot is in
player.destroy();
```

- `ink`: ink.js's module. `moments`, `start`, `end`: the recording's (moments.ts; its first and last event's time).
  `side`: HTML under the moments. `words`, `icons` (`play`, `pause`, `back`, `forward` as markup): the page's own.
  `sound(name)`: `'play'`, `'pause'`, `'jump'`, `'tick'` (the scrubber crossing a moment), `'speed'`.
- Play and pause, 5 s back and on, 1×, 2× and 4×, a moment or the track tapped to jump there, the thumb dragged with a
  finger, a pen or a mouse; Space and the arrows. The frame styles the parts (`.wp-*`); the player sets only what
  placing them needs. One animation frame loop while it plays or is dragged moves the scrubber by transforms and draws
  the ink; sizes are read on resize alone. A seek on goes on from where the replay is; a seek back rebuilds it from
  the page's last snapshot.
- In HQ, the computer's Calls has Watch it back on a call with a recording (`GET /api/calls`, `recorded`), which
  opens `platform/hq/shell/callplayer.js`: the call's notes and what we heard on it beside the moments, never the
  transcript. `GET /api/calls/recording?call=<id>` (the board's) sends the recording as gzipped NDJSON: its head first,
  `{ clockMs, moments, start, end, agent, ts, request, notes, items }`, then each event, so the screen shows while the
  rest comes (`callviews.ts forBoard`).
- `node platform/hq/callplayer-check.mjs [--shots dir]` (`BROWSER=webkit`, or `all`): the player from the call log on
  an iPad mini's screen and a laptop's, in every look: the replay, ticks, a moment's jump, the ink, play, a drag, the
  keys, and the frame times with the CPU slowed 4× (Chromium). `src/callplayer.test.ts` in the coordinator: the flag,
  the route and the replay's policy.
