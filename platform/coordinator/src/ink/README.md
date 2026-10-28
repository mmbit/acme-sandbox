# Ink, in the coordinator


Ink is the pen platform as a whole: the Sketchbook you draw in, marks drawn anywhere and sent to it, the sheets that
send them to agents, their answers, the call's view of the page, and a second screen paired to the first. This folder
is its store and routes. HQ's side is `platform/hq/shell/ink/` (its README lists the parts), the marks on any page are
review mode's (`shared/review/`), and the worker's `hq sketches`, `hq sketch` and `hq book` read the book
(`platform/worker/hq/book.ts`).

The Sketchbook is one part of Ink, and in code it is the book: one per person, a row of pages a day.

- `book.ts` keeps the pages, `bookpicture.ts` and `bookrender.ts` draw one as a picture, `bookreads.ts` serves them
  to agents and calls.
- `booknotes.ts` keeps the sheets and their notes, `booklinks.ts` the links between notes, `booksheets.ts` sends a
  sheet, `booksend.ts` a free page on its own, `bookwriting.ts` the board's writing beside the notes.
- `bookslips.ts` clips the agents' answers onto their notes, and `booktyped.ts` answers a question typed on a page.
- `bookasks.ts` puts the desk phone's cards about a note or a page in the book too.
- `bookreview.ts` brings review mode's notes on a preview into the book, `bookguests.ts` an invited person's.
- `bookcalls.ts` is a call's page, `booksearch.ts` the book's Search.
- `callnotes.ts` is a call's notes page in the Notebook: the agent's scraps (one per change, each its own crop), its
  notes and title, sent and archived as the call ends; read as its call is, so a customer call's stays with the jobs
  that may read that call.
- `bookfetch.ts` fetches a picture on the web dragged or pasted into the book.
- `sketchbook.ts` is the Sketchbook app's shelf of free pages, `sketchpeople.ts` invited people's own books.

The routes keep their addresses (`/api/book/…`, `/api/sketches/…`): they are the Sketchbook's.
