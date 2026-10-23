// HQ's service worker: it shows the desk phone's push notifications and opens HQ from them. That's all:
// no fetch handler and no cache, so HQ always loads fresh from the coordinator (it has its own update toast).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data?.json() ?? {}; } catch { m = { body: e.data?.text() }; }
  e.waitUntil(Promise.all([ // (the coordinator titles every push with the brand's name, push.ts: HQ is for one that isn't)
    self.registration.showNotification(m.title || 'HQ', {
      body: m.body || '', tag: m.tag || 'hq', renotify: true, // one tag per kind: a newer call replaces the older one
      icon: '/icon-192.png', badge: '/badge-96.png', vibrate: [120, 80, 120, 80, 240], timestamp: Date.now(),
      data: { url: m.url || '/?open=phone' },
    }),
    m.count != null && self.navigator.setAppBadge?.(m.count).catch(() => {}),
  ]));
});

// Tapping a notification brings HQ to the front with the phone open, or starts it at /?open=phone.
async function openHQ(url) {
  let target = new URL(url, self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const win = wins.find(w => new URL(w.url).origin === self.location.origin);
  if (!win) return self.clients.openWindow(target.href);
  const open = target.searchParams.get('open');
  if (open) win.postMessage({ open, job: target.searchParams.get('job'), card: target.searchParams.get('card') });   // (job: Jobs at its report; card: the phone at it)
  return win.focus().catch(() => self.clients.openWindow(target.href));
}
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(openHQ(e.notification.data?.url || '/?open=phone'));
});

// The push service replaced the subscription (Firefox does this now and then): hand the new one over.
self.addEventListener('pushsubscriptionchange', e => e.waitUntil((async () => {
  const key = e.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
})()));
