// The building cut open at night, a wide shot: every room lit and someone small in most of them, one room left dark.
// Wide shots and small figures suit stories about the whole team or the whole building.
export default (g, { C, R, fg, cutaway, figure, moon }) => {
  const rooms = cutaway(g, { floors: 3, rooms: 3, width: 96, time: 'night', seed: 'night' });
  moon(g, 9, 9, 4, { crescent: true, sky: C.ink });
  const at = (f, i) => rooms.find(r => r.floor === f && r.room === i);
  const dark = at(2, 2); R(g, dark.x, dark.y, dark.w, dark.h + 3, C.night);
  const who = [['ada', 0, 0, 'carry'], ['ben', 0, 2, 'stand'], ['cleo', 1, 0, 'wave'], ['dev', 1, 1, 'stand'], ['eli', 2, 0, 'walk'], ['fay', 2, 1, 'stand'], ['gus', 0, 1, 'walk']];
  for (const [id, f, i, frame] of who) { const r = at(f, i); figure(g, id, r.x + 6 + ((i * 7 + f * 5) % (r.w - 14)), r.foot, { frame }); }
  // a little furniture so the rooms read as rooms
  const desk = at(1, 1), x = desk.x + desk.w - 12;
  fg(g, g => { R(g, x, desk.foot - 5, 10, 1, C.wood); R(g, x, desk.foot - 4, 1, 4, C.woodD); R(g, x + 9, desk.foot - 4, 1, 4, C.woodD); R(g, x + 3, desk.foot - 9, 5, 4, C.teal); });
  const pot = at(2, 1), px = pot.x + pot.w - 7;
  fg(g, g => { R(g, px, pot.foot - 3, 4, 3, C.orange); R(g, px + 1, pot.foot - 7, 2, 4, C.leaf); R(g, px - 1, pot.foot - 6, 2, 2, C.grass); R(g, px + 3, pot.foot - 8, 2, 2, C.grass); });
  const lamp = at(0, 2); fg(g, g => { R(g, lamp.x + 4, lamp.foot - 11, 1, 11, C.slate); R(g, lamp.x + 2, lamp.foot - 13, 5, 2, C.gold); });
};
