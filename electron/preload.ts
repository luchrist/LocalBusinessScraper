// Minimal preload – the renderer communicates with the Next.js backend
// via standard HTTP/SSE. No Node.js APIs need to be exposed.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('electronEnv', {
  isElectron: true,
});
