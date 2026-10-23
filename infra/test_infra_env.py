#!/usr/bin/env python3
"""python3 infra/test_infra_env.py: company/infra.env is data, never shell (infra/infra-env.sh, infra/company.py).

Several infra scripts run as root on the server and read the company's names from company/infra.env, which a pull
request with an ordinary review can change. Checks that a line is taken only as a plain KEY=value: a $( ), backticks, a
; or a quote is skipped and named, and never runs; only the names the scripts use become variables (no PATH, BASH_ENV,
LD_PRELOAD or REPO from it); the company's real file and the template read whole; and no script sources the file itself.
"""
import glob, os, re, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
failed = 0

def check(name, ok):
    global failed
    print(('ok   ' if ok else 'FAIL ') + name)
    failed += not ok

tmp = tempfile.mkdtemp(prefix='infra-env-test-')
marker = lambda n: os.path.join(tmp, f'ran-{n}')
hostile = f"""# a comment
SERVER_NAME=testco
SEATS=claude-1:claude,codex-1:codex
BACKUP_LEFT_OUT=secrets/PARCEL_*
AGENTS_EMAIL=agents@example.test
SERVER=$(touch {marker(1)})
AGENT_EMAIL_DOMAIN=`touch {marker(2)}`
EMAIL_SERVICE=x;touch {marker(3)}
PAYMENT_METHODS="$(touch {marker(4)})"
CARE_COOKIES=a b
PATH=/tmp/evil
BASH_ENV=/tmp/evil.sh
LD_PRELOAD=/tmp/evil.so
REPO=attacker/repo
 SEAT_MOVES=x:y
BACKUP_BUCKET=ok-bucket\r
"""
env_file = os.path.join(tmp, 'infra.env')
open(env_file, 'w').write(hostile)

def shell(script):
    return subprocess.run(['bash', '-c', f'. "{here}/infra-env.sh"; {script}'], env={'PATH': '/usr/bin:/bin', 'INFRA_ENV': env_file},
                          capture_output=True, text=True)

r = shell('printf "%s|" "$SERVER_NAME" "$SEATS" "$BACKUP_LEFT_OUT" "$AGENTS_EMAIL" "$BACKUP_BUCKET" "${SERVER-unset}" '
          '"${AGENT_EMAIL_DOMAIN-unset}" "${EMAIL_SERVICE-unset}" "${PAYMENT_METHODS-unset}" "${CARE_COOKIES-unset}" '
          '"${SEAT_MOVES-unset}" "$PATH" "${BASH_ENV-unset}" "${LD_PRELOAD-unset}" "${REPO-unset}"; env | grep -c "^SEATS="')
got = r.stdout.split('|')
check('plain lines are read, exported (and a CRLF line end is dropped)',
      got[:5] == ['testco', 'claude-1:claude,codex-1:codex', 'secrets/PARCEL_*', 'agents@example.test', 'ok-bucket'] and got[-1].strip() == '1')
check('$( ), backticks, ;, quotes and spaces: none of them ran', not any(os.path.exists(marker(n)) for n in range(1, 5)))
check('... and their keys stay unset', got[5:11] == ['unset'] * 6)
check('PATH, BASH_ENV, LD_PRELOAD, REPO: never taken from it', got[11] == '/usr/bin:/bin' and got[12:15] == ['unset'] * 3)
check('each skipped line is named on stderr', all(f'line {n} skipped' in r.stderr for n in (6, 7, 8, 9, 10, 15))
      and all(f'{k} isn\'t one' in r.stderr for k in ('PATH', 'BASH_ENV', 'LD_PRELOAD', 'REPO')))
check("the reader's own variables don't linger", shell('echo "${infra_env_line-x}${infra_env_n-x}${infra_env_file-x}"').stdout.strip() == 'xxx')

sys.path.insert(0, here)
os.environ['INFRA_ENV'] = env_file
import company
data = company.read(env_file)
check('company.py takes the same plain lines and skips the rest',
      data.get('SERVER_NAME') == 'testco' and data.get('BACKUP_BUCKET') == 'ok-bucket' and 'SERVER' not in data
      and 'EMAIL_SERVICE' not in data and 'CARE_COOKIES' not in data and not any(os.path.exists(marker(n)) for n in range(1, 5)))

# a name that becomes a folder is one plain name, ? is a value's, and what was
# skipped is named for the scripts that fail closed on it (sync.sh's SEATS, backup.py's BACKUP_LEFT_OUT)
names = os.path.join(tmp, 'names.env')
open(names, 'w').write('SERVER_NAME=../../../../etc/cron.d/pwn\nSERVER=Big_Server\nBACKUP_BUCKET=b.u\nBACKUP_LEFT_OUT=secrets/K_?\n'
                       'SEATS=claude-1:claude codex-1:codex\nSEAT_MOVES=a:b\n')
r = subprocess.run(['bash', '-c', f'. "{here}/infra-env.sh"; printf "%s|" "${{SERVER_NAME-unset}}" "${{SERVER-unset}}" '
                    '"${BACKUP_BUCKET-unset}" "$BACKUP_LEFT_OUT" "${SEATS-unset}" "$INFRA_ENV_SKIPPED"'],
                   env={'PATH': '/usr/bin:/bin', 'INFRA_ENV': names}, capture_output=True, text=True)
got = r.stdout.split('|')
check('SERVER_NAME, SERVER, BACKUP_BUCKET: a path, capitals or a dot are skipped', got[:3] == ['unset'] * 3
      and all(f'line {n} skipped: ' in r.stderr for n in (1, 2, 3)))
check('a ? in a value is taken', got[3] == 'secrets/K_?')
check('skipped keys are named in INFRA_ENV_SKIPPED, taken ones are not', got[4] == 'unset'
      and set(got[5].split()) == {'SERVER_NAME', 'SERVER', 'BACKUP_BUCKET', 'SEATS'})
company.SKIPPED.clear()
data = company.read(names)
check('company.py: the same', data == {'BACKUP_LEFT_OUT': 'secrets/K_?', 'SEAT_MOVES': 'a:b'}
      and company.SKIPPED == {'SERVER_NAME', 'SERVER', 'BACKUP_BUCKET', 'SEATS'})
company.SKIPPED.clear()

for path in (os.path.join(root, 'company', 'infra.env'), os.path.join(root, 'template', 'company', 'infra.env')):
    if not os.path.exists(path):
        continue
    r = subprocess.run(['bash', '-c', f'. "{here}/infra-env.sh"; echo "$SERVER_NAME"'], env={'PATH': '/usr/bin:/bin', 'INFRA_ENV': path},
                       capture_output=True, text=True)
    lines = [l for l in open(path).read().splitlines() if l and not l.startswith('#')]
    check(f'{os.path.relpath(path, root)} reads whole', r.stdout.strip() and not r.stderr and len(company.read(path)) == len(lines))

# every script that reads the file goes through the reader (workflows run on GitHub, not the server: see the audit note)
sourcing = [p for p in glob.glob(os.path.join(here, '*.sh')) if re.search(r'^\s*(set -a;\s*)?\.\s+\S*company/infra\.env', open(p).read(), re.M)]
check('no script in infra/ sources company/infra.env itself', not sourcing)

sys.exit(1 if failed else 0)
