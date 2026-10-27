"""Every function in the Python source on stdin, as JSON for the size limits (sizes.ts): its name (Class.method,
outer.inner), the line of its def, the first line of its decorators and its last line."""
import ast
import json
import sys


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


print(json.dumps(spans(ast.parse(sys.stdin.read()), '', [])))
