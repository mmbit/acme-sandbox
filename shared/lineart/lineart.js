// The isometric line-art style's drawing kit, in one import.
import { scene, PERSON } from './scene.js';
import { project, shapesOf, bounds, fit } from './shapes.js';
import { PALETTES, paletteOf } from './palettes.js';
import { svg, paint } from './draw.js';

export { scene, PERSON, project, shapesOf, bounds, fit, PALETTES, paletteOf, svg, paint };

// A drawing in one call: build(s) adds the items to a scene s, and the drawing fills a W x H frame in the palette
// (an id or a company's own). The rest of frame goes to fit (pad, focus, zoom) and svg (title, line, id).
export function drawing(build, palette, frame) {
  const s = scene();
  build(s);
  const shapes = shapesOf(s.items);
  return svg(shapes, paletteOf(palette), { ...frame, ...fit(shapes, frame) });
}
