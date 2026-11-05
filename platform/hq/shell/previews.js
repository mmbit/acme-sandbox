// The company's preview pages, as HQ's viewer opens and hears them (desk.js)
// Each is at https://<slug>.preview.<zone>/, on the zone HQ's own host is on (hq.<zone>: the coordinator's ZONE in
// config.ts), and a deck at the venture cycles' https://cycles.preview.<zone>. HQ in dev mode (data.js local) has no
// zone, so there a preview may be on any.
export function previewsOn(host, dev) {
  const zone = dev ? '[a-z0-9.-]+' : host.split('.').slice(1).join('\\.');
  return {
    page: new RegExp(`^https://[a-z0-9-]+\\.preview\\.${zone}(/|$)`),
    deck: new RegExp(`^https://cycles\\.preview\\.${zone}$`),
    // (a call's prototypes' host, an origin: the coordinator's callprototypes.ts.)
    prototype: new RegExp(`^https://call-[0-9]+\\.preview\\.${zone}$`),
  };
}

// Whether a link is to a call's prototype, on the zone HQ's host is on (any in dev mode: data.js local).
export function prototypeLink(link, host, dev) {
  let origin;
  // (new URL, as URL.parse is Safari 18's and HQ runs from iOS 16.4: a link it can't read is no prototype's)
  try {
    origin = new URL(link).origin;
  } catch {
    return false;
  }
  return previewsOn(host, dev).prototype.test(origin);
}
