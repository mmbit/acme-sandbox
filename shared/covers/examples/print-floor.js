// The print floor: the big printer feeding one long poster out across the floor, and a person at its far end reading
// the first line. A different room has its own walls, floor and light, not the office's.
export default (g, { C, R, fg, printFloor, printer, person, shadow }) => {
  printFloor(g);
  shadow(g, 30, 63, 22);
  let slot;
  fg(g, g => { slot = printer(g, 10, 63); });
  // the poster: out of the slot, down to the floor and along it
  fg(g, g => {
    R(g, slot.x, slot.y, 6, 2, C.cream); R(g, slot.x + 4, slot.y, 3, 18, C.cream);
    R(g, slot.x + 4, 62, 44, 3, C.cream);
    [C.red, C.teal, C.mustard, C.blue, C.pink, C.green].forEach((c, i) => R(g, slot.x + 8 + i * 6, 63, 4, 1, c));
  });
  person(g, 'eli', 98, 63, { item: 'paper', right: false });
};
