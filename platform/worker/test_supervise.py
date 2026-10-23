#!/usr/bin/env python3
"""python3 platform/worker/test_supervise.py: runs supervise.py over a stand-in worker (a shell script in a throwaway
code folder, run by /bin/sh), with real processes and signals; no Docker.

Checks that a reload (SIGUSR2) starts the worker again from the code staged now while the run it launched goes on, that
the run's exit code reaches its marker once its worker has gone, that a worker that crashes starts again, and that a
stop (SIGTERM) reaches the worker and ends the supervisor with it.
"""
import os, signal, subprocess, sys, tempfile, time, unittest

here = os.path.dirname(os.path.abspath(__file__))

# The stand-in worker: it notes its pid and code, launches a "run" the first time (a CLI that ends with exit 7 once
# told to, and its marker, as detached.ts makes one), leaves on SIGUSR2 without stopping it, stops it on SIGTERM.
WORKER = r'''
echo "$$ $CODE_NAME" >> "$T/workers"
if [ ! -f "$T/launched" ]; then
  touch "$T/launched"
  sh -c 'while [ ! -f "$T/go" ]; do sleep 0.05; done; exit 7' &
  run=$!
  start=$(cut -d')' -f2 /proc/$run/stat | cut -d' ' -f21)
  : > "$RUNS/pid-$run-$start"
  echo "$run $start" > "$T/run"
fi
trap 'exit 0' USR2
trap 'echo stopped >> "$T/workers"; [ -f "$T/run" ] && kill $(cut -d" " -f1 "$T/run"); exit 5' TERM
while :; do
  [ -f "$T/crash" ] && { rm "$T/crash"; exit 3; }
  sleep 0.05
done
'''


def read(path):
    with open(path) as f:
        return f.read()


def wait_for(cond, what, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return
        time.sleep(0.05)
    raise AssertionError(f'timed out waiting for {what}')


class Supervise(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix='supervise-test-')
        self.code, self.runs = f'{self.t}/code', f'{self.t}/runs'
        os.makedirs(self.runs)
        for v in ('v1', 'v2'):
            os.makedirs(f'{self.code}/{v}/src')
            with open(f'{self.code}/{v}/src/worker.ts', 'w') as f:
                f.write(f'CODE_NAME={v}\n{WORKER}')
        os.symlink('v1', f'{self.code}/current')
        env = {**os.environ, 'WORKER_CODE': self.code, 'WORKER_RUNS': self.runs, 'WORKER_NODE': '/bin/sh',
               'WORKER_RESTART_S': '0.2', 'T': self.t, 'RUNS': self.runs}
        self.sup = subprocess.Popen([sys.executable, f'{here}/supervise.py'], env=env, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop)

    def stop(self):
        if self.sup.poll() is None:
            self.sup.terminate()   # (the stand-in worker stops its run)
            self.sup.wait()
        self.sup.stderr.close()
        open(f'{self.t}/go', 'w').close()   # (a run left behind ends)

    def workers(self):
        try:
            return [l.split() for l in read(f'{self.t}/workers').splitlines()]
        except FileNotFoundError:
            return []

    def run_alive(self):
        pid, start = read(f'{self.t}/run').split()
        try:
            stat = read(f'/proc/{pid}/stat')
        except FileNotFoundError:
            return False
        return stat.rsplit(')', 1)[1].split()[19] == start and stat.rsplit(')', 1)[1].split()[0] != 'Z'

    def test_reload_keeps_the_run_and_its_exit_code(self):
        wait_for(lambda: os.path.exists(f'{self.t}/run'), 'the first worker and its run')
        self.assertEqual(os.readlink(f'{self.code}/running'), 'v1')
        # a deploy stages new code, then asks for a reload
        os.symlink('v2', f'{self.code}/current.new')
        os.replace(f'{self.code}/current.new', f'{self.code}/current')
        self.sup.send_signal(signal.SIGUSR2)
        wait_for(lambda: len(self.workers()) == 2, 'the worker started again')
        self.assertEqual(self.workers()[1][1], 'v2')
        self.assertNotEqual(self.workers()[0][0], self.workers()[1][0])
        self.assertEqual(os.readlink(f'{self.code}/running'), 'v2')
        self.assertTrue(self.run_alive(), 'the run goes on through the reload')
        pid, start = read(f'{self.t}/run').split()
        self.assertEqual(read(f'{self.runs}/pid-{pid}-{start}'), '')
        # its worker has gone: the supervisor reaps it and notes how it ended
        open(f'{self.t}/go', 'w').close()
        wait_for(lambda: read(f'{self.runs}/pid-{pid}-{start}') == 'exit 7', 'the run\'s exit code in its marker')
        self.assertIsNone(self.sup.poll())

    def test_a_crashed_worker_starts_again_and_a_stop_ends_it(self):
        wait_for(lambda: os.path.exists(f'{self.t}/run'), 'the first worker and its run')
        open(f'{self.t}/crash', 'w').close()
        wait_for(lambda: len(self.workers()) == 2, 'the worker started again after its crash')
        self.assertTrue(self.run_alive(), 'the run goes on through the crash')
        self.sup.send_signal(signal.SIGTERM)
        self.assertEqual(self.sup.wait(timeout=10), 5)   # (the worker's own exit code)
        self.assertEqual(self.workers()[-1], ['stopped'])
        wait_for(lambda: not self.run_alive(), 'the run stopped by its worker')
        self.assertIn('worker exited (3)', self.sup.stderr.read())

    def test_no_code_yet_waits_for_it(self):
        self.sup.terminate()
        self.sup.wait()
        self.sup.stderr.close()
        os.remove(f'{self.code}/current')
        env = {**os.environ, 'WORKER_CODE': self.code, 'WORKER_RUNS': self.runs, 'WORKER_NODE': '/bin/sh', 'T': self.t, 'RUNS': self.runs}
        self.sup = subprocess.Popen([sys.executable, f'{here}/supervise.py'], env=env, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        self.assertEqual(self.workers(), [])
        os.symlink('v2', f'{self.code}/current')
        self.sup.send_signal(signal.SIGUSR2)   # (sync.sh asks for a reload once it has staged code)
        wait_for(lambda: len(self.workers()) == 1, 'the worker, once there is code')
        self.assertEqual(self.workers()[0][1], 'v2')


if __name__ == '__main__':
    unittest.main()
