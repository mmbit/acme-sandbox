// A close-up: one person, head and shoulders, filling the frame's left half, talking into a microphone, with a
// question in a bubble beside them. For interviews, a new face or anyone's own story.
export default (g, { C, R, P, fg, wall, bust, box, text, disc }) => {
  wall(g, { kind: 'brick', c: C.plum2 });
  R(g, 0, 60, 128, 12, C.woodD); R(g, 0, 60, 128, 1, C.wood);                   // the desk's edge, in front
  bust(g, 'fay', 18, 16, { mouth: 'open' });
  // the microphone on its stand
  fg(g, g => { R(g, 56, 44, 2, 16, C.slate); box(g, 52, 58, 10, 3, C.slate); box(g, 53, 32, 8, 12, C.grey); for (let y = 34; y < 42; y += 2) R(g, 54, y, 6, 1, C.slate); });
  // the question
  fg(g, g => { box(g, 74, 10, 44, 26, C.cream); R(g, 80, 36, 4, 3, C.cream); R(g, 78, 39, 3, 2, C.cream); });
  text(g, 'WHAT', 82, 16, C.plum); text(g, 'NEXT?', 90, 24, C.red);
};
