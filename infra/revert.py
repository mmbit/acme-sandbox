#!/usr/bin/env python3
"""Reverts commits on main, in one commit pushed to GitHub, so a deploy that broke HQ doesn't come back with the next
merge. sync.sh runs it after going back to the last good deploy worked (the code since is what broke HQ: every
first-parent commit after that one, up to the one that failed), and for the CEO's revert requests (HQ's data folder,
reverts/: platform/coordinator/src/reverts.ts). Each reverted commit's work stays on its branch: once fixed, it comes
back by reverting its part of this commit.

python3 infra/revert.py <repo> <why> --since <last good> <failed>
python3 infra/revert.py <repo> <why> <commit>...
  prints the revert's commit, or why there is none (exit 1): a commit main doesn't have, or one whose revert conflicts
  with what came since (then nothing is pushed: the CEO hears of it)
python3 infra/revert.py --requests <folder> <repo>
  each request in the folder (<id>.json: {"why": ..., "commits": [...]}, from HQ), made, and its answer written beside
  it as <id>.done ({"ok": ..., "said": the revert's commit or why not}) for HQ to read and remove
"""
import json, os, re, subprocess, sys, tempfile

TRIES = 3  # main moving on meanwhile: the revert is made again on the new main
IDENTITY = {'GIT_AUTHOR_NAME': 'HQ', 'GIT_AUTHOR_EMAIL': 'hq@noreply.invalid', 'GIT_COMMITTER_NAME': 'HQ',
            'GIT_COMMITTER_EMAIL': 'hq@noreply.invalid'}


class Refused(Exception):
    pass


def git(repo, *args, check=True):
    done = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, env={**os.environ, **IDENTITY})
    if check and done.returncode:
        said = (done.stderr or done.stdout).strip().splitlines()
        raise Refused(f"git {args[0]}: {said[-1] if said else 'failed'}")
    return done


def commits(repo, since, failed):
    return git(repo, 'rev-list', '--first-parent', f'{since}..{failed}').stdout.split()


def revert(repo, why, shas):
    """The revert's commit on GitHub's main, newest commit reverted first"""
    if not shas:
        raise Refused('nothing to revert')
    for attempt in range(TRIES):
        git(repo, 'fetch', '-q', 'origin', 'main')
        for sha in shas:
            if git(repo, 'merge-base', '--is-ancestor', sha, 'origin/main', check=False).returncode:
                raise Refused(f"main doesn't have {sha[:9]}")
        with tempfile.TemporaryDirectory() as tree:
            git(repo, 'worktree', 'add', '-q', '--detach', tree, 'origin/main')
            try:
                lines = []
                for sha in shas:
                    merge = len(git(tree, 'rev-list', '--parents', '-n1', sha).stdout.split()) > 2
                    if git(tree, 'revert', '--no-commit', *(['-m', '1'] if merge else []), sha, check=False).returncode:
                        raise Refused(f"{sha[:9]}'s revert conflicts with what main has since")
                    lines.append(f"- {git(tree, 'log', '-1', '--format=%h %s', sha).stdout.strip()}")
                n = len(shas)
                message = (f"Revert {n} commit{'s' if n > 1 else ''} on main: {why}\n\n"
                           "HQ reverted these so the next merge doesn't bring them back. Their work stays on their "
                           "branches: once fixed, it\ncomes back by reverting its part of this commit.\n\n"
                           + '\n'.join(lines) + '\n')
                git(tree, 'commit', '-q', '--allow-empty', '-m', message)
                if not git(tree, 'push', '-q', 'origin', 'HEAD:main', check=False).returncode:
                    return git(tree, 'rev-parse', 'HEAD').stdout.strip()
            finally:
                git(tree, 'revert', '--quit', check=False)
                git(repo, 'worktree', 'remove', '--force', tree, check=False)
    raise Refused(f'main kept moving: not pushed in {TRIES} tries')


def requests(folder, repo):
    for name in sorted(n for n in os.listdir(folder) if n.endswith('.json')):
        request, done = os.path.join(folder, name), os.path.join(folder, name[:-5] + '.done')
        if os.path.exists(done):
            continue
        try:
            with open(request) as f:
                asked = json.load(f)
            if not asked['commits'] or not all(re.fullmatch(r'[0-9a-f]{7,40}', str(c)) for c in asked['commits']):
                raise Refused('a request names commits by their ids')
            shas = [git(repo, 'rev-parse', '--verify', f"{c}^{{commit}}").stdout.strip() for c in asked['commits']]
            answer = {'ok': True, 'said': revert(repo, str(asked['why'])[:200], shas)}
        except (Refused, ValueError, KeyError, TypeError) as why:
            answer = {'ok': False, 'said': str(why)}
        # (written whole, and the data folder's owner's, as HQ removes it: deploys.py's records)
        part = done + '.part'
        with open(part, 'w') as f:
            json.dump(answer, f)
        data = os.stat(folder)
        os.chown(part, data.st_uid, data.st_gid)
        os.replace(part, done)
        print(f"revert request {name}: {answer['said']}")


def main(argv):
    if len(argv) == 4 and argv[1] == '--requests':
        return requests(argv[2], argv[3])
    if len(argv) < 4:
        sys.exit(__doc__)
    repo, why, *rest = argv[1:]
    try:
        shas = commits(repo, rest[1], rest[2]) if rest[0] == '--since' and len(rest) == 3 else rest
        print(revert(repo, why, [git(repo, 'rev-parse', s).stdout.strip() for s in shas]))
    except Refused as why:
        print(why)
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv)
