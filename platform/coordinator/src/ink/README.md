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
- Answers to any note: `bookjudge.ts` is the one judge of every note the board
  makes (a small model through `../smallmodel.ts`'s queue: none, an answer, or a try; no rule on the words' shape), with
  its verdicts and their why kept; `bookseen.ts` is what it reads of a note. A note that gets no answer (its run ended
  without one, it couldn't be judged, or it came past the judge's day) says why in the answer's place, one reason a note until the next ask or answer takes it. `bookanswer.ts`
  answers: the owner's quick run, `hq answer` (words, a drawing, a
  picture, a form, a question, versions; `answerparts.ts` checks what one holds), forms answered, ticks and the open list; `answerspot.ts` places an answer in
  free paper by its group, never over the board's own. `groupanswers.ts` is what a group's children carry.
  `booktry.ts` starts a try run (versions of what a note asks to see, on a page of their own), `callanswer.ts` lets a
  call's agent write its answer on a note the board drew on the call.
- Circle a version to pick it: `bookpick.ts`. A ring or a tick on a version goes
  as a reply on it, drawn over the version's frame in its picture; the judge's verdict 'pick' (offered only on a
  version) or the board's tick on it picks it (one per try),
  the try run and a call hear which, and the note the tried group goes as carries the frame and the patch.
- `callnotes.ts` is a call's notes page in the Notebook: the agent's scraps (one per change, each its own crop), its
  promises and title, sent as the call ends and left among My Notebook's pages; read like any page. It's the call's
  one route for its asks: each scrap and promise is an item on the call's list, linked to the job it went as. `callasks.ts` keeps those asks following the page as the board leaves it: joined,
  lifted apart, deleted or changed.
- `bookfetch.ts` fetches a picture on the web dragged or pasted into the book.
- `sketchbook.ts` keeps HQ's Sketchbook app. `sketchpeople.ts` keeps invited people's identity, colour and quota.
  Guests use the Notebook room, with no separate Sketchbook environment.

The routes keep their addresses (`/api/book/…`, `/api/sketches/…`): they are the Sketchbook's.

## Guest rounds and invited notebooks

`../notebookguests.ts` keeps board-created notebooks and their guests. The notebook belongs to the board. Each page
belongs to its guest's existing `sketchpeople.ts` grant. The board reads every page and its answers, while only the
guest edits. Revoking an invitation closes guest access and retains the pages for the board. Round invitations
expire after `days` (seven by default). An invited notebook has exactly one guest and lasts until revoked.

Board routes:

- `GET /api/notebooks/guests` and `/list` return `{ notebooks }`, with guests, invitation links and all pages.
- `POST /api/notebooks/guests` takes `{ kind: 'round' | 'invited', name, people: [{ name, email }], days?, colleagues? }`.
- `POST /api/notebooks/guests/revoke` takes `{ notebook, guest? }`. Omitting `guest` revokes every invitation.
- `GET /api/notebooks/guests/pages?notebook=` reads one notebook. `/groups?page=` reads a page with child answers.
- `/pictures?file=`, `/slip/picture?id=` and `/slip/now?id=` serve its pictures to the board's authenticated session.

`../notebookguestroom.ts` registers `/guest/notebooks/` with the existing guest desk. Its door uses the platform's
email-code and passkey sign-in. Its `/api/list` contains only the signed-in person's notebooks and pages. `/groups`,
`/picture`, `/pictures` and `/slip/picture` check that same page membership. POST actions are `/create`, `/edit`,
`/delete`, `/restore`, `/send`, `/undo`, `/reply`, `/replies/delete` and `/pages/create`. New pages are only for invited
notebooks. Send and reply recheck both the session and the invitation after rendering, before saving anything.
The room serves only its notebook scripts and stylesheet. It does not expose HQ's other files.

When the board enables `colleagues` for a round, `/api/invite` takes `{ notebook, name, email }` and returns the new
person's link. The guest can invite three colleagues at their own company domain, as on checklist cards. Shared
mail domains are excluded. The notebook's `invites` field gives the permitted domain and remaining invitations.

`../notebookrounds.ts` sends each guest page through the normal notebook note routing. While a round remains open,
a guest can un-send and revise their page. Dispatched revisions and their answers stay attached to the group. The
last hand-in starts a ten-second close with undo for that guest. A completed round moves to the archive and queues
one deck task for the CEO. The task receives all notebook groups, child answers and replies at closure, plus page
numbers for `hq sketch` to read the original visual. Removing the final pending guest lets remaining hand-ins close
the round. A round with no eligible guests closes and archives without a deck.
