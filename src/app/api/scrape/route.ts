import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { chromium } from 'playwright';
import { findContactInfo } from '@/lib/email-scraper';

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
  owner?: string;
  status: string;
}

interface Place {
  name: string;
  address: string;
  phone: string;
  website: string;
}

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

export async function POST(request: NextRequest) {
  console.log('🚀 Scraping request started');
  
  if (!GOOGLE_PLACES_API_KEY) {
    console.error('❌ Google Places API Key missing');
    return NextResponse.json(
      { error: 'Google Places API Key missing in .env.local' },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendProgress = async (data: any) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Start processing in background
  (async () => {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File;
      const searchEmail = formData.get('searchEmail') === 'true';
      const searchOwner = formData.get('searchOwner') === 'true';
      const country = (formData.get('country') as string) || 'de';
      const maxBusinessesStr = formData.get('maxBusinesses') as string;
      const maxBusinesses = maxBusinessesStr === 'max' ? Infinity : parseInt(maxBusinessesStr) || Infinity;

      if (!file) {
        console.error('❌ No file uploaded');
        await sendProgress({ type: 'error', message: 'No file uploaded' });
        await writer.close();
        return;
      }

      console.log(`📁 File received: ${file.name} (${file.size} bytes)`);
      console.log(`⚙️  Options: searchEmail=${searchEmail}, searchOwner=${searchOwner}, country=${country}, maxBusinesses=${maxBusinesses}`);

      // Parse Excel file
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data: BusinessData[] = XLSX.utils.sheet_to_json(sheet);
      console.log(`📊 Excel file parsed: ${data.length} rows found`);

      const results: BusinessResult[] = [];
      const browser = await chromium.launch({ 
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage'
        ]
      });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
      });
      console.log('🌐 Browser launched');

      let processedBusinesses = 0;
      let totalBusinessesFound = 0; // Total businesses found so far
      let searchCount = 0;
      const totalSearches = data.filter(row => (row.Stadt || row.stadt) && (row.Branche || row.branche)).length;

      for (const row of data) {
        const stadt = row.Stadt || row.stadt;
        const branche = row.Branche || row.branche;

        if (!stadt || !branche) {
          console.log('⏭️ Skipping row: missing Stadt or Branche');
          continue;
        }

        searchCount++;
        console.log(`🔍 Searching for "${branche}" in "${stadt}"`);
        
        // Suche mit Google Places API
        const places = await searchPlaces(stadt, branche, maxBusinesses);
        console.log(`✅ Found ${places.length} places for "${branche}" in "${stadt}"`);
        
        totalBusinessesFound += places.length;
        
        await sendProgress({
          type: 'progress',
          message: `Searching for "${branche}" in "${stadt}" - ${places.length} found`,
          current: processedBusinesses,
          total: totalBusinessesFound,
          searchCount,
          totalSearches: totalSearches,
        });

        // Define processing logic for a single place
        const processPlace = async (place: Place) => {
          if (processedBusinesses >= maxBusinesses) return;

          await sendProgress({
            type: 'progress',
            message: `Checking ${place.name}`,
            current: processedBusinesses,
            total: totalBusinessesFound,
            searchCount,
            totalSearches: totalSearches,
          });

          let email: string | null = null;
          let owner: string | null = null;
          let status = 'no_website';

          if (place.website && (searchEmail || searchOwner)) {
            console.log(`🔗 Checking website for "${place.name}": ${place.website}`);
            await sendProgress({
              type: 'progress',
              message: `Searching for ${searchEmail && searchOwner ? 'email & owner' : searchEmail ? 'email' : 'owner'} on ${place.website}`,
              current: processedBusinesses,
              total: totalBusinessesFound,
              searchCount,
              totalSearches: totalSearches,
            });
            
            status = 'searching';
            const contactInfo = await findContactInfo(context, place.website, undefined, { 
              searchEmail, 
              searchOwner,
              country
            });
            
            if (searchEmail) {
              email = contactInfo.email;
            }
            if (searchOwner) {
              owner = contactInfo.owner;
            }

            status = (searchEmail && email) || (searchOwner && owner) ? 'success' : 'no_match';
            if (email) {
              console.log(`✉️  Email found: ${email}`);
            }
            if (owner) {
              console.log(`👤 Owner found: ${owner}`);
            }
            if (!email && !owner && (searchEmail || searchOwner)) {
              console.log(`❌ No ${searchEmail && searchOwner ? 'email or owner' : searchEmail ? 'email' : 'owner'} found on ${place.website}`);
            }
          } else if (!place.website) {
            console.log(`⚠️  No website for "${place.name}"`);
          } else {
            console.log(`⏭️  Skipping contact info search for "${place.name}" (disabled)`);
            status = 'skipped';
          }

          results.push({
            stadt,
            branche,
            name: place.name,
            adresse: place.address,
            telefon: place.phone,
            website: place.website,
            email: email || undefined,
            owner: owner || undefined,
            status,
          });
          
          processedBusinesses++;
          
          await sendProgress({
            type: 'result',
            result: results[results.length - 1],
            current: processedBusinesses,
            total: totalBusinessesFound,
          });
        };

        // Group places by domain to respect "max 1 per domain" constraint
        const domainGroups = new Map<string, Place[]>();
        const noWebsitePlaces: Place[] = [];

        for (const place of places) {
            if (place.website) {
               try {
                   const domain = new URL(place.website).hostname;
                   if (!domainGroups.has(domain)) domainGroups.set(domain, []);
                   domainGroups.get(domain)!.push(place);
               } catch {
                   noWebsitePlaces.push(place);
               }
            } else {
                noWebsitePlaces.push(place);
            }
        }

        // Create tasks
        const tasks: (() => Promise<void>)[] = [];

        // 1. Domain tasks (Sequential processing of places for that domain)
        for (const [_, groupPlaces] of domainGroups) {
            tasks.push(async () => {
                for (const place of groupPlaces) {
                   await processPlace(place);
                }
            });
        }

        // 2. No website tasks (can be parallelized individually)
        for (const place of noWebsitePlaces) {
            tasks.push(async () => {
                await processPlace(place);
            });
        }

        // Execute with concurrency limit of 10
        await runWithLimit(tasks, 10);
      }

      await context.close();
      await browser.close();
      console.log(`🎉 Scraping completed successfully. Total results: ${results.length}`);

      await sendProgress({
        type: 'complete',
        results,
        message: 'Scraping completed!',
      });
    } catch (error) {
      console.error('❌ Scraping error:', error);
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

async function searchPlaces(stadt: string, branche: string, maxBusinesses?: number): Promise<Place[]> {
  const query = `${branche} in ${stadt}`;
  console.log(`📍 Calling Google Places API with query: "${query}"`);
  
  const url = 'https://places.googleapis.com/v1/places:searchText';
  let allPlaces: Place[] = [];
  let pageToken: string | undefined = undefined;
  let pageNumber = 1;

  do {
    const requestBody: any = { textQuery: query };
    if (pageToken) {
      requestBody.pageToken = pageToken;
    }

    console.log(`📄 Fetching page ${pageNumber}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY!,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,nextPageToken',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorMsg = `Google Places API error: ${response.statusText}`;
      console.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const places = data.places || [];
    console.log(`📦 Page ${pageNumber} returned ${places.length} places`);

    const mappedPlaces = places.map((place: any) => ({
      name: place.displayName?.text || '',
      address: place.formattedAddress || '',
      phone: place.nationalPhoneNumber || '',
      website: place.websiteUri || '',
    }));

    allPlaces = [...allPlaces, ...mappedPlaces];
    pageToken = data.nextPageToken;
    pageNumber++;

    // Small delay between requests to avoid rate limiting
    if (pageToken) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (pageToken && (!maxBusinesses || allPlaces.length < maxBusinesses));

  console.log(`✅ Total places found across all pages: ${allPlaces.length}`);
  return allPlaces;
}
