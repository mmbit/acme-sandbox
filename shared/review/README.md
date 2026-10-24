# Review mode

The board's feedback tool on every product page, and on every venture cycles' page at `cycles.preview.<zone>` (brand
directions, sketched sites, demos, a demo a deck opens; decks not yet). <!-- --> On a preview page the board taps the red pin, then taps
anything (or draws a circle around it, or a rectangle with Shift held as the drag starts) and says or types what should
change. A rectangle is a circle whose line is its four corners: the note, its picture and whoever reads it treat it as one. Each note carries:

- the note itself (typed, or spoken and transcribed by the coordinator);
- the element: its selector, tag, text, HTML (form values stripped) and position, plus the circled area and the line
  drawn around it (inside an open shadow root too, like a chat's panel: its selector starts with the host's path, then a
  space). Only review mode reads the line back, to draw it again; HQ and the owner get the area;
- a screenshot of the screen as it was, with the pin or circle drawn on it;
- pictures of the reviewer's own, pasted (Ctrl or Cmd+V) or dropped on the open note: thumbnails under its words, each
  with a × to take it off, drawn again on the device at most 2,000 px a side (a PNG stays one while it fits, the rest
  become JPEGs, which leaves out what a photo's file says besides its pixels). A dozen to a note, 200 waiting at once.
  They go wherever the screenshot goes: My notes (a change keeps them by name), Reviews, a call and `hq note`;
- the trail: the last 50 clicks, scrolls, page loads and route changes in that tab;
- the page path and the viewport (size, scroll position, pixel ratio, browser).

**On HQ itself** the board summons the same tool from Settings (Pin a note on HQ), on any of HQ's screens. The
coordinator serves it there only behind the board's sign-in. Its notes wait in Reviews under HQ, and a send goes to
the CEO's routing check like any other (step 3 below). A page that summons the tool (its script tag has `data-summoned`) gets Put the pin away
in its menu, a `review:summon` event brings it back, and Send my notes is the page's `review:send` event (the notes' ids).
A `review:cover` event (detail `true`, later `false`) hides the tool while the page frames another page with its own
pin, as HQ's viewer does around a preview. A note in progress returns when the viewer closes.

**The menu**: the pin stays just the pin; beside it a small round button carries
the count of notes not sent yet and opens a small menu in the guest pages' look (their colours, `guests.ts` palette,
which the coordinator writes into the script), as plain as a checklist for the outside people it also serves. Its
caption has the count ("Review · 2 notes to send"), and every line fits on one line in the menu's width, a phone's too:
an item's sub-line says only what its title doesn't:

- **General note**, for something across several pages, or that differs between them: the same sheet, typed or
  spoken, pinned to nothing (no element, spot or screenshot), saved with the page it was written on and the trail. It
  counts and goes with the other notes, and reads as "General note" in Reviews and in the owner's job.
<!-- the sidebar, the screenshot links and the board's Send, down to the end of this list -->
- **My notes**: a sidebar in the same look, each note a card, sliding in from the side (the whole width on a phone), with
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
  words only. Saved or not, it goes back to My notes. The board's are its notes waiting on this product until it sends or discards
  them in HQ (a delete there is a discard); an outsider's are theirs on the link until they send them (a delete removes
  it). The page's own code can read and change them too, as it can write notes: the board still sees every note in HQ
  before anything goes. **The screenshots** are never served from the product's own origin, where its code could read
  them (an outsider's can show what they typed on another host of the link): `mine?shots` gives each a link on HQ's
  host, an image only, with no CORS, checked against the session the browser loading it holds there: the board's HQ
  sign-in (Reviews' own `/api/review/shot`), an outsider's guest desk session from their door's code
  (`/guest/review-shot/<id>`: their own note, while they're still on the link and it's still theirs, checked at every
  load). The page's code sees the link and can show the picture, but can't read it, and the link alone opens nothing.
  On a device without that session (a page handed on to a phone) the notes show without their screenshots. The sidebar
  loads each picture as it scrolls into view.
- **Send my notes**, in the menu and at the sidebar's foot. An outsider's sends theirs (two taps; once sent, a
  tester's **Add more notes**, below). The board's is a hand-over, since the page could forge a send: inside HQ's
  viewer it asks HQ for the send step (Reviews over the preview, nothing ticked), in a tab of its own it opens HQ's
  Reviews at those notes (`/?open=notes&notes=<ids>`).

`review.js` is the whole tool, in one file with no dependencies. Its UI lives in a closed shadow root, so product
styles can't touch it, and it never logs or photographs itself. Beside it, `frame.js` frames a note's screenshot on its
mark (the circle, or the pinned element and the pin's head): the coordinator serves it at `/__review/frame.js` on every
host, for review mode's polaroid and HQ's note thumbnails alike (`node --test shared/review/frame.test.js`).

## On a phone, and inside HQ

- **HQ's preview viewer** (where the desk phone, the Library and decks open previews) is a frame. There the tool
  runs only right inside HQ: the coordinator writes HQ's origin into the script (`{{HQ_ORIGIN}}`), the script says
  hello to it, and it starts once HQ answers from that origin. A page that frames another preview gets no pin.
  The viewer bar then shows a red **Note** button that starts a note in the frame, and a **Send N** button while the
  board has notes waiting on the product, from this sitting or before (review mode lists them to HQ: see the flow). HQ asks every page its frame loads, and the page's review mode answers with its
  hello: Note stays only where review mode runs, after any move to another page (a page's goodbye as it unloads
  doesn't always arrive).
- **The pin keeps out of the way:** bottom right, above the home bar. When one of the product's buttons or links
  sits under it (not a huge one, like a whole card), it moves up above it (up to 40% of the screen height), and back down when the page moves on. Dragged
  somewhere, it stays there on that product. On a shorter screen (the phone turned sideways, HQ's viewer) it stops at
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
   **Venture cycle pages**, the CEO's. It's saved as **pending** in
   the coordinator. It does **not** go to an agent.
2. The board reads pending notes in HQ: the computer's **Reviews**, grouped by product, with the screenshots. The
   computer's button and the Reviews icon count the notes waiting. A short way there: **Send N** in HQ's viewer bar,
   or review mode's own Send my notes, opens Reviews over the preview at that product. Closing the computer, or a send
   from that product, goes back to the preview. It ticks no note. Pinning puts nothing over the page: the pin boings
   and counts the note, and that's all. The page in the frame can post notes and ask for the send step too, so
   nothing it says chooses a note.
3. The board ticks the notes it recognises and taps **Send N**. Every note starts unticked, and one that
   arrives while the tab is open stays unticked, so it never rides along unseen. At most 50 go per send, to the CEO's
   short routing check (`platform/coordinator/src/routing.ts`; a send before it starts joins it). It runs first and
   below the worker's room line, and turns the notes into the work they ask for (`hq route` lists them): one task per
   improvement, related notes in one, each with its own title, code, owner and thread in the notes' project (`hq job
   ... --notes <ids>`), or into the brief of a job in that area that an agent queued and that hasn't started (`hq route
   '#<job>'`, as `hq extend` adds). A product's notes are a piece of its return to the board
   (`platform/coordinator/src/owed.ts`), which ends with the product back on the desk phone (a card filed with `--back
   <slug>`): its owner's task holds it when it can, else HQ queues the owner's return after the tasks, in the product's
   project (`project:` in `product.yaml`). A note the check leaves stays unrouted until a later CEO job routes it (HQ's
   summary lists it). The board can discard the rest (and a discarded note's screenshot is deleted).
4. The job carries only what the board saw in HQ: the note, its page, and the element's tag, selector and text
   (quoted, one line each). The owner reads the rest (screenshot, HTML, browser, trail) with `hq note <id>`,
   which also saves the screenshot to `$TMPDIR/review-note-<id>.XXXXXX.png|jpg` (a new file each time) so they can look at it,
   and each picture added to it to `review-note-<id>-picture-<n>.XXXXXX.png|jpg`
5. Or the board taps **Call <owner>** next to Send, and talks the ticked notes through with the owner
. The call's prompt carries them as a sent note's job reads them, and their
   screenshots go to the agent with the board's first words. Starting the call sends nothing. On it the agent rewords a pin (`pin_words`) and
   marks one sent (`pin_sent`): with the job it queued for it, or answered on the call (no work; Reviews says
   "answered"), and tells the board which. A pin nobody marks stays waiting, for Send or another call.

Why the extra step: a preview page runs the product's own code, and that code can post a note too (same origin,
same cookie). A note proves nothing about who wrote it. Only a batch the board sends from HQ reaches an agent,
and the Notes tab tells the board to send only what it recognises as its own.

## The gate

- Caddy sends `/__review/*` on every product host and on `cycles.preview.<zone>` to the coordinator, never to the
  product or the cycles' files (`infra/products.py`), outside the preview login.
- The cycles' pages (`*/` and `*.html` on `cycles.preview.<zone>`) come from the coordinator too, behind the login: it
  adds the tag at the end of each page that lacks it (`server.ts` cyclePage). Their other files stay Caddy's.
- On the front's preview door, `front.preview.<zone>`, every shelf's `/<slug>/__review/*` goes to the coordinator
  too, which files the note under that product with the page's path on it.
- `GET /__review/review.js` is the real script only on `<slug>.preview.<zone>` for an existing product (or on
  `cycles.preview.<zone>` while `products/_cycles` exists) and with
  the board's preview key (the `pv` cookie). Everyone else, and every live host, gets an empty script
  (`vary: cookie`, `no-store`). Customers never run it. The `pv` cookie never reaches the product.
- `POST /__review/notes` and `/__review/voice` need the same key and `Origin: https://<slug>.preview.<zone>`
  (other products share the site, so SameSite alone isn't enough).
- A rate limit per product: 60 notes an hour, refused (429) with why, which review mode shows. A note with a screenshot
  is refused (507) while the server's disk is too low to keep it, and review mode says so. Bodies up to 6 MB,
  screenshots and pictures up to 1.5 MiB each, and they must really be a PNG or JPEG; a body holds a screenshot and a dozen
  pictures. The note is at most 4000 characters, the element HTML 2000, the trail 50 steps. Every other text field is
  collapsed to one line, so nothing but the note can add lines to the owner's job.
- Reading, sending and discarding (`/api/review/*`) sit behind the HQ session only.

Code: `platform/coordinator/src/feedback.ts` (+ `feedback.test.ts`), the HQ tab in `platform/hq/shell/desk.js`.

## What products must do

Keep this in the `<head>` of every page (the template already has it):

```html
<script src="./__review/review.js" defer></script>
```

The script posts its notes next to where it was loaded from, so the address is relative: on a shelf
(`/<slug>/`) it is the shelf's own. A page deeper down climbs with `../` or builds it from `X-Forwarded-Prefix`
(`infra/products.md`).

For everyone but the board it's an empty script, so it costs nothing. Don't serve your own `/__review/` path:
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
  `author_email`). Their notes are saved with the share, as `outside`; the board's waiting notes, its count, Send and
  Call never see them. Once they went, Reviews lists them in the product's history with who wrote each. The rate
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

- **HQ's Notes tab:** serve HQ (`node platform/hq/serve.mjs`) and open it on `localhost`. Dev mode kicks
  in and the tab reads `mock/review.json`. Sending and discarding work in memory.
- **The tool on a page:** serve a product's `app/public/` and, in Playwright, route `**/__review/review.js` to
  this file and `**/__review/notes` to a stub that records the POST body. The UI's shadow root is closed:
  force it open with an init script that wraps `Element.prototype.attachShadow`. The pin button bobs, so click
  it with `{ force: true }`.
- **The short way to sending:** `node platform/hq/notes-check.mjs [--shots dir]`. HQ with a stand-in coordinator and a
  product page running this file in HQ's viewer and in a tab of its own: the count, both send steps and HQ's link
  with nothing ticked (a forged send message, a note the page posted and an older one included), a late note unticked; a note on a shelf posted to the shelf's own path.
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
  and every cycle page but a deck from HQ's viewer <!-- --> and "Open in browser" (`--only cycles` for just those), and checks the real script, the pin
  on screen and clear of HQ's bar and the product's buttons, a tap on it and on the bar's Note button, no pin in a
  foreign frame, and a drag that sticks. A cycles page's PDF link, tapped in HQ's viewer, must save with the page staying
  put (with its `download` and without; in the whole Chromium, `channel: 'chromium'`: Chrome shows no PDF in the viewer's
  sandboxed frame, and only it shows that). About 3 minutes. <!-- --> Chromium only: WebKit's quirks still need a real iPhone.
