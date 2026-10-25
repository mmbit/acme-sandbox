"""python3 -m unittest discover -s shared/inference -p 'test_*.py'"""

import json
import os
import select
import signal
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


SMOKE = Path(__file__).with_name('smoke.py')
FIXTURE = '''#!/usr/bin/env python3
import json, os, pathlib, sys, time
folder = pathlib.Path(__file__).parent
state_path = folder / 'state.json'
if pathlib.Path(sys.argv[0]).name == 'nvidia-smi' and (folder / 'slow-sample').exists():
    time.sleep(0.6)
state = json.loads(state_path.read_text())
if pathlib.Path(sys.argv[0]).name == 'nvidia-smi':
    active = state.get('active', False) and (state['mode'] == 'memory' or pathlib.Path('/proc/'+str(state.get('pid', 0))).exists())
    extra = '<process_info><pid>88</pid><type>C</type><process_name>trial</process_name></process_info>' if active else ''
    board = '<process_info><pid>77</pid><type>G</type><process_name>/usr/lib/xorg/Xorg</process_name><used_memory>100 MiB</used_memory></process_info>'
    if state.get('changed'): board = ''
    used = 200 if active else 100
    print('<nvidia_smi_log>' + ''.join('<gpu><uuid>GPU-12345678-abcd-1234-abcd-123456789ab'+str(i)+'</uuid><fb_memory_usage><used>'+str(used)+' MiB</used><free>'+str(24000-used)+' MiB</free></fb_memory_usage><processes>'+board+extra+'</processes></gpu>' for i in range(2)) + '</nvidia_smi_log>')
    if active: (folder / (state['loaded'][-1] + '.sampled')).touch()
    sys.exit(0)
manifest = json.loads(pathlib.Path(sys.argv[sys.argv.index('--manifest')+1]).read_text())
name = sys.argv[sys.argv.index('--model')+1]
model = next(model for model in manifest['models'] if model['name'] == name)
configuration = manifest['runtime']
state['loaded'].append(name)
state['pid'] = os.getpid()
(folder / 'runtime.pid').write_text(str(os.getpid()))
state['active'] = True
pending = state_path.with_suffix('.pending')
pending.write_text(json.dumps(state))
pending.replace(state_path)
if state['mode'] == 'load-wait': time.sleep(10)
print(json.dumps(dict(type='ready', modelSha256=model['sha256'], runtimeCommit=configuration['commit'], architecture='test', templateSha256='c'*64, backend='CUDA', devices=[i for i, share in enumerate(model['gpuSplit']) if share], gpuLayers=10, totalLayers=10, contextTokens=configuration['contextTokens'])), flush=True)
while not (folder / (name + '.sampled')).exists(): time.sleep(0.01)
if state['mode'] == 'wait': time.sleep(10)
assistant = dict(role='assistant', content=None, reasoning_content='retained reasoning', provider_specific=dict(retained=True), tool_calls=[dict(id='call-1',type='function',function=dict(name='read_nonce',arguments='{}'))])
if state['mode'] == 'tool': assistant['tool_calls'][0]['function']['name'] = 'shell'
for line in sys.stdin:
    request = json.loads(line)
    if request['id'] == 1:
        message = assistant
        reason = 'tool_calls'
    else:
        if state['mode'] == 'turn-wait': time.sleep(10)
        assert request['messages'][1] == assistant
        assert request['messages'][2]['tool_call_id'] == 'call-1'
        nonce = json.loads(request['messages'][2]['content'])['nonce']
        message = dict(role='assistant', content=nonce)
        reason = 'length' if state['mode'] == 'length' else 'stop'
    response = dict(id=request['id'], choices=[dict(message=message,finish_reason=reason)], usage=dict(completion_tokens=10))
    if state['mode'] == 'timings':
        time.sleep(0.05)
        response['timings'] = dict(prompt_ms=12, predicted_ms=34)
    print(json.dumps(response), flush=True)
if state['mode'] == 'shutdown-wait': time.sleep(10)
state['active'] = state['mode'] == 'memory'
state['changed'] = state['mode'] == 'board'
pending = state_path.with_suffix('.pending')
pending.write_text(json.dumps(state))
pending.replace(state_path)
'''


class SmokeTest(unittest.TestCase):
    def run_smoke(self, mode='pass', pinned=True, cancel=False, kill_stage=None):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            state = folder / 'state.json'
            state.write_text(json.dumps({'loaded': [], 'mode': mode}))
            if mode == 'slow-sample':
                (folder / 'slow-sample').touch()
            for executable in ('trial-runtime', 'nvidia-smi'):
                path = folder / executable
                path.write_text(FIXTURE)
                path.chmod(0o755)
            manifest = {'runtime': {
                'image': 'example.test/runtime@sha256:' + 'a' * 64 if pinned else None,
                'commit': 'b' * 40, 'transport': 'stdio', 'parallelRequests': 1,
                'contextTokens': 32768, 'smokeOutputTokens': 1024},
                'models': [{'name': name, 'revision': 'd' * 40, 'sha256': 'e' * 64,
                            'sampling': {'temperature': 1}, 'gpuSplit': split, 'architecture': 'test'}
                           for name, split in [('first', [1, 1]), ('second', [1, 0])]]}
            manifest_path = folder / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest))
            report_path = folder / 'report.json'
            process = subprocess.Popen(
                ['python3', str(SMOKE), '--manifest', str(manifest_path),
                 '--runtime', str(folder / 'trial-runtime'), '--report', str(report_path)],
                env={**os.environ, 'PATH': str(folder) + os.pathsep + os.environ['PATH']},
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            streamed = b''
            if kill_stage:
                streamed, output, errors = self.kill_after_stage(process, folder, kill_stage)
            if cancel:
                deadline = time.monotonic() + 5
                while not json.loads(state.read_text())['loaded']:
                    self.assertLess(time.monotonic(), deadline, 'Runtime did not start')
                    time.sleep(0.02)
                process.terminate()
            if not kill_stage:
                output, errors = process.communicate(timeout=20)
            completed = subprocess.CompletedProcess(
                process.args, process.returncode, (streamed + output).decode(), errors.decode())
            report = json.loads(report_path.read_text()) if report_path.exists() else None
            return completed, report, json.loads(state.read_text())

    def kill_after_stage(self, process, folder, stage):
        streamed = b''
        try:
            while True:
                readable, _, _ = select.select([process.stdout], [], [], 5)
                self.assertTrue(readable, 'Smoke stage evidence did not arrive')
                line = process.stdout.readline()
                self.assertTrue(line, 'Smoke exited before the requested stage')
                streamed += line
                if json.loads(line)['stage'] == stage:
                    break
        finally:
            process.kill()
            process.wait()
            runtime_pid = folder / 'runtime.pid'
            if runtime_pid.exists():
                try:
                    os.killpg(int(runtime_pid.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            output, errors = process.communicate(timeout=20)
        return streamed, output, errors

    def test_readiness_without_image_completes_tool_turns_and_releases_models(self):
        completed, report, state = self.run_smoke()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(report['passed'])
        self.assertEqual(state['loaded'], ['first', 'second'])
        events = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(events[-1]['stage'], 'finished')
        self.assertTrue(events[-1]['passed'])
        for index, model in enumerate(report['models']):
            self.assertNotIn('image', model['ready'])
            self.assertEqual([turn['finishReason'] for turn in model['turns']],
                             ['tool_calls', 'stop'])
            for turn in model['turns']:
                self.assertGreater(turn['exchangeSeconds'], 0)
                self.assertIsNone(turn['timings'])
            self.assertGreater(model['toolSeconds'], 0)
            self.assertEqual(model['samplerFailures'], [])
            self.assertTrue(model['normalShutdown'])
            self.assertFalse(model['forcedCleanup'])
            self.assertGreater(model['peakUsedMiB'][0], model['before'][0]['usedMiB'])
            self.assertEqual(model['before'], model['after'])
            release = next(event for event in events
                           if event['stage'] == 'release' and event['modelIndex'] == index)
            self.assertNotIn('after', release)

    def test_slow_driver_observes_each_allocation_before_the_fixture_unloads(self):
        completed, report, state = self.run_smoke('slow-sample')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(report['passed'])
        self.assertEqual(state['loaded'], ['first', 'second'])
        for model in report['models']:
            self.assertEqual(model['samplerFailures'], [])
            self.assertTrue(model['toolRoundTrip'])
            self.assertGreater(model['peakUsedMiB'][0], model['before'][0]['usedMiB'])
            self.assertEqual(model['before'], model['after'])

    def test_exchange_elapsed_and_tool_time_are_separate_from_runtime_timings(self):
        completed, report, _ = self.run_smoke('timings')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for model in report['models']:
            self.assertGreater(model['toolSeconds'], 0)
            for turn in model['turns']:
                self.assertGreaterEqual(turn['exchangeSeconds'], 0.05)
                self.assertEqual(turn['timings'], {'prompt_ms': 12, 'predicted_ms': 34})
                self.assertEqual(turn['usage'], {'completion_tokens': 10})

    def test_stage_markers_survive_hq_line_limit_with_full_measurements_in_report(self):
        completed, report, state = self.run_smoke()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        lines = completed.stdout.splitlines()
        self.assertTrue(lines)
        for line in lines:
            self.assertLess(len(line), 300)
            marker = json.loads(line[:300])
            self.assertEqual(marker['type'], 'smoke')
            self.assertIn('stage', marker)
        for model in report['models']:
            self.assertGreater(len(json.dumps(model['before'])), 300)
            self.assertEqual(len(model['before']), 2)
            self.assertEqual(model['before'][0]['processes'][0]['process_name'],
                             '/usr/lib/xorg/Xorg')
            self.assertTrue(model['toolRoundTrip'])
            self.assertIn('ready', model)
            self.assertEqual(len(model['turns']), 2)

    def test_missing_image_pin_starts_no_runtime(self):
        completed, report, state = self.run_smoke(pinned=False)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(state['loaded'], [])
        self.assertIsNone(report)

    def test_truncated_completion_does_not_start_the_next_model(self):
        measurement = self.check_failure('length')
        self.assertEqual([turn['finishReason'] for turn in measurement['turns']],
                         ['tool_calls', 'length'])
        self.assertNotIn('toolRoundTrip', measurement)

    def test_tool_outside_allowlist_is_never_executed(self):
        measurement = self.check_failure('tool')
        self.assertEqual(len(measurement['turns']), 1)
        self.assertNotIn('toolCompleted', measurement)
        self.assertTrue(measurement['forcedCleanup'])

    def test_retained_gpu_memory_fails_acceptance(self):
        measurement = self.check_failure('memory')
        self.assertTrue(measurement['normalShutdown'])
        self.assertTrue(measurement['toolRoundTrip'])
        self.assertGreater(measurement['after'][0]['usedMiB'], measurement['before'][0]['usedMiB'])

    def test_missing_graphics_process_fails_acceptance(self):
        measurement = self.check_failure('board')
        self.assertTrue(measurement['normalShutdown'])
        self.assertTrue(measurement['toolRoundTrip'])
        self.assertNotEqual(measurement['before'][0]['processes'], measurement['after'][0]['processes'])

    def test_caller_sigterm_reaps_the_runtime_and_checks_release(self):
        completed, report, state = self.run_smoke('wait', cancel=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(report['passed'])
        self.assertEqual(state['loaded'], ['first'])
        self.assertFalse(Path('/proc/' + str(state['pid'])).exists())
        self.assertTrue(report['models'][0]['forcedCleanup'])
        self.assertEqual(report['models'][0]['samplerFailures'], [])
        events = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertIn('cleanup-started', [event['stage'] for event in events])
        self.assertEqual(report['models'][0]['before'], report['models'][0]['after'])

    def test_hard_caller_termination_retains_files_and_streamed_stage_evidence(self):
        cases = [('load-wait', 'gpu-sample', 'peakUsedMiB'),
                 ('wait', 'ready', 'loadSeconds'),
                 ('turn-wait', 'tool-result', 'turns'),
                 ('shutdown-wait', 'shutdown-started', 'turns')]
        for mode, stage, retained in cases:
            with self.subTest(stage=stage):
                completed, report, state = self.run_smoke(mode, kill_stage=stage)
                self.assertEqual(completed.returncode, -signal.SIGKILL)
                self.assertFalse(report['passed'])
                self.assertEqual(state['loaded'], ['first'])
                measurement = report['models'][0]
                self.assertIn(retained, measurement)
                self.assertNotIn('after', measurement)
                self.assertNotIn('normalShutdown', measurement)
                lines = completed.stdout.splitlines()
                for line in lines:
                    self.assertLess(len(line), 300)
                events = [json.loads(line[:300]) for line in lines]
                event = next(event for event in events if event['stage'] == stage)
                self.assertEqual(event['modelIndex'], 0)
                self.assertEqual(events[0]['stage'], 'started')
                self.assertEqual(next(event for event in events if event['stage'] == 'before')['modelIndex'], 0)
                if stage == 'gpu-sample':
                    self.assertGreater(measurement['peakUsedMiB'][0], 100)
                if stage == 'tool-result':
                    self.assertEqual([turn['finishReason'] for turn in measurement['turns']],
                                     ['tool_calls'])

    def check_failure(self, mode):
        completed, report, state = self.run_smoke(mode)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(report['passed'])
        self.assertEqual(state['loaded'], ['first'])
        self.assertTrue(report['models'][0]['failure'])
        self.assertFalse(report['models'][0]['passed'])
        self.assertFalse(Path('/proc/' + str(state['pid'])).exists())
        return report['models'][0]


if __name__ == '__main__':
    unittest.main()
