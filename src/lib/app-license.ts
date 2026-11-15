import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { licenseFile, dataRoot } from './app-paths';
import { verifyLicenseCertificate, readLicenseCertificate } from './license-certificate';
import { LICENSE_PUBLIC_KEY } from './license-public-key';
const exec = promisify(execFile);
const LICENSE_SERVER = process.env.AUTOSETTER_LICENSE_SERVER || 'https://www.autosetter.de';
async function readMachineId() {
  let id = '';
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000 });
      id = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || '';
    } else if (process.platform === 'win32') {
      const { stdout } = await exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { timeout: 5000, windowsHide: true });
      id = stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] || '';
    } else { id = (await fs.readFile('/etc/machine-id', 'utf8')).trim(); }
  } catch { /* Persist an install ID on systems without a hardware identifier. */ }
  if (!id) {
    const file = path.join(dataRoot(), 'installation-id');
    await fs.mkdir(dataRoot(), { recursive: true });
    try { id = await fs.readFile(file, 'utf8'); }
    catch {
      try { id = randomUUID(); await fs.writeFile(file, id, { flag: 'wx', mode: 0o600 }); }
      catch { id = await fs.readFile(file, 'utf8'); }
    }
  }
  // Do not send raw hardware identifiers to the licensing service.
  return createHash('sha256').update(`autosetter:${os.platform()}:${id.trim()}`).digest('hex');
}
let machinePromise: Promise<string> | undefined;
const machineId = () => machinePromise ??= readMachineId();

type LicenseConfig = {
  server: string;
  publicKey: string;
  file: () => string;
  machine: () => Promise<string>;
};

// The production instance always uses the bundled public key. Tests construct
// an independent instance with their own keypair; no test key ships in the app.
export function createLicenseManager(config: LicenseConfig) {
  const savedLicense = async (): Promise<string | null> => {
    try {
      const certificate = JSON.parse(await fs.readFile(config.file(), 'utf8')).certificate;
      return typeof certificate === 'string' ? certificate : null;
    } catch { return null; }
  };
  const access = async () => {
    const certificate = await savedLicense();
    const claim = certificate ? readLicenseCertificate(certificate, await config.machine(), config.publicKey) : null;
    if (!claim) throw new Error('Bitte aktiviere deine AutoSetter-Lizenz oder deinen Testzugang auf diesem Computer.');
    return claim;
  };
  const requireLicense = async () => { await access(); };
  const saveCertificate = async (certificate: string) => {
    if (!verifyLicenseCertificate(certificate, await config.machine(), config.publicKey)) throw new Error('Die Freischaltung konnte nicht bestätigt werden. Bitte kontaktiere den Support.');
    const file = config.file();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ certificate }), { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  const activateLicense = async (key: string) => {
    const machine = await config.machine();
    const res = await fetch(`${config.server}/api/license/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machine_id: machine }), signal: AbortSignal.timeout(12000), cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lizenz ist für dieses Gerät nicht freigeschaltet.');
    if (typeof data.certificate !== 'string' || !verifyLicenseCertificate(data.certificate, machine, config.publicKey)) {
      throw new Error('Die Freischaltung konnte nicht bestätigt werden. Bitte kontaktiere den Support.');
    }
    await saveCertificate(data.certificate);
  };
  const upgradeTrial = async () => {
    const claim = await access();
    if (claim.tier === 'lifetime') return;
    try {
    const response = await fetch(`${config.server}/api/trial/upgrade`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certificate: await savedLicense(), result_number: 51 }), signal: AbortSignal.timeout(35_000), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.paid || typeof data.certificate !== 'string') throw new TrialPaymentRequired(data.error || (data.paymentUrl ? 'Die Bank benötigt eine Bestätigung. Die Recherche pausiert vor Ergebnis 51.' : 'Die Zahlung wird geprüft. Die Recherche pausiert vor Ergebnis 51.'), data.paymentUrl);
    const paid = readLicenseCertificate(data.certificate, await config.machine(), config.publicKey);
    if (paid?.tier !== 'lifetime') throw new Error('Die bezahlte Freischaltung konnte nicht geprüft werden.');
    await saveCertificate(data.certificate);
    } catch (error) {
      if (error instanceof TrialPaymentRequired) throw error;
      throw new TrialPaymentRequired(error instanceof Error ? `Zahlung nicht bestätigt. Die Recherche pausiert vor Ergebnis 51. ${error.message}` : 'Zahlung nicht bestätigt. Die Recherche pausiert vor Ergebnis 51.');
    }
  };
  const cancelTrial = async () => {
    if ((await access()).tier !== 'trial') throw new Error('Die Lifetime-Lizenz ist bereits bezahlt.');
    const response = await fetch(`${config.server}/api/trial/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certificate: await savedLicense() }), signal: AbortSignal.timeout(15_000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Test konnte nicht beendet werden.');
    await fs.rm(config.file(), { force: true });
  };
  return { activateLicense, savedLicense, requireLicense, access, upgradeTrial, cancelTrial };
}

export class TrialPaymentRequired extends Error { constructor(message: string, public paymentUrl?: string) { super(message); } }

export const { activateLicense, savedLicense, requireLicense, access: licenseAccess, upgradeTrial, cancelTrial } = createLicenseManager({
  server: LICENSE_SERVER, publicKey: LICENSE_PUBLIC_KEY, file: licenseFile, machine: machineId,
});
