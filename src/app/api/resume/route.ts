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
import { Browser, chromium } from 'playwright';
import { findContactInfo } from '@/lib/email-scraper';
import { GoogleMapsScraper } from '@/lib/maps-scraper';
import { ScraperPool } from '@/lib/scraper-pool';
import { getNextAvailableKey, incrementApiKeyUsage } from '@/lib/settings-db';
import {
  openDb, closeDb, getSession, resetStaleJobs,
  claimNextJob, markJobDone, countJobs, updateSessionStatus,
  insertPlace, claimNextPlace, updatePlaceEnriched,
  drainStreamable, countPlaces, hasPendingPlaces, getAllPlaces,
  type EnrichStatus,
} from '@/lib/db';

interface Place {
  id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  hours?: string;
  price?: string;
  rating?: number;
  reviews?: number;
  exactIndustry?: string;
}

type SendEvent = Record<string, unknown>;

type LocationRestriction = {
  rectangle: {
    low: { latitude: number; longitude: number };
    high: { latitude: number; longitude: number };
  };
};

interface PlacesApiPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  primaryTypeDisplayName?: { text?: string };
}

interface PlacesApiResponse {
  places?: PlacesApiPlace[];
  nextPageToken?: string;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session');
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing session parameter' }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const runAbortController = new AbortController();
  let activeEmailBrowser: Browser | null = null;
  let activePool: ScraperPool | null = null;
  let activeSessionId: string | null = null;

  let isAborted = false;
  request.signal.addEventListener('abort', () => {
    isAborted = true;
    runAbortController.abort();
    void activePool?.close().catch(() => {});
    void activeEmailBrowser?.close().catch(() => {});
  });

  const send = async (data: SendEvent) => {
    if (isAborted) return;
    try { await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
    catch { isAborted = true; }
  };

  (async () => {
    try {
      // ── Load session ────────────────────────────────────────────────────
      const db = openDb(sessionId);
      activeSessionId = sessionId;
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
      const checkCategory = (exactIndustryRaw?: unknown): boolean => {
        if (!exactIndustryRaw) return true;
        const exactIndustry = typeof exactIndustryRaw === 'string' ? exactIndustryRaw : exactIndustryRaw.toString();
        if (typeof exactIndustry !== 'string') return true;
        const industryLower = exactIndustry.toLowerCase();
        const isWhitelisted = sessionWhitelist.some((term: string) => industryLower.includes(term.toLowerCase()));
        const isBlacklisted = sessionBlacklist.some((term: string) => industryLower.includes(term.toLowerCase()));
        return !isBlacklisted || isWhitelisted;
      };
      const parsePriceAndMatch = (priceString?: string): boolean => {
        if (!priceString) return true;
        const rangeMatch = priceString.match(/(\d+)[^\d]+(\d+)/);
        let bounds: { lowerBound: number; upperBound: number } | null = null;
        if (rangeMatch) {
          bounds = { lowerBound: parseInt(rangeMatch[1], 10), upperBound: parseInt(rangeMatch[2], 10) };
        } else {
          const moreThanMatch = priceString.match(/(mehr als|more than|>|ab)\s*.*?(\d+)/i);
          if (moreThanMatch) bounds = { lowerBound: parseInt(moreThanMatch[2], 10), upperBound: Infinity };
          else {
            const singleNumberMatch = priceString.match(/(\d+)/);
            if (singleNumberMatch) {
              const val = parseInt(singleNumberMatch[1], 10);
              bounds = { lowerBound: val, upperBound: val };
            } else {
              const euroCount = (priceString.match(/€/g) || []).length;
              if (euroCount === 1) bounds = { lowerBound: 0, upperBound: 10 };
              if (euroCount === 2) bounds = { lowerBound: 10, upperBound: 25 };
              if (euroCount === 3) bounds = { lowerBound: 25, upperBound: 50 };
              if (euroCount >= 4) bounds = { lowerBound: 50, upperBound: Infinity };
            }
          }
        }
        if (!bounds) return true;
        if (sessionMinPrice !== undefined && bounds.lowerBound < sessionMinPrice) return false;
        if (sessionMaxPrice !== undefined && bounds.upperBound > sessionMaxPrice) return false;
        return true;
      };

      await send({ type: 'session', sessionId, resumed: true });
      logger.log(`[Resume] Session ${sessionId} – ${totalJobs} total jobs, resuming`);

      // ── Email-enrichment browser (reused across enrichWorkers) ──────────
      const emailBrowser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
      });
      activeEmailBrowser = emailBrowser;
      const emailContext = await emailBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
      });

      const pendingJobs = db.prepare(`
        SELECT max_results, stufe FROM jobs
        WHERE session_id = ? AND status = 'pending'
      `).all(sessionId) as { max_results: number | null; stufe: number | null }[];
      const hasScrapingJobs = pendingJobs.some(job => {
        const effectiveMax = job.max_results != null && job.max_results > 0 ? job.max_results : Infinity;
        const stufe = job.stufe ?? 0;
        return !(stufe >= 1 || effectiveMax <= 60);
      });

      // ── Maps browser pool ───────────────────────────────────────────────
      const pool = hasScrapingJobs ? new ScraperPool() : null;
      activePool = pool;
      if (pool) await pool.initialize(1); // Force 1 Maps worker as scraping is no longer parallelized
      request.signal.addEventListener('abort', async () => {
        updateSessionStatus(db, sessionId, 'paused');
        await pool?.close().catch(() => {});
      });

      const seenPlaceIds = new Set<string>();
      const seenDomains  = new Set<string>();
      const scrapedNames = new Set<string>();

      // Pre-populate dedup sets from existing places so re-scraped jobs don't create duplicates
      const existingPlaces = db.prepare(
        `SELECT place_key, website, name FROM places WHERE session_id = ?`
      ).all(sessionId) as { place_key: string | null; website: string | null; name: string | null }[];
      for (const p of existingPlaces) {
        if (p.place_key) seenPlaceIds.add(p.place_key);
        if (p.website) {
          try { seenDomains.add(new URL(p.website).hostname.replace(/^www\./, '')); } catch {}
        }
        if (p.name) scrapedNames.add(p.name);
      }

      // ── Send existing fully-enriched results to frontend immediately ──
      const allDBPlaces = getAllPlaces(db, sessionId);
      const c = countPlaces(db, sessionId);
      for (const row of allDBPlaces) {
        if (['done', 'skipped', 'no_website', 'error', 'success', 'no_match'].includes(row.enrich_status)) {
          await send({
            type: 'result',
            result: {
              stadt: row.stadt ?? '', branche: row.branche ?? '',
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
          const effectiveMax = job.max_results != null && job.max_results > 0 ? job.max_results : Infinity;
          const stufe = job.stufe ?? 0;
          const isApi = stufe >= 1 || effectiveMax <= 60;
          const mode = isApi ? (stufe >= 1 ? `API Grid Stufe ${stufe}` : 'API') : 'Scraping';

          try {
            const c = countPlaces(db, sessionId);
            await send({
              type: 'progress',
              message: `[Resume][${mode}] "${branche}" in "${stadt}"`,
              current: c.done, total: c.total,
              searchCount: countJobs(db, sessionId).done,
              totalSearches: totalJobs,
            });

            if (isApi) {
              let allPlacesRaw: Place[] = [];

              if (stufe >= 1) {
                const gridSide = stufe + 1;
                logger.log(`[Resume][Grid] "${stadt}" Stufe ${stufe} → ${gridSide}×${gridSide}`);
                const bbox = await getCityBoundingBox(stadt, country);
                const gridCells = splitBoundingBox(bbox, stufe);
                await send({
                  type: 'progress',
                  message: `[Resume][Grid] "${stadt}" in ${gridCells.length} Quadranten aufgeteilt (Stufe ${stufe} → ${gridSide}×${gridSide})`,
                  current: c.done, total: c.total,
                  searchCount: countJobs(db, sessionId).done,
                  totalSearches: totalJobs,
                });

                const gridSeenIds = new Set<string>();
                for (const cell of gridCells) {
                  if (isAborted) break;
                  const cellPlaces = await searchGridCellRecursive(
                    cell,
                    stadt,
                    branche,
                    send,
                    () => isAborted,
                    runAbortController.signal,
                    0,
                    gridSeenIds,
                  );
                  allPlacesRaw.push(...cellPlaces);
                }
              } else {
                allPlacesRaw = await searchPlaces(stadt, branche, effectiveMax, send, () => isAborted, undefined, runAbortController.signal);
              }

              let rowProcessedCount = 0;
              for (const place of allPlacesRaw) {
                if (isAborted) break;
                if (rowProcessedCount >= effectiveMax) break;
                if (!parsePriceAndMatch(place.price) || !checkCategory(place.exactIndustry)) continue;

                const placeKey = place.id || `${place.name}|${place.address ?? ''}`;
                if (seenPlaceIds.has(placeKey)) continue;
                let domain: string | null = null;
                if (place.website) {
                  try { domain = new URL(place.website).hostname.replace(/^www\./, ''); } catch {}
                }
                if (domain && seenDomains.has(domain)) continue;

                seenPlaceIds.add(placeKey);
                if (domain) seenDomains.add(domain);
                insertPlace(db, sessionId, jobId, {
                  name: place.name,
                  website: place.website,
                  phone: place.phone,
                  rating: place.rating,
                  reviews: place.reviews,
                  hours: place.hours,
                  price: place.price,
                  address: place.address,
                  placeKey,
                  exactIndustry: place.exactIndustry,
                });
                rowProcessedCount++;
              }

              markJobDone(db, jobId, 'done');
              continue;
            }

            if (!pool) throw new Error('Maps pool not initialized for scraping resume job');
            const worker = await pool.acquire();
            try {
              const scraper = new GoogleMapsScraper(
                worker.page!,
                sessionMinPrice,
                sessionMaxPrice,
                sessionWhitelist,
                sessionBlacklist,
                scrapedNames
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
                  exactIndustry: place.exactIndustry,
                });
              }
              markJobDone(db, jobId, 'done');
            } finally {
              try { await worker.resetContext(); } catch {}
              pool.release(worker);
            }
          } catch (e) {
            logger.error(`[Resume][Maps] Job error ${jobId}:`, e);
            markJobDone(db, jobId, 'error');
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
          const branche = (db.prepare('SELECT branche FROM jobs WHERE id = ?').get(place.job_id) as { branche: string } | undefined)?.branche ?? '';
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
                businessName: place.name, industry: branche, businessCity: place.stadt,
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
                stadt: row.stadt ?? '', branche: row.branche ?? '',
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
              stadt: row.stadt ?? '', branche: row.branche ?? '',
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
          .then(async () => {
            await pool?.close();
            activePool = null;
          }),
        Promise.all(Array.from({ length: Math.max(2, worker_count) }, () => enrichWorkerLoop())) // Parallel Enrichment
          .then(() => { pipelineDone = true; }),
        streamLoop(),
      ]);

      await emailContext.close();
      await emailBrowser.close();
      activeEmailBrowser = null;
      updateSessionStatus(db, sessionId, 'done');
      closeDb(sessionId);

      await send({ type: 'complete', message: 'Session completed!' });
    } catch (err) {
      logger.error('[Resume] Error:', err);
      await send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      const { shutdownWorker } = await import('@/lib/llm-extractor');
      logger.log('🏁 Resume route execution finished, cleaning up resources...');
      await activePool?.close().catch(() => {});
      await activeEmailBrowser?.close().catch(() => {});
      if (activeSessionId) {
        try { closeDb(activeSessionId); } catch {}
      }
      await shutdownWorker(); // Destroy LLM worker to avoid memory leaks
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

interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface GridCell {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
  label: string;
}

async function getCityBoundingBox(city: string, country: string): Promise<BoundingBox> {
  const apiKey = getNextAvailableKey();
  if (!apiKey) throw new Error('No API key available for geocoding');

  logger.log(`[Resume][BBox] Geocoding "${city}, ${country}" (Key: ...${apiKey.slice(-4)})`);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city + ', ' + country)}&key=${apiKey}`;
  const response = await fetch(url);
  incrementApiKeyUsage(apiKey);

  if (!response.ok) throw new Error(`Geocoding API error: ${response.status}`);
  const data = await response.json();
  if (!data.results || data.results.length === 0) throw new Error(`Geocoding: No results for "${city}"`);

  const result = data.results[0];
  const viewport = result.geometry.viewport;
  const bounds = result.geometry.bounds;
  return {
    north: bounds ? Math.max(viewport.northeast.lat, bounds.northeast.lat) : viewport.northeast.lat,
    east: bounds ? Math.max(viewport.northeast.lng, bounds.northeast.lng) : viewport.northeast.lng,
    south: bounds ? Math.min(viewport.southwest.lat, bounds.southwest.lat) : viewport.southwest.lat,
    west: bounds ? Math.min(viewport.southwest.lng, bounds.southwest.lng) : viewport.southwest.lng,
  };
}

function splitBoundingBox(bbox: BoundingBox, stufe: number): GridCell[] {
  if (stufe < 1) return [];
  const side = stufe + 1;
  const totalCells = side * side;
  const cellHeight = (bbox.north - bbox.south) / side;
  const cellWidth = (bbox.east - bbox.west) / side;
  const cells: GridCell[] = [];
  let cellNum = 0;

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      cellNum++;
      cells.push({
        low: {
          latitude: bbox.south + row * cellHeight,
          longitude: bbox.west + col * cellWidth,
        },
        high: {
          latitude: bbox.south + (row + 1) * cellHeight,
          longitude: bbox.west + (col + 1) * cellWidth,
        },
        label: `Quadrant ${cellNum}/${totalCells}`,
      });
    }
  }

  return cells;
}

function splitCellInHalf(cell: GridCell): [GridCell, GridCell] {
  const latRange = cell.high.latitude - cell.low.latitude;
  const lngRange = cell.high.longitude - cell.low.longitude;

  if (latRange >= lngRange) {
    const mid = cell.low.latitude + latRange / 2;
    return [
      { low: cell.low, high: { latitude: mid, longitude: cell.high.longitude }, label: `${cell.label}a` },
      { low: { latitude: mid, longitude: cell.low.longitude }, high: cell.high, label: `${cell.label}b` },
    ];
  }

  const mid = cell.low.longitude + lngRange / 2;
  return [
    { low: cell.low, high: { latitude: cell.high.latitude, longitude: mid }, label: `${cell.label}a` },
    { low: { latitude: cell.low.latitude, longitude: mid }, high: cell.high, label: `${cell.label}b` },
  ];
}

const MAX_GRID_DEPTH = 3;

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function searchGridCellRecursive(
  cell: GridCell,
  stadt: string,
  branche: string,
  sendProgress: (data: SendEvent) => Promise<void>,
  shouldAbort: () => boolean,
  abortSignal?: AbortSignal,
  depth: number = 0,
  globalSeenIds?: Set<string>,
  parentIds?: Set<string>,
): Promise<Place[]> {
  if (!globalSeenIds) globalSeenIds = new Set();
  if (!parentIds) parentIds = new Set();
  if (shouldAbort()) return [];

  await sendProgress({
    type: 'progress',
    message: `[Resume][Grid] Suche ${cell.label}${depth > 0 ? ` (Tiefe ${depth})` : ''}`,
  });

  const places = await searchPlaces(
    stadt,
    branche,
    undefined,
    sendProgress,
    shouldAbort,
    { rectangle: { low: cell.low, high: cell.high } },
    abortSignal,
  );

  const foreignDup = places.find(p => globalSeenIds!.has(p.id) && !parentIds!.has(p.id));
  const thisIds = new Set(places.map(p => p.id));
  for (const id of thisIds) globalSeenIds.add(id);

  if (foreignDup) {
    logger.log(`[Resume][Grid] ${cell.label}: locationRestriction scheint ignoriert zu werden, stoppe weitere Unterteilung`);
    return places;
  }

  if (places.length >= 60 && depth < MAX_GRID_DEPTH) {
    await sendProgress({
      type: 'progress',
      message: `[Resume][Grid] ${cell.label} hat ${places.length} Ergebnisse - wird geteilt (Tiefe ${depth + 1})`,
    });
    const [cellA, cellB] = splitCellInHalf(cell);
    const [placesA, placesB] = await Promise.all([
      searchGridCellRecursive(cellA, stadt, branche, sendProgress, shouldAbort, abortSignal, depth + 1, globalSeenIds, thisIds),
      searchGridCellRecursive(cellB, stadt, branche, sendProgress, shouldAbort, abortSignal, depth + 1, globalSeenIds, thisIds),
    ]);
    return [...placesA, ...placesB];
  }

  return places;
}

async function searchPlaces(
  stadt: string,
  branche: string,
  maxBusinesses?: number,
  sendProgress?: (data: SendEvent) => Promise<void>,
  shouldAbort?: () => boolean,
  locationRestriction?: LocationRestriction,
  abortSignal?: AbortSignal,
): Promise<Place[]> {
  const query = locationRestriction ? branche : `${branche} in ${stadt}`;
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const allPlaces: Place[] = [];
  let pageToken: string | undefined;
  let pageNumber = 1;
  const priceLevelMap: Record<string, string> = {
    PRICE_LEVEL_INEXPENSIVE: '€',
    PRICE_LEVEL_MODERATE: '€€',
    PRICE_LEVEL_EXPENSIVE: '€€€',
    PRICE_LEVEL_VERY_EXPENSIVE: '€€€€',
  };

  do {
    if (shouldAbort?.()) break;

    let apiKey: string | null = null;
    while (!apiKey) {
      apiKey = getNextAvailableKey();
      if (!apiKey) {
        await sendProgress?.({
          type: 'blocked',
          level: 1,
          label: 'API Keys Exhausted',
          message: 'Das Limit von 1000 Aufrufen pro API Key wurde erreicht. Bitte neue Keys in den Einstellungen hinzufügen.',
        });
        await abortableDelay(5000, abortSignal);
      }
    }

    const requestBody: { textQuery: string; locationRestriction?: LocationRestriction; pageToken?: string } = { textQuery: query };
    if (locationRestriction) requestBody.locationRestriction = locationRestriction;
    if (pageToken) requestBody.pageToken = pageToken;

    logger.log(`[Resume][API] Page ${pageNumber}: "${query}"${locationRestriction ? ' (grid-restricted)' : ''} (Key: ...${apiKey.slice(-4)})`);
    const response = await fetch(url, {
      method: 'POST',
      signal: abortSignal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.rating,places.userRatingCount,places.priceLevel,places.primaryTypeDisplayName,nextPageToken',
      },
      body: JSON.stringify(requestBody),
    });
    incrementApiKeyUsage(apiKey);

    if (!response.ok) throw new Error(`Google Places API error: ${response.status} ${response.statusText}`);

    const data = await response.json() as PlacesApiResponse;
    const places = data.places || [];
    allPlaces.push(...places.map((place) => ({
      id: place.id || '',
      name: place.displayName?.text || '',
      address: place.formattedAddress || '',
      phone: place.nationalPhoneNumber || '',
      website: place.websiteUri || '',
      rating: place.rating,
      reviews: place.userRatingCount,
      hours: place.regularOpeningHours?.weekdayDescriptions?.join(' | '),
      price: place.priceLevel ? priceLevelMap[place.priceLevel] : undefined,
      exactIndustry: place.primaryTypeDisplayName?.text || undefined,
    })));

    pageToken = data.nextPageToken;
    pageNumber++;
    if (pageToken) await abortableDelay(500, abortSignal);
  } while (pageToken && (!maxBusinesses || allPlaces.length < maxBusinesses) && !shouldAbort?.());

  return allPlaces;
}
