// The shared Notebook's page records and summaries as the shell keeps them.
export const recordOf = p => ({
  ...summaryOf(p),
  ink: null,
  scraps: [],
  texts: [],
  groups: null,
  gone: new Map(),
  error: '',
});
// (what the store says of a page: its day the one it was made on, its title its label; its groups' count left out, as
// a page read keeps its groups there)
export const summaryOf = ({ groups: _count, ...p }) => ({ ...p, label: p.title ?? '', day: localDay(p.created) });
export const localDay = at => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
