import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'scraper.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function formatMessage(level: string, message: any, ...args: any[]) {
  const timestamp = new Date().toISOString();
  const formattedArgs = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');
  
  const msgContent = typeof message === 'object' ? JSON.stringify(message, null, 2) : String(message);
  
  return `[${timestamp}] [${level.toUpperCase()}] ${msgContent} ${formattedArgs}\n`;
}

function writeLog(level: string, message: any, ...args: any[]) {
  const logMessage = formatMessage(level, message, ...args);
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
