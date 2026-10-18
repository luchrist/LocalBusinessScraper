import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from './app-paths';
export async function getModelPath() {
  try { return JSON.parse(await fs.readFile(path.join(dataRoot(), 'model-settings.json'), 'utf8')).path || process.env.LLM_MODEL_PATH || ''; }
  catch { return process.env.LLM_MODEL_PATH || ''; }
}
export async function saveModelPath(modelPath: string) {
  if (modelPath) {
    if (!path.isAbsolute(modelPath) || !modelPath.toLowerCase().endsWith('.gguf')) throw new Error('Bitte wähle eine lokale GGUF-Datei.');
    const file = await fs.open(modelPath, 'r');
    try { const header = Buffer.alloc(4); await file.read(header,0,4,0); if (header.toString() !== 'GGUF') throw new Error('Die Datei ist kein GGUF-Modell.'); }
    finally { await file.close(); }
  }
  await fs.mkdir(dataRoot(), { recursive:true });
  await fs.writeFile(path.join(dataRoot(),'model-settings.json'),JSON.stringify({path:modelPath}),{mode:0o600});
}
