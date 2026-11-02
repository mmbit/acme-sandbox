// Frame recordings cross a channel so navigation cannot erase a queued event's source window.
export function frames() {
  const channels = new Set();
  const start = (frame, typed) => {
    const source = frame.contentWindow;
    const { port1, port2 } = new MessageChannel();
    channels.add(port1);
    port1.onmessage = ({ data }) => {
      if (data.watchalong === 'over') {
        channels.delete(port1);
        port1.close();
        return;
      }
      if (data.type !== 'rrweb') return;
      // rrweb owns frame id translation. Only its fields cross into the window's other message listeners.
      const recording = { type: 'rrweb', event: data.event, origin: data.origin };
      dispatchEvent(new MessageEvent('message', { data: recording, origin: data.origin, source }));
    };
    source.postMessage({ watchalong: 'start', typed }, '*', [port2]);
  };
  return {
    start,
    startAll: typed => document.querySelectorAll('iframe').forEach(frame => start(frame, typed)),
    stopAll() {
      document
        .querySelectorAll('iframe')
        .forEach(frame => frame.contentWindow.postMessage({ watchalong: 'stop' }, '*'));
      for (const port of channels) port.close();
      channels.clear();
    },
  };
}

// A fresh start can supply a new channel while the same document keeps recording.
export function toFramer() {
  let port = null;
  const release = () => {
    port?.postMessage({ watchalong: 'over' });
    port?.close();
    port = null;
  };
  return {
    connect(next) {
      release();
      port = next;
    },
    emit: event => port.postMessage({ type: 'rrweb', event, origin: location.origin }),
  };
}
