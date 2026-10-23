# mockup.mjs: see the printed product before anything is printed

Turns a flat design into a photo-like image of the Print API product it will be printed on. It uses
headless Chromium (Playwright, installed globally) and draws everything in code: the scene, the props,
the paper and wood textures, the light and the shadows. No stock photos (house rule 6). One file, no dependencies to install.

```sh
node shared/demo/mockup.mjs mug design.png --out mug.png
node shared/demo/mockup.mjs postcard design.png --out ad.jpg --size 1080x1920 --surface '#e9dccb' --accent '#ff6b4a'
node shared/demo/mockup.mjs poster design.png --out cutout.png --transparent      # product + soft shadows on alpha
node shared/demo/mockup.mjs --all design.png --out sheet.png                       # sheet-<product>.png each + a contact sheet
```

| product  | shown as | art ratio (w:h) |
|---|---|---|
| poster   | paper on a wall (or leaning, `--scene table`) | 3:4 or 4:3 (30×40) |
| canvas   | 2 cm stretched canvas, image wraps the sides, weave texture | 3:4 or 4:3 |
| calendar | A4 page with spiral wire, hanger and page stack | 1:1.414 (either way) |
| clock    | round printed face with hands at 10:09 | 1:1 |
| mug      | 330 ml, wrapped on a cylinder with glaze highlight; `--view left/right/front`, `--magic 0..1` | 2.02:1 (198×98 mm) |
| card     | folded A6, standing open on a table (the art is the front) | 1:1.41 |
| postcard | A6 flat lay with a blank address side beneath | 1.41:1 or 1:1.41 |
| book     | hardcover, standing 3/4 view with spine | 1:1 (21×21) or A4 either way |
| puzzle   | top-down, real jigsaw cuts (`--pieces 500`), three loose pieces | 4:3 or 3:4 |
| tile     | 15×15 glossy ceramic tile standing in Print API's wooden holder: a pale block 10 × 3.3 cm that hides the tile's bottom 13 mm (keep text clear of it) | 1:1 |

- **Scenes:** `--scene wall|table|flat|studio|none`. Each product has a sensible default. Restyle per team
  with `--wall`, `--surface` (table or sideboard) and `--accent` (plant pot, pencil), or drop the props with `--no-props`.
  Pick your own colours so the five products don't all look the same. The scenes help, they never limit:
  `--transparent` gives the printed object and its shadow alone, to set in a scene drawn
  for the product.
- **Sizes:** `--size 1600x1200` (default), `1080x1920` or `1080x1080`. Use `--scale 2` for retina output.
- **Ratio:** if the art doesn't match the product, it warns and crops to fill (cover). Export the art at the ratio above.
- **Honest claims (rule 4):** only mock up products and options we actually sell. Don't show a frame, stand or
  packaging that Print API doesn't supply. The tile holder and the clock hands are real Print API options.
- **Output format** follows the `--out` extension: `.png` (lossless, needed for `--transparent`) or `.jpg` (much smaller, fine for ads and docs).
- Examples: `shared/demo/examples/mockups/` (source art in `art/`).
- Hello (the platform's test product): art `products/hello/demo/card-art.svg`, mockups `mockup-card.jpg` (1600×1200),
  `mockup-card-9x16.jpg` (1080×1920), `mockup-card-square.jpg` (1080×1080) and `mockup-card.png` (transparent), all in
  `products/hello/demo/`, made with:

  ```sh
  cd products/hello/demo
  node ../../../shared/demo/mockup.mjs card card-art.svg --out mockup-card.jpg --wall '#c8d5cf' --accent '#e0664f'
  node ../../../shared/demo/mockup.mjs card card-art.svg --out mockup-card-9x16.jpg --size 1080x1920 --wall '#c8d5cf' --accent '#e0664f'
  node ../../../shared/demo/mockup.mjs card card-art.svg --out mockup-card-square.jpg --size 1080x1080 --wall '#c8d5cf' --accent '#e0664f'
  node ../../../shared/demo/mockup.mjs card card-art.svg --out mockup-card.png --transparent
  ```

Not covered yet: memory game, wine box, bookmarks, mouse mat, wood, aluminium and acrylic panels, photo-print sets.
There are no apparel, sticker or phone-case mockups because Print API doesn't sell them.
