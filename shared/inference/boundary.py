"""Verify real candidate tool execution cannot reach supervisor authority before loading a model."""

import fcntl
import json
import os
from pathlib import Path
import tempfile

import tools


PROBE = r'''
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import net from 'node:net';
const targets = TARGETS;
const denied = operation => assert.throws(operation, error => ['EPERM', 'EACCES'].includes(error.code));
for (const path of targets.private) {
  denied(() => fs.readFileSync(path));
  denied(() => fs.writeFileSync(path, 'forged'));
  denied(() => fs.truncateSync(path, 0));
}
denied(() => fs.readFileSync(`/proc/${targets.pid}/environ`));
denied(() => fs.readFileSync(`/proc/${targets.pid}/fd/${targets.fd}`));
denied(() => process.kill(targets.pid, 0));
assert.throws(() => fs.fstatSync(targets.fd), {code:'EBADF'});
assert.equal(fs.readFileSync(targets.dependency, 'utf8'), 'approved');
denied(() => fs.writeFileSync(targets.dependency, 'forged'));
fs.writeFileSync('candidate-output.txt', 'allowed');
fs.symlinkSync(targets.private[0], 'evidence-link');
denied(() => fs.readFileSync('evidence-link'));
denied(() => fs.writeFileSync('evidence-link', 'forged'));
for (const endpoint of [{host:'127.0.0.1', port:1}, {path:targets.socket}]) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.on('connect', () => { socket.destroy(); reject(new Error('Network boundary escaped')); });
    socket.on('error', error => {
      try { assert.equal(error.code, 'EPERM'); resolve(); } catch (failure) { reject(failure); }
    });
  });
}
'''


def verify(receipt):
    with tempfile.TemporaryDirectory(prefix='candidate-boundary-') as temporary:
        folder = Path(temporary)
        workspace = folder / 'candidate'
        workspace.mkdir()
        evidence = folder / 'evidence'
        evidence.write_text('retained')
        dependency = folder / 'dependency'
        dependency.write_text('approved')
        read_fd, write_fd = os.pipe()
        # The fixture intentionally lends a high descriptor to the worker. It must be closed
        # before candidate code starts, even if a future launcher accidentally passes one.
        probe_fd = fcntl.fcntl(write_fd, fcntl.F_DUPFD_CLOEXEC, 198)
        try:
            targets = {'private': [str(evidence), str(Path(__file__).with_name('provider.mjs').resolve())],
                       'dependency': str(dependency), 'pid': os.getpid(), 'fd': probe_fd,
                       'socket': str(folder / 'supervisor.sock')}
            (workspace / 'attack.mjs').write_text(PROBE.replace('TARGETS', json.dumps(targets)))
            (workspace / 'boundary.test.mjs').write_text("import './attack.mjs';\n")
            settings = {'tools': ['bash'], 'commands': ['node --test boundary.test.mjs']}
            policy = tools.policy(workspace, settings, receipt, 32768)
            policy['readOnly'] = [*policy['readOnly'], str(dependency)]
            policy_path = folder / 'policy.json'
            policy_path.write_text(json.dumps(policy))
            completed = tools.run(policy_path, 'bash', {'command': settings['commands'][0]}, pass_fds=(probe_fd,))
            if completed.returncode != 0:
                raise RuntimeError('Candidate boundary fixture failed: ' + completed.stderr)
            response = json.loads(completed.stdout)
            if response['metadata']['exit'] != 0:
                raise RuntimeError('Candidate boundary fixture failed: ' + response['output'])
            if evidence.read_text() != 'retained' or dependency.read_text() != 'approved':
                raise RuntimeError('Candidate boundary fixture modified supervisor files')
            if (workspace / 'candidate-output.txt').read_text() != 'allowed':
                raise RuntimeError('Candidate boundary fixture could not write its workspace')
        finally:
            for fd in (read_fd, write_fd, probe_fd):
                os.close(fd)
    return {'passed': True, 'tool': 'node --test', 'filesystem': 'Landlock', 'syscalls': 'seccomp allowlist'}
