// The roof at dusk: the town's skyline beyond the parapet, the water tower, and two people at a telescope looking for
// the first star. Light the sky with a time of day instead of a window.
export default (g, { C, fg, roof, waterTower, telescope, star, bird, person, shadow }) => {
  roof(g, { time: 'dusk', seed: 'dusk' });
  star(g, 104, 8);
  bird(g, 30, 10); bird(g, 38, 14);
  shadow(g, 18, 62, 10);
  fg(g, g => waterTower(g, 10, 62));
  shadow(g, 76, 63, 8);
  fg(g, g => telescope(g, 70, 63));
  person(g, 'cleo', 52, 63);
  person(g, 'dev', 90, 64, { right: false });
};
