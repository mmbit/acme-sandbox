# Ink, in HQ's browser


Ink is the pen platform as a whole: the Sketchbook you draw in, marks drawn anywhere and sent to it, the sheets that
send them to agents, their answers, the call's view of the page, and a second screen paired to the first. This folder
is its browser side in HQ. The coordinator's side is `platform/coordinator/src/ink/`, the marks on any page are review
mode's (`shared/review/`), and the ink's one outline is `shared/review/ink.js`.

The Sketchbook is one part of Ink, and the only name the board sees. In code it is the book (`book*`): the paper on
the right of HQ's screen, its rail, pages, tools, sheets and Search. The pages also have a shelf of their own, HQ's
Sketchbook app and an invited person's on the guest desk (`sketch*`).

- `book.js` opens the book beside HQ's page. `bookpages.js`, `bookpage.js` and `booksave.js` draw and keep its pages,
  `bookgroups.js` a page's groups with their paperclips and the answers under them, `bookpagesend.js` a page's Send,
  `bookrail.js` Undo and Redo, `bookshelf*.js` the overview and the Shelf, `booksearch*.js` Search. `notebook*.js` read
  and write the Notebook's routes (`notebookdata.js`), and play them in dev mode and book-check (`notebookplay*.js`).
  (the Notebook's groups and the sheets gone)
- `sketch*.js` hold the Sketchbook app's shelf and pages (`sketchbook.js` in HQ, `sketchguest.js` on the guest desk).
- `calldraw.js` is the Pencil on a call, with the call's agent on the same page, and the call's notes page opened as
  it's picked up.
- `pair.js` shows a one-time sign-in code for another device. Notebook content syncs through its model.
  App annotations stay on the device that draws them.
- `agentink.js` is an agent's own ink, and `pagemerge.js` merges two writers' saves of one page.

A scrap the board just saved (the pin flow) lands in the book: `booklanding.js` lands its ink on its photo
(`pencil:landing` with `group`) and turns to one saved elsewhere (`book:scrap`); `bookgroupshow.js` turns to its page
and slides it into view clear of the controls; `bookgroupbox.js` says where the store stacks the next one. Folded, the
pull tab's tap opens the book at it.

The book's routes keep their addresses (`/api/book/…`, `/api/sketches/…`): they are the Sketchbook's.


## Guest notebooks

The Shelf's Invite control opens `bookinvites.js`. It creates a `round` with one page per guest or a permanent
`invited` notebook for one person, exposes their individual invitation links, revokes access, and opens a read-only
live view. The same `notebookguest.js` renders the guest room and the board's watcher. It reads the scoped Notebook
routes, keeps the active draft during refreshes, sends pages and replies, and shows agent attribution and answers.
`notebookpen.js` draws with Ink's shared stroke renderer. Typed notes can be edited and deleted with Undo.

An opted-in review round lets its guests make invitation links for up to three same-domain colleagues. Guests see
only their own pages. The board can watch retained pages after revocation. Guest passkeys use the separate guest
session, never the board's. Existing email codes remain available.

Run `node platform/hq/book-check.mjs --stories 'guest notebooks' --shots /tmp/ink-guests` for the real coordinator
journeys and tablet, phone and desktop evidence. `--chromium-only` is for local debugging when WebKit is absent.
The real-server story needs the coordinator's pinned dependencies as well as Playwright.
