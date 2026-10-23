// The machine-readable mark of a photo edited with generative AI, in a JPEG's or a PNG's XMP: IPTC's digital source
// type "composite with trained algorithmic media" (a real photo, edited by an AI model).
//   node shared/provenance/provenance.ts <file>...           marks each file in place (a resized copy loses the mark)
//   node shared/provenance/provenance.ts --check <file>...   says whether each carries it, and fails if one doesn't
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

export const AI_EDITED = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';
const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';
const PACKET =
  `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">` +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""' +
  ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">' +
  `<Iptc4xmpExt:DigitalSourceType>${AI_EDITED}</Iptc4xmpExt:DigitalSourceType>` +
  '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

export class NotAPictureError extends Error {}

// The picture with the mark as its only XMP. A content credential (C2PA) already in the file goes: it signs the file's
// bytes, so with the mark added it would read as tampered.
export function markAiEdited(picture: Buffer) {
  if (picture.subarray(0, 8).equals(PNG_SIGNATURE)) return markPng(picture);
  if (picture[0] === 0xff && picture[1] === 0xd8) return markJpeg(picture);
  throw new NotAPictureError('not a JPEG or PNG');
}

export function isAiEdited(picture: Buffer) {
  const packets = picture.subarray(0, 8).equals(PNG_SIGNATURE)
    ? pngChunks(picture)
        .filter(isPngXmp)
        .map(c => c.data)
    : jpegSegments(picture)
        .filter(isJpegXmp)
        .map(s => s.payload);
  return packets.some(p => p.includes(`>${AI_EDITED}<`));
}

// ---- JPEG: the mark in an APP1 segment after the opening JFIF one (else right after SOI), the scan data copied as it is
type Segment = { marker: number; payload: Buffer; bytes: Buffer };
const APP1 = 0xe1,
  APP11 = 0xeb,
  SOS = 0xda;
const isJpegXmp = (s: Segment) => s.marker === APP1 && s.payload.subarray(0, XMP_HEADER.length).equals(XMP_HEADER);
// APP11 holds JUMBF boxes, where C2PA keeps its manifest
const isJumbf = (s: Segment) => s.marker === APP11 && s.payload.subarray(0, 2).toString('latin1') === 'JP';

function markJpeg(picture: Buffer) {
  const segments = jpegSegments(picture),
    headerEnd = segments.reduce((end, s) => end + s.bytes.length, 2);
  const kept = segments.filter(s => !isJpegXmp(s) && !isJumbf(s));
  const payload = Buffer.concat([XMP_HEADER, Buffer.from(PACKET, 'utf8')]);
  const mark = Buffer.concat([Buffer.from([0xff, APP1]), u16(payload.length + 2), payload]);
  const at = kept[0]?.marker === 0xe0 ? 1 : 0;
  const head = [...kept.slice(0, at).map(s => s.bytes), mark, ...kept.slice(at).map(s => s.bytes)];
  return Buffer.concat([picture.subarray(0, 2), ...head, picture.subarray(headerEnd)]);
}

// The segments before the first scan (where every APPn lives), each with its marker and length bytes
function jpegSegments(picture: Buffer): Segment[] {
  const segments: Segment[] = [];
  let i = 2;
  while (i + 4 <= picture.length && picture[i] === 0xff) {
    const marker = picture[i + 1];
    if (marker === SOS) return segments;
    const length = picture.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > picture.length) break;
    segments.push({
      marker,
      payload: picture.subarray(i + 4, i + 2 + length),
      bytes: picture.subarray(i, i + 2 + length),
    });
    i += 2 + length;
  }
  throw new NotAPictureError('a JPEG whose segments end before its scan');
}
const u16 = (n: number) => {
  if (n > 0xffff) throw new Error('provenance: the XMP packet is too long for one JPEG segment');
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

// ---- PNG: the mark in an iTXt chunk right after IHDR, every other chunk copied whole
type Chunk = { type: string; data: Buffer; bytes: Buffer };
const isPngXmp = (c: Chunk) =>
  c.type === 'iTXt' &&
  c.data.subarray(0, PNG_XMP_KEYWORD.length + 1).equals(Buffer.from(`${PNG_XMP_KEYWORD}\0`, 'latin1'));
const isC2paChunk = (c: Chunk) => c.type === 'caBX';

function markPng(picture: Buffer) {
  const chunks = pngChunks(picture).filter(c => !isPngXmp(c) && !isC2paChunk(c));
  const data = Buffer.concat([Buffer.from(`${PNG_XMP_KEYWORD}\0\0\0\0\0`, 'latin1'), Buffer.from(PACKET, 'utf8')]);
  const typed = Buffer.concat([Buffer.from('iTXt', 'latin1'), data]),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([PNG_SIGNATURE, chunks[0].bytes, length, typed, crc, ...chunks.slice(1).map(c => c.bytes)]);
}

function pngChunks(picture: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 8; i + 12 <= picture.length;) {
    const length = picture.readUInt32BE(i),
      type = picture.toString('latin1', i + 4, i + 8),
      end = i + 12 + length;
    if (end > picture.length) break;
    chunks.push({ type, data: picture.subarray(i + 8, i + 8 + length), bytes: picture.subarray(i, end) });
    if (type === 'IEND') {
      if (chunks[0].type !== 'IHDR') break;
      return chunks;
    }
    i = end;
  }
  throw new NotAPictureError('a PNG that ends before its IEND');
}

// ---- the command line
if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2),
    check = first === '--check',
    files = check ? rest : [first, ...rest].filter(Boolean);
  if (!files.length) {
    console.error('usage: node shared/provenance/provenance.ts [--check] <file>...');
    process.exit(2);
  }
  let unmarked = 0;
  for (const file of files) {
    const picture = readFileSync(file);
    if (check) {
      const marked = isAiEdited(picture);
      if (!marked) unmarked++;
      console.log(`${file}: ${marked ? 'marked as edited with AI' : 'not marked'}`);
      continue;
    }
    writeFileSync(`${file}.marking`, markAiEdited(picture));
    renameSync(`${file}.marking`, file);
    console.log(`${file}: marked as edited with AI`);
  }
  if (unmarked) process.exit(1);
}
