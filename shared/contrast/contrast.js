// WCAG 2's relative luminance and contrast ratio, for a theme's sums and a page check alike: sRGB channels 0 to 255 in.
// A browser module, served at its path in the repo beside the kits that import it

// One channel 0..1 through sRGB's curve to linear light. Luminance keeps WCAG 2.0's threshold unless asked for sRGB's
// own (0.04045). This takes ** for speed: a room's every pixel goes through it.
export const linearChannel = (channel, { threshold = 0.04045 } = {}) =>
  channel <= threshold ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

export function luminanceChannels(rgb, { threshold = 0.03928 } = {}) {
  const linear = rgb.map(value => linearChannel(value / 255, { threshold }));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

// A computed rgb() or rgba() string's sRGB channels, 0 to 255, its alpha left out
export const cssChannels = colour =>
  colour
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);

// From 1 (the same luminance) to 21 (black against white), whichever of the two is lighter.
export function contrastChannels(a, b) {
  const [hi, lo] = [luminanceChannels(a), luminanceChannels(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
