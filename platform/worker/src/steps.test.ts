// node --test src/steps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandKind, detailOf, stepOf, memberReturned, memberOf, writtenTokens } from './steps.ts';

test('a tool call reads as a line in plain words: its kind and what it names for agents, the line itself for the board', () => {
  assert.deepEqual(stepOf('Read', { file_path: '/repo/platform/hq/shell/hud.js' }), { text: 'Reading hud.js' });
  assert.deepEqual(stepOf('Edit', { file_path: 'a/b.ts', old_string: 'x', new_string: 'y' }), { text: 'Editing b.ts' });
  assert.deepEqual(stepOf('MultiEdit', { file_path: 'b.ts', edits: [] }), { text: 'Editing b.ts' });
  assert.deepEqual(stepOf('Write', { file_path: 'n.md', content: 'one' }), { text: 'Writing n.md' });
  assert.deepEqual(stepOf('Bash', { command: 'hq care 12', description: 'Read case 12' }), {
    text: 'Running hq care',
    board: 'Read case 12',
  });
  assert.equal(stepOf('Bash', { command: 'ls -la' })?.board, 'Running ls -la');
  assert.deepEqual(stepOf('Grep', { pattern: 'jan@example.org' }), {
    text: 'Searching the files',
    board: 'Searching for “jan@example.org”',
  });
  assert.deepEqual(stepOf('WebSearch', { query: 'Jan Jansen' }), {
    text: 'Searching the web',
    board: 'Searching the web for “Jan Jansen”',
  });
  assert.deepEqual(stepOf('WebFetch', { url: 'https://example.com/a?b' }), { text: 'Reading example.com' });
  assert.equal(stepOf('mcp__github__get_file')?.text, 'Using github');
  assert.equal(stepOf('SendMessage', { to: 'x' }), null);
});

test('the job’s log has each call as it was made for the board, and its kind for agents', () => {
  assert.deepEqual(detailOf('Bash', { command: 'hq care reply 12 "Dear Jan"', description: 'Reply' }), {
    text: 'Running hq care',
    board: '$ hq care reply 12 "Dear Jan"',
  });
  assert.deepEqual(detailOf('Edit', { file_path: 'platform/hq/a.js' }), {
    text: 'Editing a.js',
    board: 'Edit platform/hq/a.js',
  });
  assert.deepEqual(detailOf('Grep', { pattern: 'until', path: 'src', glob: '*.ts' }), {
    text: 'Searching the files',
    board: 'Grep “until” in src (*.ts)',
  });
  assert.deepEqual(detailOf('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b' }] }), {
    text: 'Updating its plan',
    board: 'Plan: ✓ a · b',
  });
  assert.deepEqual(detailOf('SendMessage', { to: 'kit', message: 'Jan wants a refund' }), {
    text: 'To kit',
    board: 'To kit: Jan wants a refund',
  });
});

test("a team member is done when its Agent call comes back with its work or fails, not when it's sent to the background", () => {
  const back = (status: string) => ({ type: 'user', tool_use_result: { status } });
  assert.equal(memberReturned(back('completed'), { type: 'tool_result', tool_use_id: 'a' }), true);
  assert.equal(memberReturned(back('async_launched'), { type: 'tool_result', tool_use_id: 'a' }), false);
  assert.equal(memberReturned(back('teammate_spawned'), { type: 'tool_result', tool_use_id: 'a' }), false);
  assert.equal(memberReturned({ type: 'user' }, { type: 'tool_result', tool_use_id: 'a', is_error: true }), true);
});

test("a team member's task is its Agent call's description, never only its name again", () => {
  assert.deepEqual(memberOf({ name: 'quoin', description: "The formats kit's tests" }), {
    name: 'quoin',
    task: "The formats kit's tests",
  });
  assert.deepEqual(memberOf({ description: 'Burnish' }), { name: 'Burnish', task: '' }); // the name in the description
  assert.deepEqual(memberOf({ name: 'burnish', description: 'Burnish' }), { name: 'burnish', task: '' });
  assert.deepEqual(memberOf({ name: 'sea-glass', description: 'Sea glass' }), { name: 'sea-glass', task: '' });
  assert.deepEqual(memberOf({ name: 'burnish', description: ' ' }), { name: 'burnish', task: '' });
  assert.deepEqual(memberOf({}), { name: 'helper', task: '' });
});

test('what a step wrote counts in tokens, about four characters each, whichever engine wrote it', () => {
  const claude = (...content: object[]) => ({
    type: 'assistant',
    message: { id: 'm', content, usage: { output_tokens: 1 } },
  });
  assert.equal(writtenTokens(claude({ type: 'text', text: 'x'.repeat(400) })), 100);
  assert.equal(writtenTokens(claude({ type: 'thinking', thinking: 'y'.repeat(40) })), 10);
  assert.equal(writtenTokens(claude({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } })), 4);
  assert.equal(writtenTokens({ type: 'item.completed', item: { type: 'agent_message', text: 'z'.repeat(80) } }), 20);
  assert.equal(writtenTokens({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }), 2);
  assert.equal(
    writtenTokens({ type: 'user', message: { content: [{ type: 'tool_result', content: 'long output' }] } }),
    0,
  );
});

test('a command reads for agents as its program and the script or subcommand it runs, never its other arguments', () => {
  const kinds = {
    'cd /repo && node platform/hq/book-check.mjs --all': 'Running node book-check.mjs',
    'npm run gates': 'Running npm run gates',
    'hq care reply 12 "Dear Jan"': 'Running hq care',
    "bash -lc 'git log --oneline -3'": 'Running git log',
    'PORT=1 python3 -c "open(\'jan.txt\')"': 'Running python3',
    '/usr/bin/grep -rn jan@example.org .': 'Running grep',
    'sqlite3 jansen.db "select 1"': 'Running sqlite3',
    'git -C /work/jan add -A': 'Running git',
    '$(cat x)': 'Running a command',
  };
  for (const [command, kind] of Object.entries(kinds)) assert.equal(commandKind(command), kind, command);
});

// (a quote, a backslash, $, a backtick, a redirection, a comment or a line end ends the reading: only the names read before
// it can show)
test('nothing from after the first uncertain character is named, wherever the separators are', () => {
  const kinds = {
    'echo "Receipt; SyntheticPerson delivery pending"': 'Running a command',
    'echo "Receipt && SyntheticPerson paid"': 'Running a command',
    "echo 'Receipt | SyntheticPerson'": 'Running a command',
    'echo "hello\nAda Lovelace paid"': 'Running a command',
    'echo "hello\\" ; Ada"': 'Running a command',
    'NAME="Ada Lovelace; Jan" node x.mjs': 'Running a command',
    'NAME="x" && "Ada" pays': 'Running a command',
    'git "Ada" log': 'Running git',
    'node "Ada Lovelace.mjs"': 'Running node',
    'echo hi # Ada; Lovelace\nnpm run gates': 'Running a command',
    "cat > a.txt <<'EOF'\nAda Lovelace paid\nEOF": 'Running cat',
    'echo hi <<EOF\nAda Lovelace paid\nEOF': 'Running a command',
    'node a.mjs 2>&1 | tail -3': 'Running node a.mjs',
    'cat x | node a.mjs': 'Running cat',
    "bash -lc 'cd /repo && node platform/hq/book-check.mjs'": 'Running node book-check.mjs',
    'bash -lc "cd /repo && npm run gates"': 'Running npm run gates',
    '/bin/bash -lc "sed -n \'1,80p\' Ada.txt"': 'Running sed',
    '/bin/bash -lc "python3 - <<\'PY\'\nprint(1)\nPY"': 'Running python3',
    '/bin/bash -lc "rg -n \\"Ada\\" . | sed -n \'1,2p\'"': 'Running rg',
    '/bin/bash -lc "python3 - <<\'PY\'\nprint(\\"Ada\\")\nPY"': 'Running python3',
    '/bin/bash -lc "echo \\"x\\" \\\\"; Ada pays"': 'Running a command',
    '/bin/bash -lc "echo \\x; Ada pays"': 'Running a command',
    "/bin/bash -lc \"sed -n '1,2p' \"'$F'": 'Running a command',
    '/bin/bash -lc "echo $(x); Ada pays"': 'Running a command',
    '/bin/bash -lc "git log" "Ada"': 'Running a command',
    "bash -- -c 'SyntheticPrivateArgument'": 'Running a command',
    "bash -o -c 'SyntheticPrivateArgument'": 'Running a command',
    "bash -oc 'SyntheticPrivateArgument'": 'Running a command',
    'bash -oc SyntheticPrivate.py': 'Running a command',
    'sh -ec SyntheticPrivate.sh': 'Running a command',
    'bash -x -c "SyntheticPrivateArgument"': 'Running a command',
    'cd /repo; node a.mjs': 'Running node a.mjs',
    'echo hi || npm run gates': 'Running npm run gates',
    '/bin/bash -lc \'echo "Receipt; SyntheticPerson"\'': 'Running a command',
    'bash -lc \'bash -lc "Ada; Lovelace"\'': 'Running bash',
    'echo "$(printf \'%s\' a; echo "Ada; Lovelace paid")"': 'Running a command',
    'echo "a `echo "Ada; Lovelace"`"; node x.mjs': 'Running a command',
    'echo ${message:-Receipt; Ada paid}': 'Running a command',
    'X=$(date; echo "Ada; Jan") node x.mjs': 'Running a command',
    'bash -lc \'echo "$(echo "Ada; Lovelace")"\'': 'Running a command',
    'node >/tmp/Ada.mjs actual.mjs': 'Running node',
    'node > Ada.mjs a.mjs': 'Running node',
    'node <<</tmp/Ada.mjs': 'Running node',
    'echo <(true; Lovelace paid)': 'Running a command',
    'echo >(true; Lovelace paid)': 'Running a command',
    'diff <(sort a.txt) b.txt': 'Running diff',
    "echo $'Ada\\'s; Lovelace paid'": 'Running a command',
    "echo $(printf $'%s\\'; Ada' x); node x.mjs": 'Running a command',
    'echo >| Ada.mjs; node a.mjs': 'Running a command',
    'node >|Ada.mjs a.mjs': 'Running node',
    "msg=$(cat <<'EOF'\nSteps: 1) call Ada; Lovelace paid\nEOF\n) node x.mjs": 'Running a command',
    'echo $(cat <<EOF\n1) Ada; Lovelace paid\nEOF\n)': 'Running a command',
    'echo "$(cat <<\'EOF\'\n)"; Ada paid\nEOF\n)"': 'Running a command',
    'echo "$(printf x # )"; Ada paid\n)"': 'Running a command',
    'echo $(cat <<-A <<B\n1) x\nA\n2) Ada; Lovelace\nB\n); node x.mjs': 'Running a command',
    'x=$(case $1 in a) Ada Lovelace;; esac)': 'Running a command',
    'x=$(case $1 in a) echo Ada;; (b) Lovelace;; esac) node x.mjs': 'Running a command',
    'echo $( (case $1 in a) Ada;; esac) ); node x.mjs': 'Running a command',
    'x=$(if true; then case $1 in a) Ada Lovelace;; esac; fi) node x.mjs': 'Running a command',
    'x=$(for i in 1; do case $i in a) Ada Lovelace;; esac; done) node x.mjs': 'Running a command',
    'x=$({ case $1 in a) Ada Lovelace;; esac; }) node x.mjs': 'Running a command',
    'x=$(! case $1 in a) Ada Lovelace;; esac) node x.mjs': 'Running a command',
    'x=$(case $1 in a) echo do esac;; b) Ada Lovelace;; esac) node x.mjs': 'Running a command',
    'x=$(case $1 in a) case $2 in b) x;; esac;; c) Ada Lovelace;; esac) node x.mjs': 'Running a command',
    'echo "$(cat <<"E\'OF"\nEOF\n)"; Ada paid\nE\'OF\n)"': 'Running a command',
    'echo "$(cat <<"E\\$OF"\nE\\$OF\n)"; Ada paid\nE$OF\n)"': 'Running a command',
    'echo "$(case $1 in a) echo $(printf x) esac;; b) echo "Receipt; Ada paid";; esac)"': 'Running a command',
    'echo "$(cat <<$\'EOF\'\n$EOF\n)"; Ada paid\nEOF\n)"': 'Running a command',
    'echo "$(cat <<$\'E\\x4fF\'\nE\\x4fF\n)"; Ada paid\nEOF\n)"': 'Running a command',
    'echo "$(cat <<$\'EO\\t\'\nEOt\n)"; Ada paid\nEO\t\n)"': 'Running a command',
    'echo "$(cat <<$\'EO\\q\'\nEOq\n)"; Ada paid\nEO\\q\n)"': 'Running a command',
    'echo "$(cat <<$\'EO\\400\'\nEOĀ\n)"; Ada paid\nEO\n)"': 'Running a command',
  };
  for (const [command, kind] of Object.entries(kinds)) assert.equal(commandKind(command), kind, command);
});

test('a quoted customer-looking word never shows, whether it stands as the program, the subcommand or the script', () => {
  const quoted = ['"Ada Lovelace"', "'Ada Lovelace'", "$'Ada'", '\\Ada', '"$Ada"', '`Ada`', '$(Ada)'];
  for (const q of quoted) {
    for (const command of [
      `${q} pays`,
      `cd /repo && ${q} pays`,
      `hq ${q} 12`,
      `git ${q}`,
      `npm run ${q}`,
      `node ${q}.mjs`,
      `python3 scripts/${q}.py`,
      `bash -lc 'hq ${q} 12'`,
      `bash -lc 'node ${q}.mjs'`,
      `bash -lc "git ${q}"`,
    ]) {
      const kind = commandKind(command);
      assert.doesNotMatch(kind, /Ada|Lovelace/, command);
      assert.match(kind, /^Running (a command|hq|git|npm run|node|python3)$/, command);
    }
  }
});
