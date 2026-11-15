import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { dataRoot } from './app-paths';
import { getModelPath, saveModelPath } from './model-settings';

export type ModelDownload = { id: string; name: string; file: string; url: string; size: number; sha256: string };
export const MODELS: ModelDownload[] = [
  { id: 'qwen-1.5b', name: 'Qwen 2.5 1.5B Instruct', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', size: 1117320736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf' },
  { id: 'qwen-7b', name: 'Qwen 2.5 7B Instruct', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', size: 4683074240,
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/8911e8a47f92bac19d6f5c64a2e2095bd2f7d031/Qwen2.5-7B-Instruct-Q4_K_M.gguf' },
];
export const chooseModel = (ramBytes = os.totalmem()) => MODELS[ramBytes <= 12 * 1024 ** 3 ? 0 : 1];

type SetupState = { status: 'idle' | 'downloading' | 'verifying' | 'ready' | 'error'; model: string; received: number; total: number; error?: string };
const globalState = globalThis as typeof globalThis & { autosetterModelSetup?: { state: SetupState; running?: Promise<void> } };
const store = globalState.autosetterModelSetup ??= { state: { status: 'idle', model: '', received: 0, total: 0 } };

export async function downloadVerifiedModel(model: ModelDownload, destination: string, onProgress: (received: number, verifying?: boolean) => void, request: typeof fetch = fetch) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const partial = destination + '.part';
  let offset = await fs.stat(partial).then(s => s.size).catch(() => 0);
  if (offset > model.size) { await fs.rm(partial); offset = 0; }
  if (offset < model.size) {
    const response = await request(model.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(24 * 60 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Modell-Download nicht erreichbar (${response.status}). Bitte erneut versuchen.`);
    if (offset && response.status === 206) {
      if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Ungültige Antwort beim Fortsetzen des Downloads.');
    } else offset = 0;
    const handle = await fs.open(partial, offset ? 'a' : 'w', 0o600);
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        offset += chunk.byteLength;
        if (offset > model.size) throw new Error('Die Modelldatei hat eine unerwartete Größe.');
        await handle.writeFile(chunk);
        onProgress(offset);
      }
    } finally { await handle.close(); }
  }
  if (offset !== model.size) throw new Error('Der Download wurde unterbrochen. Beim erneuten Versuch wird er fortgesetzt.');
  onProgress(offset, true);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(partial)) hash.update(chunk);
  if (hash.digest('hex') !== model.sha256) {
    await fs.rm(partial, { force: true });
    throw new Error('Die Modell-Prüfsumme stimmt nicht. Bitte lade das Modell erneut herunter.');
  }
  const file = await fs.open(partial, 'r');
  try { const header = Buffer.alloc(4); await file.read(header, 0, 4, 0); if (header.toString() !== 'GGUF') throw new Error('Die Datei ist kein gültiges GGUF-Modell.'); }
  finally { await file.close(); }
  await fs.rename(partial, destination);
}

export async function modelSetupState() {
  const configured = await getModelPath();
  if (configured && await fs.access(configured).then(() => true).catch(() => false)) {
    return { ...store.state, status: 'ready' as const, model: path.basename(configured), path: configured };
  }
  return { ...store.state, path: '' };
}

export async function startModelSetup() {
  const existing = await modelSetupState();
  if (existing.status === 'ready' || store.running) return existing;
  const model = chooseModel();
  store.state = { status: 'downloading', model: model.name, received: 0, total: model.size };
  const initialPath = await getModelPath();
  store.running = (async () => {
    const folder = path.join(dataRoot(), 'models');
    await fs.mkdir(folder, { recursive: true });
    const capacity = await fs.statfs(folder).catch(() => null);
    const partialSize = await fs.stat(path.join(folder, model.file + '.part')).then(s => Math.min(s.size, model.size)).catch(() => 0);
    if (capacity && capacity.bavail * capacity.bsize < model.size - partialSize + 256 * 1024 ** 2) throw new Error('Zu wenig freier Speicher für das lokale KI-Modell.');
    const destination = path.join(folder, model.file);
    await downloadVerifiedModel(model, destination, (received, verifying) => {
      store.state = { status: verifying ? 'verifying' : 'downloading', model: model.name, received, total: model.size };
    });
    // A manual model choice made during the download takes precedence.
    if (await getModelPath() === initialPath) await saveModelPath(destination);
    await fs.writeFile(path.join(folder, 'MODEL-NOTICE.txt'), 'Qwen 2.5 Instruct, Q4_K_M. Apache License 2.0.\nSmall model: https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF\n7B quantization: https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF\nLicense: https://www.apache.org/licenses/LICENSE-2.0\n');
    store.state = { status: 'ready', model: model.name, received: model.size, total: model.size };
  })().catch(error => { store.state = { ...store.state, status: 'error', error: error instanceof Error ? error.message : 'Modell konnte nicht heruntergeladen werden.' }; })
    .finally(() => { store.running = undefined; });
  return store.state;
}
