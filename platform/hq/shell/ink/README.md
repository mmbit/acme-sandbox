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
  `bookrail.js` Undo and Redo on the bar, `bookviewhead.js` the page's title and day on the view, `bookshelf*.js` the overview and the Shelf, `booksearch*.js` Search. `notebook*.js` read
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
- **A sent page stays where it is.** No page is made after it, even after the last.
- **What an agent puts down lands in sight only on an idle page.** The paper never slides to it while the board draws.
- **Ink stays where it was drawn.** A line beside a scrap stays put as the scrap's room grows or is dragged, and the
  room's edge reads at a glance. (On a sketch page what's below a room dragged taller moves down with the room it
  opens: Our scraps.)
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
`notebookasks.mjs`). What two stories need lives in one of four modules, never copied:

- `start.mjs`: the states a story starts from: a page watched for errors, HQ loaded, the book at rest open, the book
  open on a touch screen with a pen.
- `kit.mjs`: the screens, waits and readings: the iPad mini both ways, `until`, the Shelf opened and at rest, a
  screenshot's pixels, the microphone's stand-in, the pin.
- `preview.mjs`: a preview in HQ's viewer, review mode running in its frame.
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
  upright, ten or more across a 4K screen. The columns are drawn scaled (`scale`) from `LEAST` up to `MOST`, their
  own size, at the page's left under its title: the width left over is paper at its right, so a note's type is never
  bigger than the rest of the screen's. On paper too narrow for one column at
  `LEAST` with both margins (the narrowest book's, beside its tools), the margin at the notes' right gives way before
  their size does (`rightMarginOf`, in the page's scale `scaleOf`): the left one stays, under the title. The narrowest
  book (`booklayout.js` `BOOK.min`, 400 px) leaves paper enough for that column at `LEAST`. Units keep their own width and grow down, always `GAP` apart. A note with ink beside it
  takes every column that ink reaches into (its `w`), so a word written in that paper covers no note when the page
  widens. Ink on a note never widens it, so an arrow from one note
  onto the next moves neither. The board's own drawing has no paper, so all its ink counts. On a page drawn before
  this, an arrow from the drawing onto a note beside it was kept as the drawing's: that page widens the drawing once
  as it opens, and the notes after it move. That reflow is accepted, not rewritten when the page is read. `layout` takes each unit's height as the page draws it (its `h` and
  whatever hangs under it) and gives every place. A new day on the page starts under a date across every column
  (`headers`). `placeAt` finds the unit under a pen, and `pointIn` turns the pen's point into that unit's px.
- **The page** is HQ's (`bookunits.js`): it measures its width, calls `layout` again whenever the width or a unit's
  height changes, and draws each unit at its place as a sticky note, and a date where a later day starts (the title
  and the day of what's showing are the view's: The book's frame). It pinch-zooms from its fit (the paper's width) in to `ZOOM_MAX`, panning across as far as it's zoomed past
  its width (`bookview.js`, its limits in `bookrow.js`), and is laid left of the rail of controls (`--bk-rail-width`), its paper running on under them. A stroke goes to the unit it
  starts on, else to the board's own drawing it comes near, by its ink, never the empty frame round it (a word written
  inside a drawing's outline, away from its lines, is apart: `bookstrokes.js` `apart`),
  else it's a new unit of its own, the page's last, kept in
  the column it was drawn in (masonry's and the store's `column`), its ink where it was drawn; a unit's canvas reaches all its ink. The
  board's own drawings have no paper card. A scrap's words are part of its body; under an agent's body its
  room shows, with a handle at its foot (`heightFor`, saved with `/api/notebooks/groups/resize`). The page's lists hold
  each element at its unit's place on the page; `booksave.js` saves it in the unit's own px.
- **A Sketch page** is a canvas (`sketchcanvas.js`, shared by the page, the store's `notebookplaces.ts` and the picture
  agents read): each unit keeps its place in the page's px (`notebook_groups.place`), the same at any width. A stroke
  apart from every unit is a unit of its own where it's drawn. A unit with no place yet is laid as the masonry lays it
  and pinned there (`/api/notebooks/groups/place`: the first screen's place stands). What hangs under a unit goes
  where it covers no other. The page opens at scale 1 (a column's fit on a phone: `opensAt`), zooms from `ZOOM_OUT`
  (further out where what's drawn needs it) to `ZOOM_MAX`, and pans down till an edge of what's on it is left, never
  above or left of its corner or of what's already drawn beyond it (The book's frame).
  It pans across only as far as it's zoomed past the paper's width or something on it lies past the paper's right edge:
  no sideways wiggle (the board's).

## Our scraps

The board's rules for the scraps we put in its book (call 192, 3 Nov; call 193 left how scraps and drawing share a page
to us).

- **Taped on:** a scrap is one post-it, glued at its top and lying on the page with its own real shadow, as the board's
  picked mock-up draws it (`bookgroups.css` `.bk-unit-paper`). Its photo is taped straight onto it, a strip of tape
  whole across the photo's top edge, with no card or shadow of its own (`bookpage.js` photos, `bookscrapdraw.js`), and
  its words are written on the same paper. Under it is plain page, the room to write.
- **Ink is on top:** the page's dry ink lies over everything on it, a scrap's photo, its words and typed words included
  (`bookdesk.css` `.bk-ink`). Our scraps' photos are the page's own elements under every unit's canvas, so no unit's
  ink lies under another's photo.
- **A stroke starts anywhere:** on a scrap's photo or its words too, by finger or Pencil. A press there waits: a tap is
  the thing's (its words' caret), a line drawn from it is ink (`bookwrite.js` drawable, `bookgroups.js`). Only the words
  being typed in are the field's.
- **Our scraps are fixed:** the board draws over them, rubs out and undoes its own ink there, and edits their words;
  nothing else. Select, a loop or Select all picks one only whole, with no handles, and a drag or grip moves nothing
  of it; Assign, Move to page and Delete still take it whole (`bookunits.js` fixed, `bookselect.js` holdsFixed).
- **The handle only adds room:** a scrap's room dragged taller on a sketch page moves what's under it and everything
  below its foot down as far, so it never pulls one note under another; whatever is beside it stays. Dragged shorter,
  nothing moves (`sketchcanvas.js` pushedDown, kept by `/api/notebooks/groups/resize`'s push).
- **Scraps and drawing share a sketch page:** one page, no scrap pages and drawing pages. A scrap lands under
  everything on it; the board draws anywhere. A line started on a scrap, or drawn across it, belongs to it; a line by
  it in its room is its too. Anywhere else a drawing is the board's own, where it was drawn.
- **Dates where a day starts:** the page's first day is in its head. On a sketch page, the first scrap of a later day
  has that day's date just above its top-left, and lands with room for it (`sketchcanvas.js` daysOf); the board's own
  drawing never dates anything, so free drawing puts no dates on the page. A page of scraps (Asks) starts a later day
  under a date across its columns. A call's page never spans days: no dates on it.

## The book's frame

The board's rules for the book as a real book, seen from the side.

- **The page:** the spine is the screen's right edge, and only the left page shows. The paper runs the screen's whole
  height, up under the status bar's blur, with no cover band (`book.css`). Upright, on a phone or an iPad, the page is
  the whole screen. Beside HQ's page a slim page block stands at its outer edge.
- **The page to every edge:** the page is one surface under the whole paper, up under the status bar's blur, beside
  and round the tools' island and under the bar, so ink goes right up to every edge; only a press on a control is the
  control's (`bookdesk.css`). Its dots zoom with it there too. Only its content is set down below the blur and laid
  left of the tools: the desk's padding, read as `book.size`'s `top` and `right` (`bookview.js`). A place on a page
  (remembered, a find's, a box shown) is its point at that content's top-left.
- **The title on the view:** the page's title, and under it the day of what's showing (the topmost scrap or drawing
  seen below it; none on a call's page, whose title has its date), sit fixed at the view's top left below the blur,
  never zoomed or panned with the page (`bookviewhead.js`). Once the page is scrolled, what passes under them goes
  quietly out of sight under a band of frosted paper across the page, from the screen's top to just below the date,
  its foot fading out: never cut by a box. It takes no press: the page under it is drawn on. The dates between days
  stay on the page, each handing its day to the title as it reaches it, so no second date shows under it. Zoom and pan never go above or left
  of the page's corner, where the title lies at rest (`bookrow.js` `canvasPans`, `unitsPans`). Rename page, first of
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
- **Two islands** float over the paper, HQ's own controls in HQ's look (`bookui.js`, `bookstrip.css`). Only the page is
  paper. The tools stand on the right, upright and short: on a phone, well under half the screen's height. The bar runs
  along the foot between the screen's corners: Undo and Redo at its left, the page's arrows and count exactly in its
  middle, All pages and its dots menu at its right. What's written is laid left of the tools, but ink goes under and
  beside them.
- **The islands are glass:** the tools' island and the bar are lightly frosted glass over the page, in every look: the
  look's panel two thirds opaque, what's under it blurred, a line of light on its top edge, the look's own edge kept
  (`bookstrip.css`, the renderers' skin.css). A dark panel dims what it lets through, so it stays dark and its keys
  read. While the book swings or its tab is held, the frost is off, so the swing keeps its frames. Never overdone: a
  hairline rim at most.
- **The bar's spacing** gets smaller inward: its margin at its ends the largest, then the room each side of a rule,
  alike at every rule, then the gap between two keys, alike in every group. Each end holds two keys at every size, New
  page in the dots menu, so the parts sit against the middle alike on both sides (`bookstrip.css`).
- **The tools,** in order: the pen, shapes, the eraser, Select, Text and the mic (`bookpalette.js`). The pen and the
  marker are one tool. Its card holds what draws, its colour and its width, one tap away. A tap picks a tool, and
  nothing waits on a hold.
- **The marker under the ink:** a see-through line (the marker's, the pencil's) lies under the pen's ink while it's
  drawn, and over the page's words and a note's picture as all ink does, just as it dries, so nothing changes as it's
  lifted (`bookwet.js`).
- **Delete crumples and falls:** what's deleted or archived balls up and falls straight down off the screen's foot,
  never thrown aside or up, heard landing below (`bookpaper.js` `crumple`).
- **A voice note at a spot:** the mic tapped lights and waits; a spot then pressed and held on the page records there
  until it's let go (`bookvoice.js`). The words write themselves at that spot as they're said, live, in the page's own
  type and ink, never in a bubble, with a small loader of three ink dots after them while more are coming
  (`bookheard.js`); let go, the mic is out at once, nothing says Listening, and the words land there as the page's own
  box (`booktape.js` `book.tape.words` at a page's point). The words come over the live line, as they're said
  (`dictate.js` `dictateLive`): their accuracy is the recogniser's, which the board corrects after. On the page, a
  double tap held still is the same note at its spot, by the Pencil, or a finger where a finger draws, with the pen or
  the marker (`bookinput.js`), after the board's setting, Hold to talk in Preferences (short, medium or long:
  `shared/review/prefs.js`). A single press held is only ink. Off the book, on HQ's own page, nothing waits on a held
  pen.
- **The tools' cards** and every panel in the book that can't be pressed (the preferences, the dots menu, the pages)
  lie as the tools' island does, its edge and shadow, never on a key's base: if it looks like a key, it presses
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
  (`renderers/brownstone/shelf.css`). The books stay real books in every look. It opens whole: read ahead, and before
  its first read it stands with the boards it had last time, its things arriving on them. No menu on a cover. A book
  tapped opens on its All pages.

## The book's icons

Every icon on the book's controls (the tools and their card, the bar, the menus, the overview and the Shelf's keys) is
one of HQ's, named (`icon('tool-pen')`, `../icons.js`) and drawn in the look on stage's own style: Brownstone's pixel
art, Holo's line, and Slate's from the brand guide (the kit's set) (board, call 193). The book never draws an icon of
its own. A new control names its icon, and its drawing goes in every style's folder (`icons/pixel/`, `icons/smooth/`
and the company's kit): `icons.test.js` fails a name the code uses that a style lacks, and `icons-check.mjs` a book
showing one missing. What lies on the paper stays the paper's, drawn by hand in every look: the stamps, a slip's clip,
the bookmarks and the covers. A guest's book, with no look, wears the line set.

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
for good and never lights. Beside HQ's page they stick out of the page block to the left, on an upright iPad too. On a
page that is the whole screen (upright, not beside HQ's page: `book.js`'s `data-whole` on the book, set from where it's
going) they lie folded at its left edge, slivers with their icons, and a tap brings them out. A call's notes page is
under Calls, shut at hang-up and stamped Sent once the call's follow-up has handed out what's on it.

The board's rules for them as real ribbon:

- **Made by a person:** each a thin ribbon, notched at its end, with its icon alone on it in a deeper tone of its own
  colour and no words (its name is its label). It sticks out about as far as the pull tab, and they sit just above it,
  one group, never sprawling over HQ's page (`bookmarks.css`).
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
