// The size a picture declares in its own header (PNG, JPEG or SVG), read without decoding it.

export type Size = { width: number; height: number };

const PNG_SIGNATURE = 0x89504e47;

// null when the bytes are none of the three, or their header doesn't add up
export function pictureSize(bytes: Buffer): Size | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === PNG_SIGNATURE)
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return svgSize(bytes);
}

// Walk the JPEG's segments to its frame header (SOF0 to SOF15, without DHT, JPG and DAC) and read the size it declares.
// null if there's none before the scan, or the segments don't add up. The first SOF counts: libjpeg refuses a second.
export function jpegSize(bytes: Buffer): Size | null {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      // a fill byte
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // a marker without a length
      i += 2;
      continue;
    }
    // the end, or the scan, before any frame header
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return null;
      return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

// An SVG's size is its viewBox's width and height
function svgSize(bytes: Buffer): Size | null {
  const viewBox = bytes.toString('utf8').match(/<svg\b[^>]*?\sviewBox="[\d.\s-]+?([\d.]+)\s+([\d.]+)"/);
  return viewBox ? { width: Number(viewBox[1]), height: Number(viewBox[2]) } : null;
}
