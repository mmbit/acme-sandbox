"""python3 -m unittest test_recipe   (from shared/inference/runtime: writes Dockerfiles in a throwaway folder)"""

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
COMMIT = 'a' * 40
MODEL = {'name': 'small', 'repository': 'example/small-GGUF', 'revision': 'b' * 40, 'file': 'small-Q4_K_M.gguf',
         'sha256': 'c' * 64, 'bytes': 123456789, 'gpuSplit': [1, 0]}


def manifest(**changes):
    return {'runtime': {'repository': 'https://github.com/ggml-org/llama.cpp', 'commit': COMMIT,
                        'cudaArchitecture': '89', 'transport': 'stdio', 'contextTokens': 8192,
                        'parallelRequests': 1, 'image': None},
            'models': [{**MODEL, **changes}]}


def recipe(folder, content):
    source = Path(folder) / 'models.json'
    source.write_text(json.dumps(content))
    out = Path(folder) / 'models.Dockerfile'
    result = subprocess.run([sys.executable, str(HERE / 'recipe.py'), '--manifest', str(source), '--out', str(out)],
                            capture_output=True, text=True)
    return result, out


class RecipeTest(unittest.TestCase):
    def test_the_dockerfile_carries_the_sources_and_checks_each_model_after_the_compile(self):
        with tempfile.TemporaryDirectory() as folder:
            result, out = recipe(folder, manifest())
            self.assertEqual(result.returncode, 0, result.stderr)
            text = out.read_text()
            for name in ('stdio.cpp', 'stdio.cmake', 'fetch.mjs'):
                delimiter = name.replace('.', '_').upper() + '_END'
                embedded = re.search(rf'<<"{delimiter}" \S+\n(.*?)\n{delimiter}\n', text, re.S).group(1)
                self.assertEqual(embedded, (HERE / name).read_text().rstrip('\n'))
            self.assertIn(f'fetch -q --depth 1 https://github.com/ggml-org/llama.cpp {COMMIT}', text)
            self.assertIn('-DCMAKE_CUDA_ARCHITECTURES=89', text)
            runtime = text[text.index('FROM nvidia/cuda:12.8.1-runtime'):]
            self.assertIn('install -y --no-install-recommends libgomp1 python3', runtime)
            url = f'https://huggingface.co/example/small-GGUF/resolve/{"b" * 40}/small-Q4_K_M.gguf'
            download = text.index(url)
            self.assertLess(text.index('cmake --build build --target llama-stdio'), download)
            self.assertIn(f'{url} \\\n    123456789 {"c" * 64} /opt/inference/models/small-Q4_K_M.gguf', text)
            self.assertEqual(json.loads(result.stdout)['weightBytes'], 123456789)

    def test_a_model_without_its_exact_revision_or_a_plain_file_name_is_refused(self):
        for changes in ({'revision': 'main'}, {'file': '../escape.gguf'}):
            with tempfile.TemporaryDirectory() as folder:
                result, out = recipe(folder, manifest(**changes))
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
