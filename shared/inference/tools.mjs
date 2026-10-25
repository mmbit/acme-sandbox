// Mediate OpenCode tools through the candidate OS boundary.
import { spawn } from 'node:child_process';

const text = description => ({ type: 'string', description });
const filePath = text('File path in the candidate repository, relative to its root or absolute.');
const path = { ...text('Directory to search, relative to the candidate root. Defaults to .'), default: '.' };
const definitions = {
  read: {
    description:
      'Read a UTF-8 file with numbered lines. Use offset and limit to page. Defaults to 200 lines, at most 2000 lines. Follow nextOffset for more. Long lines are marked as truncated.',
    args: {
      filePath,
      offset: { type: 'integer', minimum: 1, default: 1, description: 'First line to read, counted from 1.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 2000,
        default: 200,
        description: 'Maximum lines to return. The response byte cap may return fewer.',
      },
    },
  },
  write: {
    description:
      'Create or overwrite a UTF-8 file in the candidate repository. Read existing files first. Prefer edit for a targeted replacement.',
    args: { filePath, content: text('Complete new file contents, without line-number prefixes.') },
  },
  edit: {
    description:
      'Replace an exact source string in a UTF-8 file. Read the relevant lines first. A unique match is required unless replaceAll is true.',
    args: {
      filePath,
      oldString: text('Exact nonempty text to replace, without read-tool line-number prefixes.'),
      newString: text('Replacement text. Use an empty string to delete the matched text.'),
      replaceAll: {
        type: 'boolean',
        default: false,
        description: 'Replace every occurrence instead of requiring one unique match.',
      },
    },
  },
  bash: {
    description:
      'Run one approved command from the candidate root as an argument vector. No shell, compound commands, pipes, redirects, substitutions or newlines. Use read, glob and grep for file inspection.',
    args: {
      command: text('One command matching an approved pattern. Quote arguments containing spaces.'),
      description: text('Short purpose of this command.'),
    },
  },
  glob: {
    description:
      'Find paths by a glob pattern. Returns at most 100 paths. Narrow pattern or path when results are marked truncated. Does not read file contents.',
    args: { pattern: text('Glob relative to path, such as **/*.mjs.'), path },
  },
  grep: {
    description:
      'Search UTF-8 text with a Python regular expression. Returns path:line:text, at most 100 matches. Skips .git, binary files and files over 1 MiB, with a notice. Narrow path or include when truncated.',
    args: {
      pattern: text('Python regular expression to find within each line.'),
      path,
      include: { ...text('File glob to search recursively, such as *.py. Defaults to *.'), default: '*' },
    },
  },
};

export default async function candidateTools() {
  const policy = JSON.parse(process.env.INFERENCE_TOOLS);
  const tools = Object.fromEntries(
    policy.tools.map(name => [
      `candidate_${name}`,
      {
        description:
          definitions[name].description +
          (['read', 'glob', 'grep'].includes(name) ? ` Output is capped at ${policy.outputBytes} bytes.` : '') +
          (name === 'bash' ? ` Approved commands: ${policy.commands.join(', ') || '(none)'}.` : ''),
        args: definitions[name].args,
        execute: arguments_ => execute(policy, name, arguments_),
      },
    ]),
  );
  return {
    tool: tools,
    'tool.execute.before': async ({ tool }) => {
      if (!Object.hasOwn(tools, tool)) throw new Error('Only confined candidate tools are enabled');
    },
  };
}

function execute(policy, tool, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(policy.python, [policy.worker, policy.file], {
      cwd: policy.directory,
      env: { PATH: policy.path, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    child.on('error', () => reject(new Error('Tool worker could not start')));
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.resume();
    child.on('close', code => {
      if (code !== 0) return reject(new Error('Tool worker failed before completing the request'));
      let response;
      try {
        response = JSON.parse(Buffer.concat(output).toString());
      } catch {
        return reject(new Error('Tool worker returned an invalid response'));
      }
      if (response.error) return reject(new Error(response.error));
      resolve(response);
    });
    child.stdin.on('error', () => reject(new Error('Tool worker could not receive the request')));
    child.stdin.end(JSON.stringify({ tool, arguments: arguments_ }));
  });
}
