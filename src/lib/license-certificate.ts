import { createPublicKey, verify } from 'node:crypto';
import { LICENSE_PUBLIC_KEY } from './license-public-key';

export function readLicenseCertificate(certificate: string, machine: string, encodedPublicKey = LICENSE_PUBLIC_KEY) {
  try {
    if (certificate.length > 8192) return null;
    const [version, payload, signature, extra] = certificate.split('.');
    if (!['ASET1', 'ASET2'].includes(version) || !payload || !signature || extra !== undefined) return null;
    const key = createPublicKey({ key: Buffer.from(encodedPublicKey, 'base64'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.id !== 'string' || !data.id || data.machine !== machine) return null;
    if (version === 'ASET1' && data.v === 1 && data.product === 'autosetter_lifetime_v1') return { tier: 'lifetime' as const, id: data.id as string };
    if (version === 'ASET2' && data.v === 2 && data.product === 'autosetter_trial_v1' && data.limit === 50 && data.priceCents === 29900) return { tier: 'trial' as const, id: data.id as string, limit: 50, priceCents: data.priceCents as number };
    return null;
  } catch { return null; }
}

export function verifyLicenseCertificate(certificate: string, machine: string, publicKey = LICENSE_PUBLIC_KEY) { return !!readLicenseCertificate(certificate, machine, publicKey); }
