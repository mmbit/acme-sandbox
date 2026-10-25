"""python3 -m unittest discover -s shared/inference -p 'test_tools.py'"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import boundary
import coding
import tools


# Runtime dependencies on the Linux fixture host, explicitly read-only inside the boundary.
SANDBOX = {'readOnly': ['/usr/bin', '/usr/local/bin/node', '/usr/lib', '/usr/local/lib', '/lib', '/lib64',
                        '/etc/ld.so.cache', '/etc/ssl/openssl.cnf', '/dev/urandom'],
           'path': '/usr/local/bin:/usr/bin:/bin'}


class ToolTests(unittest.TestCase):
    def test_allowed_node_test_cannot_reach_supervisor_files_processes_descriptors_or_network(self):
        self.assertTrue(boundary.verify({'sandbox': SANDBOX})['passed'])

    def test_candidate_cannot_trace_signal_borrow_descriptors_or_change_supervisor_attributes(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            workspace = folder / 'candidate'
            workspace.mkdir()
            script = workspace / 'probe.py'
            script.write_text("""
import ctypes, errno, fcntl, os
libc = ctypes.CDLL(None, use_errno=True)
parent = PARENT
for number, arguments in [(62, [parent, 0]), (101, [16, parent, 0, 0]),
                          (310, [parent, 0, 0, 0, 0, 0]), (311, [parent, 0, 0, 0, 0, 0]),
                          (434, [parent, 0]), (438, [0, 1, 0]), (302, [parent, 0, 0, 0]),
                          (109, [0, parent]), (112, []), (90, [0, 0]), (425, [0, 0])]:
    assert libc.syscall(number, *arguments) == -1, number
    assert ctypes.get_errno() == (errno.ENOSYS if number == 425 else errno.EPERM), number
try:
    fcntl.fcntl(1, fcntl.F_SETOWN, parent)
except PermissionError:
    pass
else:
    raise AssertionError('A supervisor signal recipient was installed')
""".replace('PARENT', str(os.getpid())))
            settings = {'tools': ['bash'], 'commands': ['/usr/bin/python3 probe.py']}
            policy_path = folder / 'policy.json'
            policy_path.write_text(json.dumps(tools.policy(workspace, settings, {'sandbox': SANDBOX}, 32768)))
            completed = tools.run(policy_path, 'bash', {'command': settings['commands'][0]})
            self.assertEqual(completed.returncode, 0, completed.stderr)
            response = json.loads(completed.stdout)
            self.assertEqual(response['metadata']['exit'], 0, response['output'])

    def test_scope_gate_rejects_git_hook_without_running_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            workspace = folder / 'candidate'
            workspace.mkdir()
            def git(*arguments):
                return subprocess.run(['git', '-C', str(workspace), *arguments], check=True,
                                      capture_output=True, text=True).stdout.strip()
            git('init', '-q', '--template=')
            (workspace / 'value.txt').write_text('source')
            git('add', '--all')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Source')
            snapshot = coding.inventory(workspace)
            evidence = folder / 'evidence'
            evidence.write_text('retained')
            hook = workspace / '.git' / 'probe.mjs'
            hook.write_text("import fs from 'node:fs'; let access = 'escaped';\n"
                            'try { fs.writeFileSync(' + json.dumps(str(evidence)) + ", 'forged'); }\n"
                            "catch (failure) { if (failure.code !== 'EACCES') throw failure; access = 'confined'; }\n"
                            "fs.writeFileSync('probe-ran', access); process.stdout.write('token\\0');\n")
            git('config', 'core.fsmonitor', 'node .git/probe.mjs')
            measured = {}
            with self.assertRaises(ValueError):
                coding.check_changes(workspace, snapshot,
                                     {'editablePaths': ['.git/config', '.git/probe.mjs']}, measured)
            self.assertEqual(evidence.read_text(), 'retained')
            self.assertFalse((workspace / 'probe-ran').exists())
            self.assertEqual(measured['changedFiles'], ['.git/config', '.git/probe.mjs'])

    def test_scope_gate_allows_new_parents_but_rejects_changes_to_existing_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            (workspace / 'source').mkdir()
            snapshot = coding.inventory(workspace)
            (workspace / 'source/new').mkdir()
            (workspace / 'source/new/value.txt').write_text('allowed')
            settings = {'editablePaths': ['source/new/value.txt']}
            measured = {}
            coding.check_changes(workspace, snapshot, settings, measured)
            self.assertEqual(measured['changedFiles'], ['source/new', 'source/new/value.txt'])
            (workspace / 'source').chmod(0o777)
            with self.assertRaises(ValueError):
                coding.check_changes(workspace, snapshot, settings, measured)

    def test_read_pages_fit_the_context_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            workspace = folder / 'candidate'
            workspace.mkdir()
            source = workspace / 'pages.txt'
            source.write_text(''.join(f'row {i}\n' for i in range(1, 701)))
            settings = {'tools': list(tools.TOOLS), 'commands': ['node --test *']}
            policy_path = folder / 'policy.json'
            policy_path.write_text(json.dumps(tools.policy(workspace, settings, {'sandbox': SANDBOX}, 32768)))
            def invoke(tool, **arguments):
                completed = tools.run(policy_path, tool, arguments)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(completed.stderr, '')
                return json.loads(completed.stdout)
            page = invoke('read', filePath='pages.txt', offset=301, limit=3)
            self.assertIn('301: row 301\n302: row 302\n303: row 303', page['output'])
            self.assertNotIn('304: row 304', page['output'])
            self.assertEqual(page['metadata']['nextOffset'], 304)
            end = invoke('read', filePath='pages.txt', offset=700, limit=3)
            self.assertIsNone(end['metadata']['nextOffset'])
            self.assertIn('700: row 700', end['output'])
            self.assertIn('offset', invoke('read', filePath='pages.txt', offset=0)['error'])
            self.assertNotIn('Traceback', invoke('read', filePath='missing')['error'])
            source.write_text(('x' * 5000 + '\n') * 700)
            bounded = invoke('read', filePath='pages.txt', limit=2000)
            self.assertLessEqual(len(bounded['output'].encode()), 16384)
            self.assertIn('truncated', bounded['output'])
            self.assertIsNotNone(bounded['metadata']['nextOffset'])

    def test_context_too_small_for_a_marked_entry_returns_an_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            workspace = folder / 'candidate'
            workspace.mkdir()
            (workspace / 'value.txt').write_text('message \U0001f600\n')
            settings = {'tools': ['read', 'grep', 'glob']}
            policy_path = folder / 'policy.json'
            policy_path.write_text(json.dumps(tools.policy(workspace, settings, {'sandbox': SANDBOX}, 2048)))
            for tool, arguments in [('read', {'filePath': 'value.txt'}),
                                    ('grep', {'pattern': 'message'}), ('glob', {'pattern': '*.txt'})]:
                with self.subTest(tool=tool):
                    completed = tools.run(policy_path, tool, arguments)
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    response = json.loads(completed.stdout)
                    self.assertIn('error', response)
                    self.assertNotIn('output', response)

    def test_search_results_are_bounded_and_bad_searches_explain_the_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            workspace = folder / 'candidate'
            workspace.mkdir()
            source = workspace / 'pages.txt'
            settings = {'tools': list(tools.TOOLS), 'commands': ['node --test *']}
            policy_path = folder / 'policy.json'
            policy_path.write_text(json.dumps(tools.policy(workspace, settings, {'sandbox': SANDBOX}, 32768)))
            def invoke(tool, **arguments):
                completed = tools.run(policy_path, tool, arguments)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(completed.stderr, '')
                return json.loads(completed.stdout)
            source.write_text('needle\n' * 700)
            grep = invoke('grep', pattern='needle', include='*.txt')
            self.assertLessEqual(grep['output'].count('pages.txt:'), 100)
            self.assertIn('truncated', grep['output'])
            self.assertLessEqual(len(grep['output'].encode()), 16384)
            source.write_bytes(b'needle\0binary')
            oversized = workspace / 'oversized.txt'
            oversized.write_bytes(b'needle\n' * 200000)
            grep = invoke('grep', pattern='needle', include='*.txt')
            self.assertIn('skipped', grep['output'])
            self.assertNotIn('pages.txt:1:', grep['output'])
            for index in range(110):
                (workspace / f'match-{index}.txt').touch()
            glob = invoke('glob', pattern='match-*.txt')
            self.assertLessEqual(glob['output'].count('match-'), 100)
            self.assertIn('truncated', glob['output'])
            self.assertIn('error', invoke('grep', pattern='['))
            absolute = invoke('glob', pattern=str(workspace / '*.txt'))
            self.assertIn('error', absolute)
            self.assertNotIn(str(folder), absolute['error'])
            denied = invoke('glob', pattern='*', path=str(folder))
            self.assertIn('error', denied)
            self.assertNotIn(str(folder), denied['error'])

    def test_opencode_plugin_reads_edits_and_tests_only_through_the_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            workspace = folder / 'candidate'
            workspace.mkdir()
            evidence = folder / 'evidence'
            evidence.write_text('retained')
            source = workspace / 'value.mjs'
            source.write_text('export const value = 1;')
            test = workspace / 'value.test.mjs'
            test.write_text("import assert from 'node:assert/strict'; import {value} from './value.mjs';\n"
                            "import fs from 'node:fs'; assert.equal(value, 2);\n"
                            "assert.equal(process.env.INFERENCE_TOOLS, undefined);\n"
                            "assert.equal(process.env.INFERENCE_PROVIDER, undefined);\n"
                            'assert.throws(() => fs.writeFileSync(' + json.dumps(str(evidence)) +
                            ", 'forged'), {code:'EACCES'});\n")
            policy_path = folder / 'policy.json'
            settings = {'tools': list(tools.TOOLS), 'commands': ['node --test *']}
            policy_path.write_text(json.dumps(tools.policy(workspace, settings, {'sandbox': SANDBOX}, 32768)))
            environment = {**os.environ, 'INFERENCE_TOOLS': json.dumps({
                'python': sys.executable, 'worker': str(Path(tools.__file__).resolve()),
                'file': str(policy_path), 'directory': temporary, 'path': SANDBOX['path'],
                'tools': settings['tools'], 'commands': settings['commands'], 'outputBytes': 16384})}
            script = r'''
const {default: create} = await import(process.argv[1]);
const plugin = await create();
const tools = plugin.tool;
const path = process.argv[2];
const before = await tools.candidate_bash.execute({command:'node --test value.test.mjs'});
if (before.metadata.exit === 0) throw new Error('The original source passed');
const read = await tools.candidate_read.execute({filePath:path});
if (!read.output.includes('1: export const value = 1;')) throw new Error('Source read failed');
await tools.candidate_edit.execute({filePath:path, oldString:'value = 1', newString:'value = 2'});
const after = await tools.candidate_bash.execute({command:'node --test value.test.mjs'});
if (after.metadata.exit !== 0) throw new Error(after.output);
for (const command of ['node --test missing; printf forged', 'node --test missing && echo forged',
                       'node --test missing | cat', 'node --test $(pwd)', 'node --test missing\necho forged']) {
  try { await tools.candidate_bash.execute({command}); }
  catch (failure) {
    if (!failure.message.includes('node --test *') ||
        failure.message.includes('Traceback') || failure.message.includes('tools.py') || failure.message.includes('\n')) throw failure;
    continue;
  }
  throw new Error('A compound command was accepted');
}
if (!tools.candidate_bash.description.includes('node --test *')) throw new Error('Approved commands are missing');
if (!tools.candidate_read.args.offset.description) throw new Error('Read paging guidance is missing');
await tools.candidate_write.execute({filePath:path + '.copy', content:'copy'});
const glob = await tools.candidate_glob.execute({pattern:'*.copy'});
if (!glob.output.includes('value.mjs.copy')) throw new Error('Glob failed');
const grep = await tools.candidate_grep.execute({pattern:'value = 2', include:'*.mjs'});
if (!grep.output.includes('value.mjs')) throw new Error('Grep failed');
for (const [name, args] of [['read',{filePath:process.argv[3]}], ['write',{filePath:process.argv[3],content:'forged'}],
                          ['edit',{filePath:process.argv[3],oldString:'retained',newString:'forged'}],
                          ['bash',{command:'git commit -qam forbidden'}]]) {
  try { await tools['candidate_'+name].execute(args); }
  catch (failure) {
    if (failure.message.includes('Traceback') || failure.message.includes('tools.py') || failure.message.includes('\n')) throw failure;
    continue;
  }
  throw new Error('An unapproved operation completed');
}
try { await plugin['tool.execute.before']({tool:'bash'}); throw new Error('Builtin enabled'); }
catch (failure) { if (failure.message === 'Builtin enabled') throw failure; }
'''
            completed = subprocess.run(['node', '--input-type=module', '-e', script,
                                        Path(__file__).with_name('tools.mjs').resolve().as_uri(),
                                        str(source), str(evidence)], env=environment,
                                       capture_output=True, text=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(evidence.read_text(), 'retained')
            self.assertEqual(source.read_text(), 'export const value = 2;')


if __name__ == '__main__':
    unittest.main()
