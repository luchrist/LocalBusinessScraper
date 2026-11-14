import { createPublicKey, verify } from 'node:crypto';
import { LICENSE_PUBLIC_KEY } from './license-public-key';

export function verifyLicenseCertificate(certificate: string, machine: string, encodedPublicKey = LICENSE_PUBLIC_KEY) {
  try {
    if (certificate.length > 8192) return false;
    const [version, payload, signature, extra] = certificate.split('.');
    if (version !== 'ASET1' || !payload || !signature || extra !== undefined) return false;
    const key = createPublicKey({ key: Buffer.from(encodedPublicKey, 'base64'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.v === 1 && data.product === 'autosetter_lifetime_v1' &&
      typeof data.id === 'string' && data.id.length > 0 && data.machine === machine;
  } catch { return false; }
}
