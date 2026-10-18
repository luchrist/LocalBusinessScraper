import { spawn, type ChildProcess } from 'node:child_process';
import { requireLicense } from './app-license';
type State = { running: boolean; child: ChildProcess | null };
const globalState = globalThis as typeof globalThis & { autosetterRun?: State };
const state = globalState.autosetterRun ??= { running: false, child: null };
export class RunError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function beginRun() {
  try { await requireLicense(); } catch (e) { throw new RunError(e instanceof Error ? e.message : 'Lizenzprüfung fehlgeschlagen.', 403); }
  if (state.running) throw new RunError('Es läuft bereits eine Recherche. Bitte beende sie zuerst.', 409);
  state.running = true;
  try {
    if (process.send) process.send({ type: 'autosetter-power', active: true });
    if (process.platform === 'darwin') {
      state.child = spawn('/usr/bin/caffeinate', ['-d', '-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    } else if (!process.send && process.platform === 'win32') {
      const script = `Add-Type -Namespace AutoSetter -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; [AutoSetter.Power]::SetThreadExecutionState([uint32]2147483651) | Out-Null; while ($true) { Start-Sleep -Seconds 30 }`;
      state.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    } else if (!process.send) {
      state.child = spawn('systemd-inhibit', ['--what=idle:sleep', '--mode=block', '--who=AutoSetter', 'sleep', 'infinity'], { stdio: 'ignore' });
    }
    state.child?.on('error', e => console.warn('[keep-awake] unavailable:', e.message));
  } catch { state.running = false; throw new RunError('Wachhaltemodus konnte nicht gestartet werden.', 503); }
  let released = false;
  return () => {
    if (released) return; released = true;
    state.child?.kill(); state.child = null;
    if (process.send && process.connected) process.send({ type: 'autosetter-power', active: false });
    state.running = false;
  };
}
export const isRunning = () => state.running;
