"""python3 -m unittest discover -s shared/inference -p 'test_coding.py'"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from test_smoke import FIXTURE
from test_tools import SANDBOX


CLI = '''#!/usr/bin/env node
if (process.env.UNRELATED_CANARY) throw new Error('Parent environment leaked');
if (process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const {createStdio} = await import(config.provider.stdio.npm);
const model = createStdio({name:'stdio'}).languageModel('first');
const prompt = [{role:'user',content:[{type:'text',text:'Exercise the inherited pipes'}]}];
const tools = [{type:'function',name:'candidate_read',inputSchema:{type:'object'}}];
const read = async () => { const chunks = []; const response = await model.doStream({prompt,tools});
  for await (const part of response.stream) chunks.push(part); return chunks; };
const parts = await read();
const call = parts.find(part => part.type === 'tool-call');
const {readFileSync} = await import('node:fs');
const policy = JSON.parse(process.env.INFERENCE_TOOLS);
const workspace = JSON.parse(readFileSync(policy.file)).workspace;
const plugin = await (await import(config.plugin[0])).default();
const response = await plugin.tool.candidate_read.execute({filePath: workspace + '/value.txt'});
if (!response.output.includes('1: Original source')) throw new Error('The confined read did not read source');
prompt.push({role:'assistant',content:[{type:'tool-call', toolCallId:call.toolCallId,
  toolName:call.toolName,input:JSON.parse(call.input)}]});
prompt.push({role:'tool',content:[{type:'tool-result',toolCallId:call.toolCallId,
  toolName:call.toolName,output:{type:'json',value:{nonce:'fixture'}}}]});
// Candidate mutation
console.log(JSON.stringify({type:'tool_use',part:{tool:'candidate_read',state:{status:'completed',time:{start:1,end:3}}}}));
await read();
console.log(JSON.stringify({type:'text',part:{text:'fixture'}}));
'''


class CodingTests(unittest.TestCase):
    def test_caller_records_piped_turns_tools_and_normal_release_without_parent_environment(self):
        completed, report, state = self.run_caller(SANDBOX)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(report['passed'])
        self.assertTrue(report['candidateBoundary']['passed'])
        measured = report['models'][0]
        self.assertTrue(measured['normalShutdown'])
        self.assertFalse(measured['forcedCleanup'])
        self.assertEqual([turn['finishReason'] for turn in measured['turns']], ['tool_calls', 'stop'])
        self.assertEqual(measured['turns'][0]['timings']['prompt_ms'], 12)
        self.assertEqual(measured['tools'][0]['seconds'], 0.002)
        self.assertEqual(state['loaded'], ['first'])
        self.assertFalse(state['active'])

    def test_manifest_context_bounds_tool_output_and_model_guidance(self):
        mutation = r"""
const fs = await import('node:fs');
fs.mkdirSync(workspace + '/' + 'y'.repeat(220));
fs.writeFileSync(workspace + '/value.txt', ('needle ' + 'x'.repeat(300) + '\n').repeat(1000));
for (let i = 0; i < 100; i++) fs.writeFileSync(workspace + '/' + 'y'.repeat(220) + '/' + 'x'.repeat(220) + i + '.txt', '');
const budget = config.provider.stdio.models.first.limit.context / 8 * 4;
for (const [name, args] of [['read', {filePath:'value.txt', limit:2000}],
                          ['glob', {pattern:'**/*.txt'}], ['grep', {pattern:'needle'}]]) {
  const tool = plugin.tool['candidate_' + name];
  if (!tool.description.includes(String(budget))) throw new Error(name + ' budget guidance is missing');
  const response = await tool.execute(args);
  const bytes = Buffer.byteLength(response.output);
  if (bytes > budget || bytes <= budget / 2) throw new Error(name + ' output size: ' + bytes);
}
for (let i = 0; i < 100; i++) fs.unlinkSync(workspace + '/' + 'y'.repeat(220) + '/' + 'x'.repeat(220) + i + '.txt');
fs.rmdirSync(workspace + '/' + 'y'.repeat(220));
const longLine = 'export const message = "' + '\u{1f600}'.repeat(1900) + '";';
fs.writeFileSync(workspace + '/value.txt', longLine + '\nfollowing line\n');
const page = await plugin.tool.candidate_read.execute({filePath:'value.txt', limit:1});
const match = await plugin.tool.candidate_grep.execute({pattern:'message', include:'value.txt'});
for (const [name, response] of [['read', page], ['grep', match]]) {
  if (!response.output.includes('export const message = "\u{1f600}')) throw new Error(name + ' lost the entry');
  if (response.output.includes('\ufffd')) throw new Error(name + ' split a UTF-8 character');
  if (Buffer.byteLength(response.output) > budget) throw new Error(name + ' exceeded the budget');
  if (Buffer.byteLength(longLine) > budget - 1024 && !response.output.includes('[entry truncated]'))
    throw new Error(name + ' omitted the truncation marker');
}
if (page.metadata.nextOffset !== 2) throw new Error('Read did not advance past the oversized line');
const following = await plugin.tool.candidate_read.execute({filePath:'value.txt', offset:page.metadata.nextOffset});
if (!following.output.includes('2: following line') || following.metadata.nextOffset !== null)
  throw new Error('Read did not reach the following line and end of file');
if (Buffer.byteLength(longLine) > budget - 1024 && !match.metadata.truncated)
  throw new Error('Grep did not report the truncated match');
"""
        for context_tokens in (16384, 65536):
            with self.subTest(context_tokens=context_tokens):
                completed, report, _ = self.run_caller(SANDBOX, mutation, context_tokens=context_tokens)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertTrue(report['passed'])

    def test_failed_boundary_prevents_model_loading(self):
        completed, report, state = self.run_caller({'readOnly': [], 'path': SANDBOX['path']})
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(report['passed'])
        self.assertNotIn('candidateBoundary', report)
        self.assertEqual(state['loaded'], [])

    def test_dependencies_cannot_expose_supervisor_tools(self):
        sandbox = {'readOnly': [str(Path(__file__).resolve().parent)], 'path': SANDBOX['path']}
        completed, report, state = self.run_caller(sandbox)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(report['passed'])
        self.assertEqual(state['loaded'], [])

    def test_scope_gate_rejects_ignored_untracked_output(self):
        mutation = "(await import('node:fs')).writeFileSync(workspace + '/ignored.txt', 'outside');"
        completed, report, _ = self.run_caller(SANDBOX, mutation)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(report['passed'])
        self.assertEqual(report['models'][0]['changedFiles'], ['ignored.txt'])

    def test_scope_gate_rejects_git_exclusions_and_index_flags(self):
        mutations = [
            "fs.mkdirSync(workspace + '/.git/info', {recursive:true}); "
            "fs.writeFileSync(workspace + '/.git/info/exclude', 'outside.txt\\n'); "
            "fs.writeFileSync(workspace + '/outside.txt', 'outside');",
            "execFileSync('git', ['-C', workspace, 'update-index', '--assume-unchanged', 'fixed.txt']); "
            "fs.writeFileSync(workspace + '/fixed.txt', 'outside');",
            "execFileSync('git', ['-C', workspace, 'update-index', '--skip-worktree', 'fixed.txt']); "
            "fs.writeFileSync(workspace + '/fixed.txt', 'outside');",
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                script = "const fs = await import('node:fs'); "
                script += "const {execFileSync} = await import('node:child_process'); " + mutation
                completed, report, _ = self.run_caller(SANDBOX, script)
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse(report['passed'])

    def test_scope_gate_detects_outside_changes_without_git_metadata(self):
        for mutation, changed in [
            ("const before = fs.statSync(workspace + '/fixed.txt'); "
             "fs.writeFileSync(workspace + '/fixed.txt', 'Other source'); "
             "fs.utimesSync(workspace + '/fixed.txt', before.atime, before.mtime);", 'fixed.txt'),
            ("fs.unlinkSync(workspace + '/fixed.txt');", 'fixed.txt'),
            ("fs.chmodSync(workspace + '/fixed.txt', 0o755);", 'fixed.txt'),
            ("fs.writeFileSync(workspace + '/.hidden', 'outside');", '.hidden'),
            ("fs.symlinkSync(workspace, workspace + '/loop');", 'loop'),
            ("(await import('node:child_process')).execFileSync('mkfifo', [workspace + '/pipe']);", 'pipe'),
        ]:
            with self.subTest(mutation=mutation):
                completed, report, _ = self.run_caller(SANDBOX, "const fs = await import('node:fs'); " + mutation)
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse(report['passed'])
                self.assertEqual(report['models'][0]['changedFiles'], [changed])

    def test_scope_gate_accepts_only_allowed_file_changes(self):
        for mutation in [
            "fs.writeFileSync(workspace + '/value.txt', 'Edited');",
            "fs.unlinkSync(workspace + '/value.txt');",
            "fs.chmodSync(workspace + '/value.txt', 0o755);",
            "fs.unlinkSync(workspace + '/value.txt'); fs.symlinkSync('fixed.txt', workspace + '/value.txt');",
        ]:
            with self.subTest(mutation=mutation):
                completed, report, _ = self.run_caller(SANDBOX, "const fs = await import('node:fs'); " + mutation)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertTrue(report['passed'])
                self.assertEqual(report['models'][0]['changedFiles'], ['value.txt'])

    def run_caller(self, sandbox, mutation='', launch=None, context_tokens=32768):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / 'state.json').write_text(json.dumps({'loaded': [], 'mode': 'timings'}))
            for executable in ('runtime', 'nvidia-smi'):
                path = folder / executable
                path.write_text(FIXTURE.replace("name='read_nonce'", "name='candidate_read'"))
                path.chmod(0o755)
            cli = folder / 'opencode-fixture.mjs'
            cli.write_text(CLI.replace('// Candidate mutation', mutation))
            cli.chmod(0o755)
            with tarfile.open(folder / 'opencode-home.tar', 'w'):
                pass
            settings = {'opencode': {'version': 'fixture', 'commit': 'f' * 40},
                        'tools': ['read', 'glob', 'grep'], 'outputTokens': 1024, 'minimumFreeMiB': {'first': [200, 200]},
                        'editablePaths': ['value.txt']}
            manifest = {'runtime': {'image': 'sha256:' + 'a' * 64, 'commit': 'b' * 40,
                        'transport': 'stdio', 'parallelRequests': 1, 'contextTokens': context_tokens},
                        'models': [{'name': 'first', 'revision': 'd' * 40, 'sha256': 'e' * 64,
                                    'sampling': {'temperature': 1}, 'gpuSplit': [1, 1], 'architecture': 'test'}]}
            assets = {'opencode': cli, 'provider': Path(__file__).with_name('provider.mjs'),
                      'home': folder / 'opencode-home.tar', 'git': Path(shutil.which('git')),
                      **{name: Path(__file__).with_name(name) for name in
                         ('tools.mjs', 'tools.py', 'confinement.py')}}
            receipt = {'reviewed': True, 'opencode': settings['opencode'], 'sandbox': sandbox,
                       'sha256': {name: hashlib.sha256(path.read_bytes()).hexdigest()
                                  for name, path in assets.items()}}
            for name, contents in [('settings', settings), ('manifest', manifest), ('receipt', receipt)]:
                (folder / (name + '.json')).write_text(json.dumps(contents))
            workspace = folder / 'candidate'
            original = folder / 'original'
            original.mkdir()
            subprocess.run(['git', '-C', str(original), 'init', '-q'], check=True)
            (original / 'value.txt').write_text('Original source')
            (original / 'fixed.txt').write_text('Fixed source')
            (original / '.gitignore').write_text('ignored.txt\n')
            subprocess.run(['git', '-C', str(original), 'add', '--all'], check=True)
            subprocess.run(['git', '-C', str(original), '-c', 'user.name=Fixture',
                            '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Original'], check=True)
            revision = subprocess.run(['git', '-C', str(original), 'rev-parse', 'HEAD'], check=True,
                                      capture_output=True, text=True).stdout.strip()
            (folder / 'scope.json').write_text(json.dumps({'paths': ['value.txt', 'fixed.txt', '.gitignore']}))
            subprocess.run(['python3', str(Path(__file__).with_name('export.py')),
                            '--repository', str(original), '--revision', revision,
                            '--scope', str(folder / 'scope.json'), '--archive', str(folder / 'base.tar')], check=True)
            (folder / 'prompt.txt').write_text('Fixture only')
            command = ['python3', str(Path(__file__).with_name('coding.py')),
                       '--runtime', str(folder / 'runtime'), '--opencode', str(cli),
                       '--model', 'first', '--workspace', str(workspace),
                       '--source', str(folder / 'base.tar'), '--source-receipt', str(folder / 'base.json'),
                       '--revision', revision,
                       '--prompt', str(folder / 'prompt.txt'), '--report', str(folder / 'report.json')]
            for name in ('manifest', 'settings', 'receipt'):
                command += ['--' + name, str(folder / (name + '.json'))]
            environment = {**os.environ, 'UNRELATED_CANARY': 'must not reach child',
                           'PATH': str(folder) + os.pathsep + os.environ['PATH']}
            completed = (launch(folder, command, environment) if launch else
                         subprocess.run(command, capture_output=True, text=True, timeout=10, env=environment))
            report = json.loads((folder / 'report.json').read_text())
            state = json.loads((folder / 'state.json').read_text())
            return completed, report, state


if __name__ == '__main__':
    unittest.main()
