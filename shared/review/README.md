# Review mode

The board's feedback tool on every product page, and on every venture cycles' page at `cycles.preview.<zone>` (brand
directions, sketched sites, demos, a demo a deck opens; decks not yet). On a preview page the board taps the red pin (or just draws on
the page with a pen), then taps anything or draws on it (circles it, crosses it out, underlines it: as many lines as it
likes until the note goes; a rectangle with Shift held as a mouse starts a line) and says or types what should change.
Lines are a circle's mark to the note, its picture and whoever reads it (The pen, below). Each note carries:

- the note itself (typed, or spoken: its words appear as the reviewer speaks, from the voice line's recogniser through
  the coordinator's WebSocket at `<base>/__review/dictate`, platform/voice/README.md's "Dictation");
- the mark, as an anchor (`anchor.js`, v1): the page, the element (its selector, tag, text and box: inside an open
  shadow root too, like a chat's panel, its selector starting with the host's path, then a space; no text inside
  `[data-private]`, and no field's value ever), the screen it was seen on and the lines themselves (`ink`), all in the
  page's CSS px (the screen's plus its scroll). Drawn again, each point moves and scales with its element where that's
  still found and has a size, else stays where it was on the page. Review mode adds the kind, the area around all the
  lines and the element's HTML (form values stripped). Only review mode reads the lines back, to draw them again; HQ
  and the owner get the area and the screenshot with the lines on it. Notes kept before v1 were moved to it once
  (their screen px plus the scroll; an older circle's closed `path` became one line);
- a screenshot of the screen as it was, with the pin or circle drawn on it;
- pictures of the reviewer's own, pasted (Ctrl or Cmd+V) or dropped on the open note: thumbnails under its words, each
  with a × to take it off, drawn again on the device at most 2,000 px a side (a PNG stays one while it fits, the rest
  become JPEGs, which leaves out what a photo's file says besides its pixels). A dozen to a note. The board's go into
  its note's snip in the book, under the screenshot cut around the mark; an outsider's (200 waiting at once) go
  wherever the screenshot goes: My notes (a change keeps them by name), Reviews and `hq note`;
- the trail: the last 50 clicks, scrolls, page loads and route changes in that tab;
- the page path and the viewport (size, scroll position, pixel ratio, browser).

**On HQ itself** the board always has the same tool, on any of HQ's screens. The coordinator serves it there only
behind the board's sign-in. Each note goes on the board's sheet in the book for the agent whose work it's on (what's
drawn on names them, `data-owner`), else the CEO's, as a preview's go on its owner's (The flow, below); the post-it's
Send names that sheet ("Send to Juno"), and the menu names the sheet the last note went to (the CEO's before one).
A page that loads the tool itself (its script tag has `data-summoned`) hears the menu's Open the book as its
`review:book` event (detail: whose sheet). (the owners: job #19219)
A `review:cover` event (detail `true`, later `false`) hides the tool while the page frames another page with its own
pin, as HQ's viewer does around a preview. A note in progress returns when the viewer closes. Such a page also
summons the pin and puts it away (`review:summon`, detail `true` or `false`): HQ shows it while its book is open
beside the page (and on a phone, where the book has no room beside it), never folded; the Pencil writes either way,
and a preview's own pin is always there.

**The menu**: the pin stays just the pin; beside it a small round button carries
the count of notes not sent yet and opens a small menu in the guest pages' look (their colours, `guests.ts` palette,
which the coordinator writes into the script), as plain as a checklist for the outside people it also serves. Its
caption has the count ("Review · 2 notes to send"), and every line fits on one line in the menu's width, a phone's too:
an item's sub-line says only what its title doesn't. The board's menu says whose sheet in its book a note on this page
joins and how many are on it (`GET /__review/mine?page=<the page>`): "For Bolt · 2 on the sheet", and **Open the
book**, which inside HQ's viewer opens the book beside it at that sheet, and in a tab of its own opens HQ at it
(`/?open=book&owner=<id>`). The board has no My notes or Send my notes: it reads, corrects, wipes and sends its notes in
the book. The rest of the list is an outsider's:

- **General note**, for something across several pages, or that differs between them: the same sheet, typed or
  spoken, pinned to nothing (no element, spot or screenshot), saved with the page it was written on and the trail. It
  counts and goes with the other notes, and reads as "General note" in Reviews and in the owner's job.

<!-- the sidebar, the screenshot links and the board's Send, down to the end of this list -->

- **My notes**: an outsider's sidebar in the same look, each note a card, sliding in from the side (the whole width on a phone), with
  every note not sent yet as one scrolling list (`GET /__review/mine`): its screenshot as it went with the note, the
  spot marked, framed on the mark as the polaroid was (or the whole screen; a tap shows it bigger), its words in full
  and its page, and Change and Delete (`POST /__review/delete`, two taps).
  It closes with its ×, the Close at its foot (beside Send my notes), a tap on the dimmed page beside it or Escape. It
  fits what's visible, at the phone's own scale (the visual viewport): on a page laid out wider than the phone, or
  zoomed in, the fixed layer is bigger than the screen, so its × and foot would sit off it. **Change** opens the note's
  own sheet with its words, and its mark back on the page: the circle or rectangle on its element where that's still
  there (moving and scaling with it), else where it was on the screen; a pin's element outlined. **Redraw** there marks
  it again as a new note would, with a new screenshot (`POST /__review/edit` with the mark; under a new file name, so
  no browser shows the old picture); Escape or the pin puts the sheet back as it was. A note pinned on another page of
  the product opens that page first; one on another product's page (an outsider's link opens several) changes its
  words only. Saved or not, it goes back to My notes. They are the outsider's on the link until they send them (a delete
  removes it). The page's own code can read and change them too, as it can write notes: they go to the owner as
  outside data, never as the board's words. **The screenshots** are never served from the product's own origin, where its code could read
  them (an outsider's can show what they typed on another host of the link): `mine?shots` gives each a link on HQ's
  host, an image only, with no CORS, checked against the session the browser loading it holds there: the outsider's
  guest desk session from their door's code
  (`/guest/review-shot/<id>`: their own note, while they're still on the link and it's still theirs, checked at every
  load). The page's code sees the link and can show the picture, but can't read it, and the link alone opens nothing.
  On a device without that session (a page handed on to a phone) the notes show without their screenshots. The sidebar
  loads each picture as it scrolls into view.
- **Send my notes**, in the menu and at the sidebar's foot: an outsider sends theirs (two taps; once sent, a
  tester's **Add more notes**, below).

`review.js` is the tool's door: a small classic script that says hello to HQ's frame and loads the tool. The tool is
modules beside it with no dependencies, one concern each: `tool.js` puts them together (the shared state, Escape and
Cmd+Z), `dock.js` the pin, `menu.js` its menu, `notes.js` My notes, `change.js` changing a note, `surface.js` the page
while it's marked (pen and finger), `mark.js` what a mark keeps, `postit.js` the note's sheet and its polaroid (in the look of a scrap torn from HQ's book, its paper and indigo, on every page),
`pictures.js` the pictures added, `dictation.js` the mic, `snapshot.js` (with `copy.js`, `flow.js` and `faces.js`) the
screenshot, `trail.js` the trail, `layer.js` the layer over popups, `pencil.js`, `pentouch.js`, `tap.js`, `settle.js`, `lift.js`, `join.js`, `gestures.js`, `marks.js`, `marktaps.js`, `markpage.js`, `markshows.js`, `markfollow.js` and `written.js` the Pencil on HQ and its numbered
marks (below), `slip.js` and `markslips.js` the answers on them, `base.js` what they share. The coordinator serves
each at `/__review/<name>.js` behind the same gate as the real `review.js`; only `anchor.js`, `frame.js` and `ink.js`
are open on every host. Its UI lives in a closed shadow root, so product styles can't touch it, and it never logs or
photographs itself. `frame.js` frames a note's screenshot on its mark (the circle, or the pinned element and the pin's
head), for review mode's polaroid and HQ's note thumbnails alike; `anchor.js` finds a mark's element again on any width
(`node --test shared/review/frame.test.js shared/review/anchor.test.js`).

## The pen

`ink.js` (served at `/__review/ink.js` on every host, like `frame.js`) is the pen: one drawing engine for review mode
and HQ's Sketchbook. A stroke is plain data, `{ color, size, alpha, points: [[x, y, pressure, t], ...] }` in CSS px, so
anything can draw it again or replay it as it was drawn (`draw(g, strokes, { until })`, `svg()`), and the document hears
an `ink:stroke` event as a line starts, grows and ends (a walk-through call's recording follows the ink that way).

- **Pressure-sensitive and live:** a pen's own pressure (an Apple Pencil's, through Safari's Pointer Events; its lift,
  which Safari reports at no pressure, keeps the last), a mouse's or a finger's from its speed; each new bit drawn on its
  own canvas as it comes, so only a few shapes a point are filled, however long the line. Review mode's ink has a white
  edge, so it shows on any page.
- **Nothing moves as the pen lifts:** the line drawn live is the very line drawn dry. Each new point's box (whole device
  px) is filled once with every disc and band of the stroke that reaches it, as `draw()` fills the whole stroke, so soft
  edges don't add up where pieces meet; the live white edge goes on its own canvas under the dry ink (`under`, at 0.9),
  as `draw()` puts every edge under every line. `ink.test.js` compares the live pieces with the whole stroke for a pen,
  a mouse, a flick, a tremble and a loop; `inkcheck.mjs` compares the screen just before and after each lift in a
  browser (at most `STILL` pixels off: soft-edge rounding; a line that moved changes hundreds).
- **A pen starts it:** drawn across a page while review mode rests, a pen opens it right there, the line from where it
  touched, and the page doesn't scroll under it. A pen's tap stays the page's own. Once a pen has drawn on a note, only
  the pen draws (a palm resting on the screen doesn't); a finger still taps and scrolls.
- **Lines until the note goes:** the first mark opens the note (a tap as the first mark still pins what's under it); more
  lines can follow while it's open, open as drawn. The screenshot is the page at the first mark; every line is drawn on
  it, in the polaroid as it comes and in what goes with the note.
- **The strip**, over the page while it's marked: five inks (red, black, blue, green and a see-through highlighter,
  remembered on the device) and undo (Cmd or Ctrl+Z too). Undoing the first mark goes back to tapping or drawing, the
  words kept.
- **The first mark starts the mic**, where the browser records, on a computer and a tablet alike. A web page can't
  hear a Pencil's double-tap or squeeze (only apps can), so the mark itself is the trigger: the hand that draws needs
  no second gesture.
- **The words as they're said:** the mic's audio goes as 16 kHz PCM to `/__review/dictate` and each phrase's words come
  back while the reviewer talks (above). The clip is recorded too, and where the line can't be reached (or drops), it's
  transcribed whole by `POST /__review/voice`. Five minutes at most.

`pen-check.mjs` runs it held like an iPad mini: a pen's tap, a pen's line opening a note, a palm, the inks and undo, the
lines and the screenshot with them on the note, the pin dragged by its menu's handle, the first mark's mic with live words
from a stand-in line and the clip when it's down, a mouse's lines; `--shots dir` adds HQ in each look.

## The Pencil on HQ

On HQ's own pages (desk.js loads the tool with `data-book`) the Pencil writes and a finger works the page: no button,
no mode (`pencil.js`). A pen drawn across any of HQ's screens draws there and the page doesn't scroll under it; a finger
still scrolls and taps under the ink, a pen's tap stays the page's, and a pen in a text field is Apple's
handwriting-to-text. A mouse draws with the pin, as everywhere. HQ's page is `<body>`, beside the book on `<html>`
(platform/hq/shell/book.js): the tool lives in `<body>`, so it's the page's width and the book's spread covers it with
the page; over a dialog it leaves the book's room (`--book-room`); a pen or two fingers on the book are the book's.

- **A mark** is the lines drawn while the pen keeps coming back: its first line starts the mic once it can't be a tap,
  as a pen held still does (a pulse at the pen's last point while it listens; a tap never asks for the mic, house rule
  7), and the words said go in its note. **Rest the pen** 1.5 s and the mark is done
  (`settle.js`, the one way from a mark to the book, on a call or not): its note goes on its sheet in the board's book
  (`marks.js`: `POST /api/book/note` with the anchor, the words and how they came, and a snip of the page around the
  mark with its lines, 24 px of margin), and its ink **lifts** off the page into the book (`lift.js`: the book answers
  `pencil:landing` with where it lands, its page turned there, or the folded book's handle, which hears `book:landed`;
  `platform/hq/shell/booklanding.js`). No post-it and no Send: a mouse's mark with the pin goes the same way once the
  mouse rests; a page with no book keeps the post-it. HQ's page is a sheet's page in today's book for its owner (made at its first
  note, `page/new`).
- **Hairlines:** every note in the book shows on HQ's page as a faint hairline of its ink, sent or not, so the page is
  clean for the next mark (`marks.js`). A finger's tap on one opens its card (`marktaps.js`): its words, where it is
  ("For Lark, not sent", "On your call with Juno", "Sent Tue 09:12") and its answers. HQ keeps one address whatever
  screen is open, so a hairline shows only while what it was drawn on is on the screen (`markshows.js`): its element
  found again (the element itself, else its selector), mostly the words it had, taking room, and on top at the mark's
  middle (not under another screen or a dialog). The marks are drawn again as the page changes what it shows
  (`markfollow.js`).
- **Join, wipe, undo:** a line drawn on or beside a hairline joins its note (`join.js`: the note's ink and the new lines
  one mark, then `note/edit` with its ink, the snip cut again and the words added). A scribble over a mark or a
  hairline wipes its note, from the book too; over a sent note's, only the hairline clears, on this screen. A two-finger
  tap or Cmd/Ctrl+Z takes back the last thing: a line, a lift, a join, a wipe, a clear. A finger pressed inside a
  hairline's ring and dragged onto the open book tapes its snip there (`carry.js`), the note left as it is.
- **A pen's tap** is a click, never ink (`tap.js`, shared with the book): lifted within 300 ms, never 10 px from where
  it touched, it clicks what's under it, focused, on HQ's page and over a dialog. (`pentouch.js` has the pen's and the
  fingers' touches.)
- **Not for ink**: a page's floating control marked `data-no-ink` (HQ's minimised call) takes the pen as a finger, to
  drag or tap, never ink (`pencil.js` theirs).
- **Written words**: once the pen rests 1.2 s, the mark's lines go as a
  picture of the ink alone, dark on white, to `POST /api/book/read` (the coordinator's `handwriting.ts`: a small model
  on a seat says whether it's writing and what it says). The words are the note's while it holds no words
  typed or said, stand beside the ink as type (`marks.js`), and the note keeps them as `written` (changed first:
  `typed`). Lines that went before they were read are read as they go, and their words go in the note when they come (`note/edit`, then
  `pencil:words` on the document for the book). Never on a call: its agent sees the ink.
- **Hold the pen still** on one spot for half a second and talk: a red pulse at its tip, the words landing there as a
  note (a pin on what's under it) as the pen lifts, on a call too (the call's own hearing). Nothing heard, no note.
- **Ring something** and the mark is on what's inside the ring. A wiped note comes back whole with an undo, last on
  its sheet. Nothing asks "are you sure?". A wipe or undo the book refuses changes nothing, and the step stays to take
  back.
- The document hears `pencil:note` (`{ id, n, page, call }`) as each note goes into the book, for the book and a call.
- **A second screen** (`handover.js`; HQ's `shell/pair.js` pairs a phone or tablet with a desktop by the book's code):
  while `<html data-paired>`, the Pencil tells `pencil:mark` (the open mark as an anchor and its words, or null) at each
  change and `pencil:flick` when its post-it is thrown away by its paper; `pencil:hand` `{ take: mark, reply }` opens a
  mark from the other screen here, post-it and caret ready, and `{ give: true, reply }` lets the open mark go. Nothing
  goes across on a call. On HQ a mark goes into the book from the screen it's drawn on as it settles, its ink drifting
  off that screen, and the other screen's book turns to it (`pair.js` tells it the note's page; `pencil:wiped` has it
  read a wiped note's page again).

**On a call** (`callnotes.js`; HQ's `shell/calldraw.js` tells it through `call:on`, `call:off`, `call:heard` and
`call:ink`): a mark goes on the call's page in the book (`kind: 'call'`, made at the call's first mark by either side,
its notes on a sheet of their own that's never sent: the coordinator's `bookcalls.ts`; the book shows them on that
page), not on a sheet. No mic of its own: the words the call heard while it was drawn (or while the pen was held still,
a voice note) are its words; it settles and lifts as every mark does, and HQ's call then sends it to the agent. The
agent's ring (its `draw` tool) is drawn round what it names on the board's screen, or round one of the call's notes, in
its own ink with its words beside it, kept as its note on the call's page (`by`), then lifts into the book too. Its snip
goes to the agent with what the watch-along keeps out (`[data-private]`, `[data-watchalong-hide]`) painted over
(`snapshot(r, { masked })`); lines drawn while a mark goes in are drawn and make the next; a mark the book doesn't take
stays, the pin's tip says so (the pin back while it speaks, even with the book folded), and it goes in with the next line (tried once more as the call ends). `book-check.mjs` plays it (`bookcall.mjs`).

**Answers** (`slip.js`, `markslips.js`; the coordinator's `bookslips.ts`): an agent's answer clips onto its note as a
slip, typed under a paper clip, with then and now: the note's snip beside the same place cut again from the live page
(once its mark is on the screen and the page has been still 1.2 s, kept on the store with `slip/now`, one cut per
answer), or something new's running preview (its picture and link). The page shows a slip's corner under an answered
number; a tap on the mark (or a hairline) opens its card with the slips. A tick in a slip's box closes the note; words
written under it go as the reply, a new note on the same sheet (`slip/reply`). The book (HQ's `shell/bookslips.js`)
draws the same slips, and there a tick written over one with the Pencil ticks it. HQ's feed brings a new answer at
once (a `book` event). `book-check.mjs` plays it (`bookslip.mjs`).

`platform/hq/book-check.mjs` plays it in WebKit held like an iPad mini, with the book's store and the voice line played,
and the ring, its number and Send again in Wire (in Chromium: Linux's headless WebKit has no en-CA dates, so Wire can't
start there).

## On a phone, and inside HQ

- **HQ's preview viewer** (where the desk phone, the Library and decks open previews) is a frame. There the tool
  runs only right inside HQ: the coordinator writes HQ's origin into the script (`{{HQ_ORIGIN}}`), the script says
  hello to it, and it starts once HQ answers from that origin. A page that frames another preview gets no pin.
  The viewer bar then shows a red **Note** button that starts a note in the frame. HQ asks every page its frame loads, and the page's review mode answers with its
  hello: Note stays only where review mode runs, after any move to another page (a page's goodbye as it unloads
  doesn't always arrive).
- **The pin keeps out of the way:** bottom right, above the home bar. When one of the product's buttons or links
  sits under it (not a huge one, like a whole card), it moves up above it (up to 40% of the screen height), and back down when the page moves on. Dragged
  somewhere (by the pin, or by its menu's button beside it, which looks like a handle: a tap there still opens the menu),
  it stays there on that product. On a shorter screen (the phone turned sideways, HQ's viewer) it stops at
  the top edge and goes back to its spot on a taller one.
- **Over a page's popup** (a modal dialog or a popover, like a "More things" sheet): the browser puts it in its top
  layer, over any z-index, and a modal one leaves everything outside it dead. While one is open, review mode's host
  sits inside the topmost popup a tap reaches (with a modal dialog open, the one the browser lets a tap reach, found by
  a hit test, or a popup opened inside it after it) and joins the top layer after it as a manual popover, so the pin,
  the picker, the note and My notes are over the popup and work on what's in it; it goes back to the page's end when
  the popups close. A tap or a key on review mode stays its own (a popup that shuts on a tap beside it stays open), and
  Escape that puts away review mode's note, menu or sidebar leaves the popup open. The screenshot copies each open
  popup over the page in the order they opened, each over its backdrop in a stacking context of its own (so a popup's
  own z-index, which the top layer ignores, doesn't reorder them). The order is kept as they open: a dialog's open
  attribute and a popover's `beforetoggle`, both as they happen. The limit: popups already open when review mode starts
  are taken in the page's order, the modal dialog a tap reaches over the rest, as the browser tells no more. A browser
  without popovers (Safari before 17) leaves the pin at the page's end, under a modal dialog.
- **The first three pages** a reviewer opens show a bubble, "Tap the red pin to leave a note", until the pin is used or
  waved off ("Got it"). The coordinator counts them for the person (the board, or a share's guest: `/__review/coach`),
  so the shop and each of its apps, each on a host of its own, don't ask again.

## The flow

1. The board pins a note on `<slug>.preview.<zone>`, or on `cycles.preview.<zone>`, whose notes HQ files by the
   cycle folder the page is in (`cycles/<folder>`), its owner the agent who made the folder: the first agent on a desk
   whose commit added a file to it (`owed.ts` maker()), else the CEO, who hands it on; a page in no folder is
   **Venture cycle pages**, the CEO's. HQ's own pages are the CEO's unless what's marked names an agent (job #19219).
   The note goes on the board's open sheet
   in its book for that owner, on today's sheet page for them (one a day, whatever the page's address: `book.ts`
   sheetPageFor), as a book note: its anchor, its words, and a snip, the screenshot cut around the mark with the
   pictures added under it (`platform/coordinator/src/bookreview.ts`). It does **not** go to an agent, and its words ask
   nothing, a question too: only the board's own words in HQ do. The trail, the element's HTML and the browser stay
   out: the book has no place for them. Pinning puts nothing over the page: the pin boings and counts the note.
2. The board reads the sheet in its book in HQ (review mode's Open the book takes it there), where it corrects, wipes
   and adds to the notes, and taps the plane to send the sheet. The ten seconds after are its undo; a note that joins
   then waits for the next sheet.
3. The sheet goes to its owner as one job (`booknotes.ts` deliver). Each note is kept as a sent note too, which its job
   reads with `hq note <id>` (the snip as its screenshot) and Reviews lists. A sheet no seat can take goes to the CEO's
   routing check (`routing.ts`), which hands its notes on.
4. The job carries only what the board saw in its book: the note, its page, and the element's tag, selector and text
   (quoted, one line each). `hq note <id>` also saves the snip to `$TMPDIR/review-note-<id>.XXXXXX.png|jpg` (a new file
   each time) so they can look at it.
5. HQ's Reviews keeps the record (Sent): each sheet sent, newest first, as one block (who it went to, when, its job,
   its notes with their snips and how each was answered), then the review notes sent before the book.

The board's notes that waited in HQ from before the book moved onto their owners' sheets once, as open notes (their
screenshot, or else their first picture, as the snip).

Why the book, and no send from the page: a preview page runs the product's own code, and that code can post a note
too (same origin, same cookie). A note proves nothing about who wrote it. Only a sheet the board sends from its book,
behind HQ's sign-in and after seeing every note on it, reaches an agent, so a note the page wrote waits in plain sight
with the rest.

## The gate

- Caddy sends `/__review/*` on every product host and on `cycles.preview.<zone>` to the coordinator, never to the
  product or the cycles' files (`infra/products.py`), outside the preview login.
- The cycles' pages (`*/` and `*.html` on `cycles.preview.<zone>`) come from the coordinator too, behind the login: it
  adds the tag at the end of each page that lacks it (`server.ts` cyclePage). Their other files stay Caddy's.
- On the front's preview door, `front.preview.<zone>`, every shelf's `/<slug>/__review/*` goes to the coordinator
  too, which files the note under that product with the page's path on it.
- `GET /__review/review.js` is the real script only on `<slug>.preview.<zone>` for an existing product (or on
  `cycles.preview.<zone>` while `products/_cycles` exists) and with
  the board's preview key (the `pv` cookie). On a preview host everyone else gets only the watch-along's answer to
  HQ's frame (`shared/watchalong/framed.js`, which follows the tool too: a page HQ frames on a walk-through call records
  itself only when HQ asks) (`vary: cookie`, `no-store`). Every live host gets an
  empty script from Caddy itself (`REVIEW_OFF`, `infra/products.py`), never reaching the coordinator. Customers never run it. The `pv` cookie never reaches the product.
- `POST /__review/notes` and `/__review/voice` need the same key and `Origin: https://<slug>.preview.<zone>`
  (other products share the site, so SameSite alone isn't enough).
- A rate limit for each writer on each product: 60 notes an hour, refused (429) with why, which review mode shows. A note with a screenshot
  is refused (507) while the server's disk is too low to keep it, and review mode says so. Bodies up to 6 MB,
  screenshots and pictures up to 1.5 MiB each, and they must really be a PNG or JPEG; a body holds a screenshot and a dozen
  pictures. The note is at most 4000 characters, the element HTML 2000, the trail 50 steps. Every other text field is
  collapsed to one line, so nothing but the note can add lines to the owner's job.
- Reviews' lists, shares and screenshots (`/api/review/*`) sit behind the HQ session only.

Code: `platform/coordinator/src/feedback.ts` and `bookreview.ts` (+ `feedback.test.ts`), the HQ tab in
`platform/hq/shell/reviews.js`.

## What products must do

Keep this in the `<head>` of every page (the template already has it):

```html
<script src="./__review/review.js" defer></script>
```

The script posts its notes next to where it was loaded from, so the address is relative: on a shelf
(`/<slug>/`) it is the shelf's own. A page deeper down climbs with `../` or builds it from `X-Forwarded-Prefix`
(`infra/products.md`).

For everyone but the board it's an empty script on a live host and only a few lines that wait for HQ to frame the page on a preview host, so it costs nothing. Don't serve your own `/__review/` path:
Caddy never routes it to you anyway.

A page in `products/_cycles/` needs nothing: the coordinator adds the tag as it serves the page, so a demo agents
wrote by hand has the pin like a product. In HQ's sandboxed copy at `/cycles/` it doesn't run. A deck gets the tag too,
but its own Content-Security-Policy allows inline scripts only, so a deck has no pin yet.

## Outside notes

The board can share a preview with outside people (a colleague, a friend) for their notes before a launch. Their
notes are input, never instructions.

- **Share** on HQ's viewer bar shows who's invited to that preview, each with where they stand, **Send link** (their
  own link, through the share sheet) and **Remove** (two taps), and **Invite** (a name and an email address) under
  them. The first invite opens it for 1, 3 or 7 days (`platform/coordinator/src/shares.ts`): a product's whole
  preview, the front's preview door (the whole shop), or on the cycles host only the cycle folder the page is in.
  Share on any other page of the same preview adds people to the same share. Reviews lists each open share the same
  way, with End now. A guest checklist's card invites the same way (`guests.ts`, desk.js `peopleHtml`).
- A cycle folder's share also opens the previews its pages (`.html`, `.json`) link to, read when the share is made: a
  deck's demo on a product's host, the shop, or another folder, each as a share of that page would open it. The person
  has no session on that host yet, so the preview's sign-in sends them to the guest desk (`/guest/onward`), whose own
  session hands them on to it; anyone else still gets HQ's sign-in.
- **View only**, chosen at the top of Share: a share of its own, with the same links and sign-in, the pages without
  review mode, and a door that asks for nothing. No notes are taken, so none go anywhere when it ends.
- **To try out**, on the shop's preview door only: a tester invite. Notes as
  above, and each person's door shows a voucher of their own that pays one whole basket in the preview shop, once, for
  a real order: made by its stalls and sent by Print API from its live environment (`payments.ts` `paidByTester`,
  `parcels.ts` `printer`). The voucher works while the invite is open and the person is on it; the board's list shows who
  ordered, and from which stalls. The notes' job hears the same, never the order's details.
- Each person's link is a guest desk link (`guests.ts`, its "doors"). The person proves the address with a code by
  email, the same sign-in as a guest checklist's. Open then hands them to the preview host, which keeps their session
  in a host-only `ps` cookie: no other host gets it, and Caddy drops it before the product (`infra/products.py`).
  Remove stops their link and session at once; inviting them again gives a new link.
- `ps` opens that host under that path, the kits' files, and review mode (not for view only). It never opens HQ,
  another host or folder, or the preview's chat (Caddy asks the check with `?board=1` there), so an outsider files
  nothing on the board's desk phone and finds no real order. The board's own key wins where both are set.
- Every note keeps who wrote it: the person's name and the address they signed in with (`review_notes.author`,
  `author_email`). Their notes are saved with the share, as `outside`; the board's book never sees them. Once they went, Reviews lists them in the product's history with who wrote each. The rate
  limit is each person's: 60 an hour.
- Review mode gives an outsider **Send my notes** in the pin's menu (two taps): they add no more, and review mode is off
  for them from then on (a tester's keeps only its menu's Add more notes). Once everyone still on the share has sent theirs, it ends; it also ends at its date (a
  one-minute sweep) or with End now. All its notes then go to the owner of what was shared as one job, signed, which
  reads them as outside data, builds the board one short deck of what we'd change (who raised it, our recommendation,
  in our own words) and sends it on one card once the deck is on main. No notes, no job. The job's brief, whole, stays
  within a quarter of the model's context: the notes in full while they fit, and for the rest the `hq notes --before`
  page to start from. The roll of who was on the share takes at most a quarter of it, and `hq reviewers <share>` pages
  through everyone and the jobs its notes went to.
- The pin's count for an outsider is all their notes on the share still to go, wherever they pinned them (the shop's
  pages and its shelves'): review mode reads it from `/__review/mine` on every page. Send my notes shows in the menu
  only once that count is one or more. A tester who has sent theirs gets **Add more notes** on their door and in
  review mode's menu (`POST /__review/more`) until the invite's date: it takes their notes up again, and opens an invite
  that ended only because everyone was in (not one the board ended). Such an invite keeps its testers' sessions for
  that, each opening only while its tester may still take theirs up. The later
  notes go to the owner as a follow-up job, which names the first.
- For an outsider the pin's first bubble says who the notes go to, and the first note says once that a picture of the
  screen goes with it.
- **An early look** (the same one-minute sweep): while a share is open, once the oldest note no look has had is an hour
  old, the new notes go to the owner as one short job that fixes only what's plainly broken (an error, a
  button that does nothing, a wrong total) and leaves the rest for the deck. Each note is looked at once
  (`review_notes.early`). The job marks a note it fixed with `hq note <id> fixed [job:<n>] "..."` (`fixed`, `fixed_by`),
  and the gather's job shows those as done, not as asks. Once the fixing job's pull request is merged and deployed (the
  wakes' `deployed`), the outsider's next preview page shows `thanks.js` after the tool (or alone, once they've sent):
  thanks, it's fixed, refresh and try again, in the page's language, once per fix (`thanked`), with × to close it.
  A fix not live yet goes to the gather's job as one to check, not done. An
  outsider may still change or delete a note a look already has: changed words are a new note for the next look; a
  deleted one is gone from the deck, but the look's job keeps the words it was given.

Checks: `node --test src/shares.test.ts` (in `platform/coordinator`) and `node platform/hq/shares-check.mjs`.

## Before and after, for a card

A card that brings work back for the board's look leads with each change as it was and as it is now (the Board
requests playbook). `shot.mjs` takes one of those pictures, held like a phone (390 px wide, twice the pixels), cropped
to an element with a margin, with anything floating over it hidden:
`hq preview <slug> -- node shared/review/shot.mjs /en/about-us/ about-after.jpg --selector "#who" --hide header`.
Shoot the before and the after with the same arguments, so the two frames match.

## Privacy

- The screenshot shows the screen as the board saw it, except password fields: those stay empty.
- The element HTML goes without form values: hidden and password inputs are dropped, other inputs lose their
  `value`, textareas their text.
- The trail logs where the board clicked and scrolled, never what it typed.
- The tool runs only for the board and the outside people it shares a preview with, so no customer data passes
  through it. Don't paste customer data into notes.

## Testing locally

- **HQ's Reviews:** serve HQ (`node platform/hq/serve.mjs`) and open it on `localhost`. Dev mode kicks
  in and Sent reads `mock/book-sheets.json` and `mock/review.json`.
- **The tool on a page:** serve a product's `app/public/` and, in Playwright, route `**/__review/*.js` to this
  folder (`parts.mjs` does it) and `**/__review/notes` to a stub that records the POST body. The UI's shadow root is closed:
  force it open with an init script that wraps `Element.prototype.attachShadow`. The pin button bobs, so click
  it with `{ force: true }`.
- **The book:** `node platform/hq/book-check.mjs [--shots dir]`, the book's stories in a browser.
- **The gate:** `cd platform/coordinator && node --test src/feedback.test.ts`.
- **The screenshot against the browser:** `node shared/review/snapshot-check.mjs [--shots dir]`. A note's screenshot of
  a sticky header with a row under it, a `::before`/`::after` picture, a chat in an open shadow root and fixed or sticky
  boxes in a faded-out or filtered wrapper, a low z-index parent, an overflow:hidden one and an overflow:clip one,
  and under a later positioned sibling (theirs or their overflow:hidden wrapper's), at the top and scrolled, spot by
  spot. A tap on the chat's panel pins the panel inside its shadow root, not
  the chat's empty host element. Cards that turn over in 3D (faces with
  backface-visibility: hidden in a preserve-3d flip) show only the face turned towards the board, the right way round.
  The copy matches the browser on these cards too:
  - a card turned just past edge-on under an off-centre perspective shows its front
  - a card moved by a calc() translate shows its front
  - a card flattened by will-change: opacity or by an overflow:hidden box shows its front
  - a face turned away hides its plain child, but not a child with its own transform
  - an inline box of text with a turn shows, because the browser doesn't turn it
    Two more pages, at a phone's size. One is scrolled below its fold:
  - its header sticks above the top, and a sticky box and a sticky `::before` band in its first row cover the row under
    it as on screen (a sticky pseudo-element can't be measured, so its place is worked out from its parent's box and
    the viewport)
  - a sticky `::after` at the bottom of a tall box sits under that box's content (its last child shifted by
    `position: relative`, or a line of text), and sticks to the bottom of the screen while that content runs past it
  - a label one line wide on screen stays on one line in the copy, though the copy draws it wider (its font from a
    style sheet the copy can't read, as Firefox draws text a hair wider)
  - the margins a block's first and last child let through it land as on screen, on screen and off it
  - an inline SVG's shapes are painted by the page's style sheet
    The other page scrolls its own boxes, not itself:
  - a row scrolled sideways, a main scrolled down and a positioned box scrolled down with an absolutely positioned box
    in it, each shown where its scroll has it
  - main's sticky header, narrower than a wide box in main and centred, stays at main's top
  - a `body::before` with a negative z-index is painted over the body's background, as the browser paints the page's
    background under everything
    Three last pages have popups open, the pin tapped where it is on screen. On one, a modal dialog moved by a transform over a sticky header with a high
    z-index, its own backdrop and a z-index of -1, opened in one go with a popover just before it (under its backdrop)
    and two after it, the first with a high z-index and the second, over it, with a low one. The tap reaches the dialog's
    button through its backdrop, the note is pinned on that button, the dialog (which shuts on a tap beside what it shows)
    stays open, and the copy stacks them as the browser does. On the other, two modal dialogs open before review mode
    starts, opened in the reverse of their order on the page: the note is pinned in the one opened last, which the copy
    shows over the other. On the third, a modal dialog opened inside another, then a popover inside the outer one but
    outside the inner one: the note is pinned in the inner dialog, the one a tap reaches.

<!-- includes platform/hq/mock/artifacts.json -->

- **Every way the board opens a demo, on a phone:** `node shared/review/check.mjs [--shots dir] [--only hello]`
  (after `npm ci` in `platform/coordinator`). The real coordinator, every product's server and a Caddy stand-in with
  TLS (on 127.7.2.2:443) run on this machine. Then an iPhone-sized touch screen in Chromium opens each product from a desk-phone card,
  HQ's viewer, "Open in browser" (twice), the Artifacts tab's tile (each `status: live` product gets the board's
  approval there, so a live app's tile and its "live ↗" link to the public site, titled as having no notes, are
  covered) and the cycle deck's buttons, to a
  product or a cycles demo (and back),
  and every cycle page but a deck from HQ's viewer and "Open in browser" (`--only cycles` for just those), and checks the real script, the pin
  on screen and clear of HQ's bar and the product's buttons, a tap on it and on the bar's Note button, no pin in a
  foreign frame, and a drag that sticks. A cycles page's PDF link, tapped in HQ's viewer, must save with the page staying
  put (with its `download` and without; in the whole Chromium, `channel: 'chromium'`: Chrome shows no PDF in the viewer's
  sandboxed frame, and only it shows that). About 3 minutes. Chromium only: WebKit's quirks still need a real iPhone.
