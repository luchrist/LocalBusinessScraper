import { Page, BrowserContext } from 'playwright';

export const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
export const OBFUSCATED_EMAIL_REGEX = /([\w.+\-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|\<at\>|at|AT|ät))\s*([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/gi;
export const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net', 'aol.com'];

// Clean email by removing leading numbers and ensure it starts with a letter
export function cleanEmail(email: string): string | null {
  // Remove leading numbers until we hit a letter
  const cleaned = email.replace(/^[0-9]+/, '');
  // Check if it starts with a letter now
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
  
  // Exact match
  if (emailDomainWithoutTLD === domainWithoutTLD) return true;
  
  // Fuzzy match (if not strict)
  if (!strictMode) {
    const normalizedEmail = normalizeDomain(emailDomainWithoutTLD);
    const normalizedExpected = normalizeDomain(domainWithoutTLD);
    
    // Check if one contains the other (min 8 chars to avoid false positives)
    if (normalizedEmail.length >= 8 && normalizedExpected.length >= 8) {
      if (normalizedEmail.includes(normalizedExpected) || normalizedExpected.includes(normalizedEmail)) {
        return true;
      }
    }
  }
  
  return false;
}

export async function searchPageForEmail(page: Page, url: string, domain: string, isMainPage: boolean = false): Promise<string | null> {
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
          if (cleaned) {
            // Hauptseite: mailto immer akzeptieren
            if (isMainPage) {
              console.log(`   ✅ Mailto from main page accepted: ${cleaned}`);
              return cleaned;
            }
            // Subpages: erst exakt, dann fuzzy
            if (isEmailFromDomain(cleaned, domain, true)) {
              console.log(`   ✅ Exact match mailto: email found: ${cleaned}`);
              return cleaned;
            }
            if (isEmailFromDomain(cleaned, domain, false)) {
              console.log(`   ✅ Fuzzy match mailto: email found: ${cleaned}`);
              return cleaned;
            }
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

    // Also catch obfuscated forms like "info at domain.de" or "info[at]domain.de"
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

    // Clean all emails
    const cleanedDirectEmails = directEmails.map((e: string) => cleanEmail(e)).filter((e: string | null): e is string => e !== null);
    const cleanedObfuscatedEmails = obfuscatedEmails.map((e: string) => cleanEmail(e)).filter((e: string | null): e is string => e !== null);
    
    // Direct emails: erst exakt, dann fuzzy
    for (const email of cleanedDirectEmails) {
      if (isEmailFromDomain(email, domain, true)) {
        console.log(`   ✅ Exact match (direct) email accepted: ${email}`);
        return email;
      }
    }
    
    for (const email of cleanedDirectEmails) {
      if (isEmailFromDomain(email, domain, false)) {
        console.log(`   ✅ Fuzzy match (direct) email accepted: ${email}`);
        return email;
      }
    }
    
    // Obfuscated emails: nur exakt
    for (const email of cleanedObfuscatedEmails) {
      if (isEmailFromDomain(email, domain, true)) {
        console.log(`   ✅ Exact match (obfuscated) email accepted: ${email}`);
        return email;
      }
    }
  } catch (error) {
    // Seite konnte nicht geladen werden
    console.log(`   ⚠️  Failed to load page: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return null;
}

export async function findEmail(context: BrowserContext, websiteUrl: string): Promise<string | null> {
  console.log(`🕷️  Starting email search for: ${websiteUrl}`);
  const page = await context.newPage();
  const visited = new Set<string>();
  const baseUrl = new URL(websiteUrl);
  const domain = baseUrl.hostname.replace(/^www\./, '');

  try {
    // Suche auf der Hauptseite
    console.log(`🔎 Scanning main page...`);
    const email = await searchPageForEmail(page, websiteUrl, domain, true);
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
