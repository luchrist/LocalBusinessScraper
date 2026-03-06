/**
 * db.ts – SQLite persistence layer for the scraper pipeline.
 *
 * Schema
 * ──────
 *  sessions  – one row per scraping job submitted by the user
 *  jobs      – one row per Excel row (city × industry)
 *  places    – one row per scraped Google Maps place
 *
 * The file is stored at  ./scraper-data/<session_id>.db  (relative to CWD).
 * All writes are synchronous (better-sqlite3) so workers never race on WAL
 * commits and we never lose results, even on SIGKILL.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus    = 'pending' | 'running' | 'done' | 'error';
export type EnrichStatus = 'pending' | 'enriching' | 'done' | 'error' | 'skipped' | 'no_website';
export type SessionStatus = 'active' | 'paused' | 'done';

export interface SessionRow {
  id: string;
  created_at: number;
  status: SessionStatus;
  total_jobs: number;
  worker_count: number;
  search_email: number;   // 0/1
  search_owner: number;   // 0/1
  country: string;
}

export interface JobRow {
  id: string;
  session_id: string;
  stadt: string;
  branche: string;
  max_results: number | null;
  status: JobStatus;
  started_at: number | null;
}

export interface PlaceRow {
  id: string;
  session_id: string;
  job_id: string;
  name: string;
  website: string | null;
  phone: string | null;
  rating: number | null;
  reviews: number | null;
  hours: string | null;
  address: string | null;
  place_key: string | null;   // Google Maps internal ID / dedup key
  email: string | null;
  owner: string | null;
  owner_first_names: string | null;
  owner_last_names: string | null;
  enrich_status: EnrichStatus;
  streamed: number;           // 0/1
  created_at: number;
}

// ─── DB singleton cache (one DB per session inside this process) ──────────────

const dbCache = new Map<string, Database.Database>();

function dataDir(): string {
  const dir = path.join(process.cwd(), 'scraper-data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function openDb(sessionId: string): Database.Database {
  if (dbCache.has(sessionId)) return dbCache.get(sessionId)!;

  const dbPath = path.join(dataDir(), `${sessionId}.db`);
  const db = new Database(dbPath);

  // WAL mode: reads don't block writes
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      created_at   INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      total_jobs   INTEGER NOT NULL DEFAULT 0,
      worker_count INTEGER NOT NULL DEFAULT 2,
      search_email INTEGER NOT NULL DEFAULT 1,
      search_owner INTEGER NOT NULL DEFAULT 1,
      country      TEXT NOT NULL DEFAULT 'de'
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      stadt       TEXT NOT NULL,
      branche     TEXT NOT NULL,
      max_results INTEGER,
      status      TEXT NOT NULL DEFAULT 'pending',
      started_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS places (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      job_id        TEXT NOT NULL REFERENCES jobs(id),
      name          TEXT NOT NULL,
      website       TEXT,
      phone         TEXT,
      rating        REAL,
      reviews       INTEGER,
      hours         TEXT,
      address       TEXT,
      place_key     TEXT,
      email         TEXT,
      owner         TEXT,
      owner_first_names TEXT,
      owner_last_names  TEXT,
      enrich_status TEXT NOT NULL DEFAULT 'pending',
      streamed      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_session_status  ON jobs(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_places_enrich        ON places(session_id, enrich_status, streamed);
    CREATE INDEX IF NOT EXISTS idx_places_job           ON places(job_id);
  `);

  // Migration: add max_results column to existing DBs
  try { db.exec(`ALTER TABLE jobs ADD COLUMN max_results INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE places ADD COLUMN owner_first_names TEXT`); } catch {}
  try { db.exec(`ALTER TABLE places ADD COLUMN owner_last_names TEXT`); } catch {}

  dbCache.set(sessionId, db);
  return db;
}

export function closeDb(sessionId: string) {
  const db = dbCache.get(sessionId);
  if (db) { db.close(); dbCache.delete(sessionId); }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

export function newSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function createSession(
  db: Database.Database,
  opts: { sessionId: string; workerCount: number; searchEmail: boolean; searchOwner: boolean; country: string }
): void {
  db.prepare(`
    INSERT INTO sessions (id, created_at, status, worker_count, search_email, search_owner, country)
    VALUES (?, ?, 'active', ?, ?, ?, ?)
  `).run(opts.sessionId, Date.now(), opts.workerCount, opts.searchEmail ? 1 : 0, opts.searchOwner ? 1 : 0, opts.country);
}

export function updateSessionStatus(db: Database.Database, sessionId: string, status: SessionStatus) {
  db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId);
}

export function updateSessionTotalJobs(db: Database.Database, sessionId: string, total: number) {
  db.prepare(`UPDATE sessions SET total_jobs = ? WHERE id = ?`).run(total, sessionId);
}

export function getSession(db: Database.Database, sessionId: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as SessionRow | undefined;
}

// ─── Job helpers ──────────────────────────────────────────────────────────────

export function insertJobs(db: Database.Database, sessionId: string, rows: { stadt: string; branche: string; max_results?: number | null }[]): void {
  const stmt = db.prepare(`
    INSERT INTO jobs (id, session_id, stadt, branche, max_results, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  const insertMany = db.transaction((jobs: typeof rows) => {
    for (const job of jobs) {
      stmt.run(crypto.randomBytes(6).toString('hex'), sessionId, job.stadt, job.branche, job.max_results ?? null);
    }
  });
  insertMany(rows);
}

/**
 * Insert a single job and return its generated ID.
 * Used by the unified per-row pipeline to create a job row before inserting places.
 */
export function insertSingleJob(
  db: Database.Database,
  sessionId: string,
  job: { stadt: string; branche: string; max_results?: number | null }
): string {
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO jobs (id, session_id, stadt, branche, max_results, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(id, sessionId, job.stadt, job.branche, job.max_results ?? null);
  return id;
}

/**
 * Atomically claim the next pending job.
 * Returns null when no more pending jobs exist.
 */
export function claimNextJob(db: Database.Database, sessionId: string): JobRow | null {
  return db.transaction(() => {
    const job = db.prepare(`
      SELECT * FROM jobs
      WHERE session_id = ? AND status = 'pending'
      ORDER BY rowid ASC LIMIT 1
    `).get(sessionId) as JobRow | undefined;

    if (!job) return null;

    db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(Date.now(), job.id);

    return { ...job, status: 'running' as JobStatus };
  })();
}

export function markJobDone(db: Database.Database, jobId: string, status: JobStatus = 'done') {
  db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, jobId);
}

/** Reset a running job back to pending (e.g. when Maps scraping was interrupted by a block). */
export function resetJobToPending(db: Database.Database, jobId: string) {
  db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(jobId);
}

export function resetStaleJobs(db: Database.Database, sessionId: string) {
  // Called on resume – jobs that were 'running' when we crashed go back to 'pending'
  db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE session_id = ? AND status = 'running'`).run(sessionId);
  db.prepare(`UPDATE places SET enrich_status = 'pending' WHERE session_id = ? AND enrich_status = 'enriching'`).run(sessionId);
}

export function countJobs(db: Database.Database, sessionId: string): { pending: number; running: number; done: number } {
  const rows = db.prepare(`SELECT status, COUNT(*) as n FROM jobs WHERE session_id = ? GROUP BY status`).all(sessionId) as { status: string; n: number }[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = r.n;
  return { pending: map.pending ?? 0, running: map.running ?? 0, done: (map.done ?? 0) + (map.error ?? 0) };
}

// ─── Place helpers ────────────────────────────────────────────────────────────

export function insertPlace(
  db: Database.Database,
  sessionId: string,
  jobId: string,
  p: {
    name: string;
    website?: string;
    phone?: string;
    rating?: number;
    reviews?: number;
    hours?: string;
    address?: string;
    placeKey?: string;
  }
): string {
  const id = crypto.randomBytes(8).toString('hex');
  const enrichStatus: EnrichStatus = p.website ? 'pending' : 'no_website';
  db.prepare(`
    INSERT INTO places
      (id, session_id, job_id, name, website, phone, rating, reviews, hours, address, place_key, enrich_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, sessionId, jobId,
    p.name, p.website ?? null, p.phone ?? null,
    p.rating ?? null, p.reviews ?? null,
    p.hours ?? null, p.address ?? null, p.placeKey ?? null,
    enrichStatus, Date.now()
  );
  return id;
}

/**
 * Atomically claim the next place ready for enrichment.
 * Returns null when none available.
 */
export function claimNextPlace(db: Database.Database, sessionId: string): PlaceRow | null {
  return db.transaction(() => {
    const place = db.prepare(`
      SELECT * FROM places
      WHERE session_id = ? AND enrich_status = 'pending'
      ORDER BY rowid ASC LIMIT 1
    `).get(sessionId) as PlaceRow | undefined;

    if (!place) return null;

    db.prepare(`UPDATE places SET enrich_status = 'enriching' WHERE id = ?`).run(place.id);
    return { ...place, enrich_status: 'enriching' as EnrichStatus };
  })();
}

export function updatePlaceEnriched(
  db: Database.Database,
  placeId: string,
  data: {
    email?: string | null;
    owner?: string | null;
    ownerFirstNames?: string | null;
    ownerLastNames?: string | null;
    status: EnrichStatus;
  }
) {
  db.prepare(`
    UPDATE places
    SET email = ?, owner = ?, owner_first_names = ?, owner_last_names = ?, enrich_status = ?
    WHERE id = ?
  `).run(
    data.email ?? null,
    data.owner ?? null,
    data.ownerFirstNames ?? null,
    data.ownerLastNames ?? null,
    data.status,
    placeId
  );
}

/**
 * Fetch enrichment-done places that haven't been streamed yet.
 * Marks them as streamed atomically.
 */
export function drainStreamable(db: Database.Database, sessionId: string): PlaceRow[] {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT p.*, j.stadt, j.branche FROM places p
      JOIN jobs j ON j.id = p.job_id
      WHERE p.session_id = ? AND p.enrich_status IN ('done','skipped','no_website','error') AND p.streamed = 0
      ORDER BY p.rowid ASC
      LIMIT 50
    `).all(sessionId) as PlaceRow[];

    if (rows.length > 0) {
      const ids = rows.map(r => `'${r.id}'`).join(',');
      db.prepare(`UPDATE places SET streamed = 1 WHERE id IN (${ids})`).run();
    }
    return rows;
  })();
}

export function countPlaces(db: Database.Database, sessionId: string): { total: number; done: number } {
  const total = (db.prepare(`SELECT COUNT(*) as n FROM places WHERE session_id = ?`).get(sessionId) as { n: number }).n;
  const done  = (db.prepare(`SELECT COUNT(*) as n FROM places WHERE session_id = ? AND enrich_status IN ('done','skipped','no_website','error')`).get(sessionId) as { n: number }).n;
  return { total, done };
}

export function hasPendingPlaces(db: Database.Database, sessionId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM places WHERE session_id = ? AND enrich_status IN ('pending','enriching') LIMIT 1
  `).get(sessionId);
  return !!row;
}

// ─── Session list (for resume UI) ────────────────────────────────────────────

export function listSessions(): { id: string; path: string; created_at: number; status: string; total_jobs: number; worker_count: number }[] {
  const dir = path.join(process.cwd(), 'scraper-data');
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const id = f.replace('.db', '');
      const fullPath = path.join(dir, f);
      try {
        // If already open (active), use it
        if (dbCache.has(id)) {
          const db = dbCache.get(id)!;
          const session = db.prepare(`SELECT id, created_at, status, total_jobs, worker_count FROM sessions WHERE id = ?`).get(id) as any;
          if (session) {
             const countFn = db.prepare('SELECT COUNT(*) as c FROM places WHERE session_id = ?');
             const count = (countFn.get(id) as any).c;
             return { ...session, total_jobs: count, path: fullPath };
          }
          return null;
        }

        // Open read-only to check status without modifying cache
        const db = new Database(fullPath, { readonly: true });
        const session = db.prepare(`SELECT id, created_at, status, total_jobs, worker_count FROM sessions WHERE id = ?`).get(id) as any;
        if (session) {
             const countFn = db.prepare('SELECT COUNT(*) as c FROM places WHERE session_id = ?');
             const count = (countFn.get(id) as any).c;
             db.close();
             return { ...session, total_jobs: count, path: fullPath };
        }
        db.close();
        return null;
      } catch { return null; }
    })
    .filter(Boolean) as any[];
}

export function getAllPlaces(db: Database.Database, sessionId: string): any[] {
  return db.prepare(`
    SELECT p.*, j.stadt, j.branche
    FROM places p
    JOIN jobs j ON j.id = p.job_id
    WHERE p.session_id = ?
  `).all(sessionId);
}

