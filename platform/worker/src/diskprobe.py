"""Run the allocated-byte scanner with only its owning slot's filesystem permissions."""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from disktree import DiskTree, described
from diskerror import AccountingError


def main():
    identities = json.loads(sys.argv[1])
    if os.getuid() == 0:
        os.setgroups([])
    os.setegid(identities["gid"])
    os.seteuid(identities["uid"])
    tree = None
    try:
        for request in sys.stdin:
            try:
                if tree is None:
                    tree = DiskTree(sys.argv[3:], int(sys.argv[2]))
                reply = {"bytes": tree.measure()}
            except Exception as failure:
                reason = failure.reason if isinstance(failure, AccountingError) else (
                    "worker-scanner" if isinstance(failure, sqlite3.Error) else "job-tree"
                )
                reply = {"error": {"reason": reason, "message": described(failure)}}
                if tree:
                    tree.close()
                tree = None
            print(json.dumps(reply), flush=True)
    finally:
        if tree:
            tree.close()


if __name__ == "__main__":
    main()
