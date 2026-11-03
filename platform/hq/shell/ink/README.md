# Ink, in HQ's browser

Ink is the pen platform as a whole: the Sketchbook you draw in, marks drawn anywhere and sent to it, the sheets that
send them to agents, their answers, the call's view of the page, and one-time sign-in on another device. This folder
is its browser side in HQ. The coordinator's side is `platform/coordinator/src/ink/`, the marks on any page are review
mode's (`shared/review/`), and the ink's one outline is `shared/review/ink.js`.

The Sketchbook is one part of Ink, and the only name the board sees. In code it is the book (`book*`): the paper on
the right of HQ's screen, its rail, pages, tools, sheets and Search. Invited people use the same Notebook shell with
scoped pages. (HQ's Sketchbook app on the computer, `sketch*`, is gone: the book is the one notebook.)

- `book.js` opens the book beside HQ's page. `bookpages.js`, `bookpage.js` and `booksave.js` draw and keep its pages,
  `bookgroups.js` a page's groups, a paperclip on each of two or more things, and the answers under them, `booktear.js` and `bookpagesend.js` a page torn off at its right edge, where the spine is, onto Submit, PDF or PNG (a guest's, its Send),
  `bookforyou.js` what's still the board's to answer (an open ask edged "for you", counted over the page's name, its arrows going to each),
  `bookrail.js` Undo and Redo on the bar and Close notebook in its dots menu, `bookshelf*.js` the overview and the Shelf, `booksearch*.js` Search. `notebook*.js` read
  and write the Notebook's routes (`notebookdata.js`), and play them in dev mode and book-check (`notebookplay*.js`).
  (the Notebook's groups and the sheets gone)
- `bookanswers*.js` draw a try's versions on a notebook page and what the board writes on them, and a slip's form
  (`bookanswerreply.js`); the answers themselves are slips under their note (`bookgroups.js`), the agent's face and
  pencil dots there while one comes. The book's hand: `fonts/`, Caveat under the OFL (`fonts/OFL.txt`; `--bk-hand` sets
  another). `bookshelfopen.js` lists the open forms and questions in the overview.
- `bookversions.js` draws a try's versions under the board's scrap, one self-contained block (its API at its top): a frame
  per version with its live preview, pencil dots while one is coming, why a try ended empty. The board's pen on a frame
  goes as a reply on that version (`bookversionframes.js` `frameUnder`: where, never what shape), and a pick is stamped CHOSEN.
- `bookscrapdraw.js` draws a taped picture (a scrap) in its border and tape, and makes a picture file ready to upload.
- `calldraw.js` is the Pencil on a call, with the call's agent on the same page, and the call's notes page opened as
  it's picked up.
- `pair.js` shows a one-time sign-in code for another device. Notebook content syncs through its model.
  Marks on the viewed work travel live between the board’s devices through `viewmarks.js` and the board feed.
  Review mode’s `sharing.js` places them on the same element at each screen size. They disappear with the open
  note and are never kept in the feed’s history. A disconnected device’s marks expire after three missed refreshes.
- `agentink.js` is an agent's own ink, and `pagemerge.js` merges two writers' saves of one page.
- `bookarrive.js` sets down whatever arrives on a page (from the store, or pasted, dropped or heard here) with the
  paper's landing (`bookpaper.js` `land`): held off the page while a copy comes down onto its place. Checked by
  `book/arrival.mjs`.

A scrap the board just saved (the pin flow) lands in the book: `booklanding.js` lands its ink on its photo
(`pencil:landing` with `group`) and turns to one saved elsewhere (`book:scrap`); `bookgroupshow.js` turns to its page
and slides it into view clear of the controls; `notebookstack.js` says where the store stacks the next one. Folded, the pull tab's tap opens the book at it.

The book's routes keep their addresses (`/api/book/…`): they are the Sketchbook's.

## The board's rules

The board set these for Ink. Code and checks that keep one say it, or name it here by its first words.

- **A blank page isn't kept once it's left.** A sketch page with nothing on it goes as another page shows.
- **Handwriting stays ink.** Nothing turns the board's writing into type, on the page or in what's saved, and the pen
  never strikes typed words out. Whoever reads a note reads its strokes. Only a call's agent gets them read out for
  it, by Haiku 5.5 (`platform/coordinator/src/ink/inkread.ts`), and never onto the page.
- **The Undo takes back only the board's own steps.** An agent's change, or one made on another screen, is no step.
  The board deletes or changes it as it would its own.
- **Nothing stays drawn (rule zero).** A mark's ink leaves HQ or an artifact once its note is saved or let go.
- **On a call the pen is for the call's agent.** HQ's pin, the viewer's pin and the bar's Note go away for the call
  and come back after it. The board inks in red, and a mark goes to the call's agent with the words the call heard.
  It never goes into the notebook by itself and is never judged: the agent decides what becomes of it. Its ink stays
  drawn until the agent's turn on it is done, and anything left goes at the hang-up.
- **One tap starts the microphone.** Its button asks for it, never a mark, and nothing on a page has to be held down.
  The Pencil's tap on it counts as a finger's, so the board can dictate straight after scribbling. A preview in HQ's
  viewer never gets the microphone: HQ records for it.
- **The book comes in from the right.** Its spine sits just past the screen's right edge at every size, the paper runs
  on to the screen's edge, and the cover shows only at its head, foot and outer edge. It is one size from the moment
  it shows, and HQ's buttons never peek over it. Upright on an iPad mini it starts folded and opens as the spread.
- **Only a deliberate pull moves the book.** A finger's swipe from the page's left edge closes it. The Pencil and the
  mouse write there as anywhere on the page.
- **The rail floats.** The tools are toolbars floating over the paper's right edge, never a strip of it: Select, Pen,
  Eraser, Shapes, Text, then Undo and Redo, with the page's controls at its foot.
- **The page arrows stay put and within the tab.** They never move as pages turn, and they never turn on into the next
  tab. The page list shows only the tab's pages, numbered as its counter is.
- **A title that can change shows a pencil.** A tap on a page's title opens the page list with the title to write in.
  A call page's longest title shows whole on an iPad mini.
- **A sent page stays where it is.** No page is made after it, even after the last.
- **What an agent puts down lands in sight only on an idle page.** The paper never slides to it while the board draws.
- **Ink stays where it was drawn.** A line beside a scrap stays put as the scrap's room grows or is dragged, and the
  room's edge reads at a glance.
- **A tall picture is fine, a page it takes over isn't.** A scrap's picture is at most about its width tall.
- **A box of words moves by its grip, with any tool.** No Select first, and it is never squeezed to a sliver.
- **The first pen tap turns on scrolling by touch.** On a fresh device a finger draws until then. Turned off in
  Preferences, it stays off.
- **The book is the design stage (Ink Studio).** Nothing in it is built yet, so a card for a secret, a step the board
  takes or built work stays on the desk phone.
- **My shelf holds big books with covers,** drawn like the notebook itself.

## The book check

`platform/hq/book-check.mjs` plays Ink as the board lives it: held like an iPad mini in WebKit (touch, 744 × 1133) and
in Chromium, on desktops and phones, on HQ's mock data, with the Notebook's store played in memory
(`book/notebookroute.mjs` on `notebookplay.js`). Each story's name says what it checks. `--stories 'words|more words'`
runs the stories whose names hold them, `--webkit` runs those in WebKit, `--first` the check's first part alone, and
`--shots dir` keeps their stills. The Pencil on HQ's own page plays first, in `book-check.mjs` itself: a ring with no
button first, its post-it and Save, a finger's drag drawing nothing, the pen held still taking a voice note, a
two-finger tap taking it back, and every kind of line the same wet as dry.

The stories are in `platform/hq/book/`, a file for each part of Ink named for it (`lasso.mjs`, `pin.mjs`,
`notebookasks.mjs`). What two stories need lives in one of three modules, never copied:

- `start.mjs`: the states a story starts from: a page watched for errors, HQ loaded, the book at rest open, the book
  open on a touch screen with a pen.
- `kit.mjs`: the screens, waits and readings: the iPad mini both ways, `until`, a screenshot's pixels, the
  microphone's stand-in, the pin.
- `hands.mjs`: the pen's and fingers' gestures, the same in either engine.

Guest notebooks run against the real coordinator instead (`book/guests.mjs`, below).

## A page of scrap units

A notebook page holds scrap units, never marks of its own. A page of scraps (its Asks, a call's notes) lays them as a
masonry, and a Sketch page is a canvas (below). Three ideas carry it, each in one module that the store, its play and
HQ's page share:

- **A scrap unit** (`scrapunit.js`) is one scrap: its own small canvas, `UNIT_W` scrap px wide and `h` tall. Its
  picture, typed words and ink are in its own px from its top-left, so its ink moves with it wherever the page puts it.
  Below its body (`bodyOf`: what an agent put down) is its room to write, part of the same unit. What an agent puts on
  a page comes with `ROOM` of it, and a drag resizes it (`heightFor`: never into what's drawn).
  Drawing past the bottom makes the unit taller (`heightFor`): each reader floors `h` at what's drawn as it draws it, and nothing drawn
  changes `h` in the store, which keeps it as made or dragged, without the post-it words HQ's page draws in a scrap's
  body (its ink's px count them). In the store a unit is a top-level `notebook_groups` row: `pos` is its
  order on the page, `h` its height as set, `column` the column a drawing below its column's last unit keeps (bookunits.js: ink by a scrap is the scrap's). Its answers and replies slip under it.
- **The masonry** (`masonry.js`) places a page's units, in order, each under the shortest column. The page's width
  decides the columns (`columnsOf`): as many as fit at `LEAST` of their size, one beside HQ on an iPad, two on an iPad
  upright, ten or more across a 4K screen. The columns are drawn scaled (`scale`) to span the page, so a page never
  leaves a slim column in its middle. Units keep their own width and grow down, always `GAP` apart. `layout` takes each unit's height as the page draws it (its `h` and whatever hangs under it) and gives
  every place. A new day on the page starts under a date across every column (`headers`). `placeAt` finds the unit under a pen, and `pointIn` turns the pen's point into that unit's px.
- **The page** is HQ's (`bookunits.js`): it measures its width, calls `layout` again whenever the width or a unit's
  height changes, and draws each unit at its place as a sticky note, the page's title on top and a date where a day
  starts. It pinch-zooms from its fit (the paper's width) in to `ZOOM_MAX`, panning across as far as it's zoomed past
  its width (`bookview.js`, its limits in `bookrow.js`), and ends left of the rail of controls (`--bk-rail-width`). A stroke goes to the unit it
  starts on, else to the board's own drawing it comes near, else it's a new unit of its own, the page's last, kept in
  the column it was drawn in (masonry's and the store's `column`), its ink where it was drawn; a unit's canvas reaches all its ink. The
  board's own drawings have no paper card. A scrap's words are part of its body; under an agent's body its
  room shows, with a handle at its foot (`heightFor`, saved with `/api/notebooks/groups/resize`). The page's lists hold
  each element at its unit's place on the page; `booksave.js` saves it in the unit's own px.
- **A Sketch page** is a canvas (`sketchcanvas.js`, shared by the page, the store's `notebookplaces.ts` and the picture
  agents read): each unit keeps its place in the page's px (`notebook_groups.place`), the same at any width. A stroke
  apart from every unit is a unit of its own where it's drawn. A unit with no place yet is laid as the masonry lays it
  and pinned there (`/api/notebooks/groups/place`: the first screen's place stands). What hangs under a unit goes
  where it covers no other. The page opens at scale 1 (a column's fit on a phone: `opensAt`), zooms from `ZOOM_OUT`
  (further out where what's drawn needs it) to `ZOOM_MAX`, and pans any way till an edge of what's on it is left.


## The book's frame

The board's rules for the book as a real book, seen from the side.

- **The page:** the spine is the screen's right edge, and only the left page shows. The paper runs the screen's whole
  height, up under the status bar's blur, with no cover band (`book.css`). Upright, on a phone or an iPad, the page is
  the whole screen. Beside HQ's page a slim page block stands at its outer edge.
- **Nothing to press under the blur:** the drawable page, the controls and the bookmarks all start below `--sat`.
- **Two islands** float over the paper, HQ's own controls in HQ's look (`bookui.js`, `bookstrip.css`). Only the page is
  paper. The tools stand on the right, upright and short: on a phone, well under half the screen's height. The bar runs
  along the foot between the screen's corners: Undo and Redo at its left, the page's arrows and count exactly in its
  middle, its dots menu at its right.
- **The tools,** in order: the pen, shapes, the eraser, Select, Text and the mic (`bookpalette.js`). The pen and the
  marker are one tool. Its card holds what draws, its colour and its width, one tap away. A tap picks a tool, and
  nothing waits on a hold.
- **Notes** lie on the page as plain paper, with no inner shadow or turned corner on the room under them
  (`bookgroups.css`).
- **The tear:** a press at the page's right edge, where the spine is, drawn to the left, tears a copy off (`booktear.js`).
  It shrinks into the hand, to be let go on Submit, PDF or PNG. Nothing shows at the edge till it's pulled. Tear off
  and send in the bar's dots menu opens the same three.
- **All pages** (the overview, `bookshelf.js`) is the page's own paper and dots top to bottom, with one title line ("‹
  Shelf", the notebook's name, its options: Change cover, Archived pages, a project book's Archive this book), the
  search as an island, plain chapter heads and page pictures with no outline or button on any. A page is archived from
  the bar's dots menu, where Sign in another device sits under Preferences. One type at one weight, Atkinson
  (`fonts/`).
- **My shelf** stays HQ's own window from its Shelf key, and the window is a bookcase (`bookshelfbooks.js`): books
  covers out on lipped boards, two to a board on a phone and three on an iPad, the Archive a lidded box and the plant
  on a board, drawn with depth as the books are. No menu on a cover. A book tapped opens on its All pages.

## What a page offers

The board's rules for what a Notebook page lets you do with what's on it.

- **Assign** hands over only a scrap of an Asks page, and only to a guest (`bookassign.js`, the store's
  `bookassign.ts`). A sketch's scraps reach their agent by themselves, so a sketch's selection has no Assign.
- **Select's bar** is one line of icons: Duplicate, Move to page… and Delete, with Assign first on an Asks page
  (`bookselectclip.js`). Duplicate is the copy and paste, Move to page… and a drag the cut.
- **Moving to a page** takes what's picked to an open page of its chapter, or to a new page, from one list: this page
  muted, New page last (`bookmoveto.js`). Select's Move to page… opens it under its button, and the Pencil's ring and
  line out of it opens it over the page bar.
- **A locked page** (sent, or a call's notes page not yet handed out) takes no tool, key or Paste (`bookwrite.js`
  `drawable`, `bookselectclip.js`). Once sent it shows no Undo, Redo, or Tear off and send (a guest's page keeps Undo
  while its send can still be taken back: `bookcontrols.js`), and a sent sketch page offers Duplicate instead: a new
  open page with everything on it, to carry on from.

## Bookmarks

Every book of the board's has its chapters as bookmarks (`bookmarks.js`, `notebookchapters.js` shared with the store):
Sketch, Asks and Calls, a round's Guests, Asks and Advice. A page's chapter comes from its kind, and the store lists a
book's pages chapter by chapter, so the bar counts within one ("1 / 4" between the page's arrows). Each keeps one colour
for good and never lights. Beside HQ's page they stick out of the page block to the left. On a page that is the whole
screen they lie folded at its left edge, slivers with their icons, and a tap brings them out. A call's notes page is
under Calls, shut at hang-up and stamped Sent once the call's follow-up has handed out what's on it.

## Guest notebooks

Guests are invited from the work itself (Share, `desk.js`): a review round from Reviews, or a lasting invitation
from the work's Share control. A guest's book on the Shelf opens `bookinvites.js`, the board's read-only live view
(`notebookguest.js`), which shows their pages with agent attribution and answers.

Foundation carry: remove `bookguestinvites.js`, `notebookpen.js`, `notebookshellwords.js`,
`notebookshellwords.test.js` and the coordinator's `notebookguestactions.ts` when carrying this change.

A guest writes in the board's own book shell (`bookguest.js`), under a scope (`bookscope.js`). Each Notebook route
keeps its board name below the scope's api (`bookroutes.js`): the shell's `/api/notebooks/groups/create` is the
guest's `/guest/notebooks/api/groups/create`, and the coordinator answers it by that name in one route table
(`notebookguestroom.ts`): each page write names how its page is found and whether a closed round still takes it (an
answer to an agent). Guests see only their own pages. The board can watch retained pages after revocation. Guest passkeys use the separate guest
session, never the board's. Existing email codes remain available.

Run `hq run --kind render --bring .data/guest-shots -- node platform/hq/book-check.mjs --stories 'guest notebooks'
--out .data/guest-shots` for the real coordinator journeys and tablet, phone and desktop evidence: `hq run` installs
the coordinator's packages, which the check's own browser dispatch doesn't.
`--chromium-only` is for local debugging when WebKit is absent.
The real-server story needs the coordinator's pinned dependencies as well as Playwright.

## The notebook's link

The notebook tells HQ and the artifact in the viewer (a game, a deck, a site) when a hand moves it, and hears them talk
back. It's optional: a page that never listens is untouched. `notebooklink.js` is the notebook's end:

- `pull`: a hand takes the pull tab to pull the notebook out or in, by a drag (`bookswing.js`) or a tap
  (`bookhandle.js`: a tap pulls and lets go at once). Opens HQ makes itself, Search's or a card's, are no hand's and
  tell nothing.
- `letgo`: the hand lets go, with `{ open }`, whether the notebook ends up open. Always after a `pull`.
- `on(event, fn)` listens (→ unsubscribe). `send(kind, detail)` is HQ's word to the notebook, heard on `on('message')`
  as `{ kind, detail, from: 'hq' }`, an artifact's as `from: 'artifact'`.

HQ's scene pauses on `pull` and resumes on `letgo`, however the notebook ends up (`stage.js`, its `notebook` cover:
neither updates nor draws). The viewer's page hears `{ hq: 'hq', notebook: 'pull' | 'letgo', detail }` and talks back
with `{ hq: 'notebook', kind, detail }`, taken only from the viewer's own frame on a preview (`desk.js`). An artifact
imports its end, `shared/notebook/notebook.js`, which every product host serves. A game that stays frozen while the
notebook's open, for the board to circle what moves:

```js
import * as notebook from '../../../../shared/notebook/notebook.js';
notebook.on('pull', () => (frozen = true));
notebook.on('letgo', ({ open }) => (frozen = open));
```

A run from the repo serves it from the app's own server, as the other browser kits (`infra/products.md`).

## Live messages from work

`shared/notebook/notebook.js` lets framed work send `notebook.send('debug', 'Frame 42: paused')` or a structured
context. `notebooklink.js` accepts messages only from the current staging frame at a trusted preview origin.
`bookmessages.js` shows the kind and detail as plain text on the notebook page open when each message arrives.
These lines belong to this visit, stay on their page when it turns and are not sent as board notes or saved.
HQ can use the same display through `notebooklink.send`.

Check both routes with `node platform/hq/book-check.mjs --stories 'live work'`, plus `--webkit`.
