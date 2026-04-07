import { app, BrowserWindow, dialog, shell } from 'electron';
import { utilityProcess, UtilityProcess } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { execFile } from 'child_process';

const isDev = !app.isPackaged;
const PORT = 3100;

let mainWindow: BrowserWindow | null = null;
let serverProcess: UtilityProcess | null = null;

// ─── Path helpers ─────────────────────────────────────────────────────────────

function getResourcesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..');
}

function getDataDir(): string {
  return path.join(app.getPath('userData'), 'scraper-data');
}

function getBrowsersDir(): string {
  return path.join(app.getPath('userData'), 'browsers');
}

function getLogsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function getModelsDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

function getServerPath(): string {
  return path.join(getResourcesDir(), '.next', 'standalone', 'server.js');
}

function getWorkerPath(): string {
  return path.join(getResourcesDir(), '.next', 'standalone', 'src', 'lib', 'llm-worker.mjs');
}

function getPlaywrightCliPath(): string {
  // In dev: playwright is in project root node_modules
  // In production: playwright is in .next/standalone/node_modules (Next.js standalone output)
  const candidates = [
    path.join(getResourcesDir(), '.next', 'standalone', 'node_modules', 'playwright', 'cli.js'),
    path.join(getResourcesDir(), 'node_modules', 'playwright', 'cli.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

function ensureDirectories(): void {
  for (const dir of [getDataDir(), getBrowsersDir(), getLogsDir(), getModelsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function hasChromiumInstalled(): boolean {
  const browsersDir = getBrowsersDir();
  if (!fs.existsSync(browsersDir)) return false;
  return fs.readdirSync(browsersDir).some((f) => f.startsWith('chromium'));
}

function installChromium(onProgress: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliPath = getPlaywrightCliPath();
    if (!fs.existsSync(cliPath)) {
      return reject(new Error(`Playwright CLI not found at: ${cliPath}`));
    }

    const proc = execFile(
      process.execPath,
      [cliPath, 'install', 'chromium'],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: getBrowsersDir(),
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    );

    proc.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) onProgress(msg);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) onProgress(msg);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install chromium exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ─── Model download ───────────────────────────────────────────────────────────

function getModelInfo(): { filename: string; url: string } {
  const gbRam = os.totalmem() / 1024 ** 3;
  if (gbRam > 8) {
    return {
      filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
      url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    };
  }
  return {
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  };
}

function downloadModel(destDir: string, onProgress: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const { filename, url } = getModelInfo();
    const destPath = path.join(destDir, filename);

    if (fs.existsSync(destPath)) {
      resolve();
      return;
    }

    const tmpPath = destPath + '.tmp';

    const download = (downloadUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) { reject(new Error('Zu viele Redirects beim Model-Download')); return; }
      const mod = downloadUrl.startsWith('https') ? https : http;
      (mod as typeof https).get(downloadUrl, { headers: { 'User-Agent': 'Autosetter/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Model-Download fehlgeschlagen: HTTP ${res.statusCode}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        let lastReportedPct = -1;

        const fileStream = fs.createWriteStream(tmpPath);
        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.floor((downloadedBytes / totalBytes) * 100);
            if (pct !== lastReportedPct) {
              lastReportedPct = pct;
              const mb = Math.round(downloadedBytes / 1024 / 1024);
              const totalMb = Math.round(totalBytes / 1024 / 1024);
              onProgress(`KI-Modell wird heruntergeladen: ${mb} / ${totalMb} MB (${pct}%)`);
            }
          }
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => {
            fs.renameSync(tmpPath, destPath);
            onProgress('KI-Modell installiert.');
            resolve();
          });
        });
        fileStream.on('error', (err) => {
          fs.unlink(tmpPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(tmpPath, () => {});
        reject(err);
      });
    };

    onProgress(`KI-Modell wird heruntergeladen (einmalig, ~${getModelInfo().filename.includes('Llama') ? '4.6' : '1'} GB)…`);
    download(url);
  });
}

// ─── Next.js server ───────────────────────────────────────────────────────────

function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverPath = getServerPath();

    if (!fs.existsSync(serverPath)) {
      return reject(
        new Error(
          `Next.js server nicht gefunden: ${serverPath}\nFühre zuerst "npm run build" aus.`,
        ),
      );
    }

    serverProcess = utilityProcess.fork(serverPath, [], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(PORT),
        HOSTNAME: '127.0.0.1',
        ELECTRON_DATA_DIR: getDataDir(),
        ELECTRON_LOG_DIR: getLogsDir(),
        PLAYWRIGHT_BROWSERS_PATH: getBrowsersDir(),
        LLM_WORKER_PATH: getWorkerPath(),
        LLM_MODEL_DIR: getModelsDir(),
      },
      cwd: path.dirname(getServerPath()),
    });

    serverProcess.on('exit', (code) => {
      console.log(`Next.js server beendet mit Code ${code}`);
    });

    // Poll until server responds
    const deadline = Date.now() + 45_000;
    const check = () => {
      http
        .get(`http://127.0.0.1:${PORT}/`, () => resolve())
        .on('error', () => {
          if (Date.now() > deadline) {
            reject(new Error('Next.js server konnte nicht gestartet werden (Timeout 45s)'));
          } else {
            setTimeout(check, 600);
          }
        });
    };
    setTimeout(check, 1500);
  });
}

// ─── Windows ──────────────────────────────────────────────────────────────────

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 300,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#0f172a;color:#e2e8f0;
    display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    height:100vh;gap:18px;
    -webkit-app-region:drag;user-select:none;
  }
  h1{font-size:20px;font-weight:600;color:#f1f5f9}
  #status{
    font-family:ui-monospace,'SF Mono',Menlo,monospace;
    font-size:11px;color:#64748b;
    width:400px;text-align:center;
    min-height:40px;line-height:1.5;
    overflow:hidden;white-space:pre-wrap;
    word-break:break-all;
  }
  .spinner{
    width:30px;height:30px;
    border:3px solid #1e293b;
    border-top-color:#3b82f6;
    border-radius:50%;
    animation:spin .8s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body>
  <div class="spinner"></div>
  <h1>Autosetter</h1>
  <div id="status">Initialisierung…</div>
</body></html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

function setStatus(win: BrowserWindow, msg: string): void {
  if (win.isDestroyed()) return;
  win.webContents
    .executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(msg)}`)
    .catch(() => {});
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Autosetter',
  });

  const url = isDev ? 'http://localhost:3000' : `http://127.0.0.1:${PORT}`;
  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App startup ──────────────────────────────────────────────────────────────

async function startup(): Promise<void> {
  const splash = createSplashWindow();

  // Small delay so the splash renders before heavy work begins
  await new Promise((r) => setTimeout(r, 200));

  try {
    ensureDirectories();

    if (!hasChromiumInstalled()) {
      setStatus(splash, 'Browser wird installiert (einmalig, ca. 200 MB)…');
      await installChromium((msg) => setStatus(splash, msg));
      setStatus(splash, 'Browser erfolgreich installiert.');
      await new Promise((r) => setTimeout(r, 400));
    }

    await downloadModel(getModelsDir(), (msg) => setStatus(splash, msg));

    if (!isDev) {
      setStatus(splash, 'Server wird gestartet…');
      await startNextServer();
    }

    setStatus(splash, 'Bereit!');
    await new Promise((r) => setTimeout(r, 300));

    splash.close();
    createMainWindow();
  } catch (err: unknown) {
    splash.close();
    const msg = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox('Startfehler', msg);
    app.quit();
  }
}

app.whenReady().then(startup);

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    serverProcess?.kill();
    app.quit();
  }
});

app.on('before-quit', () => {
  serverProcess?.kill();
});
