
# Routes


A server's routes as one table on the web's own `URLPattern` (global in Node 24, the same in the browser): no
dependency, no path matched by hand.

```ts
import { routes } from '../../shared/routes/routes.ts';

const api = routes({
  'GET /api/orders/:id': ({ res, params }) => sendOrder(res, getOrder(params.id)),
  'POST /api/orders': async ({ req, res, jsonBody }) => sendOrder(res, createOrder(req, await jsonBody())),
  'POST /api/pairs/:code([\\w\\-]{22})/send': ({ res, params }) => sendPair(res, params.code),
  '* /api/care/*': ({ req, res, params }) => care.serve(req, res, params[0]),
});
createServer((req, res) => api(req, res));
```

- **A key** is `'METHOD /pattern'` in URLPattern's pathname syntax: `:name` for a segment, `:name(regex)` where an id
  has a shape (the regex has the `v` flag: a `-` in a class is escaped), `{/:action}?` for an optional part, `*` for
  the rest. The method `*` takes every method. The first matching entry wins.
- **A handler** gets `{ req, res, url, params, jsonBody }`: the params decoded by name, and `jsonBody(max = 20_000)`,
  the body parsed, `{}` when it's empty, or `null` when it isn't JSON or is over max bytes. A failed body read
  rejects to the server. The handler should only adapt the request to a module function (`CODE_STYLE.md`, Naming).
- **The answers it gives itself**, as JSON with a `code`: no match 404 `notfound`, a path that matches with another
  method 405 `method` (with `Allow`), a malformed percent-encoding in a named param 400 `generic`. HEAD is answered by
  the GET route. A refused request's unread body isn't drained: the connection closes after the answer.
- **Bodies**: `routes(table, { body })` takes a reader of the server's own (a memory budget, timeouts). A server
  that matches its own paths reads with the same exports: `readBody(req, max)`, the bytes or `null` past max (the rest
  read off, so its answer still goes), `readJson(req, max)` on it, as `jsonBody`, and `parseJson(bytes)` for a body
  already read. A body cut off rejects, as does any failure of a supplied reader.
- **Named params are decoded**, a `%2F` or `%00` included: constrain one with a regex in the pattern before using it as
  a path or a key. A `*` comes as written (`params[0]`), so a file's name with a lone `%` still reaches its lookup. A
  HEAD to a route that has no HEAD entry runs its GET handler, so a GET that changes something should refuse a HEAD
  itself.

`node --test shared/routes/routes.test.ts` drives a real server through `fetch`.
