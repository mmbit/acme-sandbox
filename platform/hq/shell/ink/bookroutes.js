// The Notebook's routes under a guest scope: each keeps its board path's name, below the scope's api in place of
// /api/notebooks, and the book's /api/book routes keep their book/ part. The shell asks by the board's path
// (bookscope.js), and the coordinator answers by the same name and hands out addresses the same way
// (notebookguestroom.ts).

export const scopedPath = (path, api) =>
  path.replace(/^\/api\/(notebooks|book)(?=[/?]|$)/, (_, root) => (root === 'book' ? `${api}/book` : api));
