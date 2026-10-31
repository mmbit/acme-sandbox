# Ink, in HQ's browser

Ink is the pen platform as a whole: the Sketchbook you draw in, marks drawn anywhere and sent to it, the sheets that
send them to agents, their answers, the call's view of the page, and one-time sign-in on another device. This folder
is its browser side in HQ. The coordinator's side is `platform/coordinator/src/ink/`, the marks on any page are review
mode's (`shared/review/`), and the ink's one outline is `shared/review/ink.js`.

The Sketchbook is one part of Ink, and the only name the board sees. In code it is the book (`book*`): the paper on
the right of HQ's screen, its rail, pages, tools, sheets and Search. Invited people use the same Notebook shell with
scoped pages. (HQ's Sketchbook app on the computer, `sketch*`, is gone: the book is the one notebook.)

- `book.js` opens the book beside HQ's page. `bookpages.js`, `bookpage.js` and `booksave.js` draw and keep its pages,
  `bookgroups.js` a page's groups, a paperclip on each of two or more things, and the answers under them, `bookdogear.js` and `bookpagesend.js` a page torn out onto Submit (a guest's, its Send),
  `bookforyou.js` what's still the board's to answer (an open ask edged "for you", counted over the page's name, its arrows going to each),
  `bookrail.js` Undo and Redo, `bookshelf*.js` the overview and the Shelf, `booksearch*.js` Search. `notebook*.js` read
  and write the Notebook's routes (`notebookdata.js`), and play them in dev mode and book-check (`notebookplay*.js`).
  (the Notebook's groups and the sheets gone)
- `bookanswers*.js` draw the agents' answers on a notebook page: the bulb and the face, the words written in by a small
  pen in a hand (`fonts/`, Caveat under the OFL: `fonts/OFL.txt`; `--bk-hand` sets another), drawings, pictures, forms,
  the strip the board writes its reply on. `bookshelfopen.js` lists the open forms and questions in the overview.
- `bookversions.js` draws a try's versions under the board's scrap, one self-contained block (its API at its top): a frame
  per version with its live preview, pencil dots while one is coming, why a try ended empty. The board's pen on a frame
  goes as a reply on that version (`bookversionframes.js` `frameUnder`: where, never what shape), and a pick is stamped CHOSEN.
- `bookscrapdraw.js` draws a taped picture (a scrap) in its border and tape, and makes a picture file ready to upload.
- `calldraw.js` is the Pencil on a call, with the call's agent on the same page, and the call's notes page opened as
  it's picked up.
- `pair.js` shows a one-time sign-in code for another device. Notebook content syncs through its model.
  App annotations stay on the device that draws them.
- `agentink.js` is an agent's own ink, and `pagemerge.js` merges two writers' saves of one page.
- `bookarrive.js` sets down whatever arrives on a page (from the store, or pasted, dropped or heard here) with the
  paper's landing (`bookpaper.js` `land`): held off the page while a copy comes down onto its place. Checked by
  `bookarrival.mjs`.

A scrap the board just saved (the pin flow) lands in the book: `booklanding.js` lands its ink on its photo
(`pencil:landing` with `group`) and turns to one saved elsewhere (`book:scrap`); `bookgroupshow.js` turns to its page
and slides it into view clear of the controls; `notebookstack.js` says where the store stacks the next one. Folded, the pull tab's tap opens the book at it.

The book's routes keep their addresses (`/api/book/…`): they are the Sketchbook's.

## A page of scrap units

A notebook page is a column of scrap units laid out as a masonry, never a canvas with marks of its own. Three ideas
carry it, each in one module that the store, its play and HQ's page share:

- **A scrap unit** (`scrapunit.js`) is one scrap: its own small canvas, `UNIT_W` scrap px wide and `h` tall. Its
  picture, typed words and ink are in its own px from its top-left, so its ink moves with it wherever the page puts it.
  Below its body (`bodyOf`: what an agent put down) is its room to write, part of the same unit. What an agent puts on
  a page comes with `ROOM` of it, and a drag resizes it (`resized`: never into what's drawn). Drawing past the
  bottom makes the unit taller (`heightFor`). In the store a unit is a top-level `notebook_groups` row: `pos` is its
  order on the page, `h` its height, `column` the column a drawing with no unit above it keeps. Its answers and replies slip under it.
- **The masonry** (`masonry.js`) places a page's units, in order, each under the shortest column. The page's width
  decides the columns (`columnsOf`): one in a sliver and on an iPad mini, ten or more across a 4K screen.
  Units keep their width and grow down, always `GAP` apart. A page narrower than one column draws it scaled
  (`scale`). `layout` takes each unit's height as the page draws it (its `h` and whatever hangs under it) and gives
  every place. A new day on the page starts under a date across every column (`headers`). `placeAt` finds the unit under a pen, and `pointIn` turns the pen's point into that unit's px.
- **The page** is HQ's (`bookunits.js`): it measures its width, calls `layout` again whenever the width or a unit's
  height changes, and draws each unit at its place as a sticky note, the page's title on top and a date where a day
  starts. It scrolls down only and ends left of the rail of controls (`--bk-rail-width`). A stroke goes to the unit it
  starts on, else to the board's own drawing it comes near, else it's a new unit of its own, the page's last, kept in
  the column it was drawn in (masonry's and the store's `column`), its ink where it was drawn; a unit's canvas reaches all its ink. The
  board's own drawings have no paper card. A scrap's words are part of its body; under an agent's body its
  room shows, with a handle at its foot (`resized`, saved with `/api/notebooks/groups/resize`). The page's lists hold
  each element at its unit's place on the page; `booksave.js` saves it in the unit's own px.

## Bookmarks

Every book of the board's has its chapters as bookmarks (`bookmarks.js`, `notebookchapters.js` shared with the store):
Sketch, Asks and Calls, a round's Guests, Asks and Advice. A page's chapter comes from its kind, and the store lists a
book's pages chapter by chapter, so the rail counts within one ("1/4" between the page's arrows). Upright the tabs stand
along the book's top; sideways they peek out of a thick white stack of page edges at its left. A call's notes page is
under Calls, shut at hang-up and stamped Sent once the call's follow-up has handed out what's on it.

## Guest notebooks

The Shelf's Invite control opens `bookinvites.js`. It creates a `round` with one page per guest or a permanent
`invited` notebook for one person, exposes their individual invitation links, revokes access, and opens a read-only
live view. The same `notebookguest.js` renders the guest room and the board's watcher. It reads the scoped Notebook
routes, keeps the active draft during refreshes, sends pages and replies, and shows agent attribution and answers.
`notebookpen.js` draws with Ink's shared stroke renderer. Typed notes can be edited and deleted with Undo.

An opted-in review round lets its guests make invitation links for up to three same-domain colleagues. Guests see
only their own pages. The board can watch retained pages after revocation. Guest passkeys use the separate guest
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
