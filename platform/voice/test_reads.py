"""The call agent's report and git tools (reads.py): what they read, in pages, and that no word of the agent's becomes a
git option. Run: python3 -m unittest test_reads."""
import re, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import reads

REPORT = """(the report of 2026-10-25T20:40:16Z)
# Server status
== memory
Mem: 15613 used 6176
== work (the latest 30)
job 18510 bolt done
job 18511 bolt queued
== voice (last 40 lines)
call: session 1 turn 2 on claude-opus-5-5
"""


def sh(*argv, cwd):
    subprocess.run(argv, cwd=cwd, check=True, capture_output=True)


class Git(unittest.TestCase):
    """A mirror like the worker's (bare, branches in refs/heads, a job's unpushed commits in refs/outgoing)."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        work, mirror = f'{cls.dir.name}/work', f'{cls.dir.name}/mirror.git'
        sh('git', 'init', '-q', '-b', 'main', work, cwd=cls.dir.name)
        for k, v in (('user.name', 'Test'), ('user.email', 't@example.com')):
            sh('git', 'config', k, v, cwd=work)
        Path(f'{work}/a.txt').write_text('first line\n')
        sh('git', 'add', '.', cwd=work)
        sh('git', 'commit', '-q', '-m', 'The first', cwd=work)
        sh('git', 'checkout', '-q', '-b', 'job/7', cwd=work)
        Path(f'{work}/a.txt').write_text('first line\n--no-index here\n')
        sh('git', 'commit', '-q', '-am', 'Job 7 adds a line', cwd=work)
        sh('git', 'clone', '-q', '--mirror', work, mirror, cwd=cls.dir.name)
        sh('git', 'update-ref', 'refs/outgoing/job/8', 'job/7', cwd=mirror)
        cls.mirror = mock.patch.object(reads, 'MIRROR', mirror)
        cls.mirror.start()

    @classmethod
    def tearDownClass(cls):
        cls.mirror.stop()
        cls.dir.cleanup()

    def test_unmerged_work_by_a_jobs_name(self):
        ok, text = reads.git({'command': 'log', 'rev': 'main..origin/job/7'})
        self.assertTrue(ok, text)
        self.assertIn('Job 7 adds a line', text)
        self.assertNotIn('The first', text)
        ok, text = reads.git({'command': 'diff', 'rev': 'main...job/7', 'stat': True})
        self.assertIn('a.txt | 1 +', text)
        self.assertEqual(reads.git({'command': 'show', 'rev': 'job/7', 'path': 'a.txt'}),
                         (True, 'first line\n--no-index here'))
        branches = reads.git({'command': 'branches'})[1]
        self.assertIn('outgoing/job/8', branches)
        self.assertEqual(reads.git({'command': 'branches', 'pattern': 'outgoing'})[1].count('\n'), 0)

    def test_grep_reads_a_pattern_as_text(self):
        self.assertEqual(reads.git({'command': 'grep', 'rev': 'job/7', 'pattern': '--no-index'}),
                         (True, 'job/7:a.txt:2:--no-index here'))
        self.assertEqual(reads.git({'command': 'grep', 'rev': 'main', 'pattern': 'nowhere'}), (True, 'No line has it.'))

    def test_no_word_becomes_an_option(self):
        """Each is refused before git runs: an option for a revision (also behind origin/), a range where one revision
        goes, a pathspec's magic or a way out of the repository for a path."""
        for a in ({'command': 'show', 'rev': '-p'}, {'command': 'show', 'rev': 'origin/--output=/tmp/x'},
                  {'command': 'diff', 'rev': 'main...--no-index'}, {'command': 'show', 'rev': 'main..job/7'},
                  {'command': 'log', 'rev': 'a..b..c'}, {'command': 'show', 'rev': 'main:a.txt'},
                  {'command': 'show', 'path': ':(top)a.txt'}, {'command': 'log', 'path': '../x'},
                  {'command': 'diff', 'rev': 'main'}, {'command': 'push'}, {'command': 'grep', 'pattern': 'a\nb'}):
            with mock.patch.object(subprocess, 'run') as run:
                ok, text = reads.git(a)
            self.assertFalse(ok, a)
            run.assert_not_called()


class Report(unittest.TestCase):
    def report(self, a, out=REPORT):
        done = subprocess.CompletedProcess([], 0, out, '')
        with mock.patch.object(subprocess, 'run', return_value=done) as run:
            return reads.report(a, {}), run.call_args.args[0]

    def test_its_sections_first_then_one_by_its_heading(self):
        (ok, text), argv = self.report({})
        self.assertEqual(argv, ['hq', 'report'])
        self.assertIn('(the opening) (2 lines)\n== memory (1 lines)\n== work (the latest 30) (2 lines)', text)
        (ok, text), _ = self.report({'section': 'WORK'})
        self.assertEqual(text, '== work (the latest 30)\njob 18510 bolt done\njob 18511 bolt queued')
        (ok, text), _ = self.report({'find': '18511'})
        self.assertEqual(text, '== work (the latest 30)\njob 18511 bolt queued')
        self.assertFalse(self.report({'section': 'nothing like it'})[0][0])

    def test_what_changed_since_a_time_by_its_hunks(self):
        changed = '# What changed\n@@ -1,3 +1,3 @@ == memory\n-Mem: 1\n+Mem: 2\n@@ -9,2 +9,2 @@ == work\n+job 9\n'
        (ok, text), argv = self.report({'since': '2026-10-25T20:00Z', 'section': 'work'}, changed)
        self.assertEqual(argv, ['hq', 'report', '--since', '2026-10-25T20:00Z'])
        self.assertEqual(text, '@@ -9,2 +9,2 @@ == work\n+job 9')
        self.assertFalse(reads.report({'at': '--list'}, {})[0])

    def test_a_long_answer_comes_in_pages(self):
        text = '\n'.join(f'line {i} ' + 'x' * 1000 for i in range(1, 201))
        ok, first = reads.paged(text)
        self.assertTrue(first.endswith('(lines 1–59 of 200; the rest from 60)'), first[-60:])
        ok, last = reads.paged(text, 181)
        self.assertTrue(last.startswith('line 181 ') and last.endswith('(lines 181–200 of 200)'))
        self.assertFalse(reads.paged(text, 201)[0])
        self.assertEqual(reads.paged('short'), (True, 'short'))

    def test_a_line_longer_than_a_page_goes_on_by_its_offset(self):
        """A minified file's one line (715,488 characters in kiezel's lettering) first, in the middle and last: every
        answer stays within a PAGE, and walking the cursors the footers give puts the whole text back together."""
        long = ''.join(chr(97 + i % 26) for i in range(3 * reads.PAGE + 123))
        short = [f'line {i}' for i in range(5)]
        for lines in ([long, *short], [*short[:2], long, *short[2:]], [*short, long]):
            text, pages, start, offset = '\n'.join(lines), [], 1, 0
            while True:
                ok, answer = reads.paged(text, start, offset)
                self.assertTrue(ok, answer)
                self.assertLessEqual(len(answer), reads.PAGE)
                body, footer = answer.rsplit('\n', 1)
                # (a page that starts on a line follows the one before at a line break)
                pages.append(('\n' if pages and offset == 0 else '') + body)
                rest = re.search(r'the rest from (\d+)(?: with offset (\d+))?\)$', footer)
                if not rest:
                    break
                start, offset = int(rest[1]), int(rest[2] or 0)
            self.assertEqual(''.join(pages), text)
            self.assertGreater(len(pages), 3)
        self.assertFalse(reads.paged(long, 1, len(long))[0])


if __name__ == '__main__':
    unittest.main()
