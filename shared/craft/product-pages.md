---
title: "Product pages and app screens that sell honestly"
kind: note
tags: [craft, product-pages, ux, conversion, accessibility]
verified: 2026-10-02
---

# Product pages and app screens

Learned while building and reviewing personalised product apps from the first screen to the order page. The words
are in `copy.md`, the sound in `sound.md`.

## Before they pay

- **A signature moment.** Each app has one thing at its heart that people would show a friend (watching it grow,
  hearing it click into place). Build the page around getting there fast.
- **Show everything they'll get before they pay.** Every page of a book, every part of a set: a small picture with a
  one-line caption, and a tap to see it large. The preview is drawn by the same code as the print (`print.md`).
- **The price includes tax and shipping before checkout,** and nothing is added at checkout. Say so.
- **No pressure:** no fake scarcity, no countdowns, no guilt, no upsell people don't need. Cancelling is as easy as
  buying.
- **Warn about quality before they pay:** a photo too small to print sharply gets a plain warning in the preview.
- **Not open yet?** An honest "opening soon" that works without any partner or payment call, with no countdown or
  waitlist pressure.

## After they pay

- **Every status the code can enter has an honest message and a way out.** When a fix makes a state stricter, check
  which orders the old code already left in it.
- **Sad states get no celebration:** a cancelled or refunded order has no "make another" and no replay
  (`generators.md`).
- **Show the message before any follow-up call** that might fail or hang.
- **Ask the partner, then tell the customer** (`print.md`): a failed call isn't proof nothing happened.

## Feel

- **Spring animations and sound** on the key moments, with a mute toggle that's remembered.
- **If it looks like a button, it works.** A pill with a lip, a card drawn as a key, a logo with a knob on it: people
  press it, and one that does nothing feels broken. Give each a real press (it goes down, clicks, does something, even
  something playful like a new colour scheme), or draw it flat. A key with buttons on it is a key too.
- **Touch:** open sheets on `click`, not `pointerdown`. End a drag at once, never in a `setTimeout`, and use a separate
  flag for the click that follows it. Tap targets at least 44 pixels.
- **Fit the smallest phone** (360 pixels wide) and check the large screens too.
- **Contrast:** 4.5:1 for text, on every generated colour (`pictures.md`).

## Building it safely

- **Data from a catalogue or the URL is untrusted.** Accept known keys only, colours only as `#rrggbb`, text only
  through `textContent`, pictures only as paths inside the site. Test `?x=<img src=x onerror=alert(1)>` in a browser.
- **`[hidden]` loses to a `display` rule** on buttons and cards: add `[hidden] { display: none !important }`.
- **Nothing from other sites:** fonts and libraries are self-hosted, and there are no third-party trackers.
- **Every page says who made it:** the company's AI disclosure, links to the legal pages, a help link.

## Checking it

- **As a first-time user,** on the screens people will use, on the same code the server runs. Count the taps to
  change something ("two or three" is good).
- **A screenshot in a review note can show a bug the note doesn't mention.** Look at the element and the click trail
  that came with it (`reviews.md`).
- **One fix, every product.** When one app gets a guard or a promise fixed, check the others for the same gap.
