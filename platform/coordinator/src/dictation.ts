// Review mode's live dictation carried to the voice line (platform/voice/dictate.py): a reviewer's WebSocket upgrade,
// let in by feedback.ts, piped both ways to its internal /voice/dictate with the line's token. Nothing of it is read or
// logged here.
import { request, STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { VOICE_TOKEN, VOICE_URL } from './config.ts';

// The client's half of the handshake, which the voice line answers
const HANDSHAKE = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];

// lang: the language its words are written down in ('': written as heard, an outside reviewer's); done: once it's over, however it ends
export function carry(req: IncomingMessage, socket: Duplex, head: Buffer, lang: string, done: () => void) {
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    done();
  };
  const handshake = Object.fromEntries(
    HANDSHAKE.filter(name => req.headers[name]).map(name => [name, req.headers[name]]),
  );
  const upstream = request(`${VOICE_URL}/voice/dictate?lang=${encodeURIComponent(lang)}`, {
    headers: { ...handshake, connection: 'Upgrade', upgrade: 'websocket', authorization: `Bearer ${VOICE_TOKEN}` },
  });
  socket.on('close', () => {
    upstream.destroy();
    end();
  });
  upstream.on('upgrade', (answer, line, lineHead) => {
    const headers = answer.rawHeaders.map((value, i) => (i % 2 ? `${value}\r\n` : `${value}: `)).join('');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
    socket.write(lineHead);
    line.write(head);
    line.on('error', () => line.destroy());
    line.on('close', () => socket.destroy());
    socket.on('close', () => line.destroy());
    line.pipe(socket).pipe(line);
  });
  upstream.on('response', answer => {
    console.error(`dictation: the voice line answered ${answer.statusCode}`);
    answer.resume();
    refuse(socket, 502);
  });
  upstream.on('error', err => {
    if (over) return;
    console.error('dictation: the voice line:', err.message);
    refuse(socket, 502);
  });
  upstream.end();
}

// An upgrade refused: a plain HTTP status, and the connection closed
export const refuse = (socket: Duplex, status: number) =>
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );
