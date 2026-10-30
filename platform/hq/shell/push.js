// Push notifications on this device: the service worker (sw.js, which caches nothing) and the subscription.
import { pushKey, pushSubscribe, pushUnsubscribe, pushTest, offerEventTip } from './data.js'; // (offerEventTip)

const ua = navigator.userAgent;
const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64 = buf =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
export function registerWorker() {
  if ('serviceWorker' in navigator) register().catch(e => console.info('[hq] service worker:', e.message));
}
const registration = async () => (await navigator.serviceWorker.getRegistration('/')) ?? register();
const current = async () => (supported() ? (await registration()).pushManager.getSubscription() : null);

// on | off | denied | install (iPhone/iPad in Safari: Home Screen first) | old-ios | unsupported
export async function pushState() {
  if (ios && !standalone()) return 'install';
  if (!supported()) return ios ? 'old-ios' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && (await current()) ? 'on' : 'off';
}

// Subscribe with the coordinator's key (a subscription made for an older key is replaced) and tell it.
async function subscribe(key) {
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  const k = sub?.options?.applicationServerKey;
  if (sub && k && b64(k) !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  return pushSubscribe(sub.toJSON());
}
// Called straight from the tap, with the key fetched beforehand: iOS and Firefox only ask from a user gesture.
export async function enablePush(key) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  await subscribe(key);
  return 'on';
}
export async function disablePush() {
  const sub = await current();
  if (!sub) return;
  await pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}
export const testPush = async () => pushTest((await current())?.endpoint);
// The first urgent card this page sees, on a device without notifications, brings their tip (tips.js), whatever the
// company's other devices have.
let urgentSeen = false;
export async function urgentCards(dev, list) {
  if (urgentSeen || !list.some(r => r.urgency === 'now')) return;
  urgentSeen = true;
  if ((await pushState()) !== 'on') await offerEventTip(dev, 'notifications');
}
// On start: keep the coordinator's list in step with this device (a new server, a rotated key).
export async function syncPush() {
  try {
    if ((await pushState()) === 'on') await subscribe((await pushKey()).key);
  } catch (e) {
    console.info('[hq] push sync:', e.message || e);
  }
}
