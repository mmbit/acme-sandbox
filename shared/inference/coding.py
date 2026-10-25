#!/usr/bin/env python3
"""Drive pinned headless OpenCode over inherited runtime pipes inside an isolated helper export."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

import boundary
import smoke
import tools


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('manifest', 'settings', 'receipt', 'runtime', 'opencode', 'workspace', 'prompt', 'report', 'source'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--source-receipt', required=True, type=Path)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--phase', choices=('execution', 'repair'), default='execution')
    arguments = parser.parse_args()
    manifest = json.loads(arguments.manifest.read_text())
    settings = json.loads(arguments.settings.read_text())
    receipt = json.loads(arguments.receipt.read_text())
    models = [model for model in manifest['models'] if model['name'] == arguments.model]
    smoke.require(len(models) == 1, 'Choose exactly one pinned model')
    smoke.require(arguments.report.resolve().is_relative_to(arguments.workspace.resolve()) is False,
                  'Evidence must be outside the candidate repository')
    report = {'passed': False, 'models': [], 'phase': arguments.phase, 'equivalentUsd': None,
              'sampleIntervalSeconds': 0.25,
              'harness': settings['opencode'], 'toolchainReceipt': receipt}
    evidence = smoke.Evidence(arguments.report, report)
    measurement = {'model': arguments.model, 'passed': False}
    report['models'].append(measurement)
    evidence.record('started')
    try:
        smoke.check_pins(manifest)
        verify_tools(arguments, settings, receipt)
        snapshot = prepare_workspace(arguments, report)
        report['candidateBoundary'] = boundary.verify(receipt)
        evidence.record('candidate-boundary')
        def execute(runtime, runtime_settings, model, measured, stages):
            run_opencode(arguments, settings, runtime, runtime_settings, model, measured, stages)
            check_changes(arguments.workspace, snapshot, settings, measured)
        def admit(cards, model):
            required = settings['minimumFreeMiB'][model['name']]
            smoke.require(len(cards) >= len(required), 'A required GPU is missing')
            for card, minimum in zip(cards, required):
                smoke.require(card['freeMiB'] >= minimum, 'Insufficient fresh GPU headroom')
        smoke.check_model(arguments, manifest, models[0], measurement, evidence, action=execute, admission=admit)
        report['passed'] = True
    except Exception as failure:
        evidence.record('failed', measurement, failure=str(failure))
        raise
    finally:
        evidence.record('finished')


def verify_tools(arguments, settings, receipt):
    smoke.require(receipt['reviewed'] is True, 'A reviewed toolchain receipt is required')
    smoke.require(receipt['opencode'] == settings['opencode'], 'The OpenCode release differs from the packet')
    verify_dependencies(arguments, receipt)
    git = shutil.which('git')
    smoke.require(git is not None, 'Reviewed Git is missing from the toolchain PATH')
    paths = {'opencode': arguments.opencode, 'provider': Path(__file__).with_name('provider.mjs'),
             'git': Path(git),
             'home': arguments.receipt.resolve().parent / 'opencode-home.tar',
             **{name: Path(__file__).with_name(name) for name in
                ('tools.mjs', 'tools.py', 'confinement.py')}}
    for name, path in paths.items():
        with path.open('rb') as stream:
            digest = hashlib.sha256(stream.read()).hexdigest()
        smoke.require(digest == receipt['sha256'][name], 'The toolchain bytes differ from the reviewed receipt')
    smoke.require(set(settings['tools']) <= set(tools.TOOLS), 'An unsupported candidate tool was configured')
    with tempfile.TemporaryDirectory(prefix='opencode-version-') as home:
        seed_home(home, arguments.receipt)
        environment = home_environment(home)
        completed = subprocess.run([str(arguments.opencode.resolve()), '--version'], check=True,
                                   env=environment, capture_output=True, text=True)
        smoke.require(completed.stdout.strip() == settings['opencode']['version'], 'Unexpected OpenCode version')
        for command in ('git', 'node'):
            subprocess.run([command, '--version'], env=environment, check=True, capture_output=True)


def verify_dependencies(arguments, receipt):
    protected = [Path(__file__).resolve().parent, Path('/proc'), Path('/sys')]
    for name in ('opencode', 'runtime', 'report', 'receipt', 'manifest', 'settings',
                 'prompt', 'source', 'source_receipt', 'workspace'):
        path = getattr(arguments, name, None)
        if path is not None:
            protected.append(path.resolve())
    for dependency in receipt['sandbox']['readOnly']:
        root = Path(dependency)
        smoke.require(root.is_absolute(), 'Read-only dependencies need absolute paths')
        root = root.resolve()
        for path in protected:
            smoke.require(not path.is_relative_to(root) and not root.is_relative_to(path),
                          'An approved dependency overlaps supervisor files or processes')


def prepare_workspace(arguments, report):
    receipt = json.loads(arguments.source_receipt.read_text())
    smoke.require(receipt['sourceRevision'] == arguments.revision, 'The source revision differs from the packet')
    digest = hashlib.sha256(arguments.source.read_bytes()).hexdigest()
    smoke.require(digest == receipt['archiveSha256'], 'The immutable source archive changed')
    arguments.workspace.mkdir()
    with tarfile.open(arguments.source) as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            smoke.require(member.isfile() and not path.is_absolute() and '..' not in path.parts,
                          'The source archive contains an unsupported entry')
        archive.extractall(arguments.workspace)
    def git(*command):
        return subprocess.run(['git', '-C', str(arguments.workspace), *command], check=True,
                              capture_output=True).stdout.decode().strip()
    smoke.require(git('rev-parse', 'HEAD') == receipt['snapshotCommit'], 'The source snapshot commit changed')
    smoke.require(not git('status', '--porcelain'), 'The initial source snapshot is dirty')
    reachable = set(git('rev-list', '--objects', '--no-object-names', 'HEAD').splitlines())
    present = set(git('cat-file', '--batch-all-objects', '--batch-check=%(objectname)').splitlines())
    smoke.require(present == reachable, 'The snapshot contains objects outside its source history')
    report['source'] = receipt
    return inventory(arguments.workspace)


def check_changes(workspace, snapshot, settings, measurement):
    current = inventory(workspace)
    paths = sorted(path for path in snapshot.keys() | current.keys()
                   if snapshot.get(path) != current.get(path))
    measurement['changedFiles'] = paths
    smoke.require(not any(path == '.git' or path.startswith('.git/') for path in paths),
                  'The candidate changed Git control metadata')
    editable = set(settings['editablePaths'])
    directories = {str(parent) for path in editable for parent in Path(path).parents if str(parent) != '.'}
    permitted = editable | {path for path in directories
                            if path not in snapshot and current.get(path, (None,))[0] == stat.S_IFDIR}
    smoke.require(set(paths) <= permitted, 'The candidate changed a path outside its task')


def inventory(workspace):
    # Never follow candidate links or open a candidate FIFO while reading from the supervisor.
    entries = {}
    def visit(directory, prefix):
        for name in os.listdir(directory):
            path = prefix + name
            attributes = os.stat(name, dir_fd=directory, follow_symlinks=False)
            kind = stat.S_IFMT(attributes.st_mode)
            contents = None
            if kind == stat.S_IFLNK:
                contents = os.readlink(name, dir_fd=directory)
            elif kind in (stat.S_IFREG, stat.S_IFDIR):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if kind == stat.S_IFDIR:
                    flags |= os.O_DIRECTORY
                fd = os.open(name, flags, dir_fd=directory)
                try:
                    opened = os.fstat(fd)
                    smoke.require(stat.S_IFMT(opened.st_mode) == kind, 'The candidate file type changed during inventory')
                    attributes = opened
                    if kind == stat.S_IFDIR:
                        visit(fd, path + '/')
                    else:
                        with os.fdopen(os.dup(fd), 'rb') as stream:
                            contents = hashlib.file_digest(stream, 'sha256').hexdigest()
                finally:
                    os.close(fd)
            entries[path] = (kind, stat.S_IMODE(attributes.st_mode), contents)
    fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        visit(fd, '')
    finally:
        os.close(fd)
    return entries


# auxiliary (fixture only): OpenCode may ask for a session title beside the task, a request the provider must refuse
def run_opencode(arguments, settings, runtime, runtime_settings, model, measurement, evidence, auxiliary=False):
    read_fd, write_fd = os.pipe()
    provider = {'readFd': runtime.stdout.fileno(), 'writeFd': runtime.stdin.fileno(), 'eventsFd': write_fd,
                'model': model['name'], 'tools': ['candidate_' + tool for tool in settings['tools']],
                'sampling': model['sampling'],
                'outputTokens': settings['outputTokens'], 'phase': arguments.phase}
    smoke.require(0 < settings['outputTokens'] < runtime_settings['contextTokens'], 'Invalid output budget')
    measurement['turns'] = []
    measurement['tools'] = []
    failures = []
    with tempfile.TemporaryDirectory(prefix='opencode-home-') as home:
        environment = isolated_environment(home, provider, settings, runtime_settings, auxiliary)
        configure_tools(home, environment, arguments, settings, runtime_settings['contextTokens'])
        seed_home(home, arguments.receipt)
        started = time.monotonic()
        title = [] if auxiliary else ['--title', 'Isolated task']
        child = subprocess.Popen([str(arguments.opencode.resolve()), 'run', '--format', 'json', *title,
                                  '--model', 'stdio/' + model['name']],
                                 cwd=home, env=environment, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 pass_fds=(provider['readFd'], provider['writeFd'], write_fd),
                                 start_new_session=True, text=True)
        os.close(write_fd)
        telemetry = threading.Thread(target=read_events,
                                     args=(read_fd, measurement, evidence, failures))
        telemetry.start()
        try:
            output, diagnostics = child.communicate(
                'Candidate source directory: ' + str(arguments.workspace.resolve()) + '\n' + arguments.prompt.read_text())
            measurement['callerSeconds'] = time.monotonic() - started
            measurement['opencodeExitCode'] = child.returncode
            evidence.record('opencode-exit', measurement)
            save_output(arguments.report, output, diagnostics)
            smoke.require(child.returncode == 0, 'OpenCode failed')
        finally:
            stopped_children = stop_children(child)
            telemetry.join()
        smoke.require(not stopped_children, 'OpenCode left a process group alive')
        smoke.require(not failures, 'Provider telemetry failed')
        smoke.require(measurement['turns'], 'OpenCode made no runtime request')
        smoke.require(measurement['turns'][-1].get('finishReason') == 'stop', 'OpenCode did not finish normally')
        smoke.require(not any('failure' in turn for turn in measurement['turns']), 'Provider rejected a turn')
        collect_tools(output, measurement)


def isolated_environment(home, provider, settings, runtime_settings, auxiliary=False):
    config = {'enabled_providers': ['stdio'], 'provider': {'stdio': {
        'npm': Path(__file__).with_name('provider.mjs').resolve().as_uri(),
        'name': 'Confined stdio', 'models': {provider['model']: {
            'name': provider['model'], 'tool_call': True, 'reasoning': True,
            'limit': {'context': runtime_settings['contextTokens'], 'output': settings['outputTokens']}}}}},
        'autoupdate': False, 'share': 'disabled', 'snapshot': False, 'lsp': False, 'formatter': False,
        'compaction': {'auto': False, 'prune': False},
        'plugin': [Path(__file__).with_name('tools.mjs').resolve().as_uri()],
        'permission': {'*': 'deny', **{'candidate_' + tool: 'allow' for tool in settings['tools']}},
        'agent': {name: {'disable': True} for name in ['title', 'summary', 'compaction', 'explore']
                  if not (auxiliary and name == 'title')}}
    return {**home_environment(home), 'INFERENCE_PROVIDER': json.dumps(provider),
            'OPENCODE_CONFIG_CONTENT': json.dumps(config)}


def configure_tools(home, environment, arguments, settings, context_tokens):
    receipt = json.loads(arguments.receipt.read_text())
    policy = tools.policy(arguments.workspace, settings, receipt, context_tokens)
    policy_path = Path(home) / 'candidate-policy.json'
    policy_path.write_text(json.dumps(policy))
    environment['INFERENCE_TOOLS'] = json.dumps({
        'python': sys.executable, 'worker': str(Path(__file__).with_name('tools.py').resolve()),
        'file': str(policy_path), 'directory': home, 'tools': settings['tools'], 'commands': policy['commands'], 'path': policy['path'],
        'outputBytes': policy['outputBytes']})


def home_environment(home):
    return {'PATH': os.environ['PATH'], 'HOME': home, 'TMPDIR': home, 'LANG': 'C.UTF-8',
            'XDG_CONFIG_HOME': str(Path(home) / '.config'), 'XDG_CACHE_HOME': str(Path(home) / '.cache'),
            'XDG_DATA_HOME': str(Path(home) / '.local/share'),
            'XDG_STATE_HOME': str(Path(home) / '.local/state'),
            'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_MODELS_FETCH': 'true',
            'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true', 'OPENCODE_DISABLE_PROJECT_CONFIG': 'true',
            'OPENCODE_DISABLE_EXTERNAL_SKILLS': 'true', 'OPENCODE_DISABLE_CLAUDE_CODE': 'true',
            'OPENCODE_DISABLE_LSP_DOWNLOAD': 'true', 'OPENCODE_DISABLE_FFF': 'true',
            'OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER': 'true', 'OPENCODE_DISABLE_AUTOCOMPACT': 'true'}


def seed_home(home, receipt):
    # The machinery owner prepares this reviewed seed. No dependency installation runs during inference.
    subprocess.run(['tar', '-xf', str(receipt.resolve().parent / 'opencode-home.tar'), '-C', home], check=True)


def stop_children(child):
    if child.poll() is not None:
        child.wait()
    try:
        os.killpg(child.pid, signal.SIGKILL)
        stopped_children = True
    except ProcessLookupError:
        stopped_children = False
    child.wait()
    return stopped_children


def read_events(fd, measurement, evidence, failures):
    try:
        with os.fdopen(fd) as stream:
            for line in stream:
                turn = json.loads(line)
                previous = next((saved for saved in measurement['turns'] if saved['id'] == turn['id']), None)
                if previous is None:
                    measurement['turns'].append(turn)
                else:
                    previous.update(turn)
                measurement['requests'] = sum(saved.get('requested', False) for saved in measurement['turns'])
                evidence.record('exchange', measurement)
    except Exception as failure:
        failures.append(str(failure))


def save_output(report, output, diagnostics):
    report.with_suffix('.opencode.jsonl').write_text(output)
    report.with_suffix('.stderr').write_text(diagnostics)


def collect_tools(output, measurement):
    for line in output.splitlines():
        event = json.loads(line)
        smoke.require(event['type'] != 'error', 'OpenCode emitted an error event')
        if event['type'] != 'tool_use':
            continue
        part = event['part']
        state = part['state']
        timing = state.get('time', {})
        elapsed = ((timing['end'] - timing['start']) / 1000
                   if 'end' in timing and 'start' in timing else None)
        measurement['tools'].append({'tool': part['tool'], 'status': state['status'], 'seconds': elapsed,
                                     'exitCode': state.get('metadata', {}).get('exit')})
    measurement['toolFailures'] = sum(tool['status'] != 'completed' or tool['exitCode'] not in (None, 0)
                                      for tool in measurement['tools'])


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, smoke.interrupted)
    main()
