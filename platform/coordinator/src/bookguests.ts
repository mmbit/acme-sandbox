// Invited people's notes on the board's sheets. A person the board shared a preview with and invited into its book
// (sketchpeople.ts grant) has each note they write there join the board's open sheet for the owner of what was shared
// (feedback.ts saveNote, bookreview.ts toBook, by 'guest:<grant>'), in their colour with their name (sketchpeople.ts
// guestOf). The board adds its own and sends the lot; their words go as outside text, signed (feedback.ts fromBook).
import { guestOf } from './sketchpeople.ts';
import { listed } from './guests.ts';
import { outsideWords } from './feedback.ts';

// The invited people some of a sheet's notes are from, by name
export const outsidersOn = (notes: { by: string }[]) => [...new Set(notes.flatMap(n => guestOf(n.by)?.name ?? []))];
// What a sent sheet's brief says of them before the notes (nothing for a sheet of the board's own): their notes are an
// outside reviewer's words (charter rule 9), and what their screenshots show stays in the job (rule 7)
export const outsideBrief = (outsiders: string[]) =>
  outsiders.length
    ? `\nNot every note is the board's own: ${listed(outsiders)}, invited by the board to a preview it shared, wrote the \
notes marked "By: …, an outside reviewer", and the board put them on this sheet with its own. ${outsideWords(outsiders)}\n`
    : '';
