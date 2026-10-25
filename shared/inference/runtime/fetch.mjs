// Downloads one weight file into the image as it builds, checking its size and SHA-256 as the bytes arrive. A file
// that doesn't match is removed and fails the build, so a wrong download never becomes a layer.
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, bytes, sha256, destination] = process.argv.slice(2);
const hash = createHash('sha256');
let size = 0;
mkdirSync(dirname(destination), { recursive: true });
try {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => {
    hash.update(chunk);
    size += chunk.length;
  });
  await pipeline(body, createWriteStream(destination, { mode: 0o444 }));
  const digest = hash.digest('hex');
  if (size !== Number(bytes) || digest !== sha256)
    throw new Error(`${destination}: ${size} bytes with SHA-256 ${digest}, not ${bytes} with ${sha256}`);
  console.log(`${destination}: ${size} bytes, SHA-256 ${digest}`);
} catch (error) {
  rmSync(destination, { force: true });
  console.error(error);
  process.exit(1);
}
