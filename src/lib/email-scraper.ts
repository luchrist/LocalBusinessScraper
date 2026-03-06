import { Page, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import { extractNamesDetailed } from './extractNames';
import { scrapeImprintLightbox } from './lightBoxScrape';
import { normalizeOwnerNameString, normalizeOwnerNamesFromCandidates } from './owner-name-normalizer';

export const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
export const OBFUSCATED_EMAIL_REGEX = /([\w.+\-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|\<at\>|at|AT|ät))\s*([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/gi;
export const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net', 'aol.com', 'freenet.de', 'icloud.com', 't-online.de', 'live.com', 'protonmail.com', 'yandex.com'];

export interface ScrapeResult {
  email: string | null;
  owner: string | null;
  ownerSalutations: string | null;
  ownerFirstNames: string | null;
  ownerLastNames: string | null;
}

const isResultComplete = (result: ScrapeResult, searchEmail: boolean, searchOwner: boolean): boolean => {
  if (searchEmail && searchOwner) return Boolean(result.email && result.owner);
  if (searchEmail) return Boolean(result.email);
  if (searchOwner) return Boolean(result.owner);
  return true;
};

const mergeScrapeResults = (base: ScrapeResult, next: ScrapeResult): ScrapeResult => ({
  email: base.email || next.email,
  owner: base.owner || next.owner,  ownerSalutations: base.ownerSalutations || next.ownerSalutations,  ownerFirstNames: base.ownerFirstNames || next.ownerFirstNames,
  ownerLastNames: base.ownerLastNames || next.ownerLastNames,
});

interface OwnerExtractionResult {
  owner: string | null;
  ownerSalutations: string | null;
  ownerFirstNames: string | null;
  ownerLastNames: string | null;
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
  } catch {}
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
  de: /impressum|imprint|geschaeftsbedingungen|rechtliche|rechtliches|kontakt/i,
  at: /impressum|imprint|offenlegung|medieninhaber|kontakt/i,
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

const TEAM_REGEX = /team|about|ueber-uns|uber-uns|ueber uns|uber uns|who-we-are|our-story|company|unser-team|unser team/i;

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
export async function extractOwnerFromText(text: string, businessInfo: { name?: string, industry?: string }, log: (msg: string) => void): Promise<string | null> {
    // Try regex extraction first, including optional two-line disambiguation metadata.
    const extraction = extractNamesDetailed(text, { takeFirst: false });
    let names = [...extraction.names];

    if (extraction.pendingDisambiguations.length > 0) {
      try {
        const { chooseNaturalPersonBetweenTwoLines } = await import('./llm-extractor');

        for (const pending of extraction.pendingDisambiguations) {
          const lowerLine1 = pending.line1.toLowerCase();
          const lowerLine2 = pending.line2.toLowerCase();
          const hasLine1 = names.some(n => n.toLowerCase() === lowerLine1);
          const hasLine2 = names.some(n => n.toLowerCase() === lowerLine2);

          // Only disambiguate while both candidates are still present.
          if (!hasLine1 || !hasLine2) continue;

          log(`   🤖 Two-line owner disambiguation (${pending.cueLabel}): "${pending.line1}" vs "${pending.line2}"`);
          const winner = await chooseNaturalPersonBetweenTwoLines(pending.line1, pending.line2, {
            cueLabel: pending.cueLabel,
            businessName: businessInfo.name,
            industry: businessInfo.industry,
          });

          // Fallback requirement: keep both when LLM is unavailable or uncertain.
          if (!winner) {
            log('   ⚠️ Two-line disambiguation failed, keeping both candidates.');
            continue;
          }

          const loser = winner.toLowerCase() === lowerLine1 ? pending.line2 : pending.line1;
          const loserLower = loser.toLowerCase();
          names = names.filter(name => name.toLowerCase() !== loserLower);
          log(`   ✅ Two-line disambiguation picked: ${winner}`);
        }
      } catch (llmError) {
        log(`   ⚠️ Two-line disambiguation unavailable: ${llmError instanceof Error ? llmError.message : String(llmError)}`);
      }
    }

    if (names.length > 0) {
      const normalized = normalizeOwnerNamesFromCandidates(names);
      log(`   👤 Owner found (regex): ${normalized.ownerDisplay}`);
      return normalized.ownerDisplay;
    }
    
    // Fallback to LLM if regex found nothing
    log(`   🤖 No owner found with regex, trying LLM...`);
    try {
      const { extractOwnerWithLLM } = await import('./llm-extractor');
        const llmOwner = await extractOwnerWithLLM(text, businessInfo);
        if (llmOwner) {
          const normalized = normalizeOwnerNameString(llmOwner);
          log(`   👤 Owner found (LLM): ${normalized.ownerDisplay}`);
          return normalized.ownerDisplay;
      }
    } catch (llmError) {
      log(`   ⚠️ LLM extraction unavailable: ${llmError instanceof Error ? llmError.message : String(llmError)}`);
    }
    return null;
}

export async function extractOwnerDetailsFromText(
  text: string,
  businessInfo: { name?: string, industry?: string },
  log: (msg: string) => void
): Promise<OwnerExtractionResult> {
  const owner = await extractOwnerFromText(text, businessInfo, log);
  const normalized = normalizeOwnerNameString(owner);

  return {
    owner: normalized.ownerDisplay,
    ownerSalutations: normalized.ownerSalutations,
    ownerFirstNames: normalized.ownerFirstNames,
    ownerLastNames: normalized.ownerLastNames,
  };
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

async function searchPageForOwner(page: Page, businessInfo: { name?: string, industry?: string }, log: (msg: string) => void): Promise<OwnerExtractionResult> {
  try {
    // Prefer innerText to preserve structure/newlines, fallback to textContent
    let text = await page.evaluate(() => document.body.innerText).catch(() => null);
    if (!text) text = await page.textContent('body');
    
    if (!text) {
      return { owner: null, ownerSalutations: null, ownerFirstNames: null, ownerLastNames: null };
    }
    return extractOwnerDetailsFromText(text, businessInfo, log);
  } catch (e) {
      log(`   ⚠️ Failed to search for owner: ${e}`);
  }
  return { owner: null, ownerSalutations: null, ownerFirstNames: null, ownerLastNames: null };
}

// HTTP Fallback function
async function fetchPage(url: string, log: (msg: string) => void): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { 
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            } 
        });
        clearTimeout(timeoutId);
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    }
}

async function tryHttpScrape(url: string, domain: string, options: { searchEmail?: boolean; searchOwner?: boolean; country?: string, businessName?: string, industry?: string }, log: (msg: string) => void): Promise<ScrapeResult> {
  const result: ScrapeResult = { email: null, owner: null, ownerSalutations: null, ownerFirstNames: null, ownerLastNames: null };
    try {
        log(`   ⚡ Trying HTTP GET first for ${url}...`);
        const text = await fetchPage(url, log);
        if (!text) throw new Error("HTTP Fetch failed");
        
        if (options.searchEmail) {
            const email = extractEmailsFromText(text, domain, log);
            if (email) result.email = email;
            if (!result.email) {
                 const mailtoMatch = text.match(/href=["']mailto:([^"']+)["']/i);
                 if (mailtoMatch) {
                     const emailMatch = cleanEmail(mailtoMatch[1].split('?')[0]);
                     if (emailMatch && (isEmailFromDomain(emailMatch, domain, true) || isEmailFromDomain(emailMatch, domain, false))) {
                         result.email = emailMatch;
                     }
                 }
            }
        }

        const imprintPattern = getImprintPattern(options.country || 'de');
        let rawHtmlToScrapeForOwner = text;

        if (options.searchOwner || (!result.email && options.searchEmail)) {
            const $ = cheerio.load(text);
            let targetUrl = null;
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (href && (imprintPattern.test(href) || imprintPattern.test($(el).text()))) {
                   if (href.startsWith('http')) targetUrl = href;
                   else if (href.startsWith('/')) targetUrl = new URL(href, url).href;
                   else targetUrl = new URL(`/${href}`, url).href;
                }
            });

            if (targetUrl) {
                log(`   ⚡ HTTP Fetching Imprint/Contact page: ${targetUrl}`);
                const subpageText = await fetchPage(targetUrl, log);
                if (subpageText) {
                    rawHtmlToScrapeForOwner = subpageText;
                    if (!result.email && options.searchEmail) {
                        const email = extractEmailsFromText(subpageText, domain, log);
                        if (email) result.email = email;
                    }
                }
            }
        }

        if (options.searchOwner && !result.owner) {
            const $ = cheerio.load(rawHtmlToScrapeForOwner);
            $('script, style, nav, header, footer').remove();
            const textToSearch = $('body').text().replace(/\s+/g, ' ');
            const extracted = await extractNamesDetailed(textToSearch, { takeFirst: false });
            if (extracted && extracted.names.length > 0) {
               const normalized = normalizeOwnerNamesFromCandidates(extracted.names);
               if (normalized.ownerDisplay) {
                   log(`   ✅ Owner found via HTTP: ${normalized.ownerDisplay}`);
                   result.owner = normalized.ownerDisplay;
                   result.ownerSalutations = normalized.ownerSalutations;
                   result.ownerFirstNames = normalized.ownerFirstNames;
                   result.ownerLastNames = normalized.ownerLastNames;
               }
            }
        }

        return result;
    } catch (e) {
        log(`   ⚠️ HTTP failed: ${e instanceof Error ? e.message : String(e)}`);
        return result;
    }
}


// Playwright scraping with Jitter and Timeouts
async function tryPlaywrightScrape(context: BrowserContext, websiteUrl: string, domain: string, log: (msg: string) => void, options: { searchEmail?: boolean; searchOwner?: boolean; country?: string, businessName?: string, industry?: string }, initialResult: ScrapeResult, deadlineTs?: number): Promise<ScrapeResult> {
    const { searchEmail = true, searchOwner = true, country = 'de', businessName, industry } = options;
    const result: ScrapeResult = { ...initialResult };
    const logger = log;
    const imprintPattern = getImprintPattern(country);

    const assertNotTimedOut = () => {
      if (deadlineTs && Date.now() > deadlineTs) {
        throw new Error('Timeout');
      }
    };

    if (isResultComplete(result, searchEmail, searchOwner)) {
        return result;
    }

    const page = await context.newPage();
    const visited = new Set<string>();

    const canonicalizeForSubpageCheck = (value: string): string | null => {
      try {
        const url = new URL(value);
        url.hash = '';

        // Root query variants (e.g. ?lang=de) are treated as homepage.
        if (url.pathname === '/') {
          url.search = '';
        }

        if (url.pathname.length > 1) {
          url.pathname = url.pathname.replace(/\/+$/, '');
        }

        return url.toString();
      } catch {
        return null;
      }
    };
    
    // Add jitter to page actions
        const processPage = async (url: string, isMainPage: boolean = false, skipOwnerSearch: boolean = false) => {
          const canonicalUrl = canonicalizeForSubpageCheck(url);
          if (!canonicalUrl || visited.has(canonicalUrl)) return;
          visited.add(canonicalUrl);
          assertNotTimedOut();
         
         try {
           logger(`   📲 Loading (Playwright): ${url}`);
           await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
           assertNotTimedOut();
           
           // Human-like interaction
           await humanLikeInteraction(page);
           assertNotTimedOut();
           
           if (searchEmail && !result.email) {
                result.email = await extractEmailFromPage(page, domain, isMainPage, logger);
           }
           
           const shouldSearchOwner = searchOwner && !result.owner && !skipOwnerSearch;
           
           if (shouldSearchOwner) {
               logger(`   🔍 Scanning for owner on impressum...`);
               const ownerResult = await searchPageForOwner(page, { name: businessName, industry }, logger);
               if (ownerResult.owner) {
                 result.owner = ownerResult.owner;
                 result.ownerSalutations = ownerResult.ownerSalutations;
                 result.ownerFirstNames = ownerResult.ownerFirstNames;
                 result.ownerLastNames = ownerResult.ownerLastNames;
               }
           }
    
         } catch (e) {
             logger(`   ⚠️ Error processing ${url}: ${e instanceof Error ? e.message : String(e)}`);
         }
    };
    
    try {
      assertNotTimedOut();
        let baseUrl: URL;
        try { baseUrl = new URL(websiteUrl); } catch { return result; }

        // Homepage owner extraction is only allowed as a last fallback when no subpages exist.
        await processPage(websiteUrl, true, true);
        
        if (isResultComplete(result, searchEmail, searchOwner)) {
            await page.close();
            return result;
        }

        assertNotTimedOut();
        const rawLinks = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) => 
            anchors.map(a => a.getAttribute('href') || '').filter(h => h.trim().length > 0)
        ).catch(() => []);
        
        const homepageCanonicalUrl = canonicalizeForSubpageCheck(baseUrl.href);

        const subpages = rawLinks
          .map((link) => {
            try {
              return canonicalizeForSubpageCheck(new URL(link, baseUrl).href);
            } catch {
              return null;
            }
          })
          .filter((link): link is string => {
            if (!link) return false;
            try {
              const u = new URL(link);
              const { domainToUnicode } = require('node:url');
              const sameDomain = domainToUnicode(u.hostname).replace(/^www\./, '') === domain;
              const isHomepageVariant = homepageCanonicalUrl ? link === homepageCanonicalUrl : false;
              const isBinaryFile = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|zip|rar|tar\.gz|gz|7z|png|jpe?g|gif|svg|webp|ico|mp4|mp3|avi|mov|wmv)$/i.test(u.pathname);
              return sameDomain && !visited.has(link) && !isHomepageVariant && !isBinaryFile;
            } catch {
              return false;
            }
          });

        const orderedPages = Array.from(new Set(subpages));
        logger(`📋 checking ${orderedPages.length} subpages`);

        const scoreOwnerPrimary = (candidateUrl: string) => {
          const lower = decodeURIComponent(candidateUrl).toLowerCase();
          if (lower.includes('impressum') || lower.includes('imprint')) return 4;
          if (lower.includes('recht') || lower.includes('legal') || lower.includes('offenlegung')) return 3;
          if (lower.includes('kontakt') || lower.includes('contact')) return 2;
          return 0;
        };

        const primaryOwnerCandidates = orderedPages
          .filter((url) => scoreOwnerPrimary(url) > 0 || imprintPattern.test(url))
          .sort((a, b) => scoreOwnerPrimary(b) - scoreOwnerPrimary(a));

        const teamFallbackCandidates = orderedPages
          .filter((url) => scoreOwnerPrimary(url) === 0 && TEAM_REGEX.test(decodeURIComponent(url)));

        const primaryOwnerTargetUrl = primaryOwnerCandidates[0] || null;
        const teamFallbackTargetUrl = teamFallbackCandidates[0] || null;

        if (searchOwner && !result.owner && primaryOwnerTargetUrl) {
          logger(`   🎯 Owner primary page: ${primaryOwnerTargetUrl}`);
          await processPage(primaryOwnerTargetUrl, false, false);
        }

        if (
          searchOwner &&
          !result.owner &&
          teamFallbackTargetUrl &&
          teamFallbackTargetUrl !== primaryOwnerTargetUrl
        ) {
          logger(`   🎯 Owner team fallback page: ${teamFallbackTargetUrl}`);
          await processPage(teamFallbackTargetUrl, false, false);
        }

        if (searchOwner && !result.owner && orderedPages.length === 0) {
          logger('   🎯 No subpages found, checking homepage owner as final fallback.');
          const ownerResult = await searchPageForOwner(page, { name: businessName, industry }, logger);
          if (ownerResult.owner) {
            result.owner = ownerResult.owner;
            result.ownerSalutations = ownerResult.ownerSalutations;
            result.ownerFirstNames = ownerResult.ownerFirstNames;
            result.ownerLastNames = ownerResult.ownerLastNames;
          }
        }

        for (const link of orderedPages) {
            // Stop conditions:
          if (isResultComplete(result, searchEmail, searchOwner)) break;
          assertNotTimedOut();

            // Owner extraction is intentionally limited to one target page.
            await processPage(link, false, true);
        }
        
    } catch (e) {
         logger(`   ⚠️ Playwright loop error: ${e}`);
    } finally {
        if (!page.isClosed()) await page.close();
    }
    return result;
}

export async function findContactInfo(context: BrowserContext, websiteUrl: string, log?: (msg: string) => void, options: { searchEmail?: boolean; searchOwner?: boolean; country?: string, businessName?: string, industry?: string } = {}): Promise<ScrapeResult> {
  const { searchEmail = true, searchOwner = true, country = 'de' } = options;
  const logger = log || console.log;
  const result: ScrapeResult = { email: null, owner: null, ownerSalutations: null, ownerFirstNames: null, ownerLastNames: null };
  const retryLimit = 1;
  const attemptTimeoutMs = 30000;

  logger(`🕷️  Starting scraping for: ${websiteUrl} (email: ${searchEmail}, owner: ${searchOwner}, country: ${country})`);

  const { domainToUnicode } = require('node:url');
  let baseUrl: URL;
  try {
    baseUrl = new URL(websiteUrl);
  } catch {
    logger(`❌ Invalid URL: ${websiteUrl}`);
    return result;
  }
  const domain = domainToUnicode(baseUrl.hostname).replace(/^www\./, '');

    const doScrape = async (seed: ScrapeResult): Promise<ScrapeResult> => {
     const deadlineTs = Date.now() + attemptTimeoutMs;
     // 1. Try HTTP (Fast)
    const httpResult = await tryHttpScrape(websiteUrl, domain, options, logger);
    let partialResult = mergeScrapeResults(seed, httpResult);

    // 1.5 Try homepage lightbox/impressum owner extraction before Playwright subpage scanning.
    if (searchOwner && !partialResult.owner) {
      logger('   🔦 Checking homepage lightbox impressum before subpage scan...');
      try {
        const lightboxResult = await scrapeImprintLightbox(websiteUrl, {
          timeoutMs: 8000,
          log: (msg: string) => logger(`   ${msg}`),
        });

        if (lightboxResult.owner || lightboxResult.email) {
          if (lightboxResult.owner) logger(`   ✅ Owner found via lightbox impressum: ${lightboxResult.owner}`);
          if (lightboxResult.email) logger(`   ✅ Email found via lightbox impressum: ${lightboxResult.email}`);
          partialResult = mergeScrapeResults(partialResult, {
            email: lightboxResult.email,
            owner: lightboxResult.owner,
            ownerSalutations: lightboxResult.ownerSalutations,
            ownerFirstNames: lightboxResult.ownerFirstNames,
            ownerLastNames: lightboxResult.ownerLastNames,
          } as ScrapeResult);
        } else if (lightboxResult.lightboxFound) {
          logger('   ℹ️ Impressum lightbox found but no owner extracted.');
        } else {
          logger('   ℹ️ No impressum lightbox detected on homepage.');
        }
      } catch (e) {
        logger(`   ⚠️ Lightbox impressum check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

     if (isResultComplete(partialResult, searchEmail, searchOwner)) {
       return partialResult;
     }

     // 2. Fallback to Playwright
     const playwrightResult = await tryPlaywrightScrape(context, websiteUrl, domain, logger, options, partialResult, deadlineTs);
     return mergeScrapeResults(partialResult, playwrightResult);
  };

    const attemptScrape = async (attemptsLeft: number, currentResult: ScrapeResult): Promise<ScrapeResult> => {
      try {
        const attemptResult = await doScrape(currentResult);
        const mergedResult = mergeScrapeResults(currentResult, attemptResult);
        return mergedResult;
      } catch (e) {
        const hasPartialResult = Boolean(currentResult.email || currentResult.owner);
        if (hasPartialResult) {
          logger(`   ⚠️ Returning partial result after error: ${e instanceof Error ? e.message : String(e)}`);
          return currentResult;
        }
          if (attemptsLeft > 0) {
              logger(`   🔄 Retry triggered (error: ${e instanceof Error ? e.message : String(e)})`);
          return attemptScrape(attemptsLeft - 1, currentResult);
          }
          logger(`   ❌ Failed after retries: ${e instanceof Error ? e.message : String(e)}`);
        return currentResult;
      }
  };

    return attemptScrape(retryLimit, result);
}

export async function findEmail(context: BrowserContext, websiteUrl: string, log?: (msg: string) => void): Promise<string | null> {
    const res = await findContactInfo(context, websiteUrl, log);
    return res.email;
}
