// TAP with a structured mark for each file's start and end for the push's report, the end with the file's time, its
// tests passed and its failures. A run stopped at a time limit still says which files had ended, how they went, and
// which were still running since when. The marks come from the events as the files run (dequeue and complete), in the
// order things happen: TAP, and node:test's pass, fail, summary and stderr events, follow the files' order, so a file
// that ended behind a slow one would be heard of only after it. They go out as they come, not with TAP's next line.
//
import { resolve } from 'node:path';
import { tap, type TestEvent } from 'node:test/reporters';

// A file's end mark, as tests.ts reads it: a failure's tests from the outermost (none for the file's own failure)
export type FileEnd = { file: string; seconds: number; passed: number; failures: FileFailure[] };
export type FileFailure = { test: string[]; message: string };
// (file: where a test is declared, which can be a module the test file imports; entryFile: the test file it runs in,
// on every test but the file's own)
type TestData = { nesting: number; name: string; file?: string; entryFile?: string; line?: number; column?: number };
type Completed = Extract<TestEvent, { type: 'test:complete' }>['data'] & TestData;
// node:test's error for a failed test (ERR_TEST_FAILURE): the thrown error's message, or a file's own exit
type TestFailure = Error & { failureType: string; exitCode?: number | null; signal?: string | null };
type FileProgress = { open: string[]; passed: number; failures: FileFailure[] }; // the tests open at each depth

export default async function* timings(source: AsyncIterable<TestEvent>) {
  const lines: string[] = [];
  let wake = () => {};
  let ended = false;
  const put = (line: string) => {
    lines.push(line);
    wake();
  };
  // By path, from each file's start, which comes before any of its tests' events (each names the file it runs in, ownerOf)
  const files = new Map<string, FileProgress>();
  async function* events() {
    for await (const event of source) {
      if (event.type === 'test:dequeue') started(event.data);
      if (event.type === 'test:complete') completed(event.data);
      yield event;
    }
  }
  const started = (testEvent: TestData) => {
    if (!isFile(testEvent))
      return void files.get(ownerOf(testEvent))!.open.splice(testEvent.nesting, Infinity, testEvent.name);
    files.set(testEvent.file!, { open: [], passed: 0, failures: [] });
    put(`# file-start ${JSON.stringify({ file: testEvent.file, at: Date.now() })}\n`);
  };
  const completed = (testEvent: Completed) => {
    const progress = files.get(ownerOf(testEvent))!;
    const own = isFile(testEvent);
    const { details } = testEvent;
    if (details.passed) {
      if (!own && details.type === 'test' && !testEvent.skip && !testEvent.todo) progress.passed++;
    } else if (!testEvent.todo) failed(progress, testEvent, own);
    if (!own) return;
    const { passed, failures } = progress;
    const end: FileEnd = { file: testEvent.file!, seconds: details.duration_ms / 1000, passed, failures };
    put(`# file-end ${JSON.stringify(end)}\n`);
  };
  const formatted = (async () => {
    for await (const line of tap(events())) put(line);
  })().finally(() => {
    ended = true;
    wake();
  });
  for (;;) {
    while (lines.length) yield lines.shift()!;
    if (ended) break;
    await new Promise<void>(resolve => (wake = resolve));
  }
  await formatted;
}

// A failed test or file. One that failed only because its subtests did is left out: they say it. A file's own failure
// (it didn't load, or exited non-zero after its tests) says how it ended: its stderr comes in the files' order.
function failed(progress: FileProgress, testEvent: Completed, own: boolean) {
  const error = testEvent.details.error as TestFailure;
  if (error.failureType === 'subtestsFailed') return;
  if (own) {
    const ending = error.signal ? `signal ${error.signal}` : `exit code ${error.exitCode}`;
    return void progress.failures.push({ test: [], message: `${error.message} (${ending})` });
  }
  progress.failures.push({
    test: [...progress.open.slice(0, testEvent.nesting), testEvent.name],
    message: error.message,
  });
}

// The test file a test runs in: its own path for the file's own test, else its entryFile
function ownerOf(testEvent: TestData) {
  return isFile(testEvent) ? testEvent.file! : testEvent.entryFile!;
}

// A file's own test: named by the file's path as given (from the run's folder), at its start
function isFile(testEvent: TestData) {
  return (
    testEvent.nesting === 0 &&
    testEvent.line === 1 &&
    testEvent.column === 1 &&
    testEvent.file === resolve(testEvent.name)
  );
}
