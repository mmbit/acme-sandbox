# QR: a QR code for a link, drawn in the page

`qr.js` makes a QR code (ISO/IEC 18004) from a short text, in byte mode (UTF-8), at error correction level L, M, Q or
H, in the smallest version that holds it (1 to 40), with the mask the standard's penalty rules score lowest. One plain
module for the browser and Node, no dependencies. HQ's book shows one to pair a phone with the desktop
(`platform/hq/shell/ink/pair.js`; Ink's folder).

```js
import { qrCode, qrPath } from '../../../../shared/qr/qr.js';
const code = qrCode(link, { level: 'M' }); // { size, version, level, mask, dark(x, y) }
const n = code.size + 8;
svg.innerHTML = `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${qrPath(code)}"/></svg>`;
```

- `qrPath(code, { margin })` gives the dark modules as one SVG path, a unit per module, with `margin` modules of
  quiet zone (4 by default, as the standard asks). Keep the quiet zone light: a phone's camera needs it.
- Level M suits a link on a screen: a 60-byte link is a version 4 code (33 × 33 modules), still easy to scan at
  4 px a module.
- Only byte mode: a link is short either way, and every phone reads it.

## Using it

Browser code imports it by its path in the repo. HQ serves `/shared/qr/qr.js`; a product host serves it once the
company lists it in `SERVED_FROM_REPO` (`infra/products.md`), and an app's own server for a run from the repo.

## Checks

`node --test shared/qr/qr.test.mjs` holds two symbols to a reference encoder's (python-qrcode 8, the same mask forced),
the version information and the size limits. When it was written, every level at versions 1 to 39 (2 to 1200 bytes,
UTF-8 included) matched python-qrcode module for module, and zxing-cpp decoded each back to its text.
