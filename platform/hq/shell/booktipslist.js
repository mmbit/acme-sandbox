// What the tips book (booktips.js) shows: what Ink can do, one thing a spread, in the chapters of the Ink 1.1 deck it's
// built from, with their accents. Each tip's title says plainly what it does, its words say how in a line or two, over
// the deck's picture of it (picture) or its motion study (film, with its still as the poster), rendered into
// theme/hq/tips/ from the deck's mocks (products/_cycles/2026-10-29-ink-vision/README.md). Each names the code it
// describes (from): a change to that behaviour changes its tip here in the same pull request, a new thing adds one, and
// a thing taken out takes its tip with it. The tips book shows only what's built. It's "circle" everywhere, never
// "ring".
import { MOD } from './ink/bookui.js';

export const PARTS = [
  { name: 'The book', accent: '#6b5ca5' },
  { name: 'The experience', accent: '#5cc26a' },
  { name: 'The pen and the page', accent: '#3f7f8c' },
  { name: 'Guests', accent: '#b0507a' },
  { name: 'How we answer', accent: '#ff9b4a' },
  { name: 'The feel', accent: '#9b72cf' },
];

export const TIPS = [
  // ---- The book
  {
    part: 'The book',
    title: 'Tap the pull tab to open or close the notebook',
    words:
      'The fabric tab on the cover’s edge opens the notebook beside HQ and closes it again. Drag it to make the notebook wider: far enough and it lies over HQ.',
    from: 'platform/hq/shell/ink/book.js, platform/hq/shell/ink/bookhandle.js, platform/hq/shell/ink/bookswing.js',
    picture: 'pull-tab',
    alt: 'The notebook shut and open on a laptop, its fabric tab on the cover, and on a phone',
  },
  {
    part: 'The book',
    title: 'Tap a bookmark to open its chapter',
    words:
      'Sketch, Asks and Calls are bookmarks along the notebook. Tap one for its first page. The red number on Asks counts what’s still yours to answer.',
    from: 'platform/hq/shell/ink/bookmarks.js',
    picture: 'book-final',
    alt: 'The notebook on an iPad sideways, its bookmarks at the side, and on a phone, its bookmarks along the top',
  },
  {
    part: 'The book',
    title: 'Turn the page with ‹ and ›',
    words:
      '‹ and › on the rail turn to the page before or after in the chapter. Tap the count between them to list its pages by name, and to give this page a title.',
    from: 'platform/hq/shell/ink/bookcontrols.js, platform/hq/shell/ink/booktitle.js',
    picture: 'bars-final',
    alt: 'The page bar with ‹ and ›, the page’s title and its number',
  },

  // ---- The experience
  {
    part: 'The experience',
    title: 'See every page, and every notebook on the Shelf',
    words:
      'The grid button on the rail shows all of a notebook’s pages: drag one to put it in order, tick its box to archive it. Pinch out there for the Shelf with every notebook.',
    from: 'platform/hq/shell/ink/bookzoom.js, platform/hq/shell/ink/bookshelf.js',
    picture: 'shelf',
    alt: 'Every notebook on the Shelf, and a brown envelope',
  },
  {
    part: 'The experience',
    title: 'Search what you wrote and said',
    words:
      'Search, at the top of the grid of pages, reads your handwriting and what you said as you wrote, across all your notebooks. Write in it with the Pencil, or type.',
    from: 'platform/hq/shell/ink/booksearch.js',
    picture: 'tip-search',
    alt: 'A word written in Search over the grid of pages, the pages with it picked out',
  },
  {
    part: 'The experience',
    title: 'Answer the asks edged in red',
    words:
      'An ask still waiting on you wears a red edge. The counter on the rail says how many are open, and its arrows take you to each in turn.',
    from: 'platform/hq/shell/ink/bookforyou.js',
    picture: 'open-asks',
    alt: 'Open asks edged in red, and the counter of open asks with its arrows',
  },
  {
    part: 'The experience',
    title: 'Write under a scrap, and drag its room taller',
    words:
      'Every scrap has room to write under it. Drag the handle at its foot to make that room taller or shorter: what you write there stays with the scrap.',
    from: 'platform/hq/shell/ink/bookunits.js, platform/hq/shell/ink/scrapunit.js',
    picture: 'room',
    alt: 'Room to write under a scrap, the Pencil writing in it, the handle at its foot',
  },
  {
    part: 'The experience',
    title: 'Pick up a scrap with Select to move it',
    words:
      'With Select, press a scrap to pick it up and drag it where you want it. Its bar has Move to page… for another page, and Delete.',
    from: 'platform/hq/shell/ink/bookselect.js, platform/hq/shell/ink/bookgroups.js',
    picture: 'move',
    alt: 'A scrap moved to another page, picked from the list of pages',
  },
  {
    part: 'The experience',
    title: 'Tear a page off by its corner to send it',
    words:
      'Drag the turned-down corner of a page onto Submit: the copy flies off as a paper plane, and the page is stamped Sent and locked. Drop it on PDF or PNG to keep a copy instead.',
    from: 'platform/hq/shell/ink/bookdogear.js, platform/hq/shell/ink/bookshare.js, platform/hq/shell/ink/bookpagesend.js',
    picture: 'tear',
    alt: 'The corner pulled onto Submit, the paper plane flying off, the page stamped and locked',
  },
  {
    part: 'The experience',
    title: 'Send a page with open asks, or answer them first',
    words:
      'Tear off a page that still has asks open on it, and a small card asks first: send now and move the open asks to a new page, or answer them first.',
    from: 'platform/hq/shell/ink/bookpagesend.js',
    picture: 'send-open',
    alt: 'The card on Submit: send now and move the open asks, or answer them first',
  },
  {
    part: 'The experience',
    title: 'Drag a page onto a call to show it',
    words:
      'On a call, drag a page by its corner, or a picture, onto the agent’s call window. Click the call first and a paste goes to the call, not the notebook.',
    from: 'platform/hq/shell/calldrop.js',
    picture: 'tip-call',
    alt: 'A page dragged by its corner onto the agent’s call window',
  },
  {
    part: 'The experience',
    title: 'Close a review round to get its Advice',
    words:
      'On the Shelf, a round’s book has Close the round in its menu. It goes to us in a brown envelope; when it comes back, pull its string to open the Advice.',
    from: 'platform/hq/shell/ink/bookshelfround.js, platform/hq/shell/ink/bookshelfbooks.js',
    picture: 'round-journey',
    alt: 'A review round from the invite to closing it, the brown envelope going to us and back',
  },

  // ---- The pen and the page
  {
    part: 'The pen and the page',
    title: 'Draw on HQ with the Pencil to make a note',
    words:
      'Draw on any page of HQ with the Pencil. Rest the pen a moment: your mark lifts into the notebook as a scrap, and HQ’s page is left clean.',
    from: 'shared/review/pencil.js, shared/review/lift.js',
    picture: 'viewer-ipad',
    alt: 'Marks on the work landed in the notebook beside it as scraps',
  },
  {
    part: 'The pen and the page',
    title: 'Turn on the pin to draw with a mouse or a finger',
    words: 'No Pencil? Turn on Settings › Pin on HQ, then tap the pin and draw on HQ the same way.',
    from: 'platform/hq/shell/pinsetting.js',
    picture: 'pen-button',
    alt: 'The pen button, and its switch in Settings',
  },
  {
    part: 'The pen and the page',
    title: 'Circle something to make a note about just that',
    words: 'With the Pencil, draw a circle round something on HQ: your note is about that one thing.',
    from: 'shared/review/gestures.js',
    picture: 'tip-circle',
    alt: 'A circle round one card on HQ, and the note about it in the notebook',
  },
  {
    part: 'The pen and the page',
    title: 'Hold the pen still and talk to add your words',
    words:
      'Hold the Pencil still on HQ and talk: what you say goes into the notebook with your mark. In the notebook, hold a press still on the page to leave words there.',
    from: 'shared/review/pentouch.js, platform/hq/shell/ink/bookvoice.js',
    picture: 'tip-voice',
    alt: 'The Pencil held still on HQ, the words said written out beside the mark',
  },
  {
    part: 'The pen and the page',
    title: 'Press and slide along the rail to pick a tool',
    words: `Tap a tool on the rail, or press and slide along it: the tool under your finger is picked as you let go. Tap the tool in use for its colours and width. On a keyboard: V Select, P the pen, E the eraser, T text.`,
    from: 'platform/hq/shell/ink/bookstrip.js, platform/hq/shell/ink/bookpalette.js',
    picture: 'rail',
    alt: 'The tool rail, the pen and the marker one tool, a finger sliding along it',
  },
  {
    part: 'The pen and the page',
    title: 'Paste or drop a picture on a page',
    words: `Copy a picture anywhere and paste it in the notebook (${MOD}+V), or drop a picture file on it: it lands on the page you’re on.`,
    from: 'platform/hq/shell/ink/booktape.js',
    picture: 'tip-paste',
    alt: 'A picture pasted onto the page as a print',
  },
  {
    part: 'The pen and the page',
    title: 'Press Undo to take a step back',
    words: `Undo on the rail, or ${MOD}+Z, takes a step back, and Redo puts it back. On HQ, tap two fingers together. A page you’ve sent is the one step it can’t take back.`,
    from: 'platform/hq/shell/ink/bookedit.js, platform/hq/shell/ink/bookrail.js, shared/review/pentouch.js',
    picture: 'tip-undo',
    alt: 'Undo on the rail bringing a scrap back',
  },

  // ---- Guests
  {
    part: 'Guests',
    title: 'Share the work to invite someone',
    words:
      'Open the work in the viewer and tap Share: pick who may look at it and write on it. Change or take away their access there any time.',
    from: 'platform/hq/shell/desk.js',
    film: 'guest-invite',
    alt: 'Share on the work opening who has access, someone invited from the address book',
  },
  {
    part: 'Guests',
    title: 'Circle a scrap and draw to a name to hand it over',
    words:
      'With the Pencil, circle a scrap and carry the line on out: the people you picked last pop up. End the line on a name and a copy flies to them. With a mouse, Select’s bar has Assign.',
    from: 'platform/hq/shell/ink/bookassign.js, platform/hq/shell/ink/bookassignlist.js',
    film: 'assign',
    alt: 'The pen circling a scrap and drawing out of it to a name, the copy flying to them',
  },

  // ---- How we answer
  {
    part: 'How we answer',
    title: 'Reply under an agent’s answer',
    words:
      'An agent’s answer appears under your note. Write a tick, a cross, a ? or a few words on the line under it: it’s sent once you rest the pen.',
    from: 'platform/hq/shell/ink/bookanswerreply.js',
    picture: 'ans-answer',
    alt: 'An agent’s answer under the note',
  },
  {
    part: 'How we answer',
    title: 'Circle a version to choose it',
    words:
      'When an agent tries a few versions, they show under your note, each with its preview. Circle the one you want: it’s stamped CHOSEN. Cross one out to drop it.',
    from: 'platform/hq/shell/ink/bookversions.js',
    picture: 'ans-versions',
    alt: 'Three versions with their previews, one circled',
  },

  // ---- The feel
  {
    part: 'The feel',
    title: 'Scribble over something to delete it',
    words:
      'In the notebook, scribble over a scrap: it crumples away, and Undo brings it back. On HQ, scribble over a mark before you rest the pen, and it’s gone.',
    from: 'platform/hq/shell/ink/bookgroups.js, shared/review/gestures.js',
    picture: 'crumple',
    alt: 'A scrap held, crumpled into a ball and thrown off the page',
  },
];
