"""Every function in the Python source on stdin, as JSON for the size limits (sizes.ts): its name (Class.method,
outer.inner), the line of its def, the first line of its decorators and its last line. Source Python can't parse exits
with UNREADABLE and its error alone, so the gates can tell it from this script's own failures.
"""
import ast
import json
import sys

UNREADABLE = 3


def spans(node, prefix, found):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = prefix + child.name
            if not isinstance(child, ast.ClassDef):
                first = min([d.lineno for d in child.decorator_list] + [child.lineno])
                found.append({'name': name, 'line': child.lineno, 'first': first, 'end': child.end_lineno})
            spans(child, name + '.', found)
        else:
            spans(child, prefix, found)
    return found


try:
    tree = ast.parse(sys.stdin.read())
except SyntaxError as err:
    print(f'{type(err).__name__}: {err}', file=sys.stderr)
    sys.exit(UNREADABLE)
print(json.dumps(spans(tree, '', [])))
