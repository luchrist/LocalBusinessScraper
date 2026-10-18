import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { licenseFile, dataRoot } from './app-paths';
const exec = promisify(execFile);
const LICENSE_SERVER = process.env.AUTOSETTER_LICENSE_SERVER || 'https://autosetter.de';
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
export async function licenseRequest(action: 'activate' | 'validate' | 'deactivate', key: string) {
  const res = await fetch(`${LICENSE_SERVER}/api/license/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, machine_id: await machineId() }), signal: AbortSignal.timeout(12000), cache: 'no-store',
  });
  const data = await res.json();
  if (!res.ok || (action === 'validate' && !data.valid)) throw new Error(data.error || 'Lizenz ist für dieses Gerät nicht freigeschaltet.');
  return data;
}
export async function savedLicense(): Promise<string | null> {
  try { return JSON.parse(await fs.readFile(licenseFile(), 'utf8')).key || null; } catch { return null; }
}
export async function requireLicense() {
  const key = await savedLicense();
  if (!key) throw new Error('Bitte aktiviere zuerst deine gekaufte AutoSetter-Lizenz.');
  await licenseRequest('validate', key);
}
export async function activateLicense(key: string) {
  await licenseRequest('activate', key);
  await fs.mkdir(dataRoot(), { recursive: true });
  await fs.writeFile(licenseFile(), JSON.stringify({ key }), { mode: 0o600 });
}
export async function deactivateLicense() {
  const key = await savedLicense();
  if (key) await licenseRequest('deactivate', key);
  await fs.rm(licenseFile(), { force: true });
}
