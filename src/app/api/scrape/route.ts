//api/scrape
import { logger } from '@/lib/logger';
import os from 'os';
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { chromium, BrowserContext, Browser } from 'playwright';
import { findContactInfo } from '@/lib/email-scraper';
import { GoogleMapsScraper, BlockDetectionError } from '@/lib/maps-scraper';
import { ScraperPool } from '@/lib/scraper-pool';
import { shutdownWorker } from '@/lib/llm-extractor';
import { getNextAvailableKey, incrementApiKeyUsage, initSettingsDb } from '@/lib/settings-db';
import {
  openDb, closeDb, newSessionId, createSession, insertSingleJob, insertPlace, updatePlaceEnriched, updateSessionTotalJobs, claimNextPlace, hasPendingPlaces, hasUnfinishedWork, drainStreamable, isSessionCancelled,
  type EnrichStatus,
} from '@/lib/db';


interface BusinessData {
  Stadt?: string;
  stadt?: string;
  Branche?: string;
  branche?: string;
}

interface BusinessResult {
  stadt: string;
  branche: string;
  name?: string;
  adresse?: string;
  telefon?: string;
  website?: string;
  email?: string;
  owner?: string;  ownerSalutations?: string;  ownerFirstNames?: string;
  ownerLastNames?: string;
  status: string;
  hours?: string;
  price?: string;
  rating?: number;
  reviews?: number;
}

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

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Helper to flexibly get column values
function getColumnValue(row: any, keys: string[]): string | undefined {
  const rowKeys = Object.keys(row);
  for (const key of keys) {
    // Exact match
    if (row[key]) return row[key];
    
    // Case-insensitive match from row keys
    const foundKey = rowKeys.find(k => k.toLowerCase() === key.toLowerCase());
    if (foundKey && row[foundKey]) return row[foundKey];
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  // Initialize settings DB once requested
  try {
    initSettingsDb();
  } catch (e) {
    logger.error('Failed to initialize settings DB:', e);
  }

  logger.log('🚀 Scraping request started');
  
  if (!GOOGLE_PLACES_API_KEY) {
    // Legacy check removed, using DB keys now.
    // logger.error('❌ Google Places API Key missing');
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  
  // Tracks only SSE connection state – does NOT stop enrichment.
  // Enrichment uses the DB cancelled flag instead (see isSessionCancelled).
  let clientDisconnected = false;
  request.signal.addEventListener('abort', () => {
      logger.log('⚠️ Client disconnected (sleep / tab close / explicit cancel)');
      clientDisconnected = true;
  });

  const sendProgress = async (data: any) => {
    if (clientDisconnected) return;
    try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
        clientDisconnected = true;
    }
  };

  // Start processing in background
  (async () => {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File;
      const searchEmail = formData.get('searchEmail') === 'true';
      const searchOwner = formData.get('searchOwner') === 'true';
      const singleWorker = formData.get('singleWorker') === 'true';
      const country = (formData.get('country') as string) || 'de';
      const enrichmentWorkerCountRaw = parseInt(formData.get('enrichmentWorkerCount') as string) || 0;
      const maxBusinessesStr = formData.get('maxBusinesses') as string;
      const maxBusinesses = maxBusinessesStr === 'max' ? Infinity : parseInt(maxBusinessesStr) || Infinity;

      const minPriceStr = formData.get('minPrice') as string;
      const minPrice = minPriceStr ? parseInt(minPriceStr) : undefined;
      const maxPriceStr = formData.get('maxPrice') as string;
      const maxPrice = maxPriceStr ? parseInt(maxPriceStr) : undefined;

      const categoryWhitelistStr = formData.get('categoryWhitelist') as string || '';
      const categoryWhitelist = categoryWhitelistStr.split(',').map(s => s.trim()).filter(Boolean);

      const categoryBlacklistStr = formData.get('categoryBlacklist') as string || '';
      const categoryBlacklist = categoryBlacklistStr.split(',').map(s => s.trim()).filter(Boolean);

  const checkCategory = (exactIndustryRaw?: any): boolean => {
    if (!exactIndustryRaw) return true;
    const exactIndustry = typeof exactIndustryRaw === 'string' ? exactIndustryRaw : exactIndustryRaw?.text || exactIndustryRaw?.toString();
    if (typeof exactIndustry !== 'string') return true;
    const industryLower = exactIndustry.toLowerCase();
    const isWhitelisted = categoryWhitelist.some((term: string) => industryLower.includes(term.toLowerCase()));
    const isBlacklisted = categoryBlacklist.some((term: string) => industryLower.includes(term.toLowerCase()));
    if (isBlacklisted && !isWhitelisted) return false;
    return true;
  };

      const parsePriceAndMatch = (priceString?: string): boolean => {
        if (!priceString) return true;
        const rangeMatch = priceString.match(/(\d+)[^\d]+(\d+)/);
        let bounds: { lowerBound: number, upperBound: number } | null = null;
        if (rangeMatch) bounds = { lowerBound: parseInt(rangeMatch[1], 10), upperBound: parseInt(rangeMatch[2], 10) };
        else {
          const moreThanMatch = priceString.match(/(mehr als|more than|>|>|ab)\s*.*?(\d+)/i);
          if (moreThanMatch) bounds = { lowerBound: parseInt(moreThanMatch[2], 10), upperBound: Infinity };
          else {
            const singleNumberMatch = priceString.match(/(\d+)/);
            if (singleNumberMatch) { const val = parseInt(singleNumberMatch[1], 10); bounds = { lowerBound: val, upperBound: val }; }
            else {
              const euroCount = (priceString.match(/€/g) || []).length;
              if (euroCount === 1) bounds = { lowerBound: 0, upperBound: 10 };
              if (euroCount === 2) bounds = { lowerBound: 10, upperBound: 25 };
              if (euroCount === 3) bounds = { lowerBound: 25, upperBound: 50 };
              if (euroCount >= 4) bounds = { lowerBound: 50, upperBound: Infinity };
            }
          }
        }
        if (!bounds) return true;
        if (minPrice !== undefined && bounds.lowerBound < minPrice) return false;
        if (maxPrice !== undefined && bounds.upperBound > maxPrice) return false;
        return true;
      };

      // Clear logs at the start of a new scrape
      logger.clear();

      if (!file) {
        logger.error('❌ No file uploaded');
        await sendProgress({ type: 'error', message: 'No file uploaded' });
        await writer.close();
        return;
      }

      logger.log(`📁 File received: ${file.name} (${file.size} bytes)`);
      logger.log(`⚙️  Options: searchEmail=${searchEmail}, searchOwner=${searchOwner}, country=${country}, maxBusinesses=${maxBusinesses}`);

      // Parse Excel or CSV file
      const buffer = await file.arrayBuffer();
      let workbook;
      
      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = new TextDecoder('utf-8').decode(buffer);
        workbook = XLSX.read(text, { type: 'string' });
      } else {
        workbook = XLSX.read(buffer);
      }
      
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet);
      logger.log(`📊 Excel file parsed: ${rawData.length} rows found`);

      // Normalize data structure
      const data = rawData.map((row: any) => {
        const maxRaw = getColumnValue(row, ['max', 'maximum', 'max_results', 'maxresults']);
        const rowMax = maxRaw ? parseInt(maxRaw) : undefined;
        const stufeRaw = getColumnValue(row, ['stufe', 'level', 'grid', 'quadrat', 'split']);
        const stufe = stufeRaw ? parseInt(stufeRaw) : 0;
        return {
          stadt: getColumnValue(row, ['stadt', 'city', 'ort', 'location', 'town']),
          branche: getColumnValue(row, ['branche', 'industry', 'category', 'keyword', 'niche', 'business']),
          max_results: rowMax && !isNaN(rowMax) && rowMax > 0 ? rowMax : null,
          stufe: !isNaN(stufe) && stufe >= 1 ? stufe : 0,
        };
      }).filter(row => row.stadt && row.branche); // Filter out empty or invalid rows

      logger.log(`✅ Normalized data: ${data.length} valid search rows ready`);

      if (data.length === 0) {
        throw new Error('No valid rows found. Please ensure columns are named "Stadt"/"City" and "Branche"/"Industry".');
      }

      // SQLite session – scraping results written to disk immediately, never piling up in RAM
      const sessionId = newSessionId();
      const db = openDb(sessionId);
      createSession(db, {
        sessionId,
        workerCount: 1, 
        searchEmail, 
        searchOwner, 
        country,
        minPrice, 
        maxPrice, 
        categoryWhitelist, 
        categoryBlacklist 
      });
      await sendProgress({ type: 'session', sessionId });

      const seenPlaceIds = new Set<string>();
      const seenDomains = new Set<string>();

      const browser = await chromium.launch({  
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-features=BackForwardCache',
          '--disable-extensions'
        ]
      });

      // OPTIMIZATION: Context recreation function to prevent Memory/BFCache bloat
      const createEnrichmentContext = async () => {
        const ctx = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1920, height: 1080 },
          locale: 'de-DE',
          timezoneId: 'Europe/Berlin',
        });

        // OPTIMIZATION: Block images, fonts, css and analytics to save resources
        await ctx.route('**/*', (route: any) => {
          const type = route.request().resourceType();
          const url = route.request().url();
          
          if (['image', 'font', 'stylesheet', 'media'].includes(type) ||
              url.includes('google-analytics') || 
              url.includes('googletagmanager') || 
              url.includes('facebook.com') || 
              url.includes('doubleclick')) {
            return route.abort();
          }

          return route.continue();
        });
        return ctx;
      };

      logger.log('🌐 Browser launched');

      let processedBusinesses = 0;
      let totalBusinessesFound = 0; // Total businesses found so far
      let searchCount = 0;
      const totalSearches = data.length;

      // ── Block detection state ─────────────────────────────────────────
      let mapsPaused = false; // set to true when a block is detected
      let softBlockWarningActive = false;
      let placesScrapedSinceWarning = 0;

      // ── Unified pipeline: per-row decision API (effectiveMax ≤ 60) vs Scraping (> 60) ──
      const hasScrapingRows = data.some(row => (row.max_results ?? maxBusinesses) > 60);
      const workerCount = 1; // Always 1 Maps scraper worker since scraping is not done in parallel globally
      const pool = new ScraperPool();
      if (hasScrapingRows) {
        logger.log(`[Pool] ${workerCount} Maps worker(s) initialised – some rows will use scraping`);
        await pool.initialize(workerCount);
        request.signal.addEventListener('abort', async () => {
          await pool.close().catch(() => {});
        });
      }

      // ── Sort searches into a single Task array to run sequentially ──
      const allTasks: (() => Promise<void>)[] = [];

      // Find last row that needs the Maps browser so it can be closed early
      let lastScrapingRowIdx = -1;
      for (let i = data.length - 1; i >= 0; i--) {
        const em = (data[i].max_results != null && data[i].max_results! > 0) ? data[i].max_results! : maxBusinesses;
        if (em > 60) { lastScrapingRowIdx = i; break; }
      }
      let poolClosed = false;

      // ─── BACKGROUND ENRICHMENT POLLER ───
      let mapsFinished = false;

      async function runEnrichmentPoller() {
        // Runs until natural DB completion or explicit session cancel.
        // Client disconnect (sleep / tab close) does NOT stop this loop.
          while (true) {
            let currentPlaceId: string | null = null;
            try {
              if (isSessionCancelled(db, sessionId)) {
                logger.log('[Enrichment] Session cancelled – stopping worker.');
                break;
              }
            const placeR = claimNextPlace(db, sessionId);
            if (!placeR) {
              const missedRows = drainStreamable(db, sessionId);
              for (const row of missedRows) {
                processedBusinesses++;
                await sendProgress({
                  type: 'result',
                  result: {
                    stadt: row.stadt, branche: row.branche, name: row.name, adresse: row.address ?? undefined,
                    telefon: row.phone ?? undefined, website: row.website ?? undefined,
                    email: row.email || undefined, owner: row.owner || undefined,
                    ownerSalutations: row.owner_salutations || undefined,
                    ownerFirstNames: row.owner_first_names || undefined,
                    ownerLastNames: row.owner_last_names || undefined,
                    status: row.enrich_status as any, hours: row.hours ?? undefined,
                    price: row.price ?? undefined, rating: row.rating ?? undefined, reviews: row.reviews ?? undefined,
                  },
                  current: processedBusinesses, total: totalBusinessesFound,
                });
              }
              // Exit only when Maps is done AND no pending/enriching rows remain
              // AND all terminal-state rows have been streamed (covers no_website / skipped).
              if (mapsFinished && !hasUnfinishedWork(db, sessionId)) {
                break;
              }
              await new Promise(r => setTimeout(r, 500));
              continue;
            }
            
            currentPlaceId = placeR.id;

            let email: string | null = null;
            let owner: string | null = null;
            let ownerSalutations: string | null = null;
            let ownerFirstNames: string | null = null;
            let ownerLastNames: string | null = null;
            let enrichStatus = 'no_website';

            if (placeR.website && (searchEmail || searchOwner)) {
              const siteContext = await createEnrichmentContext();
              try {
                const ENRICHMENT_TIMEOUT_MS = 90_000;
                const info = await Promise.race([
                  findContactInfo(siteContext, placeR.website, (msg) => logger.log(msg), {
                    searchEmail, searchOwner, country, businessName: placeR.name, industry: placeR.branche, businessCity: placeR.stadt,
                  }),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`Enrichment timeout after ${ENRICHMENT_TIMEOUT_MS / 1000}s`)), ENRICHMENT_TIMEOUT_MS)
                  ),
                ]);
                email = info.email;
                owner = info.owner;
                ownerSalutations = info.ownerSalutations;
                ownerFirstNames = info.ownerFirstNames;
                ownerLastNames = info.ownerLastNames;
                enrichStatus = (searchEmail && email) || (searchOwner && owner) ? 'success' : 'no_match';
              } catch (err) {
                logger.error(`[Enrich] Error ${placeR.website}:`, err);
                enrichStatus = 'error';
              } finally {
                await siteContext.close().catch(() => {});
              }
            } else if (!placeR.website) {
              enrichStatus = 'no_website';
            } else {
              enrichStatus = 'skipped';
            }

            updatePlaceEnriched(db, placeR.id, {
              email: email || null,
              owner: owner || null,
              ownerSalutations: ownerSalutations || null,
              ownerFirstNames: ownerFirstNames || null,
              ownerLastNames: ownerLastNames || null,
              status: enrichStatus as EnrichStatus,
            });

            const scrapingResult: BusinessResult = {
              stadt: placeR.stadt, branche: placeR.branche, name: placeR.name, adresse: placeR.address ?? undefined,
              telefon: placeR.phone ?? undefined, website: placeR.website ?? undefined,
              email: email || undefined,
              owner: owner || undefined,
              ownerSalutations: ownerSalutations || undefined,
              ownerFirstNames: ownerFirstNames || undefined,
              ownerLastNames: ownerLastNames || undefined,
              status: enrichStatus, hours: placeR.hours ?? undefined,
              price: placeR.price ?? undefined,
              rating: placeR.rating ?? undefined, reviews: placeR.reviews ?? undefined,
            };

            db.prepare(`UPDATE places SET streamed = 1 WHERE id = ?`).run(placeR.id);

            processedBusinesses++;
            await sendProgress({
              type: 'result', result: scrapingResult,
              current: processedBusinesses, total: totalBusinessesFound,
            });
          } catch (err) {
            // Catch unexpected errors (e.g. browser crash) so a single failed
            // iteration doesn't silently kill the whole poller.
            logger.error('[Enrichment] Worker iteration error – retrying in 1s:', err);
            if (currentPlaceId) {
              try {
                updatePlaceEnriched(db, currentPlaceId, { status: 'error' });
              } catch (updateErr) {
                logger.error('[Enrichment] Failed to mark crashed place as error:', updateErr);
              }
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }

      const gbRam = os.totalmem() / 1024 ** 3;
      let enrichmentConcurrency = 1;
      if (enrichmentWorkerCountRaw > 0) {
        enrichmentConcurrency = Math.max(1, enrichmentWorkerCountRaw);
      } else {
        if (gbRam > 16) enrichmentConcurrency = 4;
        else if (gbRam > 8) enrichmentConcurrency = 3;
        else enrichmentConcurrency = 2;
      }
      if (singleWorker) enrichmentConcurrency = 1;

      logger.log(`[Enrichment] Starting ${enrichmentConcurrency} background workers.`);
      const pollerPromises = Array.from({ length: enrichmentConcurrency }).map(() => runEnrichmentPoller());
      // ────────────────────────────────────────

      for (let rowIdx = 0; rowIdx < data.length; rowIdx++) {
        const row = data[rowIdx];
        const stadt = row.stadt!;
        const branche = row.branche!;
        const effectiveMax = (row.max_results != null && row.max_results > 0)
          ? row.max_results
          : maxBusinesses;

        const stufe = row.stufe ?? 0;
        // Grid searches (stufe >= 1) always use API; otherwise decide by effectiveMax
        const isApi = stufe >= 1 || effectiveMax <= 60;

        const task = async () => {
          if (isSessionCancelled(db, sessionId)) return;

          searchCount++;
          const mode = isApi ? (stufe >= 1 ? `API Grid Stufe ${stufe}` : 'API') : 'Scraping';
          logger.log(`🔍 [${mode}] "${branche}" in "${stadt}" (max: ${effectiveMax === Infinity ? '∞' : effectiveMax})`);

          await sendProgress({
            type: 'progress',
            message: `[${mode}] "${branche}" in "${stadt}"`,
            current: processedBusinesses,
            total: totalBusinessesFound,
            searchCount,
            totalSearches,
          });

          if (isApi) {
            // ── API PATH (with optional adaptive grid splitting) ────────────────
            const jobMax = effectiveMax === Infinity ? null : effectiveMax;
            const jobId = insertSingleJob(db, sessionId, { stadt, branche, max_results: jobMax });

            let allPlacesRaw: Place[] = [];

            if (stufe >= 1) {
              // Grid-based search with adaptive subdivision
              try {
                const gridSide = stufe + 1;
                logger.log(`[Grid] ── Start Grid-Suche für "${branche}" in "${stadt}" ──`);
                logger.log(`[Grid] Stufe ${stufe} → ${gridSide}×${gridSide} = ${gridSide * gridSide} Zellen`);
                logger.log(`[Grid] Fetching bounding box for "${stadt}" (country: ${country})...`);
                const bbox = await getCityBoundingBox(stadt, country);
                logger.log(`[Grid] Bounding Box: N=${bbox.north.toFixed(5)} S=${bbox.south.toFixed(5)} E=${bbox.east.toFixed(5)} W=${bbox.west.toFixed(5)}`);
                logger.log(`[Grid] Lat-Range: ${(bbox.north - bbox.south).toFixed(5)}° | Lng-Range: ${(bbox.east - bbox.west).toFixed(5)}°`);

                const gridCells = splitBoundingBox(bbox, stufe);
                logger.log(`[Grid] "${stadt}" aufgeteilt in ${gridCells.length} Zellen (Stufe ${stufe})`);
                for (const c of gridCells) {
                  logger.log(`[Grid]   ${c.label}: lat [${c.low.latitude.toFixed(5)} → ${c.high.latitude.toFixed(5)}] lng [${c.low.longitude.toFixed(5)} → ${c.high.longitude.toFixed(5)}]`);
                }

                await sendProgress({
                  type: 'progress',
                  message: `[Grid] "${stadt}" in ${gridCells.length} Quadranten aufgeteilt (Stufe ${stufe} → ${gridSide}×${gridSide})`,
                  current: processedBusinesses,
                  total: totalBusinessesFound,
                  searchCount, totalSearches,
                });

                // Search each grid cell recursively (subdivides when hitting 60 results)
                let cellIdx = 0;
                for (const cell of gridCells) {
                  cellIdx++;
                  if (isSessionCancelled(db, sessionId)) {
                    logger.log(`[Grid] Session cancelled – stopping at cell ${cellIdx}/${gridCells.length}`);
                    break;
                  }
                  logger.log(`[Grid] ── Zelle ${cellIdx}/${gridCells.length}: ${cell.label} ──`);
                  const beforeCount = allPlacesRaw.length;
                  const cellPlaces = await searchGridCellRecursive(
                    cell, stadt, branche, sendProgress,
                    () => isSessionCancelled(db, sessionId),
                  );
                  allPlacesRaw.push(...cellPlaces);
                  logger.log(`[Grid] ${cell.label} fertig: ${cellPlaces.length} Ergebnisse | Gesamt bisher: ${allPlacesRaw.length} (vorher: ${beforeCount})`);
                }

                logger.log(`[Grid] ── Grid-Suche abgeschlossen für "${branche}" in "${stadt}" ──`);
                logger.log(`[Grid] Roh-Ergebnisse gesamt: ${allPlacesRaw.length} (über ${gridCells.length} Zellen + Unterteilungen)`);
              } catch (err) {
                logger.error(`[Grid] Fehler beim Abrufen der Bounding Box für "${stadt}":`, err);
                logger.log(`[Grid] Fallback: Einzelsuche ohne Grid`);
                allPlacesRaw = await searchPlaces(
                  stadt, branche, effectiveMax, sendProgress,
                  () => isSessionCancelled(db, sessionId),
                );
                logger.log(`[Grid] Fallback-Ergebnis: ${allPlacesRaw.length} Ergebnisse`);
              }
            } else {
              // Single search without grid
              allPlacesRaw = await searchPlaces(
                stadt, branche, effectiveMax, sendProgress,
                () => isSessionCancelled(db, sessionId),
              );
            }

            // Deduplicate all results across grid cells
            logger.log(`[Dedup] Starte Deduplizierung: ${allPlacesRaw.length} Roh-Ergebnisse für "${branche}" in "${stadt}"`);
            const uniquePlaces: Place[] = [];
            let skippedPrice = 0, skippedCategory = 0, skippedPlaceId = 0, skippedDomain = 0;
            for (const place of allPlacesRaw) {
              if (!parsePriceAndMatch(place.price)) {
                skippedPrice++;
                logger.log(`[Dedup] ⚠️ Preis-Filter: ${place.name} (${place.price})`);
                continue;
              }
              if (!checkCategory(place.exactIndustry)) {
                skippedCategory++;
                logger.log(`[Dedup] ⚠️ Kategorie-Filter: ${place.name} (${place.exactIndustry})`);
                continue;
              }
              if (seenPlaceIds.has(place.id)) {
                skippedPlaceId++;
                logger.log(`[Dedup] ♻️ Duplikat Place-ID: ${place.name} (${place.id})`);
                continue;
              }
              let domain: string | null = null;
              if (place.website) {
                try { domain = new URL(place.website).hostname.replace(/^www\./, ''); } catch {}
              }
              if (domain && seenDomains.has(domain)) {
                skippedDomain++;
                logger.log(`[Dedup] ♻️ Duplikat Domain: ${domain} (${place.name})`);
                continue;
              }
              seenPlaceIds.add(place.id);
              if (domain) seenDomains.add(domain);
              uniquePlaces.push(place);
            }

            logger.log(`[Dedup] ── Ergebnis: ${allPlacesRaw.length} → ${uniquePlaces.length} unique ──`);
            logger.log(`[Dedup]   Entfernt: ${skippedPlaceId} Duplikat-IDs, ${skippedDomain} Duplikat-Domains, ${skippedPrice} Preis-Filter, ${skippedCategory} Kategorie-Filter`);;
            await sendProgress({
              type: 'progress',
              message: `[API] "${branche}" in "${stadt}" – ${uniquePlaces.length} unique Ergebnisse (${allPlacesRaw.length} roh)`,
              current: processedBusinesses,
              total: totalBusinessesFound,
              searchCount, totalSearches,
            });

            let rowProcessedCount = 0;
            for (const place of uniquePlaces) {
              if (isSessionCancelled(db, sessionId)) break;
              if (rowProcessedCount >= effectiveMax) break;
              rowProcessedCount++;

              const placeKey = place.id || `${place.name}|${place.address}`;
              insertPlace(db, sessionId, jobId, {
                name: place.name,
                website: place.website,
                phone: place.phone,
                rating: place.rating,
                reviews: place.reviews,
                hours: place.hours,
                price: place.price,
                address: place.address,
                placeKey: placeKey,
                exactIndustry: place.exactIndustry,
              });

              totalBusinessesFound++;
              await sendProgress({
                type: 'progress',
                message: `[API] Found ${place.name}`,
                current: processedBusinesses,
                total: totalBusinessesFound,
                searchCount, totalSearches,
              });
            }

            if (rowProcessedCount >= effectiveMax) {
              logger.log(`[API] Reached max ${effectiveMax} for "${branche}" in "${stadt}"`);
            }
        } else if (mapsPaused) {
          // Maps is blocked – skip scraping rows, enrichment for prior results is already done
          logger.log(`[Scraping] Skipping "${branche}" in "${stadt}" – Maps is paused (block detected)`);          if (rowIdx === lastScrapingRowIdx && !poolClosed) {
            logger.log('[Pool] Last scraping row skipped due to block. Closing Maps worker pool early to free RAM.');
            await pool.close();
            poolClosed = true;
          }          return;        } else {
          // ── SCRAPING PATH ──────────────────────────────────────────────────
          // Create a job row in SQLite so place FK is satisfied
          const jobId = insertSingleJob(db, sessionId, { stadt, branche, max_results: row.max_results });
          
          let retryPlaceName: string | undefined = undefined;
          let isSecondAttempt = false;

          while (true) {
            if (isSessionCancelled(db, sessionId)) break;

            let workerReleased = false;
            const worker = await pool.acquire();

            // Fetch names already saved for this session to skip re-scraping them
            const scrapedRows = db.prepare('SELECT name FROM places WHERE session_id = ?').all(sessionId) as { name: string }[];
            const scrapedNames = new Set(scrapedRows.map(r => r.name));

            try {
              const scraper = new GoogleMapsScraper(
                  worker.page!, minPrice, maxPrice, categoryWhitelist, categoryBlacklist,
                  scrapedNames
              );
              await scraper.search(stadt, branche);

              let scraped = 0;
              for await (const place of scraper.scrape(request.signal)) {
                if (isSessionCancelled(db, sessionId)) break;
                if (effectiveMax !== Infinity && scraped >= effectiveMax) break;

                if (softBlockWarningActive) {
                    placesScrapedSinceWarning++;
                    if (placesScrapedSinceWarning >= 5) {
                        logger.log(`[SoftBlock] Processed 5 places safely. Warning cleared.`);
                        softBlockWarningActive = false;
                        await sendProgress({
                          type: 'progress',
                          message: 'Scraping fortgesetzt. Blockierung war wohl temporär.',
                          current: processedBusinesses,
                          total: totalBusinessesFound,
                          searchCount,
                          totalSearches,
                        });
                    }
                }

                // Kombiniere Name UND Adresse strikt als Fallback, falls Google keine saubere ID liefert
                const fallbackKey = `${place.name} --- ${place.address ? place.address : 'Ohne Adresse'}`;
                const placeKey = place.placeKey ? place.placeKey : fallbackKey;

                if (seenPlaceIds.has(placeKey)) {
                  logger.log(`♻️ [Scraping] Skipping duplicate place ID/Key: ${placeKey} (Name: ${place.name})`);
                  continue;
                }
                let domain: string | null = null;
                if (place.website) {
                  try { domain = new URL(place.website).hostname.replace(/^www\./, ''); } catch {}
                }
                if (domain && seenDomains.has(domain)) {
                  logger.log(`♻️ [Scraping] Skipping duplicate domain: ${domain} (${place.name})`);
                  continue;
                }
                seenPlaceIds.add(placeKey);
                if (domain) seenDomains.add(domain);

                // Write to SQLite (disk) immediately so the placeholder exists
                const placeKey2 = place.placeKey || `${place.name}|${place.address ?? ''}`;
                insertPlace(db, sessionId, jobId, {
                  name: place.name, website: place.website ?? undefined,
                  phone: place.phone ?? undefined, rating: place.rating ?? undefined,
                  reviews: place.reviews ?? undefined, hours: place.hours ?? undefined,
                  price: (place as any).price ?? undefined,
                  address: place.address ?? undefined, placeKey: placeKey2,
                  exactIndustry: (place as any).exactIndustry ?? undefined,
                });

                totalBusinessesFound++;
                await sendProgress({
                  type: 'progress',
                  message: `[Scraping] Found ${place.name}`,
                  current: processedBusinesses, // progress updated by enrichment worker
                  total: totalBusinessesFound,
                  searchCount,
                  totalSearches,
                });

                scraped++;
              }
            } catch (e) {
              if (e instanceof BlockDetectionError) {
                if (e.level === 2) {
                    if (!isSecondAttempt) {
                        logger.warn(`[SoftBlock] Soft block detected ("${e.placeName}"). Restarting browser with headless=false and retrying...`);
                        retryPlaceName = e.placeName;
                        isSecondAttempt = true;
                        try { await worker.resetContext(true, false); } catch {}
                        pool.release(worker);
                        workerReleased = true;
                        continue; // try again
                    } else {
                        if (softBlockWarningActive && placesScrapedSinceWarning < 5) {
                            logger.error(`[SoftBlock] Soft block CONFIRMED within first 5 places. Stopping all scrapes.`);
                            mapsPaused = true;
                            await sendProgress({
                                type: 'error',
                                message: 'Google Maps hat die Anfragen blockiert (Soft Block 2 bestätigt). Alle weiteren Scrapes werden abgebrochen.',
                            });
                        } else {
                            logger.warn(`[SoftBlock] Second attempt failed at "${e.placeName}". Skipping to next row.`);
                            softBlockWarningActive = true;
                            placesScrapedSinceWarning = 0;
                            await sendProgress({
                                type: 'warning',
                                message: `Soft Block Warnung bei "${branche}" in "${stadt}". Überspringe diesen Scrape...`,
                            });
                        }
                    }
                } else {
                  mapsPaused = true;
                  const levelLabels: Record<number, string> = {
                    1: 'Hard Block (CAPTCHA / 403)',
                    2: 'Soft Block (Detail-Panel lädt nicht)',
                    3: 'Ghost Block (Keine API-Daten)',
                  };
                  const label = levelLabels[e.level] ?? `Level ${e.level}`;
                  logger.warn(`[BlockDetection] Level ${e.level} – ${label}: ${e.message}`);
                  await sendProgress({
                    type: 'blocked',
                    level: e.level,
                    label,
                    message: e.message,
                  });
                }
              } else {
                logger.error(`[Scraping] Error for "${branche}" in "${stadt}":`, e);
              }
            } finally {
              if (!workerReleased) {
                if (rowIdx !== lastScrapingRowIdx) {
                  try { await worker.resetContext(); } catch {}
                }
                pool.release(worker);
              }
            }
            break; // exit while loop if we made it here (success, hard block, error, or second attempt fail)
          }
          // Close the Maps browser immediately once the last scraping task is done
          if (rowIdx === lastScrapingRowIdx && !poolClosed) {
            logger.log('[Pool] Last scraping task done. Closing Maps worker pool early to free RAM.');
            await pool.close();
            poolClosed = true;
          }
        }
        };

        allTasks.push(task);
      }

      // Execute sequentially (no parallel API / Scraping)
      await runWithLimit(allTasks, 1);
      
      // Let poller know mapping is complete, wait for it to enrich remaining items
      mapsFinished = true;
      logger.log('[Enrichment] Waiting for background workers to finish remaining enrichments.');
      await sendProgress({
        type: 'progress',
        message: 'Maps done. Finishing enrichment tasks...',
        current: processedBusinesses,
        total: totalBusinessesFound,
        searchCount: totalSearches,
        totalSearches,
      });
      await Promise.all(pollerPromises);

      if (hasScrapingRows && !poolClosed) {
        logger.log('[Pool] All tasks finished. Shutting down Maps worker pool to free RAM.');
        await pool.close();
      }

      updateSessionTotalJobs(db, sessionId, processedBusinesses);
      closeDb(sessionId);

      await browser.close();

      logger.log(`🎉 Scraping completed successfully. Total results: ${processedBusinesses}`);

      // No full results array sent – client has accumulated them via individual 'result' events
      await sendProgress({
        type: 'complete',
        total: processedBusinesses,
        message: 'Scraping completed!',
      });
    } catch (error) {
      logger.error('❌ Scraping error:', error);
      await sendProgress({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    } finally {
      logger.log('🏁 Scrape route execution finished, cleaning up resources...');
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

// Helper for concurrency
async function runWithLimit(tasks: (() => Promise<void>)[], limit: number) {
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const task = tasks[index++];
            if (task) await task();
        }
    }
    await Promise.all(Array(limit).fill(0).map(worker));
}

// ── Grid Search Helpers ─────────────────────────────────────────────────────

interface BoundingBox {
  north: number; // max latitude
  south: number; // min latitude
  east: number;  // max longitude
  west: number;  // min longitude
}

interface GridCell {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
  label: string; // e.g. "Quadrant 1/4"
}

/**
 * Get bounding box for a city using Google Geocoding API.
 */
async function getCityBoundingBox(city: string, country: string): Promise<BoundingBox> {
  const apiKey = getNextAvailableKey();
  if (!apiKey) {
    logger.error(`[BBox] Kein API-Key verfügbar für Geocoding von "${city}"`);
    throw new Error('No API key available for geocoding');
  }

  logger.log(`[BBox] Geocoding-Request: "${city}, ${country}" (Key: ...${apiKey.slice(-4)})`);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city + ', ' + country)}&key=${apiKey}`;
  const response = await fetch(url);
  incrementApiKeyUsage(apiKey);

  if (!response.ok) {
    logger.error(`[BBox] Geocoding API Fehler: ${response.status} ${response.statusText}`);
    throw new Error(`Geocoding API error: ${response.status}`);
  }
  const data = await response.json();

  if (!data.results || data.results.length === 0) {
    logger.error(`[BBox] Keine Ergebnisse für "${city}" – API gab ${data.status} zurück`);
    throw new Error(`Geocoding: No results for "${city}"`);
  }

  const result = data.results[0];
  const viewport = result.geometry.viewport;
  const bounds = result.geometry.bounds;
  logger.log(`[BBox] Ergebnis: "${result.formatted_address}"`);
  logger.log(`[BBox] Viewport: NE(${viewport.northeast.lat.toFixed(5)}, ${viewport.northeast.lng.toFixed(5)}) SW(${viewport.southwest.lat.toFixed(5)}, ${viewport.southwest.lng.toFixed(5)})`);
  if (bounds) {
    logger.log(`[BBox] Bounds:   NE(${bounds.northeast.lat.toFixed(5)}, ${bounds.northeast.lng.toFixed(5)}) SW(${bounds.southwest.lat.toFixed(5)}, ${bounds.southwest.lng.toFixed(5)})`);
  } else {
    logger.log(`[BBox] Bounds: nicht verfügbar – nutze nur Viewport`);
  }

  // Combine viewport + bounds: take the outermost edges of both
  const north = bounds ? Math.max(viewport.northeast.lat, bounds.northeast.lat) : viewport.northeast.lat;
  const east  = bounds ? Math.max(viewport.northeast.lng, bounds.northeast.lng) : viewport.northeast.lng;
  const south = bounds ? Math.min(viewport.southwest.lat, bounds.southwest.lat) : viewport.southwest.lat;
  const west  = bounds ? Math.min(viewport.southwest.lng, bounds.southwest.lng) : viewport.southwest.lng;

  logger.log(`[BBox] Kombiniert: N=${north.toFixed(5)} S=${south.toFixed(5)} E=${east.toFixed(5)} W=${west.toFixed(5)}`);

  return { north, east, south, west };
}

/**
 * Stufe (level) maps to grid size: stufe N → (N+1) × (N+1).
 * e.g. 1 → 2×2 (4), 2 → 3×3 (9), 3 → 4×4 (16), 4 → 5×5 (25), etc.
 */
function stufeToGrid(stufe: number): number {
  return stufe + 1;
}

/**
 * Split a bounding box into a grid of cells with ~10% overlap.
 * Uses stufeToGrid to determine the grid dimensions.
 */
function splitBoundingBox(bbox: BoundingBox, stufe: number): GridCell[] {
  if (stufe < 1) return [];

  const side = stufeToGrid(stufe);
  const cols = side;
  const rows = side;
  const totalCells = cols * rows;

  const latRange = bbox.north - bbox.south;
  const lngRange = bbox.east - bbox.west;

  const cellHeight = latRange / rows;
  const cellWidth = lngRange / cols;

  // 10% overlap on each side
  const latOverlap = cellHeight * 0.1;
  const lngOverlap = cellWidth * 0.1;

  const cells: GridCell[] = [];
  let cellNum = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cellNum++;
      const south = bbox.south + row * cellHeight - latOverlap;
      const north = bbox.south + (row + 1) * cellHeight + latOverlap;
      const west = bbox.west + col * cellWidth - lngOverlap;
      const east = bbox.west + (col + 1) * cellWidth + lngOverlap;

      cells.push({
        low: { latitude: south, longitude: west },
        high: { latitude: north, longitude: east },
        label: `Quadrant ${cellNum}/${totalCells}`,
      });
    }
  }

  return cells;
}

/**
 * Split a single grid cell in half along its longer dimension.
 * Returns two cells with 10% overlap.
 */
function splitCellInHalf(cell: GridCell): [GridCell, GridCell] {
  const latRange = cell.high.latitude - cell.low.latitude;
  const lngRange = cell.high.longitude - cell.low.longitude;
  const splitAxis = latRange >= lngRange ? 'horizontal (Breitengrad)' : 'vertikal (Längengrad)';

  logger.log(`[Split] Teile ${cell.label} in 2 Hälften – Achse: ${splitAxis}`);
  logger.log(`[Split]   Lat-Range: ${latRange.toFixed(5)}° | Lng-Range: ${lngRange.toFixed(5)}°`);

  if (latRange >= lngRange) {
    const mid = cell.low.latitude + latRange / 2;
    const overlap = latRange * 0.05;
    const cellA: GridCell = {
      low: { latitude: cell.low.latitude, longitude: cell.low.longitude },
      high: { latitude: mid + overlap, longitude: cell.high.longitude },
      label: cell.label + 'a',
    };
    const cellB: GridCell = {
      low: { latitude: mid - overlap, longitude: cell.low.longitude },
      high: { latitude: cell.high.latitude, longitude: cell.high.longitude },
      label: cell.label + 'b',
    };
    logger.log(`[Split]   ${cellA.label}: lat [${cellA.low.latitude.toFixed(5)} → ${cellA.high.latitude.toFixed(5)}]`);
    logger.log(`[Split]   ${cellB.label}: lat [${cellB.low.latitude.toFixed(5)} → ${cellB.high.latitude.toFixed(5)}]`);
    logger.log(`[Split]   Overlap-Zone: ${(mid - overlap).toFixed(5)} → ${(mid + overlap).toFixed(5)} (${(overlap * 2).toFixed(5)}°)`);
    return [cellA, cellB];
  } else {
    const mid = cell.low.longitude + lngRange / 2;
    const overlap = lngRange * 0.05;
    const cellA: GridCell = {
      low: { latitude: cell.low.latitude, longitude: cell.low.longitude },
      high: { latitude: cell.high.latitude, longitude: mid + overlap },
      label: cell.label + 'a',
    };
    const cellB: GridCell = {
      low: { latitude: cell.low.latitude, longitude: mid - overlap },
      high: { latitude: cell.high.latitude, longitude: cell.high.longitude },
      label: cell.label + 'b',
    };
    logger.log(`[Split]   ${cellA.label}: lng [${cellA.low.longitude.toFixed(5)} → ${cellA.high.longitude.toFixed(5)}]`);
    logger.log(`[Split]   ${cellB.label}: lng [${cellB.low.longitude.toFixed(5)} → ${cellB.high.longitude.toFixed(5)}]`);
    logger.log(`[Split]   Overlap-Zone: ${(mid - overlap).toFixed(5)} → ${(mid + overlap).toFixed(5)} (${(overlap * 2).toFixed(5)}°)`);
    return [cellA, cellB];
  }
}

const MAX_GRID_DEPTH = 6; // prevent infinite recursion

/**
 * Recursively search a grid cell. If the API returns exactly 60 results
 * (the maximum), the cell is split in half and each half is searched again.
 * All results are collected and returned.
 */
async function searchGridCellRecursive(
  cell: GridCell,
  stadt: string,
  branche: string,
  sendProgress: (data: any) => Promise<void>,
  shouldAbort: () => boolean,
  depth: number = 0,
): Promise<Place[]> {
  const indent = '  '.repeat(depth);
  if (shouldAbort()) {
    logger.log(`[Rekursiv]${indent} ${cell.label} – Abbruch (Session cancelled)`);
    return [];
  }

  logger.log(`[Rekursiv]${indent} ▶ Suche ${cell.label} (Tiefe ${depth}/${MAX_GRID_DEPTH})`);
  logger.log(`[Rekursiv]${indent}   Bereich: lat [${cell.low.latitude.toFixed(5)} → ${cell.high.latitude.toFixed(5)}] lng [${cell.low.longitude.toFixed(5)} → ${cell.high.longitude.toFixed(5)}]`);
  await sendProgress({
    type: 'progress',
    message: `[Grid] Suche ${cell.label}${depth > 0 ? ` (Tiefe ${depth})` : ''}`,
  });

  const startTime = Date.now();
  const places = await searchPlaces(
    stadt,
    branche,
    undefined, // no max – we want to know the true count
    sendProgress,
    shouldAbort,
    { rectangle: { low: cell.low, high: cell.high } },
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.log(`[Rekursiv]${indent} ◀ ${cell.label}: ${places.length} Ergebnisse in ${elapsed}s`);

  // If we got exactly 60 results (API max) and haven't gone too deep, subdivide
  if (places.length >= 60 && depth < MAX_GRID_DEPTH) {
    logger.log(`[Rekursiv]${indent} ⚠ ${cell.label} hat ${places.length} Ergebnisse (API-Maximum erreicht!) → Unterteilung in 2 Hälften (Tiefe ${depth} → ${depth + 1})`);
    await sendProgress({
      type: 'progress',
      message: `[Grid] ${cell.label} hat ${places.length} Ergebnisse (Maximum) – wird geteilt (Tiefe ${depth + 1})`,
    });

    const [cellA, cellB] = splitCellInHalf(cell);
    logger.log(`[Rekursiv]${indent} Starte parallele Suche: ${cellA.label} + ${cellB.label}`);
    const [placesA, placesB] = await Promise.all([
      searchGridCellRecursive(cellA, stadt, branche, sendProgress, shouldAbort, depth + 1),
      searchGridCellRecursive(cellB, stadt, branche, sendProgress, shouldAbort, depth + 1),
    ]);

    const combined = [...placesA, ...placesB];
    logger.log(`[Rekursiv]${indent} ✓ ${cell.label} Unterteilung fertig: ${cellA.label}=${placesA.length} + ${cellB.label}=${placesB.length} = ${combined.length} gesamt (vor Dedup)`);
    return combined;
  }

  if (places.length >= 60 && depth >= MAX_GRID_DEPTH) {
    logger.log(`[Rekursiv]${indent} ⚠ ${cell.label} hat ${places.length} Ergebnisse (API-Max), aber max. Tiefe ${MAX_GRID_DEPTH} erreicht – keine weitere Unterteilung`);
  } else {
    logger.log(`[Rekursiv]${indent} ✓ ${cell.label}: ${places.length} Ergebnisse (unter API-Max, keine Unterteilung nötig)`);
  }
  return places;
}

// ── Places Search ───────────────────────────────────────────────────────────

async function searchPlaces(
  stadt: string,
  branche: string,
  maxBusinesses?: number,
  sendProgress?: (data: any) => Promise<void>,
  shouldAbort?: () => boolean,
  locationRestriction?: { rectangle: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } } },
): Promise<Place[]> {
  const query = `${branche} in ${stadt}`;
  logger.log(`📍 Calling Google Places API with query: "${query}"`);
  
  const url = 'https://places.googleapis.com/v1/places:searchText';
  let allPlaces: Place[] = [];
  let pageToken: string | undefined = undefined;
  let pageNumber = 1;

  // Provide the price levels mapping to fake € labels for UI consistency
  const priceLevelMap: Record<string, string> = {
    'PRICE_LEVEL_INEXPENSIVE': '€',
    'PRICE_LEVEL_MODERATE': '€€',
    'PRICE_LEVEL_EXPENSIVE': '€€€',
    'PRICE_LEVEL_VERY_EXPENSIVE': '€€€€'
  };

  do {
    if (shouldAbort?.()) {
      logger.log(`🛑 API search aborted for "${branche}" in "${stadt}" before next page request`);
      break;
    }

    // ─── Key Management logic added ───
    let apiKey: string | null = null;
    while (!apiKey) {
      apiKey = getNextAvailableKey();
      if (!apiKey) {
        logger.warn('⏳ No active API keys available. Waiting for new keys...');
        if (sendProgress) {
          await sendProgress({
            type: 'blocked', 
            level: 1, 
            label: 'API Keys Exhausted',
            message: 'Das Limit von 1000 Aufrufen pro API Key wurde erreicht. Bitte neue Keys in den Einstellungen hinzufügen.'
          });
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    // ──────────────────────────────────

    const requestBody: any = { textQuery: query };
    if (locationRestriction) {
      requestBody.locationRestriction = locationRestriction;
    }
    if (pageToken) {
      requestBody.pageToken = pageToken;
    }

    logger.log(`📄 Fetching page ${pageNumber}... (Key: ...${apiKey.slice(-4)})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.rating,places.userRatingCount,places.priceLevel,places.primaryTypeDisplayName,nextPageToken',
      },
      body: JSON.stringify(requestBody),
    });

    incrementApiKeyUsage(apiKey);

    if (!response.ok) {
      const errorMsg = `Google Places API error: ${response.status} ${response.statusText}`;
      logger.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const places = data.places || [];
    logger.log(`📦 Page ${pageNumber} returned ${places.length} places`);

    const mappedPlaces = places.map((place: any) => {
      let hours = undefined;
      if (place.regularOpeningHours?.weekdayDescriptions) {
        hours = place.regularOpeningHours.weekdayDescriptions.join(' | ');
      }

      return {
        id: place.id || '',
        name: place.displayName?.text || '',
        address: place.formattedAddress || '',
        phone: place.nationalPhoneNumber || '',
        website: place.websiteUri || '',
        rating: place.rating,
        reviews: place.userRatingCount,
          hours,
          price: place.priceLevel ? priceLevelMap[place.priceLevel] : undefined,
          exactIndustry: place.primaryTypeDisplayName?.text || undefined,
      };
    });

    allPlaces = [...allPlaces, ...mappedPlaces];
    pageToken = data.nextPageToken;
    pageNumber++;

    if (shouldAbort?.()) {
      logger.log(`🛑 API search aborted for "${branche}" in "${stadt}" after page ${pageNumber - 1}`);
      break;
    }

    // Small delay between requests to avoid rate limiting
    if (pageToken) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (pageToken && (!maxBusinesses || allPlaces.length < maxBusinesses) && !shouldAbort?.());

  logger.log(`✅ Total places found across all pages: ${allPlaces.length}`);
  return allPlaces;
}
