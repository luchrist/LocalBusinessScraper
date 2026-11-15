import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './app-paths';
import { licenseAccess, upgradeTrial } from './app-license';

type Access = { tier: 'lifetime' | 'trial'; id: string; limit?: number; priceCents?: number };
export function createResultGate(options: { file: () => string; access: () => Promise<Access>; upgrade: () => Promise<void> }) {
  let queue: Promise<unknown> = Promise.resolve();
  const usage = async (id: string) => {
    try { const counts = JSON.parse(await fs.readFile(options.file(), 'utf8')); if (!(id in counts)) return 0; const value = counts[id];
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Ungültiger Test-Zähler. Bitte kontaktiere den Support.');
      return value as number;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  const record = <T>(insert: () => T): Promise<T> => {
    const task = queue.catch(() => {}).then(async () => {
      const access = await options.access();
      if (access.tier === 'lifetime') return insert();
      const used = await usage(access.id);
      if (used >= 50) { await options.upgrade(); if ((await options.access()).tier !== 'lifetime') throw new Error('Die Zahlung wurde noch nicht bestätigt.'); return insert(); }
      const result = insert();
      // Count only rows actually inserted; a failed database write never consumes a free result.
      let counts: Record<string, number> = {};
      try { counts = JSON.parse(await fs.readFile(options.file(), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      counts[access.id] = used + 1;
      await fs.mkdir(path.dirname(options.file()), { recursive: true });
      const temporary = options.file() + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temporary, JSON.stringify(counts), { mode: 0o600 }); await fs.rename(temporary, options.file()); }
      finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    queue = task;
    return task;
  };
  return { record, usage };
}
const globalState = globalThis as typeof globalThis & { autosetterResultGate?: ReturnType<typeof createResultGate> };
const gate = globalState.autosetterResultGate ??= createResultGate({ file: () => path.join(dataRoot(), 'trial-usage.json'), access: licenseAccess, upgrade: upgradeTrial });
export const recordLicensedResult = gate.record;
export const trialUsage = gate.usage;
