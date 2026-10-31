// What a try's versions block shows of a note group (bookversions.js), and the page's picture draws the same by
// (the coordinator's ink/bookpicture.ts triedOf). No DOM, so the coordinator imports it.

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// What the block shows of g's try, null for neither a try nor a version: whose it is (who), its versions in order with
// their letters, fates (what's become of one: cleared, or cleared once the page goes because another was chosen) and
// the board's replies on them, how many still coming, and why it ended with none (null otherwise)
export function versionsOf(g) {
  const versions = g.children.filter(c => c.kind === 'answer' && c.style === 'version');
  if (!g.try && !versions.length) return null;
  const chosen = versions.some(v => v.picked);
  return {
    who: g.try ?? versions[0],
    versions: versions.map((v, i) => ({
      ...{ v, letter: LETTERS[i] },
      fate: v.cleared ? 'cleared' : chosen && !v.picked ? 'cleared once the page is sent' : null,
      replies: g.children.filter(c => c.kind === 'reply' && c.answers === v.id),
    })),
    coming: g.try?.state === 'coming' ? Math.max(0, Math.max(g.try.expect ?? 1, 1) - versions.length) : 0,
    ended: g.try?.state === 'empty' && !versions.length ? g.try.reason : null,
  };
}
