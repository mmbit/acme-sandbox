// The street, a medium shot: the van at the kerb with its back door open, one person carrying a parcel to it and
// another by the door with the next few. No room, no table: the story happens outside.
export default (g, { fg, street, van, parcel, streetLamp, tree, person, shadow }) => {
  street(g, { seed: 'delivery' });
  fg(g, g => tree(g, 8, 57));
  fg(g, g => streetLamp(g, 120, 57));
  shadow(g, 64, 69, 26);
  fg(g, g => van(g, 42, 70, { label: 'POST', open: true }));
  person(g, 'ada', 18, 57, { item: 'box' });
  fg(g, g => { parcel(g, 92, 47, 10, 9); parcel(g, 94, 40, 7, 7); });
  person(g, 'ben', 104, 57, { right: false });
};
