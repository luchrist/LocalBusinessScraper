import { Page, BrowserContext } from 'playwright';
import { extractNames } from './extractNames';

export const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
export const OBFUSCATED_EMAIL_REGEX = /([\w.+\-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|\<at\>|at|AT|ät))\s*([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/gi;
export const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net', 'aol.com'];

export interface ScrapeResult {
  email: string | null;
  owner: string | null;
}

// Clean email by removing leading numbers and ensure it starts with a letter
export function cleanEmail(email: string): string | null {
  const cleaned = email.replace(/^[0-9]+/, '');
  if (cleaned && /^[A-Za-z]/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

export function getDomainWithoutTLD(fullDomain: string): string {
  const normalized = fullDomain.replace(/^www\./, '');
  const parts = normalized.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : normalized;
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
    log(`   📧 Found ${mailtoLinks.length} mailto: links: ${mailtoLinks.join(', ')}`);
    for (const email of mailtoLinks) {
      if (email && email.includes('@')) {
        const cleaned = cleanEmail(email);
        if (cleaned) {
          if (isMainPage) {
            log(`   ✅ Mailto from main page accepted: ${cleaned}`);
            return cleaned;
          }
          if (isEmailFromDomain(cleaned, domain, true)) {
            log(`   ✅ Exact match mailto: email found: ${cleaned}`);
            return cleaned;
          }
          if (isEmailFromDomain(cleaned, domain, false)) {
            log(`   ✅ Fuzzy match mailto: email found: ${cleaned}`);
            return cleaned;
          }
          log(`   ⛔ Mailto link rejected: ${cleaned} (domain mismatch)`);
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

  const directEmails = text?.match(EMAIL_REGEX) || [];
  const obfuscatedEmails: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = OBFUSCATED_EMAIL_REGEX.exec(text)) !== null) {
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

async function searchPageForOwner(page: Page, log: (msg: string) => void): Promise<string | null> {
  try {
    // Prefer innerText to preserve structure/newlines, fallback to textContent
    let text = await page.evaluate(() => document.body.innerText).catch(() => null);
    if (!text) text = await page.textContent('body');
    
    if (!text) return null;
    
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
    
  } catch (e) {
      log(`   ⚠️ Failed to search for owner: ${e}`);
  }
  return null;
}

export async function findContactInfo(context: BrowserContext, websiteUrl: string, log?: (msg: string) => void): Promise<ScrapeResult> {
  const result: ScrapeResult = { email: null, owner: null };
  const logger = log || console.log;
  
  logger(`🕷️  Starting scraping for: ${websiteUrl}`);

  const page = await context.newPage();
  const visited = new Set<string>();
  let baseUrl: URL;
  try {
    baseUrl = new URL(websiteUrl);
  } catch (e) {
    logger(`❌ Invalid URL: ${websiteUrl}`);
    await page.close();
    return result;
  }
  
  const domain = baseUrl.hostname.replace(/^www\./, '');
  
  const processPage = async (url: string, isMainPage: boolean = false) => {
     if (visited.has(url)) return;
     visited.add(url);
     
     try {
       logger(`   📲 Loading: ${url}`);
       await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
       
       if (!result.email) {
            result.email = await extractEmailFromPage(page, domain, isMainPage, logger);
       }
       
       const isImpressum = /impressum|imprint|kontakt/i.test(url);
       const shouldSearchOwner = !result.owner && isImpressum;
       
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
      await processPage(websiteUrl, true);
      
      if (result.email && result.owner) {
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
      
      const priorityPages = subpages.filter(url => /impressum|imprint|kontakt/i.test(url));
      const otherPages = subpages.filter(url => !/impressum|imprint|kontakt/i.test(url));
      
      const orderedPages = [...priorityPages, ...otherPages];
      logger(`📋 checking ${orderedPages.length} subpages`);

      for (const link of orderedPages) {
          if (result.email && result.owner) break;
          
          const isImpressum = /impressum|imprint|kontakt/i.test(link);
          if (result.email && !isImpressum && !result.owner) {
              continue;
          }

          await processPage(link, false);
      }
      
      if (!result.owner) {
         logger(`   ⚠️ No owner found after checking pages.`);
      }

  } catch(e) {
      logger(`❌ Error scraping ${websiteUrl}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
      if (!page.isClosed()) await page.close();
  }
  
  return result;
}

export async function findEmail(context: BrowserContext, websiteUrl: string, log?: (msg: string) => void): Promise<string | null> {
    const res = await findContactInfo(context, websiteUrl, log);
    return res.email;
}
