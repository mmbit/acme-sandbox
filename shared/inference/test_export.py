"""python3 -m unittest discover -s shared/inference -p 'test_export.py'"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


class ExportTests(unittest.TestCase):
    def test_scoped_export_has_original_blobs_and_no_later_or_excluded_objects(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / 'source'
            source.mkdir()
            def git(*arguments):
                return subprocess.run(['git', '-C', str(source), *arguments], check=True,
                                      capture_output=True).stdout.decode().strip()
            git('init', '-q')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@localhost')
            paths = ['-leading.ts', 'space name.ts', 'line\nbreak.ts', 'tab\tname.ts', 'é/🧭.ts']
            for index, path in enumerate(paths):
                file = source / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(f'export const number = {index};\n')
            (source / 'excluded.txt').write_text('Evaluator guidance never exported')
            git('add', '--all')
            git('commit', '-qm', 'Original')
            revision = git('rev-parse', 'HEAD')
            excluded = git('rev-parse', 'HEAD:excluded.txt')
            (source / paths[0]).write_text('Later candidate reference patch')
            git('commit', '-qam', 'Later')
            later = git('rev-parse', 'HEAD')
            later_blob = git('rev-parse', f'HEAD:{paths[0]}')
            scope = folder / 'scope.json'
            scope.write_text(json.dumps({'paths': paths}))
            archives = [folder / 'first.tar', folder / 'second.tar']
            for archive in archives:
                subprocess.run(['python3', str(Path(__file__).with_name('export.py')),
                                '--repository', str(source), '--revision', revision,
                                '--scope', str(scope), '--archive', str(archive)], check=True)
            self.assertEqual(archives[0].read_bytes(), archives[1].read_bytes())
            receipt = json.loads(archives[0].with_suffix('.json').read_text())
            self.assertEqual(receipt['sourceRevision'], revision)
            self.assertEqual(receipt['archiveSha256'], hashlib.sha256(archives[0].read_bytes()).hexdigest())
            workspace = folder / 'candidate'
            workspace.mkdir()
            with tarfile.open(archives[0]) as archive:
                archive.extractall(workspace)
            source = workspace
            self.assertFalse((workspace / 'excluded.txt').exists())
            self.assertEqual(git('status', '--porcelain'), '')
            for forbidden in (excluded, later, later_blob, revision):
                completed = subprocess.run(['git', '-C', str(workspace), 'cat-file', '-e', forbidden],
                                           capture_output=True)
                self.assertNotEqual(completed.returncode, 0)
            for path, digest in receipt['sourceBlobs'].items():
                self.assertEqual(git('rev-parse', f'HEAD:{path}'), digest)
                self.assertIn('export const number', (workspace / path).read_text())
            self.assertEqual(os.stat(archives[0]).st_mode & 0o222, 0)


if __name__ == '__main__':
    unittest.main()
