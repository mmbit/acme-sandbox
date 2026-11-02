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
  starts. It scrolls down only and ends left of the rail of controls (`--bk-rail-width`). A stroke goes to the unit it
  starts on, else to the board's own drawing it comes near, else it's a new unit of its own, the page's last, kept in
  the column it was drawn in (masonry's and the store's `column`), its ink where it was drawn; a unit's canvas reaches all its ink. The
  board's own drawings have no paper card. A scrap's words are part of its body; under an agent's body its
  room shows, with a handle at its foot (`heightFor`, saved with `/api/notebooks/groups/resize`). The page's lists hold
  each element at its unit's place on the page; `booksave.js` saves it in the unit's own px.

## Bookmarks

Every book of the board's has its chapters as bookmarks (`bookmarks.js`, `notebookchapters.js` shared with the store):
Sketch, Asks and Calls, a round's Guests, Asks and Advice. A page's chapter comes from its kind, and the store lists a
book's pages chapter by chapter, so the rail counts within one ("1/4" between the page's arrows). The tabs stand along the
book's top, tucked behind its page, wherever the screen is tall enough; sideways on a phone they peek out of a thick
white stack of page edges at its left. A call's notes page is
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
