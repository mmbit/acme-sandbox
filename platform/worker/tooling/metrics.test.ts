// node --test platform/worker/tooling/metrics.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurement } from './metrics.ts';

const use = (id: string, name: string, input: object) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const end = (id: string, is_error = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'private customer output' }] },
});
const command = (id: string, command: string, exit_code?: number) => ({
  type: exit_code === undefined ? 'item.started' : 'item.completed',
  item: { type: 'command_execution', id, command, exit_code },
});

test('startup ends at task work and the snapshot contains labels and counts only', () => {
  const m = measurement(100);
  m.observe(use('a', 'Read', { file_path: '/work/job/company/people/private-name.md' }), 120);
  m.observe(end('a'), 130);
  m.observe(use('b', 'Bash', { command: 'hq search "private customer question"' }), 140);
  m.observe(end('b', true), 150);
  m.observe(use('c', 'Read', { file_path: '/work/job/platform/worker/hq/runs.ts' }), 180);
  m.observe(end('c'), 190);
  m.observe(use('d', 'Read', { file_path: 'company/CHARTER.md' }), 210);
  m.observe(end('d'), 220);
  const snapshot = m.snapshot();
  assert.equal(snapshot.startupCalls, 2);
  assert.equal(snapshot.startupMilliseconds, 60);
  assert.equal(snapshot.firstToolMilliseconds, 20);
  assert.equal(snapshot.startup.search!.failed, 1);
  assert.equal(snapshot.startup.search!.untilNextMilliseconds, 40);
  assert.equal(snapshot.startup.charter, undefined);
  assert.equal(snapshot.lookups.charter!.calls, 1);
  assert.equal(snapshot.sources['hq/run']!.calls, 1);
  assert.equal(snapshot.pending, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|customer|question|runs\.ts|file_path/);
});

test('Codex shell wrappers, failures, browser checks and gate invocations stay distinct', () => {
  const m = measurement(0);
  const calls = [
    "/bin/bash -lc 'cat company/CHARTER.md company/people/person.md'",
    'hq run --kind simulation -- node simulate.ts',
    'node page-check.mjs',
    'npm run gates',
    'node --test src/one.test.ts',
  ];
  calls.forEach((text, i) => {
    m.observe(command(String(i), text), i * 10);
    m.observe(command(String(i), text, i === 1 ? 22 : 0), i * 10 + 5);
  });
  const snapshot = m.snapshot();
  assert.equal(snapshot.startupCalls, 1);
  assert.equal(snapshot.commands.run!.failed, 1);
  assert.deepEqual(Object.keys(snapshot.activities).sort(), ['browser', 'gates', 'tests']);
  assert.equal(snapshot.activities.browser!.milliseconds, 5);
  assert.equal(snapshot.calls, 5);
  assert.equal(snapshot.pending, 0);
});

test('mixed commands end the prefix and script content never becomes a source read', () => {
  const m = measurement(0, false);
  m.observe(use('a', 'Bash', { command: 'cat company/CHARTER.md; npm test' }), 5);
  m.observe(end('a'), 10);
  m.observe(use('b', 'Bash', { command: 'python3 - <<\'PY\'\nprint("cat platform/worker/hq/runs.ts")\nPY' }), 15);
  m.observe(end('b'), 20);
  m.observe(use('c', 'Bash', { command: 'echo "hq run playwright customer command"' }), 25);
  m.observe(end('c'), 30);
  assert.equal(m.snapshot().startupCalls, 0);
  assert.equal(m.snapshot().lookups.charter!.calls, 1);
  assert.deepEqual(m.snapshot().sources, {});
  assert.deepEqual(m.snapshot().commands, {});
  assert.equal(m.snapshot().activities.browser, undefined);
  m.resumed = true;
  assert.equal(m.snapshot().complete, false);
  assert.equal(m.snapshot().resumed, true);
});

test('team events are excluded and unfinished results remain visible', () => {
  const m = measurement(0);
  m.observe({ ...use('a', 'Read', { file_path: 'company/CHARTER.md' }), parent_tool_use_id: 'team' }, 10);
  m.observe(use('b', 'Bash', { command: 'hq --help' }), 15);
  const snapshot = m.snapshot();
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.commands.help!.completed, 0);
  assert.equal(snapshot.startupMilliseconds, null);
  snapshot.commands.help!.calls = 999;
  assert.equal(m.snapshot().commands.help!.calls, 1);
});

test('usage documentation in kits is not a tooling source read', () => {
  const m = measurement(0);
  m.observe(use('a', 'Read', { file_path: 'kits/engine/README.md' }), 10);
  m.observe(end('a'), 20);
  assert.deepEqual(m.snapshot().sources, {});
});

test('visible Codex operations end startup at their first event without retaining inputs', () => {
  for (const type of ['web_search', 'mcp_tool_call', 'file_change'])
    for (const first of ['item.started', 'item.updated', 'item.completed']) {
      const m = measurement(0);
      m.observe(
        { type: 'item.completed', item: { id: 'notice', type: 'error', message: 'Model metadata warning' } },
        5,
      );
      m.observe(command('search', 'hq search topic'), 10);
      m.observe(command('search', 'hq search topic', 0), 20);
      const item = { id: 'task', type, status: 'in_progress', arguments: { private: 'customer query' } };
      m.observe({ type: first, item }, 30);
      m.observe({ type: 'item.updated', item }, 40);
      m.observe({ type: 'item.completed', item: { ...item, status: 'completed' } }, 1030);
      m.observe(command('history', 'hq history'), 1040);
      m.observe(command('history', 'hq history', 0), 1050);
      m.observe(command('tests', 'npm test'), 1060);
      m.observe(command('tests', 'npm test', 0), 1070);
      const snapshot = m.snapshot();
      assert.equal(snapshot.firstToolMilliseconds, 10, type);
      assert.equal(snapshot.startupCalls, 1, type);
      assert.equal(snapshot.startupMilliseconds, 20, type);
      assert.equal(snapshot.startup.search!.untilNextMilliseconds, 20, type);
      assert.equal(snapshot.calls, 4, type);
      assert.equal(snapshot.unknown, 1, type);
      const reason = type === 'web_search' ? 'web' : type === 'mcp_tool_call' ? 'mcp' : 'fileChange';
      assert.equal(snapshot.unknownReasons[reason]!.calls, 1, type);
      assert.equal(snapshot.pending, 0, type);
      assert.doesNotMatch(JSON.stringify(snapshot), /private|customer|arguments|query/);
    }
});

test('shell comments preserve lookup startup', () => {
  for (const text of ['hq search topic # ; hq run', 'hq search "topic # ; hq run"', "hq search 'topic # ; hq run'"]) {
    const m = measurement(0);
    m.observe(command('lookup', text), 10);
    m.observe(command('lookup', text, 0), 20);
    const snapshot = m.snapshot();
    assert.equal(snapshot.startupCalls, 1, text);
    assert.equal(snapshot.startupMilliseconds, null, text);
    assert.equal(snapshot.commands.search!.calls, 1, text);
    assert.equal(snapshot.commands.run, undefined, text);
    assert.equal(snapshot.unknown, 0, text);
  }
});

test('conditional lists are unknown without inventing executed category counts', () => {
  for (const [text, exitCode] of [
    ['hq status || hq search topic', 0],
    ['npm run gates && npm test', 1],
    ['hq status && hq search topic', 0],
    ['hq search topic || hq search backup', 0],
    ['hq status && hq status && hq search topic', 0],
  ] as const) {
    const m = measurement(0);
    m.observe(command('conditional', text), 10);
    m.observe(command('conditional', text, exitCode), 20);
    const snapshot = m.snapshot();
    assert.equal(snapshot.calls, 1, text);
    assert.equal(snapshot.unknown, 1, text);
    assert.equal(snapshot.startupCalls, 0, text);
    assert.equal(snapshot.startupMilliseconds, 0, text);
    assert.equal(snapshot.pending, 0, text);
    assert.deepEqual(snapshot.commands, {}, text);
    assert.deepEqual(snapshot.activities, {}, text);
    assert.deepEqual(snapshot.lookups, {}, text);
    assert.deepEqual(snapshot.startup, {}, text);
    assert.deepEqual(snapshot.sources, {}, text);
  }
});

test('unknown coverage separates syntax, programs and native tools with unique observed outcomes', () => {
  const m = measurement(0);
  const calls = [
    ['a', 'Bash', { command: 'hq search topic && npm test' }],
    ['b', 'Bash', { command: 'git diff; cat --unknown company/CHARTER.md' }],
    ['c', 'Grep', { pattern: 'private customer query' }],
    ['d', 'mcp__private__tool', { customer: 'private' }],
  ] as const;
  calls.forEach(([id, name, input], i) => {
    m.observe(use(id, name, input), 10 + i * 20);
    m.observe(end(id, i < 2), 20 + i * 20);
    m.observe(end(id, i < 2), 25 + i * 20);
  });
  m.observe({ type: 'item.completed', item: { type: 'command_execution', id: 'no-outcome', command: 'git diff' } }, 90);
  m.observe(command('pending', 'git diff'), 100);
  const snapshot = m.snapshot();
  assert.equal(snapshot.version, 4);
  assert.equal(snapshot.calls, 6);
  assert.equal(snapshot.completed, 4);
  assert.equal(snapshot.failed, 2);
  assert.equal(snapshot.unknownReasons.shellProgram!.failed, 1);
  assert.equal(snapshot.unknownReasons.readOptions!.failed, 1);
  assert.equal(snapshot.milliseconds, 40);
  assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.unknown, 6);
  assert.deepEqual(snapshot.unknownReasons.shellSyntax, {
    calls: 1,
    completed: 1,
    failed: 1,
    milliseconds: 10,
    untilNextMilliseconds: 20,
  });
  assert.equal(snapshot.unknownReasons.shellProgram!.calls, 3);
  assert.equal(snapshot.unknownReasons.readOptions!.calls, 1);
  assert.equal(snapshot.unknownReasons.fileSearch!.calls, 1);
  assert.equal(snapshot.unknownReasons.mcp!.calls, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|customer|query|git diff|pattern/);
});

test('Codex operations without a known outcome do not invent a success', () => {
  const m = measurement(0);
  m.observe({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'absent' } }, 10);
  m.observe({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'failed', status: 'failed' } }, 20);
  const snapshot = m.snapshot();
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.unknownReasons.mcp!.completed, 1);
  assert.equal(snapshot.unknownReasons.mcp!.failed, 1);
});

test('first calls and prefix boundaries retain only fixed coverage labels', () => {
  const m = measurement(0);
  m.observe(use('lookup', 'Read', { file_path: 'company/CHARTER.md' }), 10);
  m.observe(end('lookup'), 20);
  m.observe(use('task', 'Bash', { command: 'hq search "private customer" && npm test' }), 30);
  m.observe(end('task'), 50);
  m.observe(use('later', 'Write', { file_path: 'private-customer.txt' }), 60);
  m.observe(end('later'), 70);
  const snapshot = m.snapshot();
  assert.equal(snapshot.version, 4);
  assert.deepEqual(snapshot.firstCall!.lookups, ['charter']);
  assert.deepEqual(snapshot.startupBoundary!.unknownReasons, ['shellSyntax']);
  assert.deepEqual(snapshot.startupBoundary!.diagnostics, ['shellConditional']);
  assert.equal(snapshot.diagnostics.shellConditional!.calls, 1);
  assert.equal(snapshot.diagnostics.shellConditional!.milliseconds, 20);
  assert.equal(snapshot.diagnostics.shellConditional!.untilNextMilliseconds, 30);
  assert.deepEqual(snapshot.commands, {});
  assert.equal(snapshot.startupCalls, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|customer|npm|file_path/);
});

test('shell coverage diagnostics explain syntax and literal programs without inventing execution', () => {
  const examples = [
    ['cat company/CHARTER.md > private.txt', 'shellRedirect'],
    ['cat "$PRIVATE"', 'shellDynamic'],
    ['PRIVATE=value cat company/CHARTER.md', 'shellAssignment'],
    ['if true; then hq search private; fi', 'shellCompound'],
    ["cat 'private", 'shellParse'],
    ['cd /private', 'directoryProgram'],
    ['rg private company', 'searchProgram'],
    ['git diff', 'versionControlProgram'],
    ['python3 private.py', 'interpreterProgram'],
    ['printf private', 'outputProgram'],
    ['env private', 'environmentProgram'],
    ['private-program secret', 'otherProgram'],
    ['cat --', 'readTerminator'],
    ['cat -- -', 'readTerminator'],
    ['head -n private.txt', 'readFlags'],
    ['head --unknown private.txt', 'readFlags'],
  ] as const;
  for (const [text, reason] of examples) {
    const m = measurement(0);
    m.observe(use('first', 'Bash', { command: text }), 10);
    m.observe(end('first'), 20);
    const snapshot = m.snapshot();
    assert.equal(snapshot.startupMilliseconds, 0, text);
    assert.equal(snapshot.diagnostics[reason]!.calls, 1, text);
    assert.deepEqual(snapshot.firstCall, snapshot.startupBoundary, text);
    assert.equal(snapshot.unknown, 1, text);
    assert.deepEqual(snapshot.lookups, {}, text);
    assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|CHARTER|file_path/);
  }
  const untouched = measurement(0).snapshot();
  assert.equal(untouched.firstCall, null);
  assert.equal(untouched.startupBoundary, null);
});

test('heredoc data never becomes executable families and following commands remain visible', () => {
  for (const text of [
    'cat <<EOF\nls\ngit diff\nhq search private\ncat company/CHARTER.md\nEOF\nhq history',
    "python3 - <<'PY'\nls\ngit diff\nPY\nhq history",
    'bash <<EOF\nls\ngit diff\nEOF\nhq history',
    'cat <<-EOF\n\tls\n\tgit diff\n\tEOF\nhq history',
    'cat <<EOF | wc -l\nls\ngit diff\nEOF\nhq history',
    'cat <<EOF\n$(git diff)\nEOF\nhq history',
  ]) {
    const m = measurement(0);
    m.observe(use('heredoc', 'Bash', { command: text }), 10);
    m.observe(end('heredoc'), 20);
    const snapshot = m.snapshot();
    assert.deepEqual(Object.keys(snapshot.diagnostics), ['shellRedirect'], text);
    assert.deepEqual(Object.keys(snapshot.unknownReasons), ['shellSyntax'], text);
    assert.equal(snapshot.commands.history!.calls, 1, text);
    assert.deepEqual(Object.keys(snapshot.commands), ['history'], text);
    assert.deepEqual(Object.keys(snapshot.lookups), ['history'], text);
    assert.equal(snapshot.startupMilliseconds, 0, text);
    assert.doesNotMatch(JSON.stringify(snapshot), /EOF|PY|git diff|command:|file_path/);
  }
  const rejected = measurement(0);
  rejected.observe(use('multiple', 'Bash', { command: "cat <<'A' <<'B'\nls\nA\ngit diff\nB\nhq history" }), 10);
  rejected.observe(end('multiple'), 20);
  const snapshot = rejected.snapshot();
  assert.deepEqual(Object.keys(snapshot.diagnostics), ['shellParse']);
  assert.deepEqual(Object.keys(snapshot.unknownReasons), ['shellSyntax']);
  assert.deepEqual(snapshot.commands, {});
});

function readSnapshot(text: string, engine: 'claude' | 'codex') {
  const m = measurement(0);
  const wrapped = `/bin/bash -lc '${text}'`;
  m.observe(engine === 'claude' ? use('read', 'Bash', { command: wrapped }) : command('read', wrapped), 10);
  m.observe(engine === 'claude' ? end('read') : command('read', wrapped, 0), 20);
  return m.snapshot();
}

test('literal read options preserve lookup prefixes and explicit source operands through native wrappers', () => {
  for (const engine of ['claude', 'codex'] as const)
    for (const text of [
      'cat -nbsETuvAet -- company/CHARTER.md',
      'cat --number --number-nonblank --show-all --show-ends --show-tabs --show-nonprinting --squeeze-blank company/CHARTER.md',
      'head -n 20 company/CHARTER.md',
      'head -qvn20 -- company/CHARTER.md',
      'head --lines=20 --quiet --silent --verbose --zero-terminated company/CHARTER.md',
      'head -c-20 company/CHARTER.md',
      'head --bytes=20 company/CHARTER.md',
      'head --lines 0 company/CHARTER.md',
      'tail -- -f/company/CHARTER.md',
      'tail -n +20 company/CHARTER.md',
      'tail --bytes 20 -qvz company/CHARTER.md',
      'tail --lines=-20 company/CHARTER.md',
      'cat -- company/CHARTER.md',
      'cat -- --unknown/company/CHARTER.md',
    ]) {
      const snapshot = readSnapshot(text, engine);
      assert.equal(snapshot.unknown, 0, text);
      assert.equal(snapshot.startupCalls, 1, text);
      assert.equal(snapshot.startupMilliseconds, null, text);
      assert.equal(snapshot.lookups.charter!.calls, 1, text);
      assert.equal(snapshot.pending, 0, text);
      assert.equal(snapshot.completed, 1, text);
      assert.deepEqual(snapshot.diagnostics, {}, text);
      assert.doesNotMatch(JSON.stringify(snapshot), /CHARTER|--number|--bytes|file_path/);
    }
  const source = readSnapshot('head -n20 platform/worker/hq/jobs.ts', 'codex');
  assert.equal(source.sources['hq/jobs']!.calls, 1);
  assert.equal(source.startupCalls, 0);
  assert.equal(source.unknown, 0);
  assert.doesNotMatch(JSON.stringify(source), /jobs\.ts|platform\/worker|n20/);
});

test('invalid read options, count arguments, stdin and follow modes never invent file reads', () => {
  for (const engine of ['claude', 'codex'] as const)
    for (const text of [
      'cat',
      'head -n20',
      'tail --',
      'cat - company/CHARTER.md',
      'head -- - company/CHARTER.md',
      'tail -n20 - company/CHARTER.md',
      'cat --unknown company/CHARTER.md',
      'cat -nx company/CHARTER.md',
      'cat --number=20 company/CHARTER.md',
      'head -n',
      'head --lines',
      'head --bytes=',
      'head -n company/CHARTER.md',
      'tail --bytes platform/worker/hq/jobs.ts',
      'head -n company/CHARTER.md platform/worker/hq/jobs.ts',
      'tail --lines=platform/worker/hq/jobs.ts company/CHARTER.md',
      'head -n20x company/CHARTER.md',
      'head --lines=+ company/CHARTER.md',
      'head -n9007199254740992 company/CHARTER.md',
      'head -c2K company/CHARTER.md',
      'head -20 company/CHARTER.md',
      'head --lin=20 company/CHARTER.md',
      'head -n -- company/CHARTER.md',
      'head -qnonsense company/CHARTER.md',
      'tail -f company/CHARTER.md',
      'tail -F company/CHARTER.md',
      'tail --follow=name company/CHARTER.md',
      'tail --follow company/CHARTER.md',
      'tail --retry company/CHARTER.md',
      'tail --pid=20 company/CHARTER.md',
      'tail -s1 company/CHARTER.md',
      'head --help company/CHARTER.md',
      'cat --version company/CHARTER.md',
    ]) {
      const snapshot = readSnapshot(text, engine);
      assert.equal(snapshot.unknown, 1, text);
      assert.equal(snapshot.unknownReasons.readOptions!.calls, 1, text);
      assert.equal(snapshot.startupCalls, 0, text);
      assert.equal(snapshot.startupMilliseconds, 0, text);
      assert.deepEqual(snapshot.lookups, {}, text);
      assert.deepEqual(snapshot.sources, {}, text);
      assert.doesNotMatch(JSON.stringify(snapshot), /CHARTER|jobs\.ts|--follow|--unknown|file_path/);
    }
});

test('option-like operands and mixed batches retain only executed literal read candidates', () => {
  for (const engine of ['claude', 'codex'] as const) {
    const operand = readSnapshot('head -n20 -- --lines/company/CHARTER.md -private/customer.txt', engine);
    assert.equal(operand.lookups.charter!.calls, 1);
    assert.equal(operand.unknown, 0);
    assert.equal(operand.startupCalls, 0);
    const mixed = readSnapshot(
      'cat -n company/CHARTER.md; head -n20 company/CHARTER.md; tail -f private/customer.txt; ls',
      engine,
    );
    assert.equal(mixed.lookups.charter!.calls, 1);
    assert.equal(mixed.startupCalls, 0);
    assert.equal(mixed.unknown, 1);
    assert.equal(mixed.unknownReasons.readOptions!.calls, 1);
    assert.equal(mixed.unknownReasons.shellProgram!.calls, 1);
    assert.equal(mixed.diagnostics.directoryProgram!.calls, 1);
    assert.doesNotMatch(JSON.stringify([operand, mixed]), /private|customer|CHARTER|--lines|tail|file_path/);
  }
});

test('read options do not cross assignments, redirects, dynamic words or control flow', () => {
  for (const engine of ['claude', 'codex'] as const)
    for (const [text, diagnostic] of [
      ['PRIVATE=x cat -n company/CHARTER.md', 'shellAssignment'],
      ['head -n20 company/CHARTER.md > private.txt', 'shellRedirect'],
      ['tail -n20 "$PRIVATE"', 'shellDynamic'],
      ['cat -n company/CHARTER.md && head -n20 company/people/private.md', 'shellConditional'],
      ['cat -n company/CHARTER.md || tail -n20 company/people/private.md', 'shellConditional'],
      ['if true; then head -n20 company/CHARTER.md; fi', 'shellCompound'],
      ['cat -n <<EOF\nhead -n20 company/CHARTER.md\nEOF', 'shellRedirect'],
    ] as const) {
      const snapshot = readSnapshot(text, engine);
      assert.equal(snapshot.unknown, 1, text);
      assert.equal(snapshot.diagnostics[diagnostic]!.calls, 1, text);
      assert.deepEqual(snapshot.lookups, {}, text);
      assert.deepEqual(snapshot.sources, {}, text);
      assert.equal(snapshot.startupCalls, 0, text);
    }
});

test('stdin rejection snapshots distinguish operands from real options and terminators', () => {
  const count = { calls: 1, completed: 1, failed: 0, milliseconds: 10, untilNextMilliseconds: 0 };
  for (const engine of ['claude', 'codex'] as const)
    for (const [text, diagnostic] of [
      ['cat', undefined],
      ['cat -', undefined],
      ['head -', undefined],
      ['tail -', undefined],
      ['cat - company/CHARTER.md', undefined],
      ['cat company/CHARTER.md - platform/worker/hq/jobs.ts', undefined],
      ['cat -n - company/CHARTER.md', 'readFlags'],
      ['cat - -n company/CHARTER.md', 'readFlags'],
      ['head -n20 - company/CHARTER.md', 'readFlags'],
      ['tail - --lines=20 company/CHARTER.md', 'readFlags'],
      ['cat --', 'readTerminator'],
      ['cat -- -', 'readTerminator'],
      ['cat - -- company/CHARTER.md', 'readTerminator'],
      ['cat -- - company/CHARTER.md', 'readTerminator'],
      ['cat -- - --unknown company/CHARTER.md', 'readTerminator'],
      ['cat -n -- - company/CHARTER.md', 'readFlags'],
      ['cat - --number -- company/CHARTER.md', 'readFlags'],
      ['head -n', 'readFlags'],
      ['head --lines', 'readFlags'],
      ['head -n -- company/CHARTER.md', 'readFlags'],
      ['head --lines -- company/CHARTER.md', 'readFlags'],
      ['head -n - company/CHARTER.md', 'readFlags'],
      ['head --lines=invalid - company/CHARTER.md', 'readFlags'],
      ['head --bytes= - company/CHARTER.md', 'readFlags'],
      ['cat --unknown - -- company/CHARTER.md', 'readFlags'],
      ['cat - --unknown company/CHARTER.md', 'readFlags'],
      ['cat company/CHARTER.md --unknown -- - platform/worker/hq/jobs.ts', 'readFlags'],
    ] as const) {
      const labels = {
        lookups: [],
        sources: [],
        commands: [],
        activities: [],
        boundary: true,
        unknownReasons: ['readOptions'],
        diagnostics: diagnostic ? [diagnostic] : [],
      };
      const snapshot = readSnapshot(text, engine);
      assert.deepEqual(
        snapshot,
        {
          version: 4,
          complete: true,
          resumed: false,
          calls: 1,
          completed: 1,
          failed: 0,
          milliseconds: 10,
          unknownReasons: { readOptions: count },
          diagnostics: diagnostic ? { [diagnostic]: count } : {},
          firstCall: labels,
          startupBoundary: labels,
          unknown: 1,
          pending: 0,
          startupCalls: 0,
          startupMilliseconds: 0,
          firstToolMilliseconds: 10,
          startup: {},
          lookups: {},
          sources: {},
          commands: {},
          activities: {},
        },
        `${engine}: ${text}`,
      );
      assert.doesNotMatch(JSON.stringify(snapshot), /private|customer|CHARTER|jobs\.ts|--unknown|--lines|file_path/);
    }
});
