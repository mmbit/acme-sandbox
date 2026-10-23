// The backup's age key pair (https://age-encryption.org/v1), made in the board's own browser.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l',
  GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// A fresh pair: { secret: 'AGE-SECRET-KEY-1…', recipient: 'age1…' }. The server only ever gets the recipient, so it
// can write backups but never read them. Rejects where WebCrypto has no X25519: there's no fallback crypto.
export async function makeAgeKey() {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const { d, x } = await crypto.subtle.exportKey('jwk', privateKey);
  return { secret: bech32('age-secret-key-', unb64u(d)).toUpperCase(), recipient: bech32('age', unb64u(x)) };
}
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// lowercase Bech32 of bytes under hrp (BIP-173, not bech32m, as age writes it; age keeps no 90-character limit)
function bech32(hrp, bytes) {
  const data = fiveBits(bytes),
    chk = polymod([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1,
    checksum = [0, 1, 2, 3, 4, 5].map(i => (chk >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map(d => CHARSET[d]).join('')}`;
}
// 8-bit bytes as 5-bit groups, the last one padded with zeros
function fiveBits(bytes) {
  let acc = 0,
    bits = 0;
  const out = [];
  for (const v of bytes) {
    acc = (acc << 8) | v;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}
const expand = hrp =>
  [...hrp]
    .map(c => c.charCodeAt(0) >> 5)
    .concat(
      0,
      [...hrp].map(c => c.charCodeAt(0) & 31),
    );
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
