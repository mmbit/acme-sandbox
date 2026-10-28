// The files HQ serves, by extension. server.ts sends a file with its type and 404s the rest; the review sends back a post
// or note that points at one it wouldn't serve (company.ts missing()). An extension is matched in lower case: a phone
// names its photos IMG_1234.JPG.
import { extname } from 'node:path';

export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json',
};
export function typeOf(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined;
}
