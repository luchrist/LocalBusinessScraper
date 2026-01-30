import { Page, BrowserContext } from 'playwright';
import { extractNames } from './extractNames';

export const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
export const OBFUSCATED_EMAIL_REGEX = /([\w.+\-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|\<at\>|at|AT|ät))\s*([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/gi;
export const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net', 'aol.com'];

export interface ScrapeResult {
  email: string | null;
  owner: string | null;
}

// Helper for random delays (Jitter)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min: number, max: number) => delay(min + Math.random() * (max - min));

// Human-like interaction (Jitter: Scroll, Mouse)
async function humanLikeInteraction(page: Page) {
  try {
     const width = page.viewportSize()?.width || 1920;
     const height = page.viewportSize()?.height || 1080;
     
     // Random small mouse move
     try { await page.mouse.move(Math.random() * width, Math.random() * height); } catch {}
     
     // Random scroll
     try { 
         await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5 * Math.random())); 
     } catch {}
     
     await randomDelay(500, 1500);
  } catch (e) {}
}

// Clean email by removing leading numbers, decoding, and trimming
export function cleanEmail(email: string): string | null {
  if (!email) return null;
  
  let cleaned = email;
  
  // Decode URI components (e.g. %20 -> space)
  try {
      cleaned = decodeURIComponent(cleaned);
  } catch {}

  // Remove whitespace and invisible characters
  cleaned = cleaned.trim().replace(/\s+/g, '');

  // Remove leading numbers
  cleaned = cleaned.replace(/^[0-9]+/, '');
  
  // Remove common trailing punctuation/garbage that might be captured
  cleaned = cleaned.replace(/[.,;:%]+$/, '');

  if (cleaned && /^[A-Za-z]/.test(cleaned) && cleaned.includes('@')) {
    return cleaned;
  }
  return null;
}

export function getDomainWithoutTLD(fullDomain: string): string {
  const normalized = fullDomain.replace(/^www\./, '');
  const parts = normalized.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : normalized;
}

// Country-specific imprint page patterns
const imprintPatterns: Record<string, RegExp> = {
  de: /impressum|imprint|kontakt|datenschutz|rechtliche|rechtliches/i,
  at: /impressum|imprint|kontakt|offenlegung|medieninhaber/i,
  ch: /impressum|imprint|kontakt|herausgeber/i,
  us: /about|contact|legal|privacy|terms/i,
  uk: /about|contact|legal|privacy|terms|company-info/i,
  fr: /mentions.*l[eé]gales|contact|[aà] propos|imprint/i,
  it: /chi siamo|contatti|note legali|imprint|impressum/i,
  es: /contacto|aviso legal|sobre nosotros|quienes somos|imprint/i,
  nl: /contact|over ons|juridisch|imprint|impressum/i,
  be: /contact|over ons|juridisch|imprint|impressum|mentions.*l[eé]gales/i,
  pl: /kontakt|o nas|informacje prawne|polityka prywatno[sś]ci/i,
  other: /impressum|imprint|about|contact|legal|kontakt|mentions.*l[eé]gales/i,
};

export function getImprintPattern(country: string = 'de'): RegExp {
  return imprintPatterns[country] || imprintPatterns.other;
}

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

export function isEmailFromDomain(email: string, expectedDomain: string, strictMode: boolean = true): boolean {
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return false;
  
  // Common providers always OK
  if (COMMON_PROVIDERS.includes(emailDomain)) return true;
  
  const emailDomainWithoutTLD = getDomainWithoutTLD(emailDomain);
  const domainWithoutTLD = getDomainWithoutTLD(expectedDomain);
  
  if (emailDomainWithoutTLD === domainWithoutTLD) return true;
  
  if (!strictMode) {
    const normalizedEmail = normalizeDomain(emailDomainWithoutTLD);
    const normalizedExpected = normalizeDomain(domainWithoutTLD);
    
    if (normalizedEmail.length >= 8 && normalizedExpected.length >= 8) {
      if (normalizedEmail.includes(normalizedExpected) || normalizedExpected.includes(normalizedEmail)) {
        return true;
      }
    }
  }
  
  return false;
}

// Extracted logic for finding emails in text (shared by HTTP and Playwright)
export function extractEmailsFromText(text: string, domain: string, log: (msg: string) => void): string | null {
  const directEmails = text?.match(EMAIL_REGEX) || [];
  const obfuscatedEmails: string[] = [];
  let match: RegExpExecArray | null;
  
  // Clone regex for stateful exec
  const obfRegex = new RegExp(OBFUSCATED_EMAIL_REGEX);
  while ((match = obfRegex.exec(text)) !== null) {
      obfuscatedEmails.push(`${match[1]}@${match[2]}.${match[3]}`);
  }

  const cleanedDirectEmails = directEmails.map((e: string) => cleanEmail(e)).filter((e: string | null): e is string => e !== null);
  const cleanedObfuscatedEmails = obfuscatedEmails.map((e: string) => cleanEmail(e)).filter((e: string | null): e is string => e !== null);

  for (const email of cleanedDirectEmails) {
    if (isEmailFromDomain(email, domain, true)) {
      log(`   ✅ Exact match (direct) email accepted: ${email}`);
      return email;
    }
  }
  for (const email of cleanedDirectEmails) {
    if (isEmailFromDomain(email, domain, false)) {
      log(`   ✅ Fuzzy match (direct) email accepted: ${email}`);
      return email;
    }
  }
  for (const email of cleanedObfuscatedEmails) {
    if (isEmailFromDomain(email, domain, true)) {
      log(`   ✅ Exact match (obfuscated) email accepted: ${email}`);
      return email;
    }
  }
  return null;
}

// Extracted logic for finding owner in text (shared by HTTP and Playwright)
export async function extractOwnerFromText(text: string, log: (msg: string) => void): Promise<string | null> {
    // Try regex extraction first
    const names = extractNames(text, { takeFirst: false });
    if (names.length > 0) {
        const owner = names.join(', ');
        log(`   👤 Owner found (regex): ${owner}`);
        return owner;
    }
    
    // Fallback to LLM if regex found nothing
    log(`   🤖 No owner found with regex, trying LLM...`);
    try {
      const { extractOwnerWithLLM } = await import('./llm-extractor');
      const llmOwner = await extractOwnerWithLLM(text);
      if (llmOwner) {
          log(`   👤 Owner found (LLM): ${llmOwner}`);
          return llmOwner;
      }
    } catch (llmError) {
      log(`   ⚠️ LLM extraction unavailable: ${llmError instanceof Error ? llmError.message : String(llmError)}`);
    }
    return null;
}

async function extractEmailFromPage(page: Page, domain: string, isMainPage: boolean, log: (msg: string) => void): Promise<string | null> {
  // 1. Mailto links
  log(`   🔍 Checking mailto: links...`);
  const mailtoLinks = await page.$$eval('a[href^="mailto:"]', (anchors: HTMLAnchorElement[]) =>
    anchors.map((a: HTMLAnchorElement) => {
      const href = a.getAttribute('href') || '';
      return href.replace('mailto:', '').split('?')[0].trim();
    })
  );
  
  if (mailtoLinks.length > 0) {
    // ... check mailto links ...
    for (const email of mailtoLinks) {
        if (email && email.includes('@')) {
          const cleaned = cleanEmail(email);
          if (cleaned) {
            if (isMainPage) {
              log(`   ✅ Mailto from main page accepted: ${cleaned}`);
              return cleaned;
            }
            if (isEmailFromDomain(cleaned, domain, true)) return cleaned;
            if (isEmailFromDomain(cleaned, domain, false)) return cleaned;
          }
        }
    }
  }

  // 2. Text content
  log(`   🔍 Finding emails in text...`);
  const text = await page.textContent('body');
  if (!text) {
    log(`   ⚠️  No text content found on page`);
    return null;
  }
  
  return extractEmailsFromText(text, domain, log);
}

async function searchPageForOwner(page: Page, log: (msg: string) => void): Promise<string | null> {
  try {
    // Prefer innerText to preserve structure/newlines, fallback to textContent
    let text = await page.evaluate(() => document.body.innerText).catch(() => null);
    if (!text) text = await page.textContent('body');
    
    if (!text) return null;
    return extractOwnerFromText(text, log);
  } catch (e) {
      log(`   ⚠️ Failed to search for owner: ${e}`);
  }
  return null;
}

// HTTP Fallback function
async function tryHttpScrape(url: string, domain: string, options: { searchEmail?: boolean; searchOwner?: boolean }, log: (msg: string) => void): Promise<ScrapeResult> {
    const result: ScrapeResult = { email: null, owner: null };
    try {
        log(`   ⚡ Trying HTTP GET first for ${url}...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout for HTTP
        
        const response = await fetch(url, { 
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            } 
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        
        if (options.searchEmail) {
            const email = extractEmailsFromText(text, domain, log);
            if (email) result.email = email;
            
            // Check mailto links in HTML string via regex
            if (!result.email) {
                 const mailtoMatch = text.match(/href=["']mailto:([^"']+)["']/i);
                 if (mailtoMatch) {
                     const email = cleanEmail(mailtoMatch[1].split('?')[0]);
                     if (email && (isEmailFromDomain(email, domain, true) || isEmailFromDomain(email, domain, false))) {
                         result.email = email;
                     }
                 }
            }
        }

        if (options.searchOwner) {
             // For HTTP, we just use the raw HTML text (stripped of tags would be better but regex handles some noise)
             // A simple tag stripper
             const plainText = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
                                   .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "")
                                   .replace(/<[^>]+>/g, "\n")
                                   .replace(/\s+/g, " ");
             
             // Only search owner if we are on a relevant page or if we found an Imprint link? 
             // Owner search is expensive (LLM), so maybe only if we are sure it's an imprint page?
             // But for main page, usually owner is not there.
             // We can check if we are on an imprint page (url matches).
             
             // If this is HTTP, we can only check the current page. If we need to go to Imprint, we need another HTTP request.
             // We can parse links here.
        }
        
        return result;
    } catch (e) {
        log(`   ⚠️ HTTP failed: ${e instanceof Error ? e.message : String(e)}`);
        return result;
    }
}


// Playwright scraping with Jitter and Timeouts
async function tryPlaywrightScrape(context: BrowserContext, websiteUrl: string, domain: string, log: (msg: string) => void, options: { searchEmail?: boolean; searchOwner?: boolean; country?: string }, initialResult: ScrapeResult): Promise<ScrapeResult> {
    const { searchEmail = true, searchOwner = true, country = 'de' } = options;
    const result: ScrapeResult = { ...initialResult };
    const logger = log;
    const imprintPattern = getImprintPattern(country);

    if ((searchEmail && result.email && !searchOwner) || (searchOwner && result.owner && !searchEmail) || (result.email && result.owner)) {
        return result;
    }

    const page = await context.newPage();
    const visited = new Set<string>();
    
    // Add jitter to page actions
    const processPage = async (url: string, isMainPage: boolean = false) => {
         if (visited.has(url)) return;
         visited.add(url);
         
         try {
           logger(`   📲 Loading (Playwright): ${url}`);
           await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
           
           // Human-like interaction
           await humanLikeInteraction(page);
           
           if (searchEmail && !result.email) {
                result.email = await extractEmailFromPage(page, domain, isMainPage, logger);
           }
           
           const isImpressum = imprintPattern.test(url);
           const shouldSearchOwner = searchOwner && !result.owner && isImpressum;
           
           if (shouldSearchOwner) {
               logger(`   🔍 Scanning for owner on impressum...`);
               const owner = await searchPageForOwner(page, logger);
               if (owner) result.owner = owner;
           }
    
         } catch (e) {
             logger(`   ⚠️ Error processing ${url}: ${e instanceof Error ? e.message : String(e)}`);
         }
    };
    
    try {
        let baseUrl: URL;
        try { baseUrl = new URL(websiteUrl); } catch { return result; }

        await processPage(websiteUrl, true);
        
        if ((searchEmail && result.email && !searchOwner) || (searchOwner && result.owner && !searchEmail) || (result.email && result.owner)) {
            await page.close();
            return result;
        }

        const rawLinks = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) => 
            anchors.map(a => a.getAttribute('href') || '').filter(h => h.trim().length > 0)
        ).catch(() => []);
        
        const subpages = rawLinks.map(link => {
            try { return new URL(link, baseUrl).href; } catch { return null; }
        }).filter((link): link is string => {
            if (!link) return false;
            try {
               const u = new URL(link);
               return u.hostname.replace(/^www\./, '') === domain && !visited.has(link);
            } catch { return false; }
        });
        
        const priorityPages = subpages.filter(url => imprintPattern.test(url));
        const otherPages = subpages.filter(url => !imprintPattern.test(url));
        
        const orderedPages = [...priorityPages, ...otherPages];
        logger(`📋 checking ${orderedPages.length} subpages`);
  
        for (const link of orderedPages) {
            if ((searchEmail && result.email && !searchOwner) || (searchOwner && result.owner && !searchEmail) || (result.email && result.owner)) break;
            
            const isImpressum = imprintPattern.test(link);
            if (result.email && !isImpressum && !result.owner) {
                continue;
            }
  
            await processPage(link, false);
        }
        
    } catch (e) {
         logger(`   ⚠️ Playwright loop error: ${e}`);
    } finally {
        if (!page.isClosed()) await page.close();
    }
    return result;
}

export async function findContactInfo(context: BrowserContext, websiteUrl: string, log?: (msg: string) => void, options: { searchEmail?: boolean; searchOwner?: boolean; country?: string } = {}): Promise<ScrapeResult> {
  const { searchEmail = true, searchOwner = true, country = 'de' } = options;
  const logger = log || console.log;
  let result: ScrapeResult = { email: null, owner: null };
  const retryLimit = 1;
  const totalTimeout = 30000; // 30s total budget (20s requested but buffer for retries)

  logger(`🕷️  Starting scraping for: ${websiteUrl} (email: ${searchEmail}, owner: ${searchOwner}, country: ${country})`);

  let baseUrl: URL;
  try {
    baseUrl = new URL(websiteUrl);
  } catch (e) {
    logger(`❌ Invalid URL: ${websiteUrl}`);
    return result;
  }
  const domain = baseUrl.hostname.replace(/^www\./, '');

  const doScrape = async (): Promise<ScrapeResult> => {
     // 1. Try HTTP (Fast)
     let partialResult = await tryHttpScrape(websiteUrl, domain, options, logger);
     if ((searchEmail && partialResult.email && !searchOwner) || (searchOwner && partialResult.owner && !searchEmail) || (partialResult.email && partialResult.owner)) {
         return partialResult;
     }

     // 2. Fallback to Playwright
     return await tryPlaywrightScrape(context, websiteUrl, domain, logger, options, partialResult);
  };

  const attemptScrape = async (attemptsLeft: number): Promise<ScrapeResult> => {
      try {
          // Promise.race for timeout
          const scrapePromise = doScrape();
          const timeoutPromise = new Promise<ScrapeResult>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 20000));
          return await Promise.race([scrapePromise, timeoutPromise]);
      } catch (e) {
          if (attemptsLeft > 0) {
              logger(`   🔄 Retry triggered (error: ${e instanceof Error ? e.message : String(e)})`);
              return attemptScrape(attemptsLeft - 1);
          }
          logger(`   ❌ Failed after retries: ${e instanceof Error ? e.message : String(e)}`);
          return result;
      }
  };

  return attemptScrape(retryLimit);
}

export async function findEmail(context: BrowserContext, websiteUrl: string, log?: (msg: string) => void): Promise<string | null> {
    const res = await findContactInfo(context, websiteUrl, log);
    return res.email;
}
