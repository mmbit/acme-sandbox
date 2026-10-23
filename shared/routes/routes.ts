// A server's routes as one table on the web's URLPattern: 'METHOD /pattern' to a handler, a path with another method a
// 405, no match a 404. README.md shows the shape.
import type { IncomingMessage, ServerResponse } from 'node:http';

// What a handler gets: the request, its answer, the address, the pattern's params decoded by name, and its body as JSON
export type RouteRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  // the body parsed (as it came: check every field), {} when it's empty, or null when it isn't JSON or is over max
  // bytes. A failed body read rejects.
  jsonBody: (max?: number) => Promise<any>;
};
export type RouteHandler = (request: RouteRequest) => unknown;
// 'GET /api/orders/:id', 'POST /api/pairs/:code([\\w\\-]{22})/send', '* /api/care/*' (any method). A param's regex has
// the v flag: a - in a class is escaped.
export type RouteTable = Record<string, RouteHandler>;
// reads a body of at most max bytes, null when it's over that; a failed read rejects through jsonBody
export type BodyReader = (req: IncomingMessage, max: number) => Promise<Buffer | null>;

export const JSON_MAX = 20_000;

// The table as one handler (req, res, url?), for node:http's createServer or a server of its own: url is the address
// that server has already parsed, else it is read from req.url
export function routes(table: RouteTable, options: { body?: BodyReader } = {}) {
  const bodyOf = options.body ?? readBody;
  const entries = Object.entries(table).map(([key, handle]) => {
    const [method, pathname] = key.split(' ');
    if (!pathname) throw new Error(`routes: '${key}' isn't 'METHOD /pattern'`);
    return { method, pattern: new URLPattern({ pathname }), handle };
  });

  return async function route(req: IncomingMessage, res: ServerResponse, address?: URL) {
    const url = address ?? parse(req.url);
    if (!url) return refuse(req, res, 400, 'generic');
    const matching = entries.filter(e => e.pattern.test({ pathname: url.pathname }));
    const method = req.method === 'HEAD' && !matching.some(e => e.method === 'HEAD') ? 'GET' : req.method;
    const entry = matching.find(e => e.method === method || e.method === '*');
    if (!entry) {
      if (!matching.length) return refuse(req, res, 404, 'notfound');
      res.setHeader('allow', [...new Set(matching.map(e => e.method))].join(', '));
      return refuse(req, res, 405, 'method');
    }
    const params = decoded(entry.pattern.exec({ pathname: url.pathname })!.pathname.groups);
    if (!params) return refuse(req, res, 400, 'generic');
    const jsonBody = async (max = JSON_MAX) => {
      const bytes = await bodyOf(req, max);
      return bytes && parseJson(bytes);
    };
    return entry.handle({ req, res, url, params, jsonBody });
  };
}

function parse(path: string | undefined) {
  try {
    return new URL(path ?? '/', 'http://x');
  } catch {
    return null;
  }
}

// The named groups as their text, or null for a malformed percent-encoding. A `*` (its group a number) is the rest of
// the path as written: a file's name goes to its lookup, which decodes it.
function decoded(groups: Record<string, string | undefined>) {
  const params: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(groups))
      if (value !== undefined) params[name] = /^\d+$/.test(name) ? value : decodeURIComponent(value);
  } catch {
    return null;
  }
  return params;
}

// A refusal as JSON with a code. A body nobody reads isn't drained: the connection closes after the answer.
function refuse(req: IncomingMessage, res: ServerResponse, status: number, code: string) {
  if (hasBody(req)) res.setHeader('connection', 'close');
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code }));
}

const hasBody = (req: IncomingMessage) =>
  Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;

// The body in memory, at most max bytes, or null past that (by its content-length or as it comes in). Past max the rest
// is read off unkept, so the answer still reaches the sender. A body cut off rejects with the request's error.
export function readBody(req: IncomingMessage, max: number) {
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number(req.headers['content-length'] ?? 0) > max;
    if (over) resolve(null);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      over ||= size > max;
      if (over) resolve(null);
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// The body as JSON (as it came: check every field), {} when it's empty, or null when it isn't JSON or is over max
// bytes. A body cut off rejects.
export async function readJson(req: IncomingMessage, max: number) {
  const bytes = await readBody(req, max);
  return bytes && parseJson(bytes);
}

// A body already read, as JSON: {} when it's empty, null when it isn't JSON. For a route that answers a body past its
// cap apart from one that isn't JSON.
export function parseJson(bytes: Buffer) {
  if (bytes.length === 0) return {};
  try {
    return JSON.parse(bytes.toString());
  } catch {
    return null;
  }
}
