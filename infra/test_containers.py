#!/usr/bin/env python3
"""python3 infra/test_containers.py: the stack's containers go into the coordinator's volume as containers.json, each
one's service, state and restart count and nothing else (infra/containers.py, read by crashes.ts). Docker is a
stand-in that answers from a file."""
import json, os, subprocess, tempfile, unittest

here = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('INFRA_ENV', os.path.join(here, '..', 'template', 'company', 'infra.env'))
DOCKER = """#!/bin/bash
case "$1" in
  ps) echo "$*" > "$STATE/ps"; if [ -s "$STATE/inspect" ]; then echo a1; echo b2; fi ;;
  inspect) cat "$STATE/inspect" ;;
esac
"""
INSPECT = [
    {'Name': '/infra-voice-1', 'RestartCount': 36, 'State': {'Status': 'restarting'},
     'Config': {'Labels': {'com.docker.compose.service': 'voice'}, 'Env': ['VOICE_TOKEN=secret']}},
    {'Name': '/infra-worker-1', 'RestartCount': 0, 'State': {'Status': 'running'}, 'Config': {'Labels': {}}},
]


def run(inspect):
    with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as volume:
        with open(os.path.join(state, 'docker'), 'w') as f:
            f.write(DOCKER)
        os.chmod(os.path.join(state, 'docker'), 0o755)
        with open(os.path.join(state, 'inspect'), 'w') as f:
            f.write(json.dumps(inspect) if inspect else '')
        env = {**os.environ, 'STATE': state, 'PATH': f'{state}:{os.environ["PATH"]}'}
        subprocess.run(['python3', os.path.join(here, 'containers.py'), volume], env=env, check=True)
        with open(os.path.join(volume, 'containers.json')) as f:
            written = json.load(f)
        with open(os.path.join(state, 'ps')) as f:
            return written, f.read()


class Containers(unittest.TestCase):
    def test_each_container_service_state_and_restarts_only(self):
        written, ps = run(INSPECT)
        self.assertIn('label=com.docker.compose.project=infra', ps)
        self.assertEqual(written['containers'], [
            {'service': 'voice', 'state': 'restarting', 'restarts': 36},
            {'service': 'infra-worker-1', 'state': 'running', 'restarts': 0},
        ])
        self.assertIn('T', written['at'])
        self.assertNotIn('secret', json.dumps(written))

    def test_no_containers_is_an_empty_list(self):
        written, _ = run([])
        self.assertEqual(written['containers'], [])


if __name__ == '__main__':
    unittest.main()
