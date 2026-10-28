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
- `pair.js` and `pairink.js` pair a phone or tablet with a desktop, the ink live across both.
- `agentink.js` is an agent's own ink, and `pagemerge.js` merges two writers' saves of one page.

The book's routes keep their addresses (`/api/book/…`, `/api/sketches/…`): they are the Sketchbook's.
