import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'scraper-data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'settings.db');

export interface ApiKey {
  key: string;
  usage: number;
  added_at: number;
}

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

export function initSettingsDb() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      usage INTEGER DEFAULT 0,
      added_at INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.close();
}

function getCurrentBillingMonth(): string {
  // Returns "YYYY-MM" in Pacific Time
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
  });
  return formatter.format(new Date()).substring(0, 7);
}

function checkAndResetMonthlyUsage(db: Database.Database) {
  const currentMonth = getCurrentBillingMonth(); // e.g. "2023-10"
  
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_reset_month'").get() as { value: string } | undefined;
  const lastResetMonth = row?.value;

  if (lastResetMonth !== currentMonth) {
    // New month detected (in PT) -> Reset all usage
    db.prepare("UPDATE api_keys SET usage = 0").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_reset_month', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(currentMonth);
    // console.log(`[Settings] Monthly reset performed for ${currentMonth} (PT)`);
  }
}

export function getApiKeys(): ApiKey[] {
  const db = openDb();
  checkAndResetMonthlyUsage(db);
  const keys = db.prepare('SELECT * FROM api_keys ORDER BY added_at DESC').all() as ApiKey[];
  db.close();
  return keys;
}

export function addApiKey(key: string) {
  const db = openDb();
  checkAndResetMonthlyUsage(db);
  try {
    db.prepare('INSERT INTO api_keys (key, usage, added_at) VALUES (?, 0, ?)').run(key, Date.now());
  } catch (err: any) {
    if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw err;
    }
    // Ignore duplicate keys
  }
  db.close();
}

export function deleteApiKey(key: string) {
  const db = openDb();
  db.prepare('DELETE FROM api_keys WHERE key = ?').run(key);
  db.close();
}

export function resetApiKeyUsage(key: string) {
  const db = openDb();
  db.prepare('UPDATE api_keys SET usage = 0 WHERE key = ?').run(key);
  db.close();
}

export function incrementApiKeyUsage(key: string) {
    const db = openDb();
    checkAndResetMonthlyUsage(db);
    db.prepare('UPDATE api_keys SET usage = usage + 1 WHERE key = ?').run(key);
    db.close();
}

export function getNextAvailableKey(): string | null {
    const db = openDb();
    checkAndResetMonthlyUsage(db);
    // Get first key with usage < 1000
    // We can order by added_at to rotate sequentially
    const row = db.prepare('SELECT key FROM api_keys WHERE usage < 1000 ORDER BY added_at ASC LIMIT 1').get() as { key: string } | undefined;
    db.close();
    return row ? row.key : null;
}
