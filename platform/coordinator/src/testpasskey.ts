// A passkey for the harness: an authenticator that registers and signs as a device's would (WebAuthn's
// "none" attestation, P-256), for HQ at origin and host (config.ts's, imported after the harness).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const digest = (text: string | Buffer) => createHash('sha256').update(text).digest();
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

// The public key as COSE has it (EC2, ES256, P-256)
function coseKey(publicKey: KeyObject) {
  const jwk = publicKey.export({ format: 'jwk' });
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
}
// authenticatorData's head: the host's hash, the flags and the sign count
function authData(host: string, flags: number, counter: number) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat([digest(host), Buffer.from([flags]), count]);
}

export function authenticator(ORIGIN: string, PUBLIC_HOST: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = randomBytes(24),
    cose = coseKey(publicKey);
  const common = {
    id: id.toString('base64url'),
    rawId: id.toString('base64url'),
    type: 'public-key',
    clientExtensionResults: {},
  };
  return {
    register(challenge: string) {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(id.length);
      const created = Buffer.concat([authData(PUBLIC_HOST, 0x45, 0), Buffer.alloc(16), size, id, cose]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, never>>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, never>()],
          ['authData', created],
        ]),
      );
      return {
        ...common,
        response: {
          clientDataJSON: encoded({ type: 'webauthn.create', challenge, origin: ORIGIN }),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    login(challenge: string, counter = 1, origin = ORIGIN, flags = 0x05, host = PUBLIC_HOST) {
      const clientDataJSON = encoded({ type: 'webauthn.get', challenge, origin }),
        authenticatorData = authData(host, flags, counter);
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, digest(Buffer.from(clientDataJSON, 'base64url'))]),
        privateKey,
      );
      return {
        ...common,
        response: {
          clientDataJSON,
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      };
    },
  };
}
