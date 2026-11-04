# The native shell: HQ as an app on iPhone and iPad

A thin app that loads HQ's web app in a web view (WKWebView) and adds only what a browser can't do, through a bridge.
There's no native copy of HQ's screens: everything on screen is the web app, served as usual.

What it adds:

- **Calls with the screen off** (`HQ/CallAudio.swift`). With `audio` in `UIBackgroundModes` (`Info.plist`), WebKit
  keeps the page's microphone running while the app is in the background: Safari and a home-screen app mute it as the
  screen locks. During a call the session is a voice chat, the proximity sensor blanks an iPhone's screen at the ear,
  and the call is heard on AirPods or another headset while one is connected. Without one, it plays from the speaker
  while the phone is held out, and from the earpiece at the ear or with the screen locked.
- **The Pencil drawn by PencilKit** (`HQ/Pen.swift`). While the notebook is open with the pen or the highlighter, a
  transparent PencilKit canvas lies over its paper and the Apple Pencil draws there: Apple's own ink, as quick as
  Notes'. Fingers never meet it and go to the page as ever (moving the page, taps, the tools), and so does the Pencil
  off the paper. Each finished stroke goes to the page (`platform/hq/shell/ink/booknative.js`), which plays it as the
  pen's own pointer events, so the book takes it exactly as one drawn on the page (a scratch-out, a line through words,
  Undo); the canvas's line fades as the page's is painted. A Pencil's tap is a click where it tapped (the rail's mic
  among them: a voice note). With any other
  tool, in the overview or with the book folded, the Pencil is the page's, as in a browser; in a browser nothing of
  this loads.
- **Signing in with the passkey, in Apple's sign-in sheet.** A passkey works in a web view only when Apple ties the
  app to HQ's domain (associated domains, a paid developer account). So when HQ asks for its sign-in, the app opens
  HQ's sign-in page in Apple's sheet (ASWebAuthenticationSession), a browser of its own where the passkey works: tap
  Sign in the app, unlock with the passkey as in Safari, and HQ opens in the app. The unlock gives the sheet a
  one-time code (good once, for a minute) instead of a session, the app trades it for its own session with a secret
  only the app that opened the sheet holds, and nothing of the sheet's is kept (coordinator `auth.ts`,
  `createAppCode`). The secret stops a code taken on the way, not another app that opens the sign-in page itself:
  unlock in the sheet only when HQ's app has just opened it. Only the associated domains close that. A pair code
  (`/pair`) never signs a device in: it opens one shared page to view.
- **The microphone without asking again**: HQ's own pages get it once the app has the system's permission.

## The bridge

The page talks to the app with `window.webkit.messageHandlers.shell.postMessage(message)`, and only HQ's own origin is
heard. A page outside the shell has no `window.webkit` and sends nothing.

| Message           | Sent by                                  | What the app does                                    |
| ----------------- | ---------------------------------------- | ---------------------------------------------------- |
| `{ call: true }`  | `platform/hq/shell/callaudio.js` start() | voice chat session, proximity sensor, call's routing |
| `{ call: false }` | callaudio.js close()                     | the session as it was, sensor off                    |
| `{ pen: { … } }`  | `platform/hq/shell/ink/booknative.js`    | the Pencil drawn natively on the paper               |
| `{ pen: false }`  | booknative.js                            | the Pencil the page's                                |

`pen` carries `paper: [x, y, width, height]` (the paper on screen, in the page's px), `tool` (`pen` or
`highlighter`), `color` (`#rrggbb`), `size` (the line's width on screen as it lands: at the board's own zoom while a
slide has lent one) and `alpha`, every one of them always, sent again whenever
one changes. The other way, the app calls `window.shellPenDown(x, y)` as the Pencil touches the paper,
where it touched (a zoom the page lent is the board's again then, as at a press in a browser), and `window.shellPen(points)` with each stroke, `[x, y, pressure 0–1, ms from its first point]` in the
page's px; it resolves once the page has painted the stroke, and only then does the canvas's line go. A stroke the
page didn't take stays on the canvas until the Pencil is the page's again, and is said in the device's log (category
`pen`).

## The company's part

`Shell.xcconfig` includes `theme/ios.xcconfig` when it's there: the company's HQ address (`HQ_URL`) and the app's id
(`PRODUCT_BUNDLE_IDENTIFIER`). Without it the app opens `http://localhost:8080`. `HQ_URL` names the host in
`infra/host`: a move of HQ changes both (`docs/foundation.md`).

## Building it

On a Mac with Xcode 16 or later (no Apple Developer account needed):

1. Open `platform/ios/HQ.xcodeproj`.
2. In the HQ target's Signing & Capabilities, choose your Apple ID's personal team. If Xcode says the app id is taken,
   change the last word of `PRODUCT_BUNDLE_IDENTIFIER` in `theme/ios.xcconfig`.
3. Plug in the iPhone or iPad, pick it as the destination and press Run. The first time, the device asks you to trust
   the developer (Settings › General › VPN & Device Management) and to turn on Developer Mode (Settings › Privacy &
   Security).

An app signed with a personal team runs for 7 days, then needs another Run from Xcode.

Nothing here has been built on a Mac yet. The first Run proves what no check here can: that it compiles, that
PencilKit's gesture draws from the web view it's moved onto (the canvas's own touch stays off, so fingers reach the
page), that the Pencil off the paper still presses the tools, and that the passkey signs in through the sheet. The
page's side is checked in a browser (`platform/hq/book/native.mjs`, the book's check), and the sign-in's server side in
the coordinator's `security.test.ts`.
