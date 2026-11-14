import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { licenseFile, dataRoot } from './app-paths';
import { verifyLicenseCertificate } from './license-certificate';
import { LICENSE_PUBLIC_KEY } from './license-public-key';
const exec = promisify(execFile);
const LICENSE_SERVER = process.env.AUTOSETTER_LICENSE_SERVER || 'https://www.autosetter.de';
async function machineId() {
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
  const requireLicense = async () => {
    const certificate = await savedLicense();
    if (!certificate || !verifyLicenseCertificate(certificate, await config.machine(), config.publicKey)) {
      throw new Error('Bitte aktiviere deine AutoSetter-Lizenz auf diesem Computer.');
    }
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
    const file = config.file();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ certificate: data.certificate }), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  };
  return { activateLicense, savedLicense, requireLicense };
}

export const { activateLicense, savedLicense, requireLicense } = createLicenseManager({
  server: LICENSE_SERVER, publicKey: LICENSE_PUBLIC_KEY, file: licenseFile, machine: machineId,
});
