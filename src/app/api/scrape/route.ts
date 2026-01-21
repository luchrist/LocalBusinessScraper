import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { chromium } from 'playwright';

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
  status: string;
}

interface Place {
  name: string;
  address: string;
  phone: string;
  website: string;
}

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const OBFUSCATED_EMAIL_REGEX = /([\w.+\-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|at|AT|ät))\s*([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/gi;
const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net'];

// Clean email by removing leading numbers and ensure it starts with a letter
function cleanEmail(email: string): string | null {
  // Remove leading numbers until we hit a letter
  const cleaned = email.replace(/^[0-9]+/, '');
  // Check if it starts with a letter now
  if (cleaned && /^[A-Za-z]/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

function getDomainWithoutTLD(fullDomain: string): string {
  const normalized = fullDomain.replace(/^www\./, '');
  const parts = normalized.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : normalized;
}

function isEmailFromDomain(email: string, expectedDomain: string): boolean {
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return false;
  
  const emailDomainWithoutTLD = getDomainWithoutTLD(emailDomain);
  const domainWithoutTLD = getDomainWithoutTLD(expectedDomain);
  
  return emailDomainWithoutTLD === domainWithoutTLD || COMMON_PROVIDERS.includes(emailDomain);
}

export async function POST(request: NextRequest) {
  console.log('🚀 Scraping request started');
  
  if (!GOOGLE_PLACES_API_KEY) {
    console.error('❌ Google Places API Key missing');
    return NextResponse.json(
      { error: 'Google Places API Key fehlt in .env.local' },
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

      if (!file) {
        console.error('❌ No file uploaded');
        await sendProgress({ type: 'error', message: 'Keine Datei hochgeladen' });
        await writer.close();
        return;
      }

      console.log(`📁 File received: ${file.name} (${file.size} bytes)`);

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
        const places = await searchPlaces(stadt, branche);
        console.log(`✅ Found ${places.length} places for "${branche}" in "${stadt}"`);
        
        totalBusinessesFound += places.length;
        
        await sendProgress({
          type: 'progress',
          message: `Suche nach "${branche}" in "${stadt}" - ${places.length} gefunden`,
          current: processedBusinesses,
          total: totalBusinessesFound,
          searchCount,
          totalSearches: totalSearches,
        });

        for (const place of places) {

          await sendProgress({
            type: 'progress',
            message: `Prüfe ${place.name}`,
            current: processedBusinesses,
            total: totalBusinessesFound,
            searchCount,
            totalSearches: totalSearches,
          });

          let email: string | null = null;
          let status = 'no_website';

          if (place.website) {
            console.log(`🔗 Checking website for "${place.name}": ${place.website}`);
            await sendProgress({
              type: 'progress',
              message: `Suche Email auf ${place.website}`,
              current: processedBusinesses,
              total: totalBusinessesFound,
              searchCount,
              totalSearches: totalSearches,
            });
            
            status = 'searching';
            email = await findEmail(context, place.website);
            status = email ? 'success' : 'no_email';
            if (email) {
              console.log(`✉️  Email found: ${email}`);
            } else {
              console.log(`❌ No email found on ${place.website}`);
            }
          } else {
            console.log(`⚠️  No website for "${place.name}"`);
          }

          results.push({
            stadt,
            branche,
            name: place.name,
            adresse: place.address,
            telefon: place.phone,
            website: place.website,
            email: email || undefined,
            status,
          });
          
          processedBusinesses++;
          
          await sendProgress({
            type: 'result',
            result: results[results.length - 1],
            current: processedBusinesses,
            total: totalBusinessesFound,
          });
        }
      }

      await context.close();
      await browser.close();
      console.log(`🎉 Scraping completed successfully. Total results: ${results.length}`);

      await sendProgress({
        type: 'complete',
        results,
        message: 'Scraping abgeschlossen!',
      });
    } catch (error) {
      console.error('❌ Scraping error:', error);
      await sendProgress({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unbekannter Fehler',
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

async function searchPlaces(stadt: string, branche: string): Promise<Place[]> {
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
  } while (pageToken);

  console.log(`✅ Total places found across all pages: ${allPlaces.length}`);
  return allPlaces;
}

async function findEmail(context: any, websiteUrl: string): Promise<string | null> {
  console.log(`🕷️  Starting email search for: ${websiteUrl}`);
  const page = await context.newPage();
  const visited = new Set<string>();
  const baseUrl = new URL(websiteUrl);
  const domain = baseUrl.hostname.replace(/^www\./, '');

  try {
    // Suche auf der Hauptseite
    console.log(`🔎 Scanning main page...`);
    const email = await searchPageForEmail(page, websiteUrl, domain);
    if (email) {
      console.log(`✅ Email found on main page: ${email}`);
      return email;
    }

    console.log(`📄 Fetching subpages...`);
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const rawLinks: string[] = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) =>
      anchors
        .map((a: HTMLAnchorElement) => a.getAttribute('href') || '')
        .filter((href: string) => href.trim().length > 0)
    );

    console.log(`🔗 Found ${rawLinks.length} links on page`);

    const subpages = rawLinks
      .map(link => {
        try {
          return new URL(link, baseUrl).href; // resolve relative to base
        } catch {
          return null;
        }
      })
      .filter((link): link is string => {
        if (!link) return false;
        try {
          const url = new URL(link);
          return url.hostname.replace(/^www\./, '') === domain && !visited.has(link);
        } catch {
          return false;
        }
      });

    console.log(`📋 Checking ${subpages.length} subpages for emails`);

    for (const link of subpages) {
      visited.add(link);
      console.log(`   🔍 Checking: ${link}`);
      const email = await searchPageForEmail(page, link, domain);
      if (email) {
        console.log(`✅ Email found on subpage: ${email}`);
        return email;
      }
    }

    console.log(`⚠️  No email found after checking ${subpages.length + 1} pages`);
  } catch (error) {
    console.error(`❌ Error scraping ${websiteUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    await page.close();
  }

  return null;
}

async function searchPageForEmail(page: any, url: string, domain: string): Promise<string | null> {
  try {
    console.log(`   📲 Loading: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    
    // 1. Zuerst nach mailto: Links in der HTML-Struktur suchen
    console.log(`   🔍 Checking mailto: links...`);
    const mailtoLinks = await page.$$eval('a[href^="mailto:"]', (anchors: HTMLAnchorElement[]) =>
      anchors.map((a: HTMLAnchorElement) => {
        const href = a.getAttribute('href') || '';
        return href.replace('mailto:', '').split('?')[0].trim();
      })
    );
    
    if (mailtoLinks.length > 0) {
      console.log(`   📧 Found ${mailtoLinks.length} mailto: links: ${mailtoLinks.join(', ')}`);
      for (const email of mailtoLinks) {
        if (email && email.includes('@')) {
          const cleaned = cleanEmail(email);
          if (cleaned && isEmailFromDomain(cleaned, domain)) {
            console.log(`   ✅ Valid mailto: email found: ${cleaned}`);
            return cleaned;
          } else {
            console.log(`   ⛔ Mailto link rejected: ${cleaned} (domain mismatch)`);
          }
        }
      }
    }
    
    // 2. Fallback: Text-basierte Suche
    console.log(`   🔍 Fallback: Checking text content...`);
    const text = await page.textContent('body');
    
    if (!text) {
      console.log(`   ⚠️  No text content found on page`);
      return null;
    }

    const directEmails = text?.match(EMAIL_REGEX) || [];
    console.log(`   📧 Direct emails found: ${directEmails.length}`);
    if (directEmails.length > 0) {
      console.log(`      Raw: ${directEmails.join(', ')}`);
    }

    // Also catch obfuscated forms like "info at domain.de"
    const obfuscatedEmails: string[] = [];
    if (text) {
      let match: RegExpExecArray | null;
      while ((match = OBFUSCATED_EMAIL_REGEX.exec(text)) !== null) {
        const candidate = `${match[1]}@${match[2]}.${match[3]}`;
        obfuscatedEmails.push(candidate);
      }
    }
    
    console.log(`   🔐 Obfuscated emails found: ${obfuscatedEmails.length}`);
    if (obfuscatedEmails.length > 0) {
      console.log(`      Raw: ${obfuscatedEmails.join(', ')}`);
    }

    // Clean emails: remove leading numbers
    const allRawEmails = [...directEmails, ...obfuscatedEmails];
    const emails = allRawEmails
      .map(email => cleanEmail(email))
      .filter((email): email is string => email !== null);
    
    if (emails.length !== allRawEmails.length) {
      console.log(`   🧹 Cleaned emails: ${emails.join(', ')}`);
    }
    
    const domainWithoutTLD = getDomainWithoutTLD(domain);
    console.log(`   🔍 Validating against domain: ${domain} (base: ${domainWithoutTLD})`);

    for (const email of emails) {
      const emailDomain = email.split('@')[1].toLowerCase();
      const emailDomainWithoutTLD = getDomainWithoutTLD(emailDomain);
      
      console.log(`      Checking ${email}: emailDomain="${emailDomainWithoutTLD}" vs domain="${domainWithoutTLD}"`);
      
      // Accept if domain name matches (ignoring TLD) OR if it's a common provider
      if (emailDomainWithoutTLD === domainWithoutTLD || COMMON_PROVIDERS.includes(emailDomain)) {
        console.log(`   ✅ Valid email accepted: ${email}`);
        return email;
      } else {
        console.log(`      ❌ Rejected: domain mismatch or not common provider`);
      }
    }
  } catch (error) {
    // Seite konnte nicht geladen werden
    console.log(`   ⚠️  Failed to load page: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return null;
}
