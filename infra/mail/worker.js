// Cloudflare Email Worker: every message to the company's domain goes to HQ (platform/coordinator/src/mail.ts)
// as raw MIME, with the envelope sender and recipient. It can't send mail. HQ's address, HQ_ORIGIN, comes from
// infra/host: the Email workflow sets it on upload, with HELD, the Worker's own store.
// A message HQ can't take now (down, deploying, a token out of step) is kept in HELD and handed over again every few
// minutes (scheduled) until HQ takes it: an outage never bounces mail. One HQ has no room for yet (507: its attachments
// don't fit) is kept the same way, and the held mail behind it still goes. Only a message HQ will never take (too big:
// 413) goes back to its sender, and so does one too big to keep. Held messages expire after HOLD_DAYS, even if HQ
// still has no room.
const HOLD_DAYS = 30;
const MAX_HELD = 25 * 1024 * 1024; // a KV value's limit

const deliver = (env, from, to, raw) => fetch(`${env.HQ_ORIGIN}/api/mail/inbound`, {
  method: 'POST',
  headers: { authorization: `Bearer ${env.MAIL_TOKEN}`, 'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': to },
  body: raw,
}).then(res => res.status, () => 0);

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const status = await deliver(env, message.from, message.to, raw);
    if (status >= 200 && status < 300) return;
    if (status === 413 || raw.byteLength > MAX_HELD) return message.setReject('The message is too big for us to receive.');
    await env.HELD.put(`${Date.now()}-${crypto.randomUUID()}`, raw,
      { expirationTtl: HOLD_DAYS * 86400, metadata: { from: message.from, to: message.to } });
  },
  async scheduled(event, env) {
    let cursor;
    let page;
    do {
      page = await env.HELD.list({ cursor });
      for (const key of page.keys) {
        const { value, metadata } = await env.HELD.getWithMetadata(key.name, 'arrayBuffer');
        if (!value) continue;
        const status = await deliver(env, metadata.from, metadata.to, value);
        if (status >= 200 && status < 300 || status === 413) await env.HELD.delete(key.name);
        else if (status !== 507) return; // HQ still can't take mail: the rest waits for the next round
      }
      cursor = page.cursor;
    } while (!page.list_complete);
  },
};
