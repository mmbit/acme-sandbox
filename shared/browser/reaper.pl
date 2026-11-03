# The render's parent and child subreaper: collects Chromium's orphans, passes a stop on, ends with the render's status.
# (Node can't wait for a process it adopted.)
use strict;
use warnings;
use POSIX ':sys_wait_h';

syscall(157, 36, 1, 0, 0, 0) == 0 or die "reaper: subreaper: $!";    # prctl(PR_SET_CHILD_SUBREAPER, 1)
my $render = 0;
$SIG{TERM} = sub { kill 'TERM', $render if $render };
$SIG{INT}  = sub { kill 'INT',  $render if $render };
$render = fork // die "reaper: fork: $!";
if (!$render) { exec @ARGV or die "reaper: exec $ARGV[0]: $!" }
for (;;) {
  my $pid = waitpid(-1, 0);
  die "reaper: wait: $!" if $pid == -1;
  last if $pid == $render;
}
my $status = $?;
1 while waitpid(-1, WNOHANG) > 0;
exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
