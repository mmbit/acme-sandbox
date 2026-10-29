# The native shell: HQ as an app on iPhone and iPad

A thin app that loads HQ's web app in a web view (WKWebView) and adds only what a browser can't do, through a bridge.
There's no native copy of HQ's screens: everything on screen is the web app, served as usual.

What it adds:

- **Calls with the screen off** (`HQ/CallAudio.swift`). With `audio` in `UIBackgroundModes` (`Info.plist`), WebKit
  keeps the page's microphone running while the app is in the background: Safari and a home-screen app mute it as the
  screen locks. During a call the session is a voice chat, the proximity sensor blanks an iPhone's screen at the ear,
  and the call is heard on AirPods or another headset while one is connected. Without one, it plays from the speaker
  while the phone is held out, and from the earpiece at the ear or with the screen locked.
- **Signing in with a code.** A passkey works in an app only when Apple ties the app to HQ's domain (associated
  domains, a paid developer account). So HQ's sign-in page gives way to its one-time device code (`/pair`): on a
  device already signed in, the Notebook's Shelf › Devices shows the code.
- **The microphone without asking again**: HQ's own pages get it once the app has the system's permission.

## The bridge

The page talks to the app with `window.webkit.messageHandlers.shell.postMessage(message)`, and only HQ's own origin is
heard. A page outside the shell has no `window.webkit` and sends nothing.

| Message           | Sent by                                  | What the app does                                    |
| ----------------- | ---------------------------------------- | ---------------------------------------------------- |
| `{ call: true }`  | `platform/hq/shell/callaudio.js` start() | voice chat session, proximity sensor, call's routing |
| `{ call: false }` | callaudio.js close()                     | the session as it was, sensor off                    |

## The company's part

`Shell.xcconfig` includes `theme/ios.xcconfig` when it's there: the company's HQ address (`HQ_URL`) and the app's id
(`PRODUCT_BUNDLE_IDENTIFIER`). Without it the app opens `http://localhost:8080`.

## Building it

On a Mac with Xcode 16 or later (no Apple Developer account needed):

1. Open `platform/ios/HQ.xcodeproj`.
2. In the HQ target's Signing & Capabilities, choose your Apple ID's personal team. If Xcode says the app id is taken,
   change the last word of `PRODUCT_BUNDLE_IDENTIFIER` in `theme/ios.xcconfig`.
3. Plug in the iPhone or iPad, pick it as the destination and press Run. The first time, the device asks you to trust
   the developer (Settings › General › VPN & Device Management) and to turn on Developer Mode (Settings › Privacy &
   Security).

An app signed with a personal team runs for 7 days, then needs another Run from Xcode.
