"""What the sync.sh tests share: git in a throwaway repository, and lines lifted from sync.sh by pattern.
"""
import os, subprocess

here = os.path.dirname(os.path.abspath(__file__))
GIT_IDENTITY = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t.test', 'GIT_COMMITTER_NAME': 't',
                'GIT_COMMITTER_EMAIL': 't@t.test'}


def git(root, *args):
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True,
                          env={**os.environ, **GIT_IDENTITY}).stdout


def sync_lines(pattern, what):
    """The match of `pattern` in sync.sh; `what` names the lines when they are missing."""
    with open(os.path.join(here, 'sync.sh')) as f:
        found = pattern.search(f.read())
    assert found, f'sync.sh: {what} were not found'
    return found
