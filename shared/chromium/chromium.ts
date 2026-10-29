// Headless Chromium over its DevTools pipe, with nothing reaching outside: every request a page makes is paused and
// answered by its owner, or refused. A print render starts one for each file; the watch-along's mirrors keep one
// running. (shared/browser is the harnesses' Playwright, not this.).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

// (read as each starts: a test sets it after the import)
const chromiumPath = () => process.env.CHROMIUM_PATH ?? 'chromium';
// Playwright's switches less a test runner's, sRGB colours whatever the machine, and no route out: a request Fetch
// doesn't pause (a WebSocket, WebRTC) meets a proxy that isn't there
const SWITCHES = [
  '--headless',
  '--remote-debugging-pipe',
  // (Chromium's own sandbox needs user namespaces a container doesn't give it. The boundary is the page instead: its
  // owner runs no script it didn't write (a print page is ours, a replay keeps the recorded page's from running), it
  // reaches nothing (Fetch and the proxy), and Chromium runs as the app's own user, in its container, without its keys)
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-breakpad',
  '--disable-features=HttpsUpgrades,Translate,OptimizationHints,MediaRouter',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--password-store=basic',
  '--proxy-server=127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

export class ChromiumError extends Error {}

// A request a page made, and how it's answered: a body with its type, or null to refuse it
export type Asked = { url: string; method: string };
export type Answer = { type: string; body: Buffer } | null;
export type Listener = (method: string, params: any) => void;

export type Tab = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
};

export type Browser = {
  // A new tab whose every request goes to answer(), and its other events to listen()
  tab: (answer: (asked: Asked) => Promise<Answer>, listen?: Listener) => Promise<Tab>;
  close: () => Promise<void>;
  closed: Promise<void>;
  // Settles once the browser's own process replies, whatever its tabs' pages are doing.
  replied: () => Promise<void>;
  pid?: number;
};

// Chromium, started and answering. An abort before then stops it.
export async function launch(abort?: AbortSignal): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'chromium-'));
  // only PATH, HOME and TMPDIR: the server's keys never reach the browser. TMPDIR is the profile too, as Chromium's
  // lock socket otherwise goes in /tmp, read-only on a lent machine. It's given relative to the profile, its working
  // folder: a socket's path holds 107 bytes at most, and Chromium stops at once on a longer one, which a long temp
  // folder makes (a push's tests).
  const chromium = spawn(chromiumPath(), [...SWITCHES, `--user-data-dir=${profile}`, 'about:blank'], {
    cwd: profile,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: profile, TMPDIR: '.' },
  });
  const devtools = connect(chromium);
  const closed = new Promise<void>(resolve =>
    chromium.once('exit', () => {
      rmSync(profile, { recursive: true, force: true });
      resolve();
    }),
  );
  const stop = () => chromium.kill('SIGKILL');
  abort?.addEventListener('abort', stop, { once: true });
  try {
    await Promise.race([devtools.send(undefined, 'Browser.getVersion'), devtools.failed]);
  } catch (err) {
    stop();
    // (one that never started has no exit to remove its profile)
    if (chromium.pid === undefined) rmSync(profile, { recursive: true, force: true });
    throw err;
  } finally {
    abort?.removeEventListener('abort', stop);
  }

  const tab = tabOpener(devtools);
  const close = async () => {
    if (chromium.exitCode !== null || chromium.signalCode !== null) return closed;
    devtools.send(undefined, 'Browser.close').catch(() => undefined); // (it may exit before it answers)
    const killed = setTimeout(stop, 5_000);
    await closed;
    clearTimeout(killed);
  };
  const replied = async () => void (await devtools.send(undefined, 'Browser.getVersion'));
  return { tab, close, closed, replied, pid: chromium.pid };
}

// Browser.tab(): a new tab over this connection, in a window of its own: tabs sharing a window are hidden behind the
// newest, and a hidden tab never paints, so anything waiting on its next frame waits for good (a live mirror behind
// another)
function tabOpener(devtools: DevTools) {
  return async (answer: (asked: Asked) => Promise<Answer>, listen?: Listener): Promise<Tab> => {
    const { targetId } = await devtools.send(undefined, 'Target.createTarget', { url: 'about:blank', newWindow: true });
    const { sessionId } = await devtools.send(undefined, 'Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: Record<string, unknown> = {}) => devtools.send(sessionId, method, params);
    devtools.listen(sessionId, (method, params) => {
      if (method === 'Fetch.requestPaused') void answered(send, answer, params);
      else listen?.(method, params);
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    return {
      send,
      close: async () => {
        devtools.forget(sessionId);
        await devtools.send(undefined, 'Target.closeTarget', { targetId }).catch(() => undefined);
      },
    };
  };
}

async function answered(send: Tab['send'], answer: (asked: Asked) => Promise<Answer>, paused: any) {
  const { requestId, request } = paused;
  const given = await answer({ url: String(request.url), method: String(request.method) }).catch(() => null);
  const reply = given
    ? send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        // (a font or stylesheet asked for from another origin is dropped without the CORS header, and every answer is
        // one the tab's owner chose to give)
        responseHeaders: [
          { name: 'content-type', value: given.type },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: given.body.toString('base64'),
      })
    : send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  await reply.catch(() => undefined); // (the tab may have closed meanwhile)
}

type DevTools = ReturnType<typeof connect>;

// ---- the DevTools protocol over the pipe Chromium opens on fds 3 (to it) and 4 (from it), each message ending in \0
function connect(chromium: ChildProcess) {
  const toChromium = chromium.stdio[3] as Writable;
  const fromChromium = chromium.stdio[4] as Readable;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  const listeners = new Map<string, Listener>();
  let nextId = 1,
    stderr = '',
    fail: (err: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => undefined);

  chromium.stderr!.on('data', chunk => (stderr = (stderr + chunk).slice(-2000)));
  chromium.on('error', err => fail(new ChromiumError(`Could not start Chromium (${chromiumPath()}): ${err.message}`)));
  chromium.on('exit', code => {
    const lastLine = stderr.trim().split('\n').pop() ?? '';
    const why = new ChromiumError(`Chromium stopped (exit ${code})${lastLine ? `: ${lastLine}` : ''}`);
    fail(why);
    for (const call of waiting.values()) call.reject(why);
    waiting.clear();
  });
  toChromium.on('error', () => undefined); // (the exit handler says why)

  messages(fromChromium, message => {
    if (message.id === undefined) return listeners.get(message.sessionId)?.(message.method, message.params);
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) call?.reject(new ChromiumError(`Chromium refused: ${message.error.message}`));
    else call?.resolve(message.result);
  });

  const send = (sessionId: string | undefined, method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      if (chromium.exitCode !== null) return reject(new ChromiumError('Chromium has stopped'));
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      toChromium.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  return {
    send,
    failed,
    listen: (sessionId: string, listen: Listener) => listeners.set(sessionId, listen),
    forget: (sessionId: string) => listeners.delete(sessionId),
  };
}

// Each whole message from Chromium, as it comes
function messages(fromChromium: Readable, take: (message: any) => void) {
  let buffered = '';
  fromChromium.on('data', chunk => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\0')) >= 0) {
      take(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
}
