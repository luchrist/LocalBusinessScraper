/**
 * /api/resume – Resume an interrupted scraping session.
 *
 * GET /api/resume?session=<session_id>
 *
 * Loads the SQLite DB for the given session, resets any stale
 * 'running' jobs back to 'pending' (crash recovery), then re-runs the
 * full maps + enrichment + SSE stream pipeline.
 */

import { logger } from '@/lib/logger';
import { NextRequest } from 'next/server';
import { chromium } from 'playwright';
import { findContactInfo } from '@/lib/email-scraper';
import { GoogleMapsScraper } from '@/lib/maps-scraper';
import { ScraperPool } from '@/lib/scraper-pool';
import {
  openDb, closeDb, getSession, resetStaleJobs,
  claimNextJob, markJobDone, countJobs, updateSessionStatus,
  insertPlace, claimNextPlace, updatePlaceEnriched,
  drainStreamable, countPlaces, hasPendingPlaces, getAllPlaces,
  type EnrichStatus,
} from '@/lib/db';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session');
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing session parameter' }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();

  let isAborted = false;
  request.signal.addEventListener('abort', () => { isAborted = true; });

  const send = async (data: any) => {
    if (isAborted) return;
    try { await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
    catch { isAborted = true; }
  };

  (async () => {
    try {
      // ── Load session ────────────────────────────────────────────────────
      const db = openDb(sessionId);
      const session = getSession(db, sessionId);
      if (!session) {
        await send({ type: 'error', message: `Session ${sessionId} not found` });
        return;
      }

      // Reset stale jobs (crash recovery)
      resetStaleJobs(db, sessionId);
      updateSessionStatus(db, sessionId, 'active');

      const { 
        worker_count, search_email, search_owner, country,
        min_price, max_price, category_whitelist, category_blacklist
      } = session;
      const searchEmail = !!search_email;
      const searchOwner = !!search_owner;
      const totalJobs   = session.total_jobs;
      
      const sessionMinPrice = min_price ?? undefined;
      const sessionMaxPrice = max_price ?? undefined;
      
      const sessionWhitelist = category_whitelist ? category_whitelist.split(',').map(s => s.trim()).filter(Boolean) : [];
      const sessionBlacklist = category_blacklist ? category_blacklist.split(',').map(s => s.trim()).filter(Boolean) : [];

      await send({ type: 'session', sessionId, resumed: true });
      logger.log(`[Resume] Session ${sessionId} – ${totalJobs} total jobs, resuming`);

      // ── Email-enrichment browser (reused across enrichWorkers) ──────────
      const emailBrowser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
      });
      const emailContext = await emailBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
      });

      // ── Maps browser pool ───────────────────────────────────────────────
      const pool = new ScraperPool();
      await pool.initialize(1); // Force 1 Maps worker as scraping is no longer parallelized
      request.signal.addEventListener('abort', async () => {
        updateSessionStatus(db, sessionId, 'paused');
        await pool.close().catch(() => {});
      });

      const seenPlaceIds = new Set<string>();
      const seenDomains  = new Set<string>();

      // Pre-populate dedup sets from existing places so re-scraped jobs don't create duplicates
      const existingPlaces = db.prepare(
        `SELECT place_key, website FROM places WHERE session_id = ?`
      ).all(sessionId) as { place_key: string | null; website: string | null }[];
      for (const p of existingPlaces) {
        if (p.place_key) seenPlaceIds.add(p.place_key);
        if (p.website) {
          try { seenDomains.add(new URL(p.website).hostname.replace(/^www\./, '')); } catch {}
        }
      }

      // ── Send existing fully-enriched results to frontend immediately ──
      const allDBPlaces = getAllPlaces(db, sessionId);
      const c = countPlaces(db, sessionId);
      for (const row of allDBPlaces) {
        if (['done', 'skipped', 'no_website', 'error', 'success', 'no_match'].includes(row.enrich_status)) {
          await send({
            type: 'result',
            result: {
              stadt: (row as any).stadt ?? '', branche: (row as any).branche ?? '',
              name: row.name, adresse: row.address ?? undefined,
              telefon: row.phone ?? undefined, website: row.website ?? undefined,
              email: row.email ?? undefined, owner: row.owner ?? undefined,
              ownerFirstNames: row.owner_first_names ?? undefined,
              ownerLastNames: row.owner_last_names ?? undefined,
              hours: row.hours ?? undefined, rating: row.rating ?? undefined,
              reviews: row.reviews ?? undefined,
              status: row.enrich_status === 'done' ? 'success' : row.enrich_status,
            },
            current: c.done, total: c.total,
          });
        }
      }

      // ── LOOP A: Maps scraping ────────────────────────────────────────────
      const mapsWorkerLoop = async () => {
        let job;
        while ((job = claimNextJob(db, sessionId)) !== null) {
          if (isAborted) break;
          const { id: jobId, stadt, branche } = job;
          const worker = await pool.acquire();
          try {
            const c = countPlaces(db, sessionId);
            await send({
              type: 'progress',
              message: `[Resume] Scraping "${branche}" in "${stadt}"`,
              current: c.done, total: c.total,
              searchCount: countJobs(db, sessionId).done,
              totalSearches: totalJobs,
            });

            const scraper = new GoogleMapsScraper(
              worker.page!,
              sessionMinPrice,
              sessionMaxPrice,
              sessionWhitelist,
              sessionBlacklist
            );
            await scraper.search(stadt, branche);

            for await (const place of scraper.scrape(request.signal)) {
              if (isAborted) break;
              const placeKey = place.placeKey || `${place.name}|${place.address ?? ''}`;
              if (seenPlaceIds.has(placeKey)) continue;
              let domain: string | null = null;
              if (place.website) {
                try { domain = new URL(place.website).hostname.replace(/^www\./, ''); } catch {}
              }
              if (domain && seenDomains.has(domain)) continue;
              seenPlaceIds.add(placeKey);
              if (domain) seenDomains.add(domain);
              insertPlace(db, sessionId, jobId, {
                name: place.name, website: place.website, phone: place.phone,
                rating: place.rating, reviews: place.reviews,
                hours: place.hours, address: place.address, placeKey,
                exactIndustry: (place as any).exactIndustry,
              });
            }
            markJobDone(db, jobId, 'done');
          } catch (e) {
            logger.error(`[Resume][Maps] Job error ${jobId}:`, e);
            markJobDone(db, jobId, 'error');
          } finally {
            try { await worker.resetContext(); } catch {}
            pool.release(worker);
          }
        }
      };

      // ── LOOP B: Enrichment ───────────────────────────────────────────────
      const enrichWorkerLoop = async () => {
        let emptyRounds = 0;
        while (emptyRounds < 8) {
          if (isAborted) break;
          const place = claimNextPlace(db, sessionId);
          if (!place) {
            const jobs = countJobs(db, sessionId);
            emptyRounds = (jobs.pending === 0 && jobs.running === 0) ? emptyRounds + 1 : 0;
            await new Promise(r => setTimeout(r, 400));
            continue;
          }
          emptyRounds = 0;
          const branche = (db.prepare('SELECT branche FROM jobs WHERE id = ?').get(place.job_id) as any)?.branche ?? '';
          let email: string | null = null;
          let owner: string | null = null;
          let ownerSalutations: string | null = null;
          let ownerFirstNames: string | null = null;
          let ownerLastNames: string | null = null;
          let enrichStatus: EnrichStatus = 'skipped';
          if (place.website && (searchEmail || searchOwner)) {
            try {
              const info = await findContactInfo(emailContext, place.website, (msg) => logger.log(msg), {
                searchEmail, searchOwner, country,
                businessName: place.name, industry: branche,
              });
              email = info.email;
              owner = info.owner;
              ownerSalutations = info.ownerSalutations;
              ownerFirstNames = info.ownerFirstNames;
              ownerLastNames = info.ownerLastNames;
              enrichStatus = 'done';
            } catch {
              enrichStatus = 'error';
            }
          }
          updatePlaceEnriched(db, place.id, {
            email,
            owner,
            ownerSalutations,
            ownerFirstNames,
            ownerLastNames,
            status: enrichStatus,
          });
        }
      };

      // ── LOOP C: SSE stream ───────────────────────────────────────────────
      let pipelineDone = false;
      const streamLoop = async () => {
        while (!pipelineDone || hasPendingPlaces(db, sessionId)) {
          if (isAborted) break;
          const rows = drainStreamable(db, sessionId);
          for (const row of rows) {
            const c = countPlaces(db, sessionId);
            await send({
              type: 'result',
              result: {
                stadt: (row as any).stadt ?? '', branche: (row as any).branche ?? '',
                name: row.name, adresse: row.address ?? undefined,
                telefon: row.phone ?? undefined, website: row.website ?? undefined,
                email: row.email ?? undefined, owner: row.owner ?? undefined,
                ownerFirstNames: row.owner_first_names ?? undefined,
                ownerLastNames: row.owner_last_names ?? undefined,
                hours: row.hours ?? undefined, rating: row.rating ?? undefined,
                reviews: row.reviews ?? undefined,
                status: row.enrich_status === 'done' ? 'success' : row.enrich_status,
              },
              current: c.done, total: c.total,
            });
          }
          await new Promise(r => setTimeout(r, 500));
        }
        // Final drain
        for (const row of drainStreamable(db, sessionId)) {
          const c = countPlaces(db, sessionId);
          await send({
            type: 'result',
            result: {
              stadt: (row as any).stadt ?? '', branche: (row as any).branche ?? '',
              name: row.name, adresse: row.address ?? undefined,
              telefon: row.phone ?? undefined, website: row.website ?? undefined,
              email: row.email ?? undefined, owner: row.owner ?? undefined,
              ownerFirstNames: row.owner_first_names ?? undefined,
              ownerLastNames: row.owner_last_names ?? undefined,
              hours: row.hours ?? undefined, rating: row.rating ?? undefined,
              reviews: row.reviews ?? undefined,
              status: row.enrich_status === 'done' ? 'success' : row.enrich_status,
            },
            current: c.done, total: c.total,
          });
        }
      };

      // ── Run all loops ────────────────────────────────────────────────────
      await Promise.all([
        Promise.all(Array.from({ length: 1 }, () => mapsWorkerLoop())) // Force 1 Maps worker loop
          .then(() => pool.close()),
        Promise.all(Array.from({ length: Math.max(2, worker_count) }, () => enrichWorkerLoop())) // Parallel Enrichment
          .then(() => { pipelineDone = true; }),
        streamLoop(),
      ]);

      await emailContext.close();
      await emailBrowser.close();
      updateSessionStatus(db, sessionId, 'done');
      closeDb(sessionId);

      await send({ type: 'complete', message: 'Session completed!' });
    } catch (err) {
      logger.error('[Resume] Error:', err);
      await send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// List available sessions for the UI
export async function POST() {
  const { listSessions } = await import('@/lib/db');
  const sessions = listSessions();
  return new Response(JSON.stringify(sessions), {
    headers: { 'Content-Type': 'application/json' },
  });
}

