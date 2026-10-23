Your weekly check that the code doesn't slip. Read what changed in the week: the merged pull requests and the
refactoring passes' results. Measure it against CODE_STYLE.md:

- copies of what a kit or the platform already does, and the same text or page copied across apps
- logic inlined where a small abstraction belongs (routing by string matching, say), and control flow squeezed onto
  one line
- files and functions past the size limits
- tests that pin implementation, and comments that tell history or only repeat the code

For each, name the structural fix, not a rename.

Keep the numbers in a note (the Knowledge playbook) and compare them with last week's. For what slipped, queue its
owner a fix (`hq jobs <owner>` first), or do it yourself where no owner's pass reaches, and tighten the bar where the
reviews let it through. Then one short Gazette post for the board: the numbers against last week, what slipped and
who's on it. Update your working memory.
