// An agent's ink: its own colour, the same on every look, readable on paper and HQ alike, and never the board's red.
// The Pencil draws a call's agent's ink in it (calldraw.js), the store types an agent's answer onto the book's page
// in it (the coordinator's bookslips.ts). No DOM, so all import it. (the book's rings round a page asked about went with
// the sheets)
export const INKS = ['#7b5ea7', '#12808a', '#4458c9', '#2e8b57', '#b06a12', '#b0417a'];
export const inkOf = agent => INKS[[...agent].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % INKS.length];
