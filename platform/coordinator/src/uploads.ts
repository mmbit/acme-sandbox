// What the board's uploads share: the JSON answer, a refusal and keeping the file.
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname } from 'node:path';

// `close`: for a refusal whose body may be unread, so the browser doesn't go on sending it on a kept-alive connection.
export const reply = (res: ServerResponse, code: number, body: unknown, close = false) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(close ? { connection: 'close' } : {}),
  });
  return new Promise<void>(r => res.end(JSON.stringify(body), () => r()));
};

// A refusal before the body is read: the answer, then the request destroyed
export async function refuse(req: IncomingMessage, res: ServerResponse, code: number, error: string) {
  await reply(res, code, { error }, true);
  req.destroy();
}

// The file written whole under a hidden name, then renamed: a reader never sees half of it. Only HQ may read it.
export function keepFile(file: string, bytes: Buffer) {
  const dir = dirname(file),
    tmp = `${dir}/.${basename(file)}-${randomBytes(4).toString('hex')}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, file);
}
