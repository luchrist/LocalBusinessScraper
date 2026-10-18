const { app, BrowserWindow, dialog, shell, powerSaveBlocker, session, ipcMain } = require('electron');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
let backend, window, blocker, quitting = false, runActive = false;
function setAwake(active) {
  runActive = active;
  if (active && blocker === undefined) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!active && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
async function port() {
  return new Promise((resolve,reject) => {
    const s = net.createServer(); s.on('error',reject);
    s.listen(0,'127.0.0.1',()=>{ const p=s.address().port; s.close(()=>resolve(p)); });
  });
}
async function start() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '.desktop');
  const serverRoot = path.join(resources, 'server');
  const dataRoot = app.getPath('userData');
  fs.mkdirSync(dataRoot, { recursive: true });
  const localPort = await port();
  const origin = `http://127.0.0.1:${localPort}`;
  const secret = randomBytes(32).toString('hex');
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (new URL(details.url).origin === origin) details.requestHeaders['x-autosetter-local-token'] = secret;
    callback({ requestHeaders: details.requestHeaders });
  });
  const log = fs.openSync(path.join(dataRoot, 'desktop.log'), 'a');
  backend = fork(path.join(serverRoot, 'server.js'), [], {
    execPath: path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    cwd: serverRoot, execArgv: [], stdio: ['ignore', log, log, 'ipc'],
    env: { NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      PORT: String(localPort), HOSTNAME: '127.0.0.1', AUTOSETTER_DATA_DIR: dataRoot,
      AUTOSETTER_ASSET_DIR: serverRoot, AUTOSETTER_LOCAL_TOKEN: secret,
      PLAYWRIGHT_BROWSERS_PATH: path.join(resources, 'browsers'),
      AUTOSETTER_LICENSE_SERVER: 'https://autosetter.de',
    },
  });
  backend.on('message', msg => { if (msg?.type === 'autosetter-power') setAwake(msg.active === true); });
  backend.on('exit', () => {
    setAwake(false);
    if (!quitting) { dialog.showErrorBox('AutoSetter wurde beendet', 'Der lokale Dienst wurde beendet. Bitte starte AutoSetter erneut. Bereits gespeicherte Ergebnisse bleiben erhalten.'); app.quit(); }
  });
  let ready = false;
  for (let i=0; i<180; i++) {
    if (backend.exitCode !== null) throw new Error('Der lokale Dienst konnte nicht gestartet werden.');
    try { const res = await fetch(origin + '/api/health', { headers: { 'x-autosetter-local-token': secret } }); if (res.ok) { ready=true; break; } } catch {}
    await new Promise(r=>setTimeout(r,500));
  }
  if (!ready) throw new Error('Der lokale Dienst hat nicht rechtzeitig geantwortet.');
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 850, minHeight: 640, title: 'AutoSetter', backgroundColor: '#0f172a',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(({url}) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action:'deny' };
  });
  window.webContents.on('will-navigate', (event,url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); }
  });
  window.on('close', event => {
    if (runActive && !quitting) {
      const choice = dialog.showMessageBoxSync(window, { type:'warning', buttons:['Weiter recherchieren','Recherche beenden und schließen'], defaultId:0, cancelId:0,
        title:'Recherche läuft', message:'Beim Schließen wird die Recherche beendet. Gespeicherte Ergebnisse bleiben erhalten.' });
      if (choice === 0) event.preventDefault();
    }
  });
  ipcMain.handle('choose-model', async event => {
    if (event.senderFrame?.url !== window.webContents.getURL()) return null;
    const result = await dialog.showOpenDialog(window, { title: 'Lokales KI-Modell wählen', filters: [{name:'GGUF-Modell',extensions:['gguf']}], properties:['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  await window.loadURL(origin);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{ if(window) { if(window.isMinimized())window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error=>{ dialog.showErrorBox('AutoSetter konnte nicht starten', error.message); app.quit(); });
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{ quitting=true; setAwake(false); backend?.kill(); });
