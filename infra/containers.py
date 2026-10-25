#!/usr/bin/env python3
"""The stack's containers for HQ's crash watch (the coordinator's crashes.ts): each one's service, state and restart
count, written to containers.json in the coordinator's volume every minute (sync.sh). No logs, no environment."""
import datetime, json, os, subprocess, sys
from backup import into_volume, open_dir

PROJECT = 'infra'   # compose.yaml's folder: its containers are infra-<service>-<n>, its volumes infra_<name>


def containers():
    ids = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={PROJECT}'],
                         capture_output=True, text=True, timeout=30, check=True).stdout.split()
    if not ids:
        return []
    found = json.loads(subprocess.run(['docker', 'inspect', *ids], capture_output=True, text=True, timeout=30,
                                      check=True).stdout)
    return [{'service': c['Config']['Labels'].get('com.docker.compose.service', c['Name'].lstrip('/')),
             'state': c['State']['Status'], 'restarts': c['RestartCount']} for c in found]


def main(argv):
    if len(argv) != 2:
        sys.exit("usage: containers.py <the coordinator's volume>")
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    text = json.dumps({'at': at, 'containers': containers()})
    fd = open_dir(argv[1])
    try:
        into_volume(text.encode(), fd, 'containers.json')
    finally:
        os.close(fd)


if __name__ == '__main__':
    main(sys.argv)
