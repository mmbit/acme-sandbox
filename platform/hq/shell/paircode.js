// A one-time pair code that opens the page in HQ's viewer on another device (pair.ts), and the QR that carries it: the
// viewer's QR card shows both (viewer.js).
import { act } from './data.js';
import { qrCode, qrPath } from '/shared/qr/qr.js';

// A code for the page view ({ code, expires }) and the link its QR carries
export async function pairCode(view) {
  const code = await act('/api/pair-codes', { url: view });
  return { ...code, link: `${location.origin}/pair#${new URLSearchParams({ code: code.code })}` };
}
export function qrSvg(link, label) {
  const qr = qrCode(link, { level: 'M' }),
    n = qr.size + 8;
  return `<svg class="pair-qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${qrPath(qr)}"/></svg>`;
}
