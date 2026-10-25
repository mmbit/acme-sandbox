#!/usr/bin/env python3
"""Check a confined stdio inference runtime, its tool calls and GPU release."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import threading
import time
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    arguments = parser.parse_args()
    manifest = json.loads(arguments.manifest.read_text())
    check_pins(manifest)
    report = {'passed': False, 'models': [], 'sampleIntervalSeconds': 0.25}
    evidence = Evidence(arguments.report, report)
    evidence.record('started')
    try:
        for model in manifest['models']:
            measurement = {'model': model['name'], 'passed': False}
            report['models'].append(measurement)
            try:
                check_model(arguments, manifest, model, measurement, evidence)
            except Exception as failure:
                evidence.record('failed', measurement, failure=str(failure))
                raise
        report['passed'] = True
    finally:
        evidence.record('finished')


class Evidence:
    def __init__(self, path, report):
        self.path = path
        self.report = report
        self.lock = threading.Lock()

    def record(self, stage, measurement=None, **fields):
        with self.lock:
            target = self.report if measurement is None else measurement
            target.update(fields)
            pending = self.path.with_name(self.path.name + '.pending')
            pending.write_text(json.dumps(self.report, indent=2) + '\n')
            pending.replace(self.path)
            event = {'type': 'smoke', 'stage': stage, 'passed': target['passed']}
            if measurement is not None:
                event['modelIndex'] = len(self.report['models']) - 1
            print(json.dumps(event, separators=(',', ':')), flush=True)


def check_pins(manifest):
    runtime = manifest['runtime']
    require(isinstance(runtime['image'], str) and
            re.fullmatch(r'([^\s]+@)?sha256:[0-9a-f]{64}', runtime['image']),
            'The runtime image needs a reviewed immutable digest before a trial')
    require(re.fullmatch(r'[0-9a-f]{40}', runtime['commit']), 'Invalid runtime commit')
    require(runtime['transport'] == 'stdio', 'The trial requires a stdio runtime')
    require(runtime['parallelRequests'] == 1, 'The trial requires sequential requests')
    require(bool(manifest['models']), 'No trial models configured')
    for model in manifest['models']:
        require(re.fullmatch(r'[0-9a-f]{40}', model['revision']), 'Invalid weight revision')
        require(re.fullmatch(r'[0-9a-f]{64}', model['sha256']), 'Invalid weight digest')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_model(arguments, manifest, model, measurement, evidence):
    before = snapshot()
    evidence.record('before', measurement, before=before,
                    peakUsedMiB=[gpu['usedMiB'] for gpu in before])
    stopped = threading.Event()
    failures = []
    sampler = threading.Thread(target=sample, args=(stopped, measurement, failures, evidence))
    runtime = subprocess.Popen(
        [str(arguments.runtime.resolve()), '--manifest', str(arguments.manifest.resolve()),
         '--model', model['name']], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        text=True, start_new_session=True)
    started = time.monotonic()
    try:
        evidence.record('runtime-started', measurement, runtimePid=runtime.pid)
        sampler.start()
        ready = read_message(runtime)
        check_ready(ready, manifest, model)
        evidence.record('ready', measurement, ready=ready, loadSeconds=time.monotonic() - started)
        round_trip(runtime, manifest['runtime'], model, measurement, evidence)
        check_shutdown(runtime, measurement, evidence)
    except Exception as failure:
        evidence.record('failed', measurement, failure=str(failure))
        raise
    finally:
        try:
            finish(runtime, sampler, stopped, measurement, failures, evidence)
        except Exception as failure:
            evidence.record('cleanup-failed', measurement, cleanupFailure=str(failure))
            if 'failure' not in measurement:
                raise
    require(not failures, 'GPU sampling failed during inference')
    for index, share in enumerate(model['gpuSplit']):
        if share:
            require(measurement['peakUsedMiB'][index] > before[index]['usedMiB'],
                    'No measured GPU allocation on a requested card')
    evidence.record('model-passed', measurement, passed=True)


def check_shutdown(runtime, measurement, evidence):
    shutdown = time.monotonic()
    runtime.stdin.close()
    evidence.record('shutdown-started', measurement, shutdownRequested=True)
    require(runtime.wait() == 0, 'Runtime failed during normal shutdown')
    shutdown_seconds = time.monotonic() - shutdown
    try:
        os.killpg(runtime.pid, 0)
    except ProcessLookupError:
        evidence.record('shutdown', measurement, normalShutdown=True,
                        shutdownSeconds=shutdown_seconds)
    else:
        raise ValueError('Runtime left processes alive after EOF')


def finish(runtime, sampler, stopped, measurement, failures, evidence):
    shutdown = time.monotonic()
    # The helper also kills the run's entire uid on cancellation or timeout.
    try:
        os.killpg(runtime.pid, signal.SIGKILL)
        forced_cleanup = True
    except ProcessLookupError:
        forced_cleanup = False
    evidence.record('cleanup-started', measurement, forcedCleanup=forced_cleanup)
    runtime.wait()
    runtime.stdout.close()
    if not runtime.stdin.closed:
        runtime.stdin.close()
    stopped.set()
    if sampler.ident is not None:
        sampler.join()
    after = snapshot()
    evidence.record('release', measurement, after=after,
                    releaseCheckSeconds=time.monotonic() - shutdown,
                    samplerFailures=failures)
    check_release(measurement['before'], after)


def snapshot():
    completed = subprocess.run(['nvidia-smi', '-q', '-x'], check=True,
                               capture_output=True, text=True, timeout=2)
    root = ET.fromstring(completed.stdout)
    cards = []
    for gpu in root.findall('gpu'):
        memory = gpu.find('fb_memory_usage')
        processes = []
        for process in gpu.findall('processes/process_info'):
            processes.append({key: process.findtext(key)
                              for key in ('pid', 'type', 'process_name', 'used_memory')})
        cards.append({'uuid': gpu.findtext('uuid'),
                      'usedMiB': int(memory.findtext('used').split()[0]),
                      'freeMiB': int(memory.findtext('free').split()[0]),
                      'processes': processes})
    require(bool(cards), 'No GPU measurements available')
    return cards


def sample(stopped, measurement, failures, evidence):
    while not stopped.is_set():
        try:
            cards = snapshot()
            require([gpu['uuid'] for gpu in cards] ==
                    [gpu['uuid'] for gpu in measurement['before']], 'GPU inventory changed')
            peaks = [max(peak, gpu['usedMiB']) for peak, gpu in
                     zip(measurement['peakUsedMiB'], cards)]
            if peaks != measurement['peakUsedMiB']:
                evidence.record('gpu-sample', measurement, peakUsedMiB=peaks)
        except Exception as failure:
            failures.append(str(failure))
            evidence.record('sampling-failed', measurement, samplerFailures=failures)
            return
        stopped.wait(0.25)


def read_message(runtime):
    line = runtime.stdout.readline()
    require(bool(line), 'Runtime ended before its response')
    message = json.loads(line)
    require(isinstance(message, dict), 'Runtime response must be a JSON object')
    return message


def check_ready(ready, manifest, model):
    runtime = manifest['runtime']
    for key, expected in (('type', 'ready'), ('modelSha256', model['sha256']),
                          ('runtimeCommit', runtime['commit']),
                          ('backend', 'CUDA'), ('architecture', model['architecture']),
                          ('contextTokens', runtime['contextTokens'])):
        require(ready.get(key) == expected, 'Runtime readiness mismatch: ' + key)
    require(re.fullmatch(r'[0-9a-f]{64}', ready.get('templateSha256', '')),
            'Runtime did not identify its embedded chat template')
    require(ready.get('totalLayers', 0) > 0 and
            ready.get('gpuLayers') == ready.get('totalLayers'), 'Model was not fully GPU offloaded')
    devices = [index for index, share in enumerate(model['gpuSplit']) if share]
    require(ready.get('devices') == devices, 'Runtime used different GPUs')


def round_trip(runtime, configuration, model, measurement, evidence):
    messages = [{'role': 'user', 'content': 'Call read_nonce with empty arguments. '
                 'Return only its exact nonce as your final answer.'}]
    tool = {'type': 'function', 'function': {'name': 'read_nonce',
            'description': 'Read the acceptance nonce from this isolated harness.',
            'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}}
    request = {'id': 1, 'messages': messages, 'tools': [tool], 'tool_choice': 'required',
               'max_tokens': configuration['smokeOutputTokens'], **model['sampling']}
    first = exchange(runtime, request)
    turns = [turn_measurement(first)]
    evidence.record('first-turn', measurement, turns=turns)
    require(first['finish_reason'] == 'tool_calls', 'First turn did not finish with a tool call')
    tool_started = time.monotonic()
    assistant = first['message']
    require(assistant.get('role') == 'assistant', 'Invalid assistant role')
    calls = assistant.get('tool_calls', [])
    require(len(calls) == 1, 'Expected exactly one tool call')
    call = calls[0]
    require(call.get('type') == 'function' and call['function']['name'] == 'read_nonce',
            'Runtime requested a tool outside the allowlist')
    require(isinstance(call.get('id'), str) and bool(call['id']), 'Missing tool call id')
    require(json.loads(call['function']['arguments']) == {}, 'Unexpected tool arguments')
    nonce = secrets.token_hex(16)
    messages.extend([assistant, {'role': 'tool', 'tool_call_id': call['id'],
                                'content': json.dumps({'nonce': nonce})}])
    evidence.record('tool-result', measurement, toolCompleted=True,
                    toolSeconds=time.monotonic() - tool_started)
    second = exchange(runtime, {**request, 'id': 2, 'tool_choice': 'none'})
    evidence.record('second-turn', measurement, turns=turns + [turn_measurement(second)])
    require(second['finish_reason'] == 'stop', 'Final answer was incomplete')
    require(not second['message'].get('tool_calls'), 'Unexpected second tool call')
    require(second['message'].get('content', '').strip() == nonce, 'Tool result was not returned')
    evidence.record('tool-round-trip', measurement, toolRoundTrip=True)


def turn_measurement(turn):
    return {'usage': turn.get('usage'), 'timings': turn.get('timings'),
            'finishReason': turn['finish_reason'], 'exchangeSeconds': turn['exchangeSeconds']}


def exchange(runtime, request):
    started = time.monotonic()
    runtime.stdin.write(json.dumps(request) + '\n')
    runtime.stdin.flush()
    response = read_message(runtime)
    elapsed_seconds = time.monotonic() - started
    require(response.get('id') == request['id'], 'Response belongs to another request')
    choices = response.get('choices', [])
    require(len(choices) == 1, 'Expected one completion choice')
    return {**choices[0], 'usage': response.get('usage'), 'timings': response.get('timings'),
            'exchangeSeconds': elapsed_seconds}


def check_release(before, after):
    require([gpu['uuid'] for gpu in before] == [gpu['uuid'] for gpu in after],
            'GPU inventory changed during the trial')
    for original, current in zip(before, after):
        require(current['usedMiB'] <= original['usedMiB'] and
                current['freeMiB'] >= original['freeMiB'], 'GPU memory was not restored')
        identity = lambda process: (process['pid'], process['type'], process['process_name'])
        require(sorted(map(identity, original['processes'])) ==
                sorted(map(identity, current['processes'])), 'Driver-visible board processes changed')


def interrupted(number, frame):
    raise InterruptedError('Trial interrupted')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    main()
