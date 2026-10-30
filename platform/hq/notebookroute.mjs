import { fileURLToPath } from 'node:url';

// The Notebook's routes in a browser check, answered by a play of its store (shell/ink/notebookplay.js), the one dev
// mode plays: a refusal as the coordinator's, its status and { error }. One stand-in, so a check's notebook moves with
// notebook.ts's answers.
//   - heard(path, body): each POST as it comes in, before the play answers it (a picture's body: { bytes, type }).
//   - bytes(): a picture's bytes the browser didn't hand over (WebKit gives a blob's body as null).
export function notebookRoute(r, play, { heard, bytes } = {}) {
  const req = r.request(),
    url = new URL(req.url()),
    path = url.pathname,
    picture = path === '/api/notebooks/pictures';
  const body =
    req.method() !== 'POST'
      ? undefined
      : picture
        ? { bytes: req.postDataBuffer() ?? bytes?.(), type: req.headers()['content-type'] }
        : req.postDataJSON();
  if (body) heard?.(path, body);
  try {
    const answer = play.route(path, url.searchParams, body);
    if (picture && !body) return r.fulfill({ contentType: answer.type, body: Buffer.from(answer.bytes) });
    return r.fulfill({ json: answer });
  } catch (e) {
    if (!e.status) throw e;
    // (a seeded picture is mock/'s, as dev mode keeps it: job #14672.)
    const file = url.searchParams.get('file');
    if (picture && !body && e.status === 404 && /^[\w.-]+\.svg$/.test(file ?? ''))
      return r.fulfill({ path: fileURLToPath(new URL(`./mock/${file}`, import.meta.url)) });
    return r.fulfill({ status: e.status, json: { error: e.message } });
  }
}
