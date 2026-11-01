// The company's preview pages, as HQ's viewer opens and hears them (desk.js)
// Each is at https://<slug>.preview.<zone>/, on the zone HQ's own host is on (hq.<zone>: the coordinator's ZONE in
// config.ts), and a deck at the venture cycles' https://cycles.preview.<zone>. HQ in dev mode (data.js local) has no
// zone, so there a preview may be on any.
export function previewsOn(host, dev) {
  const zone = dev ? '[a-z0-9.-]+' : host.split('.').slice(1).join('\\.');
  return {
    page: new RegExp(`^https://[a-z0-9-]+\\.preview\\.${zone}(/|$)`),
    deck: new RegExp(`^https://cycles\\.preview\\.${zone}$`),
  };
}
