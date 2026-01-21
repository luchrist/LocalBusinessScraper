import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright';

const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const OBFUSCATED_EMAIL_REGEX = /([\w.+\-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|at|AT|ät))\s*([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/gi;
const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net'];

function cleanEmail(email: string): string | null {
  const cleaned = email.replace(/^[0-9]+/, '');
  if (cleaned && /^[A-Za-z]/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'URL fehlt' }, { status: 400 });
    }

    const logs: string[] = [];
    const log = (message: string) => {
      console.log(message);
      logs.push(message);
    };

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
    const email = await findEmail(context, url, log);
    await context.close();
    await browser.close();

    return NextResponse.json({
      url,
      email,
      logs,
    });
  } catch (error) {
    console.error('Test error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unbekannter Fehler' },
      { status: 500 }
    );
  }
}

async function findEmail(context: any, websiteUrl: string, log: (msg: string) => void): Promise<string | null> {
  log(`🕷️  Starting email search for: ${websiteUrl}`);
  const page = await context.newPage();
  const visited = new Set<string>();
  const baseUrl = new URL(websiteUrl);
  const domain = baseUrl.hostname;

  try {
    // Suche auf der Hauptseite
    log(`🔎 Scanning main page...`);
    const email = await searchPageForEmail(page, websiteUrl, domain, log);
    if (email) {
      log(`✅ Email found on main page: ${email}`);
      return email;
    }

    log(`📄 Fetching subpages...`);
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const rawLinks: string[] = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) =>
      anchors
        .map((a: HTMLAnchorElement) => a.getAttribute('href') || '')
        .filter((href: string) => href.trim().length > 0)
    );

    log(`🔗 Found ${rawLinks.length} links on page`);
    log(`   Sample raw links: ${rawLinks.slice(0, 10).join(', ')}`);

    const subpages = rawLinks
      .map(link => {
        try {
          const absoluteUrl = new URL(link, baseUrl).href;
          log(`   🔄 "${link}" -> "${absoluteUrl}"`);
          return absoluteUrl;
        } catch (e) {
          log(`   ❌ Invalid URL: "${link}" - ${e instanceof Error ? e.message : 'error'}`);
          return null;
        }
      })
      .filter((link): link is string => {
        if (!link) return false;
        try {
          const url = new URL(link);
          const isSameDomain = url.hostname.replace(/^www\./, '') === domain;
          const notVisited = !visited.has(link);
          
          if (!isSameDomain) {
            log(`   ⛔ Skipping (different domain): ${link} (${url.hostname} !== ${domain})`);
          } else if (!notVisited) {
            log(`   ⛔ Skipping (already visited): ${link}`);
          } else {
            log(`   ✅ Valid subpage: ${link}`);
          }
          
          return isSameDomain && notVisited;
        } catch {
          log(`   ⛔ Skipping (parse error): ${link}`);
          return false;
        }
      });

    log(`📋 Checking ${subpages.length} subpages for emails`);

    for (const link of subpages) {
      visited.add(link);
      log(`\n   🔍 Checking: ${link}`);
      const email = await searchPageForEmail(page, link, domain, log);
      if (email) {
        log(`✅ Email found on subpage: ${email}`);
        return email;
      }
    }

    log(`⚠️  No email found after checking ${subpages.length + 1} pages`);
  } catch (error) {
    log(`❌ Error scraping ${websiteUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    await page.close();
  }

  return null;
}

async function searchPageForEmail(page: any, url: string, domain: string, log: (msg: string) => void): Promise<string | null> {
  try {
    log(`   📲 Loading: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    
    // 1. Zuerst nach mailto: Links in der HTML-Struktur suchen
    log(`   🔍 Checking mailto: links...`);
    const mailtoLinks = await page.$$eval('a[href^="mailto:"]', (anchors: HTMLAnchorElement[]) =>
      anchors.map((a: HTMLAnchorElement) => {
        const href = a.getAttribute('href') || '';
        return href.replace('mailto:', '').split('?')[0].trim();
      })
    );
    
    if (mailtoLinks.length > 0) {
      log(`   📧 Found ${mailtoLinks.length} mailto: links: ${mailtoLinks.join(', ')}`);
      
      const getDomainWithoutTLD = (fullDomain: string): string => {
        const normalized = fullDomain.replace(/^www\./, '');
        const parts = normalized.split('.');
        return parts.length > 1 ? parts.slice(0, -1).join('.') : normalized;
      };
      
      const domainWithoutTLD = getDomainWithoutTLD(domain);
      
      for (const email of mailtoLinks) {
        if (email && email.includes('@')) {
          const cleaned = cleanEmail(email);
          if (cleaned) {
            const emailDomain = cleaned.split('@')[1].toLowerCase();
            const emailDomainWithoutTLD = getDomainWithoutTLD(emailDomain);
            
            if (emailDomainWithoutTLD === domainWithoutTLD || COMMON_PROVIDERS.includes(emailDomain)) {
              log(`   ✅ Valid mailto: email found: ${cleaned}`);
              return cleaned;
            } else {
              log(`   ⛔ Mailto link rejected: ${cleaned} (domain: ${domain})`);
            }
          }
        }
      }
    } else {
      log(`   ⚠️  No mailto: links found`);
    }
    
    // 2. Fallback: Text-basierte Suche
    log(`   🔍 Fallback: Checking text content...`);
    const text = await page.textContent('body');
    
    if (!text) {
      log(`   ⚠️  No text content found on page`);
      return null;
    }

    log(`   📄 Page text length: ${text.length} characters`);
    log(`   📝 First 500 chars: ${text.substring(0, 500).replace(/\s+/g, ' ')}`);
    
    // Check if the word "mail" or "@" exists
    const hasMailKeyword = /mail|@/i.test(text);
    log(`   🔍 Page contains 'mail' or '@': ${hasMailKeyword}`);

    log(`   🧪 Testing EMAIL_REGEX: ${EMAIL_REGEX}`);
    const directEmails = text?.match(EMAIL_REGEX) || [];
    log(`   📧 Direct emails found: ${directEmails.length}`);
    if (directEmails.length > 0) {
      log(`      Raw: ${directEmails.join(', ')}`);
    }

    log(`   🧪 Testing OBFUSCATED_EMAIL_REGEX: ${OBFUSCATED_EMAIL_REGEX}`);
    const obfuscatedEmails: string[] = [];
    if (text) {
      let match: RegExpExecArray | null;
      while ((match = OBFUSCATED_EMAIL_REGEX.exec(text)) !== null) {
        const candidate = `${match[1]}@${match[2]}.${match[3]}`;
        obfuscatedEmails.push(candidate);
        log(`      Match: "${match[0]}" -> ${candidate}`);
      }
    }
    
    log(`   🔐 Obfuscated emails found: ${obfuscatedEmails.length}`);
    if (obfuscatedEmails.length > 0) {
      log(`      Raw: ${obfuscatedEmails.join(', ')}`);
    }

    const allRawEmails = [...directEmails, ...obfuscatedEmails];
    
    if (allRawEmails.length === 0) {
      log(`   ❌ No email patterns matched at all!`);
      // Show a snippet around potential email indicators
      const mailIndex = text.toLowerCase().indexOf('mail');
      if (mailIndex !== -1) {
        const snippet = text.substring(Math.max(0, mailIndex - 50), Math.min(text.length, mailIndex + 100));
        log(`   📍 Text around "mail": "${snippet.replace(/\s+/g, ' ')}"`);
      }
      return null;
    }

    const emails = allRawEmails
      .map(email => cleanEmail(email))
      .filter((email): email is string => email !== null);
    
    if (emails.length !== allRawEmails.length) {
      log(`   🧹 Cleaned: ${emails.join(', ')}`);
    }
    
    const getDomainWithoutTLD = (fullDomain: string): string => {
      const normalized = fullDomain.replace(/^www\./, '');
      const parts = normalized.split('.');
      return parts.length > 1 ? parts.slice(0, -1).join('.') : normalized;
    };
    
    const domainWithoutTLD = getDomainWithoutTLD(domain);
    log(`   🔍 Validating against domain: ${domain} (base: ${domainWithoutTLD})`);

    for (const email of emails) {
      const emailDomain = email.split('@')[1].toLowerCase();
      const emailDomainWithoutTLD = getDomainWithoutTLD(emailDomain);
      
      log(`      Checking ${email}:`);
      log(`         Email base: "${emailDomainWithoutTLD}"`);
      log(`         Domain base: "${domainWithoutTLD}"`);
      log(`         Common provider: ${COMMON_PROVIDERS.includes(emailDomain)}`);
      
      if (emailDomainWithoutTLD === domainWithoutTLD || COMMON_PROVIDERS.includes(emailDomain)) {
        log(`      ✅ ACCEPTED: ${email}`);
        return email;
      } else {
        log(`      ❌ REJECTED: domain mismatch`);
      }
    }
  } catch (error) {
    log(`   ⚠️  Failed to load page: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return null;
}
