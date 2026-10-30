# The profiler

Memory and smoothness of a page over a long session, measured on the board's own device, so a leak shows as growth and
lag that builds up shows as slow frames late in the session. One switch turns it on, on HQ or on any product's preview:

```
hq profile on hq                 # HQ, for 24 h (or --hours <n>, a week at most)
hq profile on <product>          # a product's preview host (any artifact the board opens there, HQ's viewer too)
hq profile on                    # everywhere
hq profile                       # each page's session in the last day (--since <time>, or hq profile <where>)
hq profile --session <id>        # one session's samples, a JSON line each
hq profile off                   # everywhere (or hq profile off <where>)
```

Nothing is asked of the board: a page it loads while the switch is on starts measuring. The coordinator serves
`profile.js` after review mode's `review.js` (`feedback.ts`), so it reaches every page that carries review mode: HQ's own
screens and every preview page, framed in HQ's viewer or in a tab of its own. Only the board's pages run it (its HQ
sign-in or its preview key), never an outside reviewer's or a customer's. A page left open after the switch goes off
hears no from HQ and stops.

## What a sample holds

Every 20 s, sent to HQ each minute and once more when the page goes (`pagehide`), kept a week (`profiles.ts`):

- `heap`: the JS heap in MB, where the browser tells it (Chromium). WebKit, the iPad's engine, doesn't: there the
  counts below are what shows a leak.
- `nodes`: every element, in open shadow roots too, and `regions`: the body's biggest children by their elements
  (`#book`, `#projects`), which says where the page grows.
- `canvases` and `canvasMb`: canvases still alive, made by script or from markup (in the page or not, until they're collected) and their pixels.
  iOS kills a page whose canvases take too much memory, and caps WebGL contexts (`webgl`). `audio`: open AudioContexts.
- `resize`, `mutation`, `intersection`: observers observing. `listeners`: listeners on `window` and `document` by type
  (an element's go with it). `intervals`: intervals running. `timeouts` and `animationFrames`: asked for in the
  sample's 20 s, so a loop started twice shows as a rate that doubles.
- `frames`: frames shown, frames slower than 60 ms (three or more dropped at 60 Hz) and the worst gap, while the page shows.
  `longTasks` where the browser reports them (Chromium).
- `state`: the root's and body's classes and the root's `data-` attributes, which say which view was open.

A page's session also says what came before it in the same tab: a reload or navigation (it closed with a `pagehide`)
or a page the browser killed without one, and whether it was hidden then. `hq profile` prints a page killed while it
showed as "ended without closing" (out of memory, a crash), and one killed in the background as "ended in the
background", since iOS reclaims hidden pages without a pagehide too.

The profiler measures by wrapping the browser's own constructors and calls (`createElement`, `addEventListener`,
`setInterval`, the observers' `observe`), from the moment it loads. On HQ that's once review mode loads, so counts
start a little after the page does: growth is what matters. While it's on, one animation-frame loop of its own measures
frames.

## Trying it in a browser

`node platform/hq/profile-session.mjs [--engine chromium|webkit] [--look brownstone]` runs HQ in dev mode at an iPad
mini's size with the profiler on from the first script (samples every 5 s): at rest, then rounds of opening and closing
its views, then at rest again, and prints a table of what each phase ended with. In Chromium it adds the browser's own
counts after a garbage collection (heap, every node including detached ones, every listener). Run it on the render
helper (`hq run --kind render -- node platform/hq/profile-session.mjs`).

