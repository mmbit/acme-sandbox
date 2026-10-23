// The company's brand as company/brand.yaml gives it (render.mjs serves it, page.html hands it over): a cover draws
// the logo from its pixels and colours instead of copying them. Guideline: README.md.
let brand;
export const setBrand = b => {
  brand = b;
};
// brand.yaml's logo: its pixels ('#' the letters, 'o' the accent mark) and colours ({ ink, accent, shadow })
export const logo = () => brand.logo;

// The logo's pixels at 1 px each: the letters in ink, the accent mark in accent, and under the mark's foot its seam (the
// shadow, the mark's side), each colour brand.yaml's unless given. Brownstone's wordmark shadows every letter; this
// draws only the accent mark's seam.
export function wordmark(g, x, y, colours = {}) {
  const { pixels, colours: own } = logo(),
    c = { ...own, ...colours };
  pixels.forEach((row, v) =>
    [...row].forEach((ch, u) => {
      const fill = ch === '#' ? c.ink : ch === 'o' ? c.accent : v && pixels[v - 1][u] === 'o' ? c.shadow : null;
      if (fill) {
        g.fillStyle = fill;
        g.fillRect(x + u, y + v, 1, 1);
      }
    }),
  );
}
