// Extracts literal executable commands from a Bash AST.
import { createRequire } from 'node:module';
import { Parser, Language, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const parse: (command: string) => any = require('bash-parser');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));

export type SyntaxReason =
  'shellParse' | 'shellConditional' | 'shellCompound' | 'shellAssignment' | 'shellRedirect' | 'shellDynamic';
type Literal = { words: string[] } | { reason: SyntaxReason };

export function literalCommands(command: string): Literal[] {
  const tree = parser.parse(command)!;
  try {
    if (hasHeredoc(tree.rootNode)) {
      if (tree.rootNode.hasError) return [{ reason: 'shellParse' }];
      return tree.rootNode.namedChildren.flatMap((statement: Node) =>
        hasHeredoc(statement) ? [{ reason: 'shellRedirect' } as Literal] : literalCommands(statement.text),
      );
    }
    return parsedCommands(command);
  } finally {
    tree.delete();
  }
}

const hasHeredoc = (node: Node) =>
  node.type === 'heredoc_redirect' || node.descendantsOfType('heredoc_redirect').length > 0;

function parsedCommands(command: string): Literal[] {
  let script;
  try {
    script = parse(command);
  } catch {
    // Invalid or unsupported model-authored shell syntax is counted as unknown, without retaining parser errors.
    return [{ reason: 'shellParse' }];
  }
  return commandWords(script);
}

function commandWords(node: any): Literal[] {
  if (node.type === 'Script' || node.type === 'Pipeline') return node.commands.flatMap(commandWords);
  if (node.type === 'LogicalExpression') return [{ reason: 'shellConditional' }];
  if (node.type !== 'Command') return [{ reason: 'shellCompound' }];
  if (node.prefix?.some((word: any) => word.type === 'AssignmentWord')) return [{ reason: 'shellAssignment' }];
  if ([...(node.prefix ?? []), ...(node.suffix ?? [])].some((word: any) => word.type === 'Redirect'))
    return [{ reason: 'shellRedirect' }];
  const words = [node.name, ...(node.suffix ?? [])];
  if (node.prefix?.length || words.some(word => !word || word.type !== 'Word' || word.expansion?.length))
    return [{ reason: 'shellDynamic' }];
  return [{ words: words.map(word => word.text) }];
}
