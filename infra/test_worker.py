#!/usr/bin/env python3
"""python3 infra/test_worker.py: worker staging includes company capacity settings in its immutable code revision."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
IDENTITY = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.test',
            'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.test'}


class WorkerStaging(unittest.TestCase):
    def test_rollback_stages_a_worker_from_before_the_staging_script_and_capacity_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository, work = root / 'repository', root / 'work'
            worker = repository / 'platform/worker'
            worker.mkdir(parents=True)
            (worker / 'worker.ts').write_text('// Old worker\n')

            def git(*arguments):
                return subprocess.run(['git', *arguments], cwd=repository, check=True, capture_output=True,
                                      text=True, env={**os.environ, **IDENTITY}).stdout.strip()

            git('init', '-q')
            git('add', '.')
            git('commit', '-qm', 'Old worker')
            previous = git('rev-parse', 'HEAD')
            infrastructure = repository / 'infra'
            infrastructure.mkdir()
            shutil.copyfile(HERE / 'worker.sh', infrastructure / 'worker.sh')
            (worker / 'capacity.json').write_text('{"samples":0,"job":0}\n')
            git('add', '.')
            git('commit', '-qm', 'Worker staging')
            subprocess.run(['bash', '-uo', 'pipefail', '-c',
                            'work=$1; . infra/worker.sh && git reset -q --hard "$2" && stage_worker_code',
                            'rollback', str(work), previous], cwd=repository, check=True,
                           capture_output=True, text=True)
            self.assertFalse((infrastructure / 'worker.sh').exists())
            staged = (work / 'code/current').resolve()
            self.assertEqual((staged / 'worker.ts').read_text(), '// Old worker\n')
            self.assertFalse((staged / 'capacity.json').exists())

    def test_company_configuration_changes_the_staged_revision_and_keeps_running_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository, work = root / 'repository', root / 'work'
            repository.mkdir()
            worker = repository / 'platform/worker'
            (worker / 'src').mkdir(parents=True)
            (worker / 'src/worker.ts').write_text('// A worker fixture\n')
            (worker / 'capacity.json').write_text('{"samples":0,"job":0}\n')
            company = repository / 'company'
            company.mkdir()

            def git(*arguments):
                return subprocess.run(['git', *arguments], cwd=repository, check=True, capture_output=True,
                                      text=True, env={**os.environ, **IDENTITY}).stdout.strip()

            def commit():
                git('add', '.')
                git('commit', '-qm', 'Configuration fixture')

            def stage():
                subprocess.run(['bash', '-uo', 'pipefail', '-c',
                                '. "$1"; work=$2; stage_worker_code', 'staging',
                                str(HERE / 'worker.sh'), str(work)], cwd=repository, check=True,
                               capture_output=True, text=True)
                return (work / 'code/current').resolve()

            git('init', '-q')
            commit()
            ordinary = stage()
            self.assertEqual(json.loads((ordinary / 'capacity.json').read_text()), {'samples': 0, 'job': 0})
            settings = company / 'worker-capacity.json'
            settings.write_text('{"samples":120,"job":42}\n')
            commit()
            enabled = stage()
            self.assertNotEqual(enabled, ordinary)
            self.assertEqual((enabled / 'src/worker.ts').read_text(), '// A worker fixture\n')
            self.assertEqual(json.loads((enabled / 'capacity.json').read_text()), {'samples': 120, 'job': 42})
            (work / 'code/running').symlink_to(enabled.name)
            settings.write_text('{"samples":0,"job":42}\n')
            commit()
            disabled = stage()
            self.assertNotEqual(disabled, enabled)
            self.assertEqual((work / 'code/running').resolve(), enabled)
            self.assertEqual(json.loads((enabled / 'capacity.json').read_text())['samples'], 120)
            self.assertEqual(json.loads((disabled / 'capacity.json').read_text()), {'samples': 0, 'job': 42})
            (company / 'unrelated.md').write_text('Unrelated company work\n')
            commit()
            self.assertEqual(stage(), disabled)


if __name__ == '__main__':
    unittest.main()
