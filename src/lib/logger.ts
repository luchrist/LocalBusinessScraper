import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'scraper.log');

// Defer directory creation to first write operation
let isLogDirCreated = false;
function ensureLogDir() {
  if (!isLogDirCreated) {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    isLogDirCreated = true;
  }
}

function formatArg(arg: any): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack}`;
  }
  return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
}

function formatMessage(level: string, message: any, ...args: any[]) {
  const timestamp = new Date().toISOString();
  const formattedArgs = args.map(formatArg).join(' ');
  const msgContent = formatArg(message);
  
  return `[${timestamp}] [${level.toUpperCase()}] ${msgContent} ${formattedArgs}\n`;
}

function writeLog(level: string, message: any, ...args: any[]) {
  const logMessage = formatMessage(level, message, ...args);
  ensureLogDir();
  try {
    // Synchronous append guarantees file order equals call order.
    fs.appendFileSync(LOG_FILE, logMessage);
  } catch (err) {
    console.error('Failed to write log to file:', err);
  }

  // Also log to console
  if (level === 'error') {
    console.error(message, ...args);
  } else if (level === 'warn') {
    console.warn(message, ...args);
  } else {
    console.log(message, ...args);
  }
}

function clearLog() {
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch (err) {
    console.error('Failed to clear log file:', err);
  }
}

export const logger = {
  log: (message: any, ...args: any[]) => writeLog('info', message, ...args),
  info: (message: any, ...args: any[]) => writeLog('info', message, ...args),
  error: (message: any, ...args: any[]) => writeLog('error', message, ...args),
  warn: (message: any, ...args: any[]) => writeLog('warn', message, ...args),
  clear: () => clearLog(),
};
