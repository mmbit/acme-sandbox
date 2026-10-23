// A close-up of one object filling the frame: the corner of a parcel, its tape, its label and a stamp. No room
// around it: when the story is about one thing, get close to it.
export default (g, { C, R, P, fg, wall, box, text, lite, dark }) => {
  wall(g, { kind: 'plain', c: C.woodL });
  for (let x = 0; x < 128; x += 9) R(g, x, 0, 1, 72, dark(C.woodL, 0.06));       // the board's flutes
  R(g, 0, 26, 128, 12, lite(C.sand, 0.15)); R(g, 0, 26, 128, 1, lite(C.sand, 0.4)); R(g, 0, 37, 128, 1, dark(C.sand, 0.2)); // the tape
  // the label
  fg(g, g => {
    box(g, 14, 12, 66, 48, C.cream);
    text(g, 'TO', 20, 18, C.plum);
    for (const [y, w] of [[28, 48], [34, 40], [40, 30]]) R(g, 20, y, w, 2, C.slate);
    for (let x = 20; x < 72; x += 2) R(g, x, 48, (x * 7) % 3 ? 1 : 2, 8, C.ink);   // a barcode
  });
  // the stamp, with its perforated edge
  fg(g, g => {
    box(g, 88, 8, 30, 34, C.cream);
    for (let i = 0; i < 15; i++) { P(g, 88 + i * 2, 8, C.woodL); P(g, 88 + i * 2, 41, C.woodL); }
    for (let i = 0; i < 17; i++) { P(g, 88, 8 + i * 2, C.woodL); P(g, 117, 8 + i * 2, C.woodL); }
    R(g, 92, 12, 22, 22, C.teal); R(g, 92, 26, 22, 8, C.leaf);
    R(g, 100, 18, 7, 8, C.cream); for (let i = 0; i < 5; i++) R(g, 99 + i, 17 - i, 9 - i * 2, 1, C.red); // a little house
  });
};
