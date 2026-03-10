//api/scrape
import { logger } from '@/lib/logger';
import os from 'os';
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { chromium, BrowserContext, Browser } from 'playwright';
import { findContactInfo } from '@/lib/email-scraper';
import { GoogleMapsScraper, BlockDetectionError } from '@/lib/maps-scraper';
import { ScraperPool } from '@/lib/scraper-pool';
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

// Initialize settings DB
try {
  initSettingsDb();
} catch (e) {
  logger.error('Failed to initialize settings DB:', e);
}

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

      const checkCategory = (exactIndustry?: string): boolean => {
        if (!exactIndustry) return true;
        const industryLower = exactIndustry.toLowerCase();
        if (categoryWhitelist.length > 0) {
            return categoryWhitelist.some(term => industryLower.includes(term.toLowerCase()));
        }
        if (categoryBlacklist.length > 0) {
            return !categoryBlacklist.some(term => industryLower.includes(term.toLowerCase()));
        }
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
        return {
          stadt: getColumnValue(row, ['stadt', 'city', 'ort', 'location', 'town']),
          branche: getColumnValue(row, ['branche', 'industry', 'category', 'keyword', 'niche', 'business']),
          max_results: rowMax && !isNaN(rowMax) && rowMax > 0 ? rowMax : null,
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
                const info = await findContactInfo(siteContext, placeR.website, (msg) => logger.log(msg), {
                  searchEmail, searchOwner, country, businessName: placeR.name, industry: placeR.branche,
                });
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

        const isApi = effectiveMax <= 60;

        const task = async () => {
          if (isSessionCancelled(db, sessionId)) return;

          searchCount++;
          const mode = isApi ? 'API' : 'Scraping';
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
            // ── API PATH ────────────────────────────────────────────────────────
          const places = await searchPlaces(stadt, branche, effectiveMax, sendProgress);
          logger.log(`✅ Found ${places.length} places for "${branche}" in "${stadt}"`);

          const jobMax = effectiveMax === Infinity ? null : effectiveMax;
          const jobId = insertSingleJob(db, sessionId, { stadt, branche, max_results: jobMax });

          const uniquePlaces: Place[] = [];
          for (const place of places) {
              if (!parsePriceAndMatch(place.price)) {
                logger.log(`⚠️ Skipping ${place.name} due to price filter (${place.price})`);
                continue;
              }
              if (!checkCategory(place.exactIndustry)) {
                logger.log(`⚠️ Skipping ${place.name} due to category filter (${place.exactIndustry})`);
                continue;
              }
            if (seenPlaceIds.has(place.id)) {
              logger.log(`♻️ Skipping duplicate place ID: ${place.name}`);
              continue;
            }
            let domain: string | null = null;
            if (place.website) {
              try { domain = new URL(place.website).hostname.replace(/^www\./, ''); } catch {}
            }
            if (domain && seenDomains.has(domain)) {
              logger.log(`♻️ Skipping duplicate domain: ${domain} (${place.name})`);
              continue;
            }
            seenPlaceIds.add(place.id);
            if (domain) seenDomains.add(domain);
            uniquePlaces.push(place);
          }

          logger.log(`✅ Deduplicated: ${places.length} -> ${uniquePlaces.length} unique new places`);

          // No longer adding totalBusinessesFound += uniquePlaces.length here
          // because it is incremented inside the loop below!

          await sendProgress({
            type: 'progress',
            message: `[API] "${branche}" in "${stadt}" – ${uniquePlaces.length} unique places found`,
            current: processedBusinesses,
            total: totalBusinessesFound,
            searchCount,
            totalSearches,
          });

          let rowProcessedCount = 0;
          for (const place of uniquePlaces) {
            if (isSessionCancelled(db, sessionId)) break;
            if (rowProcessedCount >= effectiveMax) break;
            rowProcessedCount++;

            // Insert placeholder into DB immediately
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
          const worker = await pool.acquire();
          try {
            const scraper = new GoogleMapsScraper(worker.page!, minPrice, maxPrice, categoryWhitelist, categoryBlacklist);
            await scraper.search(stadt, branche);

            let scraped = 0;
            for await (const place of scraper.scrape(request.signal)) {
              if (isSessionCancelled(db, sessionId)) break;
              if (effectiveMax !== Infinity && scraped >= effectiveMax) break;

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

              totalBusinessesFound++;
              await sendProgress({
                type: 'progress',
                message: `[Scraping] Found ${place.name}`,
                current: processedBusinesses, // progress updated by enrichment worker
                total: totalBusinessesFound,
                searchCount,
                totalSearches,
              });

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

              scraped++;
            }
          } catch (e) {
            if (e instanceof BlockDetectionError) {
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
              // Results collected so far are kept; do not mark as fatal error
            } else {
              logger.error(`[Scraping] Error for "${branche}" in "${stadt}":`, e);
            }
          } finally {
            // Skip resetContext on the last task – pool.close() will clean up immediately after,
            // so launching a fresh browser/context just to discard it is wasteful.
            if (rowIdx !== lastScrapingRowIdx) {
              try { await worker.resetContext(); } catch {}
            }
            pool.release(worker);
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

async function searchPlaces(stadt: string, branche: string, maxBusinesses?: number, sendProgress?: (data: any) => Promise<void>): Promise<Place[]> {
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
    if (pageToken) {
      requestBody.pageToken = pageToken;
    }

    logger.log(`📄 Fetching page ${pageNumber}... (Key: ...${apiKey.slice(-4)})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.rating,places.userRatingCount,places.priceLevel,nextPageToken',
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
          price: place.priceLevel ? priceLevelMap[place.priceLevel] : undefined
      };
    });

    allPlaces = [...allPlaces, ...mappedPlaces];
    pageToken = data.nextPageToken;
    pageNumber++;

    // Small delay between requests to avoid rate limiting
    if (pageToken) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (pageToken && (!maxBusinesses || allPlaces.length < maxBusinesses));

  logger.log(`✅ Total places found across all pages: ${allPlaces.length}`);
  return allPlaces;
}
