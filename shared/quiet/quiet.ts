// A background ask of HQ that keeps failing. HQ out of reach for a minute or two is no fault (a deploy restarts it with
// the products, and the ask comes again soon), so a failure goes to stdout, in words HQ's error scan doesn't read as a
// warning (infra/log_errors.py's BAD: "no answer", "failed"...). Asks still failing afterMs after the first one go to
// stderr, once each afterMs while they go on; one HQ answers starts the count again.
export function unanswered(afterMs: number) {
  let since = 0,
    told = 0;
  return {
    answered: () => {
      since = 0;
    },
    // loud: the stderr line, given the minutes the asks have gone unanswered (the quiet text when left out)
    failed(quiet: string, loud: (minutes: number) => string = () => quiet, now = Date.now()) {
      since ||= now;
      const fault = now - since >= afterMs && now - told >= afterMs;
      if (fault) {
        told = now;
        console.error(loud(Math.round((now - since) / 60_000)));
      } else {
        console.log(quiet);
      }
    },
  };
}
