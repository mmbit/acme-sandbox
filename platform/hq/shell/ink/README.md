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
  `bookrail.js` a guest's Undo on the bar, `bookviewhead.js` the page's title and day on the view, `bookshelf*.js` the overview and the Shelf, `booksearch*.js` Search. `notebook*.js` read
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
- Notebook content syncs through its model.
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
- **No line deletes anything.** Scribbled over, struck through or circled, it's ink: a scrap goes only from its ⋯
  menu or Select's Delete (the board, call 262).
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
- **The tools are an opened scrap's.** The page itself takes no ink, so it shows nothing to draw with: no tools, no
  Undo or Redo, on every device. It is one vertical roll of scraps across the paper's whole width. On an opened scrap
  the tools float over the paper's right edge, never a strip of it: the pen, shapes, the eraser, Select, Text and the
  mic, with Undo and Redo. The page's own controls stay on the bar at its foot; a scrap thrown away or moved is undone
  from its toast, which shows over the book (`book.js` puts HQ's toasts beside it on `<html>`)
.
- **The page arrows stay put and within the tab.** They never move as pages turn, and they never turn on into the next
  tab. The page list shows only the tab's pages, numbered as its counter is.
- **A sent page stays where it is.** No page is made after it, even after the last.
- **What an agent puts down lands in sight only on an idle page.** The paper never slides to it while the board draws.
- **Ink stays where it was drawn.** A line beside a scrap stays put as the scrap's room grows or is dragged, and the
  room's edge reads at a glance.
- **A tall picture is fine, a page it takes over isn't.** A scrap's picture is at most about its width tall.
- **A box of words moves by its grip, with any tool.** No Select first, and it is never squeezed to a sliver.
- **The first pen tap turns on scrolling by touch.** On a fresh device a finger draws in an opened scrap until then;
  on the grid, which takes no ink, a finger always scrolls and its tap opens a scrap. Turned off in Preferences, it
  stays off.
- **The book is the design stage (Ink Studio).** Nothing in it is built yet, so a card for a secret, a step the board
  takes or built work stays on the desk phone.
- **My shelf holds big books with covers,** drawn like the notebook itself.

## The book check

`platform/hq/book-check.mjs` plays Ink as the board lives it: held like an iPad mini in WebKit (touch, 744 × 1133) and
in Chromium, on desktops and phones, on HQ's mock data, with the Notebook's store played in memory
(`book/notebookroute.mjs` on `notebookplay.js`). Each story's name says what it checks. `--stories 'words|more words'`
runs the stories whose names hold them, `--webkit` runs those in WebKit, `--first` the check's first part alone, and
`--shots dir` keeps their stills. The main flow's parts are in `book-check.mjs` itself: a ring with no
button first, its post-it and Save, a finger's drag drawing nothing, the pen held still taking a voice note, a
two-finger tap taking it back, and every kind of line the same wet as dry.

**The whole check runs at night, never as a gate.** A change is checked
where it touches (by hand, or the one story it needs with `--stories`); the whole check never holds a fix or a pull
request. It runs once a night with the nightly test run, and in the background after a big update once it's live (a job
queued `--when deployed:<job>`), and its red parts go to their owner as a fix job. With no flags it plays every part,
the main flow's and every story, in both engines, shared out over workers side by side (`book/pool.mjs`: each a
process with its own server, stores and browsers, as many as the machine's cores and memory hold, or `--workers n`;
`--stories` with `--workers` shares out those parts too). A part starts once the memory left (the page cache the kernel
takes back not counted as used) holds what its worker may still grow by beside what the workers playing may still grow
by (each a worker at its fullest less what it holds), or once nothing else plays. A machine pushed into swap goes quiet
for minutes. Each part's line gives its time and how much of it went in timed waits, and the last line the most memory
in use, the check's share of it and how long parts waited for memory. Off the worker, it runs on the shots helper
from this checkout (shared/browser/README.md, "Checks from an agent's checkout"). The tips' films are renders, out of
git, so they're fetched first and carried along (the Tips story checks every one is served):

```sh
films=$(git ls-files 'theme/hq/tips/*.render.json' | sed 's/\.render\.json$//')
node shared/demo/renders.mjs fetch $films
hq run --kind shots --minutes 120 --with "$(echo $films | tr ' ' ,)" -- node platform/hq/book-check.mjs
```

**Where its time goes** (measured on the shots helper, 5 November, 601 parts):

- **The memory a worker takes.** One worker holds up to 2.3 GB, so the 6 GB shots helper fits two side by side. Six
  workers, as the pool started before it measured memory, need up to 14 GB, and the helper's container swaps what
  passes its limit.
- **The parts one after another:** 152 minutes. Shared out on the two workers the pool picks there: 76 minutes, at
  most 5.1 GB in use and nothing swapped.
- **Failing parts:** 40% of the parts' time. The stories the Notebook's rebuild left behind fail, many of them on
  Playwright's 30-second timeout.
- **Timed waits:** 23% of the parts' time. A third of it is the 700 ms after each time the book comes to rest. The
  rest is spread thin, about a minute at most in any one place.
- **The slowest parts** each play every look at every size: the page's title on the view (85 s in WebKit, 184 s in
  Chromium), the glass bars, My shelf fitted, the book's bookmarks, and the pen reaching every overlay (each 60 to
  120 s).

The stories are in `platform/hq/book/`, a file for each part of Ink named for it (`lasso.mjs`, `pin.mjs`,
`notebookasks.mjs`). What two stories need lives in one of four modules, never copied:

- `start.mjs`: the states a story starts from: a page watched for errors, HQ loaded, the book at rest open, the book
  open on a touch screen with a pen.
- `kit.mjs`: the screens, waits and readings: the iPad mini both ways, `until`, the Shelf opened and at rest, a
  screenshot's pixels, the microphone's stand-in, the pin.
- `preview.mjs`: a preview in HQ's viewer, review mode running in its frame.
- `hands.mjs`: the pen's and fingers' gestures, the same in either engine.

Guest notebooks run against the real coordinator instead (`book/guests.mjs`, below).

## A page of scraps

Every notebook page is one engine: a grid of scraps that reflows, the same for a call's notes, the Journal and the
Asks (the board, call 262). Free drawing and reflow don't go together, so nothing is drawn on the grid itself: ink is
always on a scrap, and moves with it wherever the grid puts it. Three ideas carry it, each in one module that the
store, its play and HQ's page share:

- **A scrap** (`scrapunit.js`) is one unit: its own canvas, `UNIT_W` scrap px wide, everything on it (a picture, typed
  words, ink) in its own px from its top-left. There is one kind of scrap, with or without a picture: the same paper,
  the same type. In the store a scrap is a top-level `notebook_groups` row: `pos` is its order on the page. Its answers
  and replies slip under it.
- **The grid** (`masonry.js`) places a page's scraps, in order, each under the shortest column. The page's width
  decides the columns (`columnsOf`): one beside HQ, two on an upright iPad, more on a wide screen. Columns are drawn
  scaled (`scale`) from `LEAST` up to `MOST`, and `GAP` apart. Each scrap shows as a card (`bookunits.js` `cardOf`):
  everything on it, fitted to the card's width and at most `CARD_MOST` tall, never enlarged, so a drawing that went
  far on its opened sheet shows whole and smaller. There is no room or handle under a card. A new day on the page starts
  under a date across every column. The grid pinch-zooms from its fit and scrolls by finger. At its fit it never moves
  sideways: whatever is on a scrap shows inside its card (`bookrow.js` `unitsPans`). Its columns keep off the paper's
  sides by as much each way (`bookunits.js` `INSET`), so a phone's one column stands in the middle, clear of the folded
  bookmarks.
- **The opened scrap** (`bookscrapopen.js`) is where drawing happens. A tap on a card (the pen, a finger or the mouse)
  picks it up: it flies forward from its place onto a sheet that nearly fills the paper, a small margin round it and
  its soft shadow over the page, the grid waiting under it as it was. The sheet is an endless canvas: the pen draws, a
  finger pans, a pinch zooms, every way past what's on it. The book's tools work on it unchanged (pen, Select, eraser,
  shapes, text, Delete's crumple). Klaar puts it back down onto its card. While it's open the bar along the foot is put
  away and Undo and Redo sit with the tools on the right. While it flies up or back down, a press on the paper inks
  nothing, so a finger's second tap never inks it or the grid (`bookwrite.js` `drawable`; a double tap held still records
  a voice note). An opened scrap is its own page record (`focus`: its group,
  `parent`: the grid's page), its things in its own px, and its view takes the grid's place in `book.views`, so saving
  and Undo work on it as on a page; it's kept for the visit, so its history goes on when it's opened again.
- **A new scrap anywhere:** the pen's tap (or a press held) in the room between two cards makes a new empty scrap
  right there in the page's order (`/api/notebooks/groups/create` with `after` and `empty`) and opens it. One closed
  empty goes again. A picture pasted on the grid is a scrap of its own; pasted on an opened scrap, it's in that scrap,
  but no group with what's there: Select's tap picks it alone (`bookselectmath.js` groupOf).
- **Undo is a scrap's and a person's own** (`bookedit.js`): Undo and Redo take only the last step of the page shown
  (the opened scrap's, or the grid's own: a scrap thrown away), and only this screen's steps. What someone else or an
  agent changes is no step. Elements keep a stable `id` through a move or resize, so when one person moves another's
  line, the line's own Undo takes it away wherever it is now, the move's Undo is then skipped, and its Redo brings it
  back where it was moved to. An Undo that changes something out of sight on the opened scrap slides there first.

## Our scraps

The board's rules for the scraps we put in its book.

- **Taped on:** a scrap is one post-it with its own real shadow on the page (`bookgroups.css` `.bk-unit-paper`). Its
  photo is taped straight onto it, a strip of tape whole across the photo's top edge (`bookpage.js` photos,
  `bookscrapdraw.js`), and its words are written on the same paper. An agent's drawing (`drawing.ts`, its picture
  marked `drawing`) has a clear ground and no tape or edge: its lines are straight on the post-it's yellow (the board,
  call 257).
- **Ink is on top:** on an opened scrap the ink lies over everything on it, its photo and its words included
  (`bookdesk.css` `.bk-ink`). A stroke starts anywhere there, on its photo or its words too: a press there waits, a
  tap is the thing's (its words' caret), a line drawn from it is ink (`bookwrite.js` drawable).
- **Our scraps are fixed:** the board draws over them, rubs out and undoes its own ink there, and edits their words;
  nothing else. Select picks one only whole (`bookunits.js` fixed, `bookselect.js` holdsFixed).
- **A question stays a question:** an agent's ask, or a scrap handed to someone, is marked on its card. A scrap handed
  over, opened by the one it's for, has Beantwoord beside Klaar: only that sends the answer back
  (`/api/notebooks/groups/answer`), Klaar just saves (nobody can tell when someone has finished drawing otherwise). An
  agent's ask is answered on its scrap the same way: a choice tapped on its card's slip answers at once, or the board
  draws on the opened scrap and its Beantwoord sends what was drawn and typed there since it was opened, through the
  desk phone's own route: one answer closes both (`bookasks.js`). An agent's answer under a scrap is replied to the same
  way, Beantwoord sending it as the reply to that agent (`bookslipreply.js`). There is no room, handle or field under a
  slip to answer in.
- **Circle and line:** a ring drawn round a card on the grid and a line out of it fades the controls and shows two
  drop zones, People and Pages (`bookgridgesture.js`, `bookdropzones.js`): ending on a person hands the scrap to them
  (any scrap; it lands in their Asks, they press Beantwoord when they've reacted), ending on a page moves it there. Only
  people invited to the book or its project, never agents (knowledge/notes/platform/notebook-invites.md). The scrap
  stays on the sender's page with the person's initial while it's out with them, and a tick once they've answered.
- **Thrown away only on purpose:** no key on a card or the sheet's face deletes a scrap. The sheet's ⋯ menu has it last,
  and asks once more for a scrap an agent made. It crumples and falls straight down.
- **Dates where a day starts:** the page's first day is in its head; a later day starts under a date across the
  columns. A call's page never spans days: no dates on it.

## The book's frame

The board's rules for the book as a real book, seen from the side.

- **The page:** the spine is the screen's right edge, and only the left page shows. The paper runs the screen's whole
  height, up under the status bar's blur, with no cover band (`book.css`). Upright, on a phone or an iPad, the page is
  the whole screen. Beside HQ's page a slim page block stands at its outer edge.
- **The page to every edge:** the page is one surface under the whole paper, up under the status bar's blur, beside
  and round the tools' island and under the bar, so ink goes right up to every edge; only a press on a control is the
  control's (`bookdesk.css`). Its dots zoom with it there too. Only its content is set down below the blur, and an
  opened scrap's kept left of the tools: the desk's padding, read as `book.size`'s `top` and `right` (`bookview.js`). A place on a page
  (remembered, a find's, a box shown) is its point at that content's top-left.
- **The title on the view:** the page's title, and under it the day of what's showing (the topmost scrap or drawing
  seen below it; none on a call's page, whose title has its date), sit fixed at the view's top left below the blur,
  never zoomed or panned with the page (`bookviewhead.js`). Once the page is scrolled, what passes under them goes
  quietly out of sight under a band of frosted paper across the page, from the screen's top to just below the date,
  its foot fading out: never cut by a box. It takes no press: the page under it is drawn on. The dates between days
  stay on the page, each handing its day to the title as it reaches it, so no second date shows under it. Zoom and pan never go above or left
  of the page's corner, where the title lies at rest (`bookrow.js` `unitsPans`). Rename page, first of
  the page's rows in the dots menu, writes it where it shows (`booktitle.js`); a sent page keeps its title. The page
  list from the count names the pages only, its numbers readable in every look. A call page's longest title shows
  whole on an iPad mini. The book closes by its pull tab or a swipe from the page's left edge, not from the page's
  menu.
- **One soft shadow:** the book is one object under its single soft drop shadow on HQ's page, the same in every look,
  and no other shadows or lines (`book.css`).
- **Nothing to press under the blur:** at rest the controls, the bookmarks and the page's own buttons all start below
  `--sat`; the page under the blur is only drawn on.
- **Only the page pinch-zooms:** nothing else in the book lets the browser zoom the screen, the islands, their cards
  and the gaps between them included, so no pinch can push a control off the screen. A pinch begun on a control does
  nothing; a card's list still scrolls (`book.css`). HQ's own page beside the book zooms as ever.
- **The islands** float over the paper, HQ's own controls in HQ's look (`bookui.js`, `bookstrip.css`). Only the page
  is paper. An opened scrap's tools stand on the right, upright and short: on a phone, well under half the screen's
  height. The page's bar runs along the foot between the screen's corners, as the board drew it: All pages at its
  left, the page's arrows and count exactly in its middle, its dots menu at its right. A guest's Undo of its send
  stands on the bar where Send was (`bookrail.js`): nothing is stacked over the bar. The overview has no bar: it shows all the pages already, and a page opens
  by its tile. What's written on an opened scrap is laid left of the tools, but ink goes under and beside them.
- **The islands are glass:** the tools' island and the bar are lightly frosted glass over the page, in every look: the
  look's panel two thirds opaque, what's under it blurred, a line of light on its top edge, the look's own edge kept
  (`bookstrip.css`, the renderers' skin.css). A dark panel dims what it lets through, so it stays dark and its keys
  read. While the book swings or its tab is held, the frost is off, so the swing keeps its frames. Never overdone: a
  hairline rim at most.
- **The bar's spacing** gets smaller inward: its margin at its ends the largest, then the room each side of a rule,
  alike at every rule, then the gap between two keys, alike in every group. Each end holds one key at every size, New
  page in the dots menu, so the parts sit against the middle alike on both sides (`bookstrip.css`).
- **The tools,** in order: the pen, shapes, the eraser, Select, Text and the mic (`bookpalette.js`). The pen and the
  marker are one tool. Its card holds what draws, its colour and its width, one tap away. A tap picks a tool, and
  nothing waits on a hold.
- **The marker under the ink:** the more see-through ink lies under the less, whichever came first: the marker's
  under the pencil's and the pen's, the pencil's under the pen's (`inkshape.js` `layered`), while it's drawn just as it
  dries, so nothing changes as it's lifted (`bookwet.js`); and over the page's words and a note's picture as all ink
  does (the board, call 262: never half over the letters).
- **Delete crumples and falls:** what's deleted or archived balls up and falls straight down off the screen's foot,
  never thrown aside or up, heard landing below (`bookpaper.js` `crumple`).
- **A voice note at a spot:** the mic tapped lights and waits; a spot then pressed and held on the page records there
  until it's let go (`bookvoice.js`). The words write themselves at that spot as they're said, live, in the page's own
  type and ink on a slip of paper with its real shadow and a strip of tape (never a bubble), a few ink bars after them
  moving with the voice while it's held, settled and breathing while the last words come (`bookheard.js`); let go,
  the mic is out at once, nothing says Listening, and the words land there and stay on their slip, a text marked
  `voice` (`booktape.js` `book.tape.words` at a page's point; drawn so on the card, the share picture and the store's
  page picture, `bookrender.ts`), edited as any typed words are. The words come over the live line, as
  they're said (`dictate.js` `dictateLive`): their accuracy is the recogniser's, which the board corrects after. On the page, a
  double tap held still is the same note at its spot, by the Pencil, or a finger where a finger draws, with the pen or
  the marker (`bookinput.js`): on the grid its first tap opens the card (or makes a new scrap) and the note is a slip
  on it. While the second press is held a small ring fills round the pen's point, never under it (`bookholdring.js`),
  gone at once if the press wanders, lifts early or meets a second finger; held as long as the board's setting, Hold
  to talk in Preferences (short, medium or long: `shared/review/prefs.js`). A single press held is only ink. Off the book, on HQ's own page, nothing waits on a held
  pen.
- **The tools' cards** and every panel in the book that can't be pressed (the preferences, the dots menu, the pages)
  lie flat, never on a key's base (no hard shadow straight under them): if it looks like a key, it presses
  (`bookui.css`). In a card the spacing narrows inward, as the brand guide's does: its margin at the edge the widest,
  the gaps between its colours and icons the least (`booktools.css`). The pen's and the marker's colour dot sits clear
  of its icon on the tools. A shape's outline and fill sit on the widths' line behind an upright rule, never among the
  shapes (`bookpalette.js`).
- **Notes** lie on the page as plain paper, with no inner shadow or turned corner on the room under them
  (`bookgroups.css`).
- **The tear:** a press at the page's right edge, where the spine is, drawn to the left, tears a copy off (`booktear.js`).
  It shrinks into the hand, to be let go on Submit, PDF or PNG. The hand takes it along the spine's middle, well clear
  of the screen's corners, where iPadOS resizes the window (call 193). Nothing shows at the edge till a hand comes: a
  press there, or the Pencil hovering, shows the page's perforation, the strip beyond it giving as it's drawn away
  (`booktearedge.js`); never a button, and a line drawn there still draws. Tear off and send in the bar's dots menu
  opens the same three, the perforation showing a moment.
- **All pages** (the overview, `bookshelf.js`) is the page's own paper and dots top to bottom, with one title line ("‹
  Shelf", the notebook's name, its options: Change cover, Archived pages, a project book's Archive this book), the
  search as an island, plain chapter heads and page pictures with no outline or button on any. A page is archived from
  the bar's dots menu. One type at one weight, Atkinson
  (`fonts/`).
- **My shelf** stays HQ's own window from its Shelf key, and the window is a bookcase (`bookshelfbooks.js`), drawn
  straight on as the things on it are: books covers out standing on the boards' top edges, two to
  a board on a phone and three on an iPad, the Archive a lidded box, and the plant in the free room on My shelf only,
  never behind anything. The shelf's name is a card in a brass label holder on its top board, never loose text. My
  journal wears the book's own black cover. The HQ look decides how the shelf is drawn, the brand's colours only tint
  it: in Slate and Holo it's real wood, never a dark shelf, tinted slightly towards the look's colours and lettered in
  its own dark ink (`--bk-shelf-tint`, `--bk-shelf-tint-share`, `--bk-shelf-ink`, the renderers' skin.css); in
  Brownstone the same bookcase is pixel art, untinted, its name in HQ's pixel type and its Close HQ's own key
  (`renderers/brownstone/shelf.css`), and its books pixel cloth with pixel-paper plates in HQ's type; in every other
  look they stay real books. It opens whole: read ahead, and before
  its first read it stands with the boards it had last time, its things arriving on them. No menu on a cover. A book
  tapped opens on its All pages.

## The book's icons

Every icon on the book's controls (the tools and their card, the bar, the menus, the overview and the Shelf's keys) is
one of HQ's, named (`icon('tool-pen')`, `../icons.js`) and drawn in the look on stage's own style: Brownstone's pixel
art, Holo's line, and Slate's from the brand guide (the kit's set) (board, call 193). The book never draws an icon of
its own. A new control names its icon, and its drawing goes in every style's folder (`icons/pixel/`, `icons/smooth/`
and the company's kit): `icons.test.js` fails a name the code uses that a style lacks, and `icons-check.mjs` a book
showing one missing. What lies on the paper stays the paper's, drawn by hand in every look: the stamps, a slip's clip,
the bookmarks and the covers. A guest's book, with no look, wears the line set. A pixel icon of a pen or a brush is
drawn upright, tip down: low-res pixels can't draw a diagonal cleanly. Rename page wears the text tool's T, never a pen,
which reads as drawing.

## What a page offers

The board's rules for what a Notebook page lets you do with what's on it.

- **Assign** hands any scrap of an open page to someone invited, never an agent (`bookassign.js`, the store's
  `bookassign.ts`): by circle and line on the grid, Geef aan… in an opened scrap's ⋯, or Select's bar.
- **Select's bar** is one line of icons: Assign, Duplicate, Move to page… and Delete (`bookselectclip.js`). Duplicate
  is the copy and paste, Move to page… and a drag the cut.
- **Moving to a page** takes what's picked to an open page of its chapter, or to a new page, from one list: this page
  muted, New page last (`bookmoveto.js`). Select's Move to page… opens it under its button; on the grid, circle and
  line shows the pages as a drop zone.
- **A locked page** (sent, or a call's notes page not yet handed out) takes no tool, key or Paste (`bookwrite.js`
  `drawable`, `bookselectclip.js`). Once sent it shows no Undo, Redo, or Tear off and send (a guest's page keeps Undo
  while its send can still be taken back: `bookcontrols.js`), and a sent sketch page offers Duplicate instead: a new
  open page with everything on it, to carry on from. A call's notes page not yet handed out says Locked under its
  title, fixed with it while the page scrolls (`bookviewhead.js`), never on the page itself.

## Bookmarks

Every book of the board's has its chapters as bookmarks (`bookmarks.js`, `notebookchapters.js` shared with the store):
Sketch, Asks and Calls, a round's Guests, Asks and Advice. A page's chapter comes from its kind, and the store lists a
book's pages chapter by chapter, so the bar counts within one ("1 / 4" between the page's arrows). Each keeps one colour
for good and never lights. Beside HQ's page they stick out of the page block to the left, on an upright iPad too. On a
page that is the whole screen (upright, not beside HQ's page: `book.js`'s `data-whole` on the book, set from where it's
going) they lie folded at its left edge, slivers with their icons, and a tap brings them out. A call's notes page is
under Calls, shut at hang-up and stamped Sent once the call's follow-up has handed out what's on it.

The board's rules for them as real ribbon:

- **Made by a person:** each a ribbon notched at its end, with its icon alone on it in a deeper tone of its own
  colour and no words (its name is its label). Each is a finger's 44 px to the touch with its gap, its icon read at a
  glance on an iPad, and it sticks out a little less than the pull tab; they sit just above it, one group, never
  sprawling over HQ's page (`bookmarks.css`). Folded on a page that is the whole screen they're bigger, easy to see
  and to hit on a phone, out a little further than the pull tab a clear gap below them, yet short of the grid's column
.
- **The pull tab at the edge:** on a phone's whole-screen page it hangs flush with the screen's left edge. On a tablet
  it hangs 24 px in, as iPadOS takes the touches at a split screen's edge (`book.css`).
- **No outline:** ribbon has no drawn edge. Their soft shade alone sets them off the paper or the table, as the book's
  labels and pull tab are (`bookmarks.css`).
- **Out of the book while it swings:** on a page that is the whole screen, while the book swings open or shut they
  stick straight out of its fore-edge as they do beside HQ's page, never over its page, and the book is a little
  thicker for them. They fold in at the screen's left edge only once it has landed.
- **Folded alike:** the three slivers are as strong and the same shade (an empty chapter's no paler), stick out exactly
  as far, and each icon sits clear of the screen's edge. The page's own shows only once they're brought out, a little
  longer than the others.

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
